# 架构

本文说明 atri-bot 的分层、依赖方向与扩展点。目标是让「加一个 provider」「加一个插件」
这类改动有确定的落点，而不是到处试。

## 分层

```
apps/server/src/
├── index.ts        薄入口：loadConfig -> createApp -> start -> 信号处理
├── app.ts          组合根：在一处装配所有对象，返回 { start, stop, address }
├── config/         配置加载（默认值 -> atri.config.json -> 环境变量）
├── core/           全部业务逻辑，不依赖上层
│   ├── agent/      AgentEngine：一轮对话的编排
│   ├── auth/       AuthManager：管理员口令与会话令牌
│   ├── session/    SessionManager：会话与消息（当前为内存实现）
│   ├── provider/   配置存储 + 装配 + ProviderRegistry + 厂商实现（openai / anthropic）
│   └── logger.ts
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

`app.ts` 是唯一做装配的地方。其余模块都不知道别人是谁：

```ts
const logger = createLogger(config.logLevel);
const auth = new AuthManager(config, logger);
await auth.init(); // 必须早于 HTTP 启动：未配置口令时要先落盘
const sessions = new SessionManager();
const providers = new ProviderRegistry();
const providerConfig = new ProviderConfigStore(config, logger);
const plugins = new PluginManager(config, logger);
// 引擎只吃三样东西；曾经还注入过 config 与 plugins，但两个字段在全仓没有任何读取点。
const engine = new AgentEngine({ sessions, providers, logger });
const adapters = new AdapterManager({ config, engine, logger });
const http = await createHttpServer({
  config,
  logger,
  sessions,
  providers,
  providerConfig,
  reloadProviders: rebuildProviders, // 启动与「配置页改完保存」共用同一个装配函数
  plugins,
  adapters,
  auth,
  engine,
});
```

`SessionManager` / `ProviderRegistry` 现在**不接配置**：给构造参数标类型这一步暴露出这两个类
把传进来的 `config` 存成了一个从未被读取的字段 —— 那是「以后要持久化」的预留位，不是当前行为。
留着它就得为它编一个没有任何真实用途的类型，所以删掉；真要做持久化时按当时的需求重新接线。

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

`api/router.ts` 是手写的极简路由：注册顺序即匹配顺序，先命中者胜，支持 `/:param` 与 `*`。
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

分层是「注册表只管存与取，存储与装配各自一层」：

```
store.ts    ProviderConfigStore：两层配置的校验与落盘（读写 atri.config.json）
factory.ts  配置 -> 实例（唯一入口，认得 type、两层合并与密钥解析）
registry.ts ProviderRegistry：选路与转发，不知道任何厂商细节
openai.ts   / anthropic.ts：厂商实现
sse.ts      SSE 解析（两个实现共用）
errors.ts   ProviderError 与上游错误归一
```

把装配从注册表里拆出来，是为了让 `registry.ts` 不 import 任何具体实现。
新增一个厂商只需在 `factory.ts` 的 `TYPES` 表里加一行。

### 两层配置与落盘

配置分两层：**provider source**（一次连接：`type`/`baseUrl`/`apiKey`/`timeoutMs`）
与 **provider**（一个模型实例：`source`/`model`/`enabled`）。合并规则是
`{ ...source, ...provider }`，实例上的同名字段覆盖源。

这样切分是因为**凭证属于连接，不属于模型**：一个网关下的十个模型共享一份密钥，
而超时也是连接级的性质。若压成一层，加一个模型就要重抄一遍密钥与端点。

`factory.ts` 对一个 provider 就是「一个模型实例」，所以构造时把 `model` 变成单元素
`models: [model]`——注册表原来的按模型名选路因此完全不用改。

`store.ts` 承担全部校验（字段类型、`id` 字符集、`baseUrl` 协议、`timeoutMs` 区间），
并保证**校验失败时文件一个字节都不动**：先在校验完的副本上改，通过才落盘，
所以「用户点错一次把配置改坏」不会发生。写文件是「读-改-写」同一份 JSON，
`host`/`auth` 等无关字段原样保留，权限设 `0600`（里面有明文密钥）。

一个反直觉但必要的分支：`config.root` 可以缺省。直接用代码构造 config 的调用方
（测试、嵌入式使用）没有配置文件可写，此时存储退化为**只读内存视图**，
写操作显式报错——否则 `join(undefined, ...)` 会以一个难懂的 `ERR_INVALID_ARG_TYPE`
冒出来。

### 配置变更如何生效

`app.ts` 里 `rebuildProviders()` 是**唯一**的装配路径，启动与每次配置写入后都走它：
清空注册表 → `createProviders` → 逐个注册 → 处理错误与默认项。
两条装配路径容易在演进中走散（比如只有一个地方处理「默认项加载失败」），
所以刻意只留一条。

清空注册表是安全的：provider 没有长连接，在途请求已持有自己的实例引用，
因此那个请求会用旧配置跑完，下一次请求拿到新配置。代价是**别的标签页不会自动
看到变化**（本次不做 WS 通知）。

### 选路与回声兜底

`#resolveFor(model)` 的显式值既可以是**实例 id** 也可以是模型名：控制台的模型
选择器发上来的是实例 id，而配置文件里写的通常是上游模型名，两种都得认。
只按模型名匹配会让「选了个非默认实例」静默落到默认 provider 上，
还把实例 id 当成上游模型名发出去——这类错误上游只会回一个含糊的 404。

选路的其余部分是三级回落：显式值命中 → 默认 provider → 第一个注册的。
模型名对不上任何 provider 时仍退回默认 provider，因为上游的模型列表通常比本地配置新，
本地列表不该当硬闸门。

回复退化为**回声**只在「一个 provider 都没注册」时发生。只要注册了 provider，
调用失败就必须如实抛错——把故障伪装成正常回复会让问题永远暴露不出来。

配了 `default` 但它加载失败时**不静默换一个**，只留一条 warn。否则请求会悄悄打到
另一个模型上，那比启动失败更难查。

### 错误归一

三个厂商的错误形状不同，`errors.ts` 把它们统一成 `ProviderError`，
并给已知状态码配中文解释（401「密钥无效」、429「触发限流」…）。
`toNetworkError` 单独处理 `AbortError`——取消是预期路径，不该报成上游故障。

### 流式

`chatStream` 与 `chat` 是**两个方法而非一个带 `onDelta` 的方法**：
调用方要么要流式、要么要整段，混在一起会让「没传 onDelta」成为一个隐藏分支。
两者走同一份消息构造与错误处理。

`registry.chatStream` 在 provider 没有 `chatStream` 时退化为「一次 `chat` 再整段
`onDelta`」，这样引擎不必判断 provider 是否支持流式，前端拿到的形状始终一致。
流式以**拼接结果**为落库依据，不依赖前端攒增量——前端丢一帧不该影响历史记录。

### 获取模型列表

`POST /provider-sources/:id/models` 用**已保存的**源构造一个临时实例去打上游的
`GET /models`。刻意**不接受请求体里的 `baseUrl`/`apiKey`**：那会让这个端点变成
「带任意凭证访问任意地址」的转发器，而它只要登录就能调用。
用户必须先保存再获取——这与 UI 上「保存并获取模型列表」的文案是同一件事。

失败回 **400 而不是 502**：绝大多数是 `baseUrl` 打错、密钥不对、或该网关根本没有
`/models`，全都是用户自己能修的问题，而 502 会把它们指向「服务器坏了」。
两个实现都**不做内置回退模型列表**——悄悄给一份「大概能用」的模型名，
会把配置错误推迟到真正发消息时才暴露。

`GET /providers` 返回**配置里的全部条目**（含被禁用与加载失败的），
每条带 `loaded` 与失败原因。旧语义只返回注册表里活着的那些，
于是「我明明配了它却不在列表里」这种最难自查的状况在界面上表现为「凭空消失」。

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

### 插件的语言与类型入口

插件目录里的入口**仍然叫 `index.js`**，且继续可以是纯 JavaScript —— 服务端按运行时
`import()` 加载它，本仓迁到 TS 不改变这个契约（`plugins/manager.ts` 里那两个
`join(pluginDir, "index.js")` 是**磁盘文件名**，不是 import 说明符，不参与扩展名改写）。

类型入口是**源码本身**：`plugins/context.ts` 导出 `PluginContext` / `PluginShared` /
`Subscribable`，`plugins/manager.ts` 导出 `PluginDefinition` / `PluginFactory` / `PluginView`。
曾经考虑过另外产出一份手维护的 `plugin-types.d.ts` 给外部作者 `@type {import("...")}` 用，
**否掉了**：那份声明和 `context.ts` 是同一事实的第二处书写，正是本仓反对的模式；
而服务端现在 `noEmit`，也不再有任何 `.d.ts` 消费者。要类型就读源码，或者在自己的插件里写 JSDoc。

### 插件可见的配置：白名单视图

插件是仓库里**唯一**来自磁盘的用户代码，因此它也是唯一的信任边界：`api/`、`core/`、`adapters/`
拿着整份 `AppConfig` 不会离开本进程，而 `shared.config` / `ctx.config` 是直接交到用户手写的
`index.js` 手上的东西。所以这两处给的不是 `AppConfig`，而是 `pluginRuntimeConfig()` 投影出来的
`PluginRuntimeConfig`，目前只有 `pluginDirs` 一条键。

迁移时曾经是反过来的：`app.ts` 把整个 config 交给 `PluginManager`，而 `PluginManagerConfig`
声明成 `{ pluginDirs?: string[] }`。那是「类型比现实窄」——插件运行时想读什么就能读到什么
（`auth.adminPassword`、源的 `apiKey` 都在里面），窄标注只会让人误以为边界已经收住了。

三条不显然的决定：

- **白名单，不是黑名单。** 秘密会换名字、会新增（下一版多个 `smtpPassword` 就再漏一次），
  而「插件需要哪几条键」是个能一次数清的问题。默认拒绝让新增必须经过人的判断，
  改动点写在 `plugins/manager.ts` 的类型上，并有对应测试。
- **投影发生在组合根。** `app.ts` 是唯一同时认识「完整配置」与「插件」两边的地方。
  决定放在那里，插件子系统就不知道自己被挡掉了什么，也不会哪天有人「顺手」把整个对象传进去。
- **视图里的数组是副本。** 共享同一个数组时，插件一次 `push` 就改到运行期配置本体，
  进而改变下一次扫描的目录。

`test/plugin-config.test.ts` 钉住这条边界：真起一个 app，fixture 插件把 `shared.config` 的键与
`ctx.config` 的**整个对象**交回测试，`deepEqual` 连多出来的键一起报错；另有一句断言「口令与
apiKey 确实存在于交给 app 的配置里」，防止有人清空测试配置后守卫悄悄变成空话。

> 对照 AstrBot：它的「分开管理」做在**对外 HTTP 面**——内部 dashboard API 全量，对外的
> Open API 由脚本从全量 `openspec/openapi-v1.yaml` 按 `PUBLIC_OPEN_API_SCOPES` 白名单派生、
> 用 API key 鉴权，并由 `tests/unit/test_openapi_scope_docs.py` 断言每个公开操作都声明了
> `x-astrbot-scope`。它的**插件层**没有做这道投影：`self.context.config` 就是那份
> `AstrBotConfig`，插件自己的配置项用 `StarConfigMetadata` 声明后也存在同一个 config 里。
> 我们抄的是它「派生一个低信任面 + 用测试把关」的形状，收得比它的插件层更紧。
> 若将来要支持在控制台里编辑某个插件的配置项（AstrBot 的 `plugin_settigns` 那种），
> 新增的应当是**该插件专属的一段**，而不是把 `AppConfig` 重新交出去。

## 前端

`apps/dashboard` 是 Vue 3 + vue-router + Pinia + UnoCSS + naive-ui 的单页应用：

```
src/
├── main.ts          挂载应用，按顺序引入 ./uno.css 与 virtual:uno.css
├── assets/images/   logo.png（控制台顶栏用，整图不裁）
├── api/
│   ├── client.ts    唯一的 HTTP/WS 出口（手写）
│   └── generated/   由 openapi.json 生成的类型化 SDK（入库，不手改）
├── stores/          auth / sessions / plugins / providers（Pinia）
├── router/index.ts  路由与登录守卫
├── layouts/         bot/BotLayout（顶栏 + 侧栏） / chat/ChatLayout（侧栏 + 顶栏）
├── views/           LoginView / ConsoleView / ProviderConfig / chat 下的创建与会话页
└── components/
    ├── shared/      icons / TopBarMenu / PlatformSwitch / ModelSelectMenu
    ├── bot/         BotHeader / BotNavigation
    ├── chat/        ChatHeader / Navigation
    └── provider/    ProviderCard
```

### 两个平台的顶栏

控制台（bot）与聊天（chat）是两套布局，各自有**自己的顶栏组件**，右侧控件则共用：

- `components/bot/BotHeader.vue` —— 左侧 logo，右侧 `ModelSelectMenu` + `PlatformSwitch` + `TopBarMenu`。
- `components/chat/ChatHeader.vue` —— 左侧模型选择器，右侧同样是那三个控件。

刻意**不把两者合成一个组件**：左侧内容本就不同，合起来只会得到一堆 `isChat` 分支，
让两个平台的顶栏改动互相牵制。曾经把 BotHeader 做成直接复用 ChatHeader，
结果是 bot 侧顶栏也跟着显示模型选择器，既丢了 logo 又表达不出平台差别。
右侧那三个控件则抽到 `components/shared/`，因为它们确实一模一样。

几个不显眼但会踩的点：

- **`PlatformSwitch` 的高亮从当前路由推出，不存本地状态。** 写成 `ref` 会立刻出现
  「停在 chat 但按钮显示 bot」——刷新、前进后退、或直接粘贴 `/chat/:id` 时局部状态都不跟着走。
- **logo 不裁剪**。原图 2172×724 里不透明像素只占 228–491 行（真实图形 2114×264、宽高比 8.0），
  约 63% 是透明留白。图片撑满顶栏高度时可见图形约 21px 并上下自然留白，
  留白本身就充当内边距；裁图只会多出一份要跟着原图更新的派生资源。
- **logo 的父链接需要 `self-stretch`**。顶栏是 `items-center` 的 flex 容器，直接子项高度是内容撑出来的，
  此时 `img` 的 `h-full`（`height:100%`）因父高不确定而解析成 `auto`，图片会退回原始尺寸。
- **窄屏要收窄 logo**（`max-width: 96px`）。177px 的 logo 加上模型选择器与 107px 的切换按钮，
  在 375px 视口下放不下，实测汉堡按钮被推到 `right=382` 而**整颗移出屏幕**——不是变窄，是点不到。

几条约束：

- **令牌只存在于 Cookie 里**，前端不持有、也不存储任何令牌。
  `main.ts` 里没有 `localStorage`/`sessionStorage` 的用法，这是有意的。
  （唯一的 `localStorage` 用法是记住模型选择——那不是凭证。）
- 401 统一在 `api/client.ts` 转成 `UnauthorizedError`，由 store 与路由守卫决定后续动作，
  调用方不需要各自判断状态码。
- 登录守卫先问 `/auth/status`、再问 `/auth/me`。前者是公开的，用来判断是否需要登录；
  后者在 401 时返回 null 而不抛错，因此守卫里没有异常控制流。
- **UnoCSS 必须引入虚拟入口**：`src/uno.css` 只是本地基础样式（reset + 全局），
  不含任何原子类。少了 `import "virtual:uno.css"`，构建产物里一个工具类都不会生成，
  样式层会**静默失效**（CSS 从 ~12 kB 掉到 ~3 kB 就是这个症状）。

### 供应商配置页

`views/ProviderConfig.vue` 是「源列表 + 源详情」的两栏工作台，状态全在
`stores/providers.ts`。三个容易做错的地方：

- **store 的私有辅助必须是模块级函数**。Pinia 把 actions 挂到另一个对象上执行，
  action 里的 `this.#privateFn()` 会因为 `this` 上根本没有那个私有名字而抛 `TypeError`。
  `stores/sessions.ts` 已经踩过一次（去重逻辑因此改成模块级 `ingestInto`）。
- **草稿只在「选中的源」变化时重建**，不在每次 `refresh()` 后重建——
  否则后台刷新会抹掉用户正在输入的内容。
- 获取模型列表前若草稿有改动，**先保存再拉取**：既符合「拉的是已保存凭证」这一
  服务端约束，也避免把一份还没落盘的凭证交给上游。

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
- **TypeScript 只在类型层，不进运行时**。`apps/server` 是 `noEmit` 的纯检查工程：
  `dev`/`start`/`test` 都直接跑 `.ts` 源码，靠 Node 22.18+ 默认开启的类型擦除执行，
  因此不产出 `dist`、没有 `.d.ts` 消费者，也不需要 `tsx`/`ts-node` 这类东西
  （服务端外部运行时依赖仍然只有 `ws` 一个）。
  配套的两条：`erasableSyntaxOnly: true` 把「只有可擦除语法才跑得起来」从口头约定
  变成编译期检查；`allowImportingTsExtensions: true` 让源码写 `./x.ts` ——
  因为擦除**不改写 import 说明符**，写 `.js` 在运行时解析不到文件。
  反面做法都被否掉了：装 `fastify`+`@fastify/swagger`（自动导出规格，但传递依赖从 1 个变 70+，
  含 `pino`/`semver`）、`hono`+`zod`（约 7 个包，但 Web Fetch 模型与现有 `node:http` 行为
  —— WS 升级鉴权、静态目录穿越 403、Cookie 逐属性、SSE 的 `cache-control: no-store` —— 冲突面最大）。
- `pnpm typecheck` 也检查测试（`test/**/*` 在 `include` 里）。测试因此不能再靠
  「JS 不检查」蒙混，config 字面量要真的符合 `AppConfig`。
- `erasableSyntaxOnly` **只开在 `apps/server`**，不是全仓统一：这个选项的前提是
  「没人编译，只靠擦除」。`packages/shared` 与 `apps/dashboard` 是真的被 `tsc` / Vite 编译，
  `enum` 在那里会被正常降级而不是留下跑不起来的东西，给它们开属于错误的一致化。

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

### pnpm 11 起的两个坑（本仓用 12，规则照旧）

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
