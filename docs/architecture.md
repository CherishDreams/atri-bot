# 架构

本文说明 atri-bot 的分层、依赖方向与扩展点。目标是让「加一个 provider」「加一个插件」
这类改动有确定的落点，而不是到处试。

## 分层

```
apps/server/src/
├── index.js        薄入口：loadConfig -> createApp -> start -> 信号处理
├── app.js          组合根：在一处装配所有对象，返回 { start, stop, address }
├── config/         配置加载（默认值 -> atri.config.json -> 环境变量）
├── core/           全部业务逻辑，不依赖上层
│   ├── agent/      AgentEngine：一轮对话的编排
│   ├── auth/       AuthManager：管理员口令与会话令牌
│   ├── session/    SessionManager：会话与消息（当前为内存实现）
│   ├── provider/   ProviderRegistry：模型提供方
│   └── logger.js
├── api/            传输层：HTTP 路由、静态托管、WebSocket（无业务逻辑）
├── adapters/       可选启用的对外接入
└── plugins/        插件加载器与上下文
```

### 依赖方向（不可逆）

```
api/ ─────┐
adapters/ ┴─> core/ ─> (无)
plugins/  ─> 仅依赖注入给它的 ctx，不 import core/ 之外的具体实现
```

`core/` 不依赖 `api/`、`adapters/`、`plugins/` 中任何东西。
**没有任何模块依赖 `api/`**——传输层是可替换的最外层。
两个 app 都依赖 `packages/shared`，共享类型、常量与线协议。

这条规则的实际好处：`api/` 可以整体换掉（换成 gRPC、CLI）而不碰业务逻辑。

## 组合根

`app.js` 是唯一做装配的地方。其余模块都不知道别人是谁：

```js
const logger = createLogger(config.logLevel);
const sessions = new SessionManager(config);
const auth = new AuthManager(config, logger);
await auth.init(); // 必须早于 HTTP 启动：未配置口令时要先落盘
const providers = new ProviderRegistry(config);
const plugins = new PluginManager(config, logger);
const engine = new AgentEngine({ sessions, providers, logger });
const adapters = new AdapterManager(config, logger);
const http = await createHttpServer({
  config,
  logger,
  sessions,
  providers,
  plugins,
  adapters,
  auth,
});
```

依赖靠**构造参数**传入，没有全局单例、没有模块级可变状态。
这使测试可以直接 `createApp(config)` 起一个真服务，而不需要 mock 掉半个世界。

## 请求生命周期

```
HTTP 请求
  └─> createServer 处理器
        ├─ new URL(req.url, ...) 取 pathname
        ├─ 鉴权闸门（仅 /api/v1 下、非白名单路径）
        ├─ router.match(method, pathname)
        │     ├─ 命中 -> handler(req, res, params)
        │     └─ 未命中 -> serveStatic()（真实文件，否则 SPA 回退）
        └─ catch -> logger.error + 500
```

### 鉴权闸门为什么在路由匹配之前

判据是「路径是否在 API 前缀下」，而不是「有没有命中路由」。若放在匹配之后，
未注册的 API 路径会先返回 404，匿名调用者就能靠 **401 与 404 的差异枚举出哪些端点存在**。
放在匹配之前还有两个好处：新增路由默认受保护（fail closed），
而静态资源（登录页本身）必须匿名可取，所以闸门只覆盖 `/api/v1` 前缀。

### 路由表为什么是数组

`api/router.js` 是手写的极简路由：注册顺序即匹配顺序，先命中者胜，支持 `/:param` 与 `*`。
这样 `GET /sessions/:id` 与其它的具体路径不会互相遮蔽，行为完全由注册顺序决定，
不需要理解框架的优先级规则。

## 鉴权设计

`AuthManager` 的分工是把「凭据」和「会话」两件事都关在一个类里：

- **凭据**：用户名与口令都用 `sha256` 摘要成定长 32 字节后再 `timingSafeEqual`，
  避免长度差异提前返回。用户名与口令**都**参与比对，用户名不存在时不短路，
  因此响应时间不泄露「这个账号是否存在」。失败一律返回同一句话。
- **会话**：令牌是随机 UUID，存在内存 `Map` 里，进程重启即全部失效。
  双层过期：绝对 15 天 + 空闲 7 天。每次使用续期空闲计时，但绝对期限不可延长。
  清理是**惰性**的（在 `login` 与 `getByToken` 时顺带 `#prune()`），
  没有定时器，所以 `stop()` 之后不残留任何资源。
- **时钟可注入**：`constructor(config, logger, { now = Date.now })`。
  过期测试因此能把时间真正往前拨，而不是回拨内部字段——
  后者只能证明「字段被读了」，证明不了「时间到了就失效」。

令牌只经 `HttpOnly; SameSite=Lax` 的 Cookie 传递，从不进入响应体。
WebSocket 复用同一个 Cookie 完成握手（浏览器无法为握手自定义请求头），
未登录的连接在握手阶段即以 401 拒绝。

## 静态托管

`pnpm build` 之后，服务端托管 `apps/dashboard/dist` 并做 SPA 回退：

1. 非 GET/HEAD -> 404（不做回退）
2. `/api/v1`、`/ws` 前缀 -> 404（不吞掉接口的 404）
3. `resolveStaticPath()` 返回 null -> 403
4. 真实文件 -> 发送之；否则回退 `index.html`；都没有 -> 404 并提示先 `pnpm build`

`resolveStaticPath` 在 `resolve()` **之后**按前缀比对，并且必须带上路径分隔符，
以挡住 `<base>-evil` 这类「字符串前缀相同但不是子路径」的陷阱。
该函数被导出以便直接单测。

> 注意：`new URL()` 会先把 `/../`、`%2e%2e` 这类点段规范化掉，
> 所以 HTTP 层到达这里时通常已不含逃逸段。这道守卫防的是「调用方改成传原始 URL」
> 或「前面有人先 decode 一次」，因此由单元测试直接覆盖，而不是靠 HTTP 层间接证明。

## 插件系统

设计上把**模块加载**和**实例创建**分开：

- 模块只 import 一次。ESM 没有移除模块的 API，所以重载时用带 `?v=` 的 cache-busting
  重新 import，拿到重新求值过的代码。
- 每次加载都由框架创建插件实例，其副作用通过 `ctx.effect()` 登记；
  卸载时**逆序**释放，插件不需要手写清理逻辑。
- `ctx.subscribe()` 在卸载时自动退订。

这使「重载」成为一次干净的销毁+重建，而不是在旧状态上打补丁。

## 前端

`apps/dashboard` 是 Vue 3 + vue-router + Pinia + UnoCSS 的单页应用：

```
src/
├── main.ts          挂载应用，按顺序引入 ./uno.css 与 virtual:uno.css
├── api/client.ts    唯一的 HTTP/WS 出口，credentials: "include"
├── stores/          auth / sessions / plugins（Pinia）
├── router/index.ts  路由与登录守卫
├── views/           LoginView / ConsoleView
└── components/      SessionList / Conversation / PluginPanel
```

几条约束：

- **令牌只存在于 Cookie 里**，前端不持有、也不存储任何令牌。
  `main.ts` 里没有 `localStorage`/`sessionStorage` 的用法，这是有意的。
- 401 统一在 `api/client.ts` 转成 `UnauthorizedError`，由 store 与路由守卫决定后续动作，
  调用方不需要各自判断状态码。
- 登录守卫先问 `/auth/status`、再问 `/auth/me`。前者是公开的，用来判断是否需要登录；
  后者在 401 时返回 null 而不抛错，因此守卫里没有异常控制流。
- **UnoCSS 必须引入虚拟入口**：`src/uno.css` 只是本地基础样式（reset + 全局），
  不含任何原子类。少了 `import "virtual:uno.css"`，构建产物里一个工具类都不会生成，
  样式层会**静默失效**（CSS 从 ~12 kB 掉到 ~3 kB 就是这个症状）。

## 工具链

- **oxlint**：`.oxlintrc.json`，`correctness` + `suspicious` 两级。
  注意 `plugins` 字段**会覆盖默认插件集**，想用的插件必须全部列出
  （当前是 unicorn / oxc / typescript / vue）。
- **oxfmt**：`.oxfmtrc.json`，`singleQuote: false`（与本仓既有风格一致）。
- 二者都以 warning 计数，`pnpm lint` 带 `--deny-warnings`，
  所以**告警即失败**——oxlint 单独运行时仅有 warning 会退出 0，这一点容易误判。
- 仓库**没有 CI**，`pnpm check` 需要手动在提交前运行。

### pnpm 11 的两个坑

1. **`onlyBuiltDependencies` 已被移除**，改用映射形式的 `allowBuilds`：
   ```yaml
   allowBuilds:
     esbuild: true
   ```
   旧键写了不生效，且安装会以 `ERR_PNPM_IGNORED_BUILDS` 失败。
2. **`minimumReleaseAge` 自 11.0 起默认开启（1 天）**。发布不足 24 小时的版本会被拒绝，
   而 `pnpm add` 遇到这种版本会**自动往 `pnpm-workspace.yaml` 塞一个
   `minimumReleaseAgeExclude` 白名单**来绕过门禁。本仓刻意只使用已过窗口的版本，
   因此 `pnpm-workspace.yaml` 里不该出现该键；一旦出现，说明有人装了刚发布的版本，
   请改用窗口外的范围后把白名单删掉，不要让一次 `pnpm add` 顺手把门禁永久关掉。

   还要注意：门禁会校验**已存在的 `pnpm-lock.yaml` 条目**。
   只改 `package.json` 的范围是没用的——`install` 会在校验这一步直接中止，
   根本不会重新解析到旧版本。**必须删掉 `pnpm-lock.yaml` 以及
   `node_modules/.pnpm/lock.yaml`（模块目录里缓存的副本）后重跑 `pnpm install`**，
   才会真正从头解析。

   本仓当前的 `@vitejs/plugin-vue: ^6.0.9` 与 `vue-tsc: ^3.3.12` 就是为了避开窗口而
   刻意留的：它们的下一个补丁版发布时若仍在 24 小时内，`pnpm update` 会被门禁拦下。
   遇到这种情况请等窗口过去或按上面的步骤重新解析，**不要加白名单**。
