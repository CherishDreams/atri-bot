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
│   ├── provider/   ProviderRegistry + 厂商实现（openai / anthropic）
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

## 模型 provider

`core/provider/` 是**出站**边界：把 `{model, messages}` 变成某个厂商的 HTTP 调用。
与入站的 `adapters/` 是两个不同形状的接口，因此刻意不共用「适配器」这个词——
adapter 是长驻的 `start()`/`stop()`，provider 是每请求的 `chat()`。

分层是「注册表只管存与取，装配单独一层」：

```
factory.js  配置 -> 实例（唯一入口，认得 type 与密钥解析）
registry.js ProviderRegistry：选路与转发，不知道任何厂商细节
openai.js   / anthropic.js：厂商实现
sse.js      SSE 解析（两个实现共用）
errors.js   ProviderError 与上游错误归一
```

把装配从注册表里拆出来，是为了让 `registry.js` 不 import 任何具体实现。
新增一个厂商只需在 `factory.js` 的 `TYPES` 表里加一行。

### 选路与回声兜底

`#resolveFor(model)` 三级回落：**显式模型名命中某个 provider 的 `models`** →
默认 provider → 第一个注册的。模型名对不上任何一段 `models` 时仍退回默认 provider，
因为上游的模型列表通常比本地配置新，本地列表不该当硬闸门。

回复退化为**回声**只在「一个 provider 都没注册」时发生。只要注册了 provider，
调用失败就必须如实抛错——把故障伪装成正常回复会让问题永远暴露不出来。

配了 `default` 但它加载失败时**不静默换一个**，只留一条 warn。否则请求会悄悄打到
另一个模型上，那比启动失败更难查。

### 错误归一

三个厂商的错误形状不同，`errors.js` 把它们统一成 `ProviderError`，
并给已知状态码配中文解释（401「密钥无效」、429「触发限流」…）。
`toNetworkError` 单独处理 `AbortError`——取消是预期路径，不该报成上游故障。

### 流式

`chatStream` 与 `chat` 是**两个方法而非一个带 `onDelta` 的方法**：
调用方要么要流式、要么要整段，混在一起会让「没传 onDelta」成为一个隐藏分支。
两者走同一份消息构造与错误处理。

`registry.chatStream` 在 provider 没有 `chatStream` 时退化为「一次 `chat` 再整段
`onDelta`」，这样引擎不必判断 provider 是否支持流式，前端拿到的形状始终一致。
流式以**拼接结果**为落库依据，不依赖前端攒增量——前端丢一帧不该影响历史记录。

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

`apps/dashboard` 是 Vue 3 + vue-router + Pinia + UnoCSS + naive-ui 的单页应用：

```
src/
├── main.ts          挂载应用，按顺序引入 ./uno.css 与 virtual:uno.css
├── api/
│   ├── client.ts    唯一的 HTTP/WS 出口（手写）
│   └── generated/   由 openapi.json 生成的类型化 SDK（入库，不手改）
├── stores/          auth / sessions / plugins（Pinia）
├── router/index.ts  路由与登录守卫
├── views/           LoginView / ConsoleView / chat 下的创建与会话页
└── components/      SessionList / Conversation / PluginPanel / chat/*
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

### OpenAPI 生成的客户端

`apps/server/openapi.json` 是接口规范的唯一源头，`apps/dashboard/src/api/generated/`
由 `pnpm codegen` 生成并入库。`pnpm check` 会重新生成一次并比对工作区，
所以改了接口必须同步提交生成物。

生成物**不参与 oxlint/oxfmt**（两者的 `ignorePatterns`）。这不只是为了省事：
若格式化会改动生成物，「重新生成后无差异」这条检查就永远不成立。

`api/client.ts` 是手写的唯一出口，原因是生成客户端默认**不抛异常**——
它把 `AxiosError` 当返回值交出（`if (opts.throwOnError) throw e; ...; return e`），
把「失败」编码进返回类型。手写一层把它转成异常，调用方才能用普通 `try/catch`。

两个必须手写而不能只靠生成物的点：

- **`bodySerializer`**。生成物在没配它时把请求体对象原样交给 fetch，
  对象会被序列化成 `[object Object]`。axios 路径自己会序列化所以看不出来，
  但 **SSE 走全局 `fetch`**，于是只有流式接口坏掉。
- **WebSocket**。OpenAPI 描述不了 WS，那一段永远是手写的。

### 流式渲染

`sessions` store 在发送时先插入一个 `pending` 的助手草稿，再按 `chunk.delta` 追加，
收到末帧才用服务端消息替换整条。这样做的原因有两条：

- 首字立刻可见，而不是等整段回复。
- **落库以服务端为准**。流式与刷新后读到的历史由此必然一致，
  不会出现「界面上一段、数据库里另一段」。

## 工具链

- **oxlint**：`.oxlintrc.json`，`correctness` + `suspicious` 两级。
  注意 `plugins` 字段**会覆盖默认插件集**，想用的插件必须全部列出
  （当前是 unicorn / oxc / typescript / vue）。
- **oxfmt**：`.oxfmtrc.json`，`singleQuote: false`（与本仓既有风格一致）。
- 二者都以 warning 计数，`pnpm lint` 带 `--deny-warnings`，
  所以**告警即失败**——oxlint 单独运行时仅有 warning 会退出 0，这一点容易误判。
- `pnpm check` 还会跑 `codegen:check`，校验生成物与 `openapi.json` 同步。
  它用 `git status --porcelain` 而不是 `git diff`——后者看不见未跟踪文件，
  而「新增了一个端点」正是最需要报警的情况。
- 仓库**没有 CI**，`pnpm check` 需要手动在提交前运行。

## 关停

`close()` 必须先掐断进行中的 SSE 流，再关 WebSocket 与 HTTP server：

```js
for (const controller of openStreams) controller.abort(); // 长连接，不掐就干等
wss.close(() => server.close(done));
server.closeAllConnections?.(); // 兜住空闲 keep-alive 连接
```

`server.close()` 只是「停止接受新连接」，它会**等所有既有连接自然结束**。
流式响应是长连接、可以持续几十秒，所以不主动收尾的关停会一直挂着
（实测有客户端开着流时要等 120s+，掐断后 4ms）。
`closeAllConnections()` 则处理另一头：空闲的 keep-alive 连接同样会让关闭悬住。

与之配套的是「客户端断开要中断上游」：`res.on("close")` 里 `controller.abort()`，
否则用户关掉标签页之后，服务端仍会为一份没人接收的响应继续消耗 token。
这种取消是预期路径，所以只记 `debug`，不按服务端故障刷 error 堆栈。

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
