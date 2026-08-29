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
│   ├── session/    SessionManager：会话与消息（`node:sqlite`，落在 `config.dataDir`）
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

### 模块说明符为什么是相对路径 + `#` 别名

服务端没有编译步骤：`dev`/`start`/`test` 都是 `node` 直接执行 `.ts` 源码，靠 Node 22.18+ 默认开启的
类型擦除。于是**每条 import 说明符都必须能被 Node 自己解析** —— 擦除只删类型，不改写说明符，
而 Node 从不读 `tsconfig.json`。同目录与向下进子目录写 `./x.ts`，**需要向上跳的**写
`#core/errors.ts`（`apps/server/package.json` 的 `imports: { "#*": "./src/*" }`，映射由 Node 的解析器完成）。
别名只覆盖 `src/` —— `#*` 的目标就是 `./src/*`，所以 `test/` 自己的 `./helpers/config.ts` 没有对应别名
（`#helpers/...` 会指到 `src/helpers`），`app.ts` 的 `./core/logger.ts` 也照旧写相对。
把别名限定在「向上跳」这一种方向，是因为它才是真正会绕晕人的那种：读一条 `../../config/file.ts`
要先算发起文件在哪、再算跳几层，而 `#config/file.ts` 直接就是答案。向下没这个负担。

三个替代，前两行的形状是本轮实测出来的，第三行是依赖代价：

| 写法                                               | `tsc`           | 运行时                     | 为什么                                                                      |
| -------------------------------------------------- | --------------- | -------------------------- | --------------------------------------------------------------------------- |
| `tsconfig.json` 的 `paths: { "@/*": ["./src/*"] }` | 通过            | **`ERR_MODULE_NOT_FOUND`** | 编译期别名需要有人改写说明符，这里没有那个人（没有 bundler、没有 tsc 产物） |
| `"#/*": "./src/*"`（键带斜杠）                     | **整树 TS2307** | 通过                       | Node 认这个形状，TypeScript 的 `imports` 解析不认                           |
| 装 `tsconfig-paths` / `tsx` 之类                   | 通过            | 通过                       | 为一个写法偏好打破「外部运行时依赖只有 `ws`」，且把「不编译」这条形态换掉了 |

`paths` 那一行的危险性在于它的**失败形态**：typecheck 全绿，坏在运行时。这与「扩展名两个包不一样」
（shared 写 `.js`、server 写 `.ts`）是同一个结论的两种症状，判据只有一条。

两道边界：`packages/shared` 不加 `imports`（它的 `exports` 与 `files` 都指 `dist/`，
再配一份指向 `src/` 的映射会让 dashboard 与 shared 内部解析出两份副本）；
`fileURLToPath(new URL("../openapi.json", import.meta.url))` 这类读法属于 **URL 解析**，
不受别名管辖也永远不能写成 `#` —— `#` 在 URL 里是片段分隔符，会静默解析成错路径而不报错。

## 组合根

`app.ts` 是唯一做装配的地方。其余模块都不知道别人是谁：

```ts
const logger = createLogger(config.logLevel);
const auth = new AuthManager(config, logger);
await auth.init(); // 必须早于 HTTP 启动：未配置口令时要先落盘
const sessions = new SessionManager(config, logger); // 会话库落在 config.dataDir
const providers = new ProviderRegistry();
const providerConfig = new ProviderConfigStore(config, logger);
// 工具：注册表只管「存在与执行」，启用与否由 ToolConfigStore 每次现读文件
const tools = new ToolRegistry();
for (const tool of createBuiltinTools()) tools.register(tool);
const toolConfig = new ToolConfigStore(config, logger);
// 插件看到的是白名单视图，不是整份 AppConfig（见「插件可见的配置」一节）
const plugins = new PluginManager(pluginRuntimeConfig(config), logger);
// 引擎吃五样：会话、provider、工具注册表、工具开关存储、日志器。
// 曾经这里还注入过 config 与 plugins，两个字段全仓没有任何读取点，于是被删掉；
// tools / toolConfig 是**先有读取点**（选本轮工具、执行调用）才加进来的。
const engine = new AgentEngine({ sessions, providers, tools, toolConfig, logger });
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
  tools,
  toolConfig,
  auth,
  engine,
});
```

`ProviderRegistry` 仍然**不接配置**：早先给它注入的 `config` 被存成一个从未被读取的字段，
那是「以后要持久化」的预留位而不是当前行为，留着就得为它编一个没有真实用途的类型，所以删掉了。

`SessionManager` 已经把那句话兑现了 —— 它现在接 `config.dataDir`（只声明自己读写的键，
见下一节）。当年那句「真要做持久化时按当时的需求重新接线」就是现在：接进来的是**唯一被读的
那一个键**，不是一个通用配置句柄。

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

## 会话与消息的持久化

会话与消息落在 `config.dataDir` 下的 `sessions.sqlite`，由 `core/session/db.ts`（连接、pragma、
schema 与版本）和 `manager.ts`（领域方法与 SQL）两层承担 —— 与 `core/provider/` 的
`store.ts` + `registry.ts` 同构。**不叫 `store.ts`**：本仓 `store` 已经被
`ProviderConfigStore` / `ToolConfigStore` 占住，含义是「读写 `atri.config.json` 的配置存储」。

选 `node:sqlite` 的理由只有一条最有分量：它是 **Node 内置模块**，因此不破
「服务端外部运行时依赖只有 `ws`」这条硬约束。免 `--experimental-sqlite` 旗标的下限是
v22.13.0 / v23.4.0，而本仓 `engines.node >= 22.18.0` 已经在里面，所以
`dev`/`start`/`test` 都不必加旗标 —— 这一点很关键，任何需要额外旗标的方案都会同时打断这三条脚本。
跨 22.18→24 可写的类名是 `DatabaseSync`（更新文档里的 `Database` 别名在 v24 的导出中还不存在）。
被否掉的替代：`better-sqlite3`（带原生编译的外部依赖）、JSONL 手写文件（排序、级联删除、
按会话取区间全要自己造，而那些正是 sqlite 免费给的）。

因为 `node:sqlite` 本身是同步 API，`SessionManager` 的方法**全部保持同步**，引擎与 HTTP 层
一个字没改 —— 这是一开始那句「可以直接平替」的兑现。

### 唯一能排序的键是 `seq`

`messages.seq` 是 `INTEGER PRIMARY KEY`（即 rowid 别名），全局单调递增，**插入序的唯一真相**。
不能用 `created_at`：那是毫秒 ISO，同一轮多步循环里可以完全相同，而 `randomUUID()` 不可排序。
更阴的是 `ORDER BY created_at` 在 SQLite 上会因为「相同 key 的行按 rowid 兜底」而**碰巧给对结果**，
于是坏实现能穿过大半测试 —— `session.test.ts` 把 fixture 的 `created_at` 刻意设成与插入顺序**逆序**，
就是为了杀掉它。也不用 `WITHOUT ROWID`：那会让行序变成 UUID 字典序，插入序直接消失。

顺序不是审美问题：`engine.ts:159-160` 的「助手这条必须先进 history，再排它的结果」是 OpenAI 与
Anthropic 配对 `tool_calls` ↔ `tool_result` 的前提。

### 三条实测出来的 API 形状，与通识相反

- `node:sqlite` **默认开启外键约束**（`enableForeignKeyConstraints` 的默认值是 true，v22.10 起），
  与 SQLite C 库的默认相反。所以 `ON DELETE CASCADE` 开箱可用 —— 但 `delete()` 仍然显式发两条
  DELETE 包在一个事务里，级联只当第二道保险：「删干净」不该寄托在某个库的默认值上。
- 绑参**拒绝 `undefined` 与 boolean**（`ERR_INVALID_ARG_TYPE`），`null` 可以。所以两个可选字段
  必须显式 `?? null`，而类型系统不会提醒（`string | undefined` 看起来完全正常）。
  `create()` 也因此显式校验 `title`：**STRICT 表会把整数 `123` 静默写成 `'123.0'`**，DDL 挡不住它。
- 查询返回的行**原型是 `null`**。直接 `as Message` 交出去，`JSON.stringify` 恰好正常
  （HTTP 面看不出任何问题），而 `deepStrictEqual` 会红 —— 最坏的一种假绿。所以每行都过
  `#toMessage()` 逐字段构造，顺带保证「列是 NULL 就**不带那个键**」而不是带一个 `null`
  （后者会让 `packages/shared` 的类型与 openapi 规格同时说谎）。
- `PRAGMA user_version = ?` 是语法错误：pragma 的值不是可绑定参数，只能 `db.exec()` 拼整数。

### `tool_calls` 是 JSON 文本列，不是子表

读路径永远是「整条消息 + 它的全部调用」，而配对这些调用是在内存里做的
（`engine.ts:229-241` 的 `#historyFor`），SQL 里从不按调用维度查。子表只能靠 JOIN 换回同一个
集合，却把「一条消息 + 两颗调用」变成 1+2 次 INSERT，任一步失败就留下「有调用没有消息」这种形状。
`arguments` 全程原样搬运、不解析（`registry.ts:97-105` 把「不是合法 JSON」当常态处理，
回喂 `isError` 而不是抛），所以落库的只是我们 `JSON.stringify` 出来的那层信封。

`role` 列**刻意没有 `CHECK`**：加了它，「上游打断留下的孤儿调用」就变成写库失败，
而那条半截历史是必须能读出来的运行期事实。

### 游标分页与那个最容易被写错的 +1

`GET /sessions` 与 `GET /sessions/:id` 都是 `limit`（默认 100、上限 500）+ `before`（不透明游标）。
游标是 `base64url(seq)`，不是裸数字：裸 seq 会把「内部用 `INTEGER PRIMARY KEY` 排序」写进 API 契约。
方向只有一个（更早），不引入 `after`，也不引入 `hasMore` 布尔 —— 同一件事写两个字段就会出现
「`hasMore: true` 而游标为 null」这种规格写得出来、代码难保证的组合。

SQL 取 `limit + 1` 条，第 limit+1 条只用来证明「还有更早的」。
**`nextCursor` 必须取响应里最旧那一行的 seq，而不是被丢掉那一行的** —— 后者会让下一页的
`seq < cursor` 正好跳过它，静默漏一条，症状是界面上「中间少一句」，不报错不重复。
唯一抓得住它的断言是「逐页拼接 == 全量」（`session.test.ts`），所以那条测试是先写的。

默认页是最新一批，但数组仍是插入序（旧→新）：**截断而不改序**。控制台不做二次排序，
把 DESC 直接吐出去会让列表整个反序，而那条既有事实不会报错、只会静默失效。
非法 `limit` / `before` 一律 400，不夹取也不当没传 —— 与 `maxToolSteps` 的「夹住 + warn」刻意相反：
那是用户手写的配置，写歪了不该让服务起不来；这是请求参数，夹取等于少给还不说。
校验排在资源查找之前：「未知 id + 非法 limit」应该回 400，回 404 等于用状态码泄露资源存在性。

`getWithMessages`（引擎专用）**不分页**：引擎要的是「一次问上游时的完整上下文」，
把分页塞进它意味着模型会忘记自己早先说过的话 —— 那是上下文窗口策略，不是存储的关切。
代价随之写明：一个几千条的会话，每轮都要一次全量 SELECT 加全量映射；真要治的是上下文裁剪，
那是另一件事，**不要**顺手在存储层裁（那会让「历史」在库里悄悄变短，比慢更难查）。

### 同会话串行为什么在引擎而不是存储层

一轮对话是「读全量历史 → await 上游几十秒 → 逐步 append」。同会话两个并发请求各自拿到的快照
都不含对方，落库后交错。内存版今天完全一样，持久化只是把「看起来怪」变成**永久记录**。

SQLite 能给的只有「两条 INSERT 串行」，缺的是「一整轮的读-改-写串行」；放存储层还会迫使
`appendMessage` 变 async，波及引擎与六个 handler。所以锁在 `AgentEngine.#running`（一个会话 id
的 `Set`），冲突抛 `ApiError(409)`，释放写在 `finally`（忘记释放的症状是「这个会话从此每次都 409」）。
流式端点额外用 `engine.isBusy()` 在**写 SSE 响应头之前**预检 —— 响应头一发出就只能靠事件报错，
409 的语义客户端再也拿不到（与「未知会话要在开流前 404」同一条约束）。预检与权威判定之间必然留
一个窗口，真撞上时以 error 帧出去，这条写在注释里而不是假装修掉了。

锁是**进程内**的：多进程各自有各自的 `Set`。所以部署上「一个数据目录只跑一个实例」
（README 的生产部署一节），跨进程的写竞争由 `timeout: 5000` + SQLite 文件锁兜住。

### 打开失败不降级

`openSessionDb` 失败即抛、启动即死，理由与 `config/file.ts` 的 `readConfigFile` 完全同构：
**把坏库当成空库，下一次写入就会在一个我们以为是空的库上写**。写方法的存储故障则细节只进日志、
对外一句固定中文 —— SQLite 的错误里带着库文件的绝对路径，不能原样回给客户端
（与 `list_plugins` 不外传 error 原文同条理由）。库文件权限 `0600`（照配置文件那套，Windows 上
静默忽略），理由不同但结论一样：配置文件是明文密钥，会话库是用户的对话内容。

### 迁移只有「末尾追加」这一条路

`PRAGMA user_version` 是 SQLite 内置的整数槽位，零依赖零新表；`MIGRATIONS` 数组**只增不改**。
改了历史条目意味着别人机器上那个「已经执行过旧条目」的库永远不会执行新条目，而 `user_version`
已经跳过去，症状是运行期某条 SQL 报 `no such column`，离根因极远。条目里不写 `IF NOT EXISTS`：
重复执行应当立刻报错 —— `CREATE TABLE IF NOT EXISTS` 一把梭最坏的地方正是「加列时它静默什么都不做」。
也不用 `package.json` 的版本号：app 版本会因无关改动 bump，schema 版本必须只跟 DDL 走。

**这件事没有任何检查守着**，只有 `db.ts` 顶注释那三条规矩 + 一条「第二次打开是 no-op」的测试。

## 鉴权设计

`AuthManager` 的分工是把「凭据」和「会话」两件事都关在一个类里：

- **凭据**：用户名与口令都用 `sha256` 摘要成定长 32 字节后再 `timingSafeEqual`，
  避免长度差异提前返回。用户名与口令**都**参与比对，用户名不存在时不短路，
  因此响应时间不泄露「这个账号是否存在」。失败一律返回同一句话。
- **会话**（这里指**登录会话**，即令牌；`core/session/` 的**对话会话**自本轮起持久化在 sqlite，
  两者不是一个东西，见[会话与消息的持久化](#会话与消息的持久化)）：
  令牌是随机 UUID，存在内存 `Map` 里，进程重启即全部失效。
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

## 工具（function calling）

`core/tool/` 是模型可以请求执行的**本地动作**。与 `core/provider/` 同一套三层拆分，
但**没有 `factory.ts`**：内置工具是代码而不是「配置 → 实例」，没有可装配的东西，
硬造一个 factory 只会得到一个没人读的文件。

```
types.ts     ToolDefinition（id / name / description / parameters / run）+ JsonSchema
registry.ts  ToolRegistry：存、取、按 id 执行转发 —— 不 import 具体工具，也不读配置
store.ts     ToolConfigStore：读写 atri.config.json 的 tools 段
builtins.ts  createBuiltinTools()：内置工具的清单，只有 app.ts import 它
builtins/    一颗工具一个文件（`currentTime.ts`），只导出自己那颗的 ToolDefinition
```

清单**直接 import 实现文件**，中间不放 `builtins/index.ts` 这类 re-export 层 ——
和 `factory.ts` 直接 import `./openai.ts` 是同一个理由：装配点只能有一处。多一处出口，
「写了工具文件但忘了登记进清单」就没人能发现：注册表只认注入进来的东西，
`openapi` 那三道检查也不看这里。

三条与既有习惯不同的决定：

- **默认关闭。** 判据是 `toggle?.enabled === true`，与 `adapters` 的
  `?.enabled !== false`（`adapters/manager.ts:55`、`:81`）**正好相反**。理由不是洁癖：
  适配器没写就启用，最坏结果是少听一个端口；工具没写就启用，最坏结果是**一次版本升级
  静默给模型新增了几件可做的事**。`atri.config.example.json` 里那条 `false` 就是这个语义的示例。
- **`enabled` 每次现读文件，不缓存在内存里。** `AppConfig` 是 `loadConfig()` 的一次性快照
  （`index.ts:9` 之后再没有重读点），而控制台的开关改的就是文件。所以 `GET /tools` 与
  引擎取启用集都走 `ToolConfigStore.#current()`，那里每次 `readConfigFile()` ——
  改完不需要重启，也不需要像 provider 那样重建注册表（注册表根本不知道启用状态）。
  抄 `AdapterManager.list()` 那种「从注入的快照算 enabled」会把这个 bug 一起抄过来。
- **参数 schema 只是搬运，不做校验。** 仓内没有 JSON Schema 校验器，也不该为了搬一个对象
  引入 `ajv`（依赖极简）。模型给的 `arguments` 只做 `JSON.parse`，逐键检查写在每颗工具
  自己的 `run()` 里 —— 与 `readJson()` 刻意返回 `Record<string, unknown>`（让 per-field
  `typeof` 成为编译期要求）是同一取向。

`ToolRegistry.run()` **从不抛错**：未知工具名、坏 JSON、handler 抛异常，一律变成
`isError: true` 的结果回喂模型。那是模型的一次可纠正回合（幻觉出一个工具名是常态），
抛出去会把整轮打成 400/500。provider 层的错误不经过这里，照旧抛。

### 工具怎么拿到别层的数据

`list_plugins` 要读插件清单，而数据源 `PluginManager.list()` 在 `plugins/` 下 ——
`core/` 不得 import `plugins/`，所以数据只能由组合根递进来
（`app.ts` 传 `{ listPlugins: () => plugins.list() }`）。两个具体选择：

- **收 getter 而不是数组。** 注册发生在 `plugins.loadAll()` 之前，插件又能在运行期被加载、
  重载、启停；传快照等于把工具冻在装配那一刻，之后一直报「当前没有安装任何插件」。
- **在 core 里重新声明窄形状 `PluginSummary`，而不是复用 `PluginView`。** import 那个类型
  本身就构成对 `plugins/` 的依赖；按「这颗工具实际读的四五个键」声明之后，`PluginView`
  作为超集可以直接赋值，不需要 `as`（`as` 只该出现在真边界上）。
  这条分层约束**没有任何检查守着**：oxlint 不解析模块路径，`tsc` 不看目录，只有 review 在看。

还有一条安全边界：工具结果会整段发给第三方 provider，所以 `list_plugins` 只报「上次加载失败」
这个事实，不外传 `error` 原文 —— 那串是**第三方文本**（动态 import 的报错、插件自己抛的错，
都可能带着文件系统路径）。失败原因是给操作者看的，控制台插件页已经在显示它。

### 两家的 function calling 报文不一样，所以映射各写一份

|            | OpenAI 兼容                                                                      | Anthropic                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 声明       | `tools: [{type:"function", function:{name, description, parameters}}]`           | `tools: [{name, description, input_schema}]`                                                                                  |
| 调用回来   | `message.tool_calls[]` / 流式 `delta.tool_calls[]`，`arguments` 是**被拆片的串** | `content[]` 里的 `tool_use` 块，`input` **已是对象**；流式时 id/name 在 `content_block_start`、参数按 `input_json_delta` 分片 |
| 结果回喂   | `role:"tool"` + `tool_call_id`                                                   | `user` 消息里的 `tool_result` 块                                                                                              |
| 助手那一轮 | 必须原样回带 `tool_calls`，正文为 `null`                                         | 必须回带 `tool_use` 块（与 text 块同消息）                                                                                    |

三处不显然、且都已写成规则的形状：

- **工具集为空时整个 `tools` 键都不发**（两家都是）。默认关闭的工具因此不在报文里留下任何痕迹，
  「启用前后逐字节相同」才可断言 —— 这是那条语义唯一的硬证明。
- **流式必须按 `index` / 内容块序号累加 `arguments`**，不能覆盖：一次响应可以并行要求调
  多个工具，分片交错到达。Anthropic 还要**先看 `delta.type`** 再决定这段是不是文本，
  否则 `{"time` 这种 JSON 碎片会被当成正文推给前端。
- **历史有两处会把工具字段抹掉**：`engine.ts` 组装 history 时、以及 `openai.ts` 映射
  messages 时，两处过去都只留 `role`/`content`，于是第二轮请求变成「有结果没有调用」。
  两处都得带上工具字段（provider 这一层已修，引擎那一层随多步循环一起改）。

`splitMessages` 的 `mergeAdjacent` 也修了一处既有缺陷：它过去只在**两侧都是纯文本**时合并相邻
同角色消息。模型一次并行调用两个工具时，回喂的两条 `role:"tool"` 消息是两条相邻 user 消息、
各自带一个 `tool_result` 块 —— 旧逻辑原样推出去，于是又被上游以
「messages: roles must alternate」拒掉，而这正是该函数存在的理由。现在块数组也合并
（两侧都是纯文本时仍拼成串，保持历史里普通消息的既有形状）。

`ToolCall.arguments` 与 Anthropic 的 `input` 之间靠一次序列化对齐：仓内统一用串
（OpenAI 给的就是串），回喂给 Anthropic 时再解回对象。解不回对象时退化成 `{}` 而**不抛错** ——
抛出去会把整轮变成 500，而此刻唯一确定的事实是「模型上一轮给了一个我们没法复现的参数串」。

### 循环：终止条件、上限，以及「未授权就不执行」

`#runLoop` 取代了原来的单次 `#runTurn`：每轮把回复落库，若它带着 `toolCalls` 就执行、
把结果推进历史、再问一次。`handleMessage` 的公开契约没变（仍返回最终那条助手消息），
所以两个端点与适配器都不用改。

- **终止只看 `toolCalls` 是否为空**，不看 `finish_reason` / `stop_reason`。
  兼容网关在这两个字段上的一致性太差（`provider/openai.ts` 早就在处理「网关把 error
  塞进 200 流」），而「有没有调用」是我们自己能数的事实。`stopReason` 仍然读出来放进
  `ChatReply`，但只作诊断。
- **只执行本轮真的声明过的工具。** 模型可以在没有任何工具被声明时硬吐一个 `tool_calls`
  （兼容网关与自训模型都会），那时引擎回一条「未授权执行」的结果而不执行它 ——
  否则就是「配置里关掉的开关被模型远程打开」。拒绝结果照样回喂，让模型有机会改用正常回答。
- **步数上限 `maxToolSteps`，默认 5。** 这个数字是本仓自选的，没有上游来源
  （理由与推导写在 `core/tool/store.ts` 的常量注释里，那里也是它唯一的定义处，
  `config.ts` 与测试 helper 都从它取）。非法值夹到 `[1, 50]` 并记一条 warn：
  这个数字写歪了不该让服务起不来，也不该被静默当成「没限制」。
  它是**顶层配置键**，不放进 `tools` 段 —— 那一段的键是工具 id。
- **一次运行内工具集固定**：循环开始前解析一次 `enabledIds()`，中途翻开关影响下一条消息，
  不影响在途这条。与 `ProviderRegistry.clear()` 的注释是同一条不变量。
- **中间消息有两条出口，语义不同。** WS 广播（`engine.subscribe`）看到全部四条消息；
  SSE 只额外看到**中间**那两条（用户消息是调用方自己发的，最终回复就是返回值）。
  这样「没启用工具时一帧都不多发」是可断言的。SSE 用的是 `StreamChunk` 已有的
  `message` 字段，没有新帧类型、也没有起 `event:` 名。
- **历史要做配对修复。** 被客户端断开或撞上限打断的那一轮，会留下「带 `toolCalls`
  但没有对应结果」的助手消息，两家上游都拒绝这种历史；`SessionManager.appendMessage`
  不做角色校验，所以兜底放在 `#historyFor`：那种助手消息退化成纯文本再发出去。
  **换成 sqlite 之后仍然不校验，`role` 列也刻意不加 `CHECK`** —— 加了就把「上游打断留下的
  半截一轮」变成写库失败，而那条历史必须能写进去、也必须能读出来（被中断的一轮原样保留，
  不做启动清理，见[会话与消息的持久化](#会话与消息的持久化)）。

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

### 插件之间能互相看到什么

`ctx.plugins()` 返回 `PluginInfo[]`，逐项由 `PluginManager.#peers()` **逐键拼出来**（不是
`...rec.meta`）：`id` / `name` / `version` / `description?` / `enabled`。少掉的两条是刻意的 ——
`dir` 是同伴插件的磁盘路径，`error` 是第三方文本（可能带着文件系统路径）。那两个键是给操作者
看的，走 `list()` → `GET /plugins`。上一次加载失败的那颗也在这里，只以 `enabled: false` 出现：
同伴需要知道的正是「别声称它的能力可用」，那一个布尔就够了。

为什么不复用给控制台的那份 `#view()`：它带着上面两个键。视图与「交给插件的形状」分家之后，
多给一个键必须在 `#peers()` 里显式写一行，而 `test/plugins.test.ts` 里那句**键集合相等**断言
会当场红（不是「不含 dir / error」那种缺席式断言 —— 后者对**新增**的键完全不红，
而 AGENTS.md 明令禁止用黑名单去列「不该看到的键」）—— 与下面的配置白名单是同一个套路：
**扩大插件的可见面要经过一次人的判断**，而不是靠 `...` 悄悄漏出去。

`plugins` 是**函数**而不是数组（`plugins: () => this.#peers()`）：`loadAll()` 按 `pluginDirs`
的顺序逐个 `await`，先加载的那个在自己的 `setup()` 里看同伴时，后面的还没进 `#records`；
`reload()` 与 `setEnabled()` 又会持续改变这份事实。传快照等于让每个插件都停留在
出生那一刻看到的插件表上。这与 `list_plugins` 那棵内置工具收访问器而不是数组是同一个理由。

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
拿着整份 `AppConfig`，读它的是仓内自己写的逻辑；而 `shared.config` / `ctx.config` 是框架**主动交到
用户手写的 `index.js` 手上**的那一份。所以这两处给的不是 `AppConfig`，而是 `pluginRuntimeConfig()`
投影出来的 `PluginRuntimeConfig`，目前只有 `pluginDirs` 一条键。

迁移时曾经是反过来的：`app.ts` 把整个 config 交给 `PluginManager`，而 `PluginManagerConfig`
声明成 `{ pluginDirs?: string[] }`。那是「类型比现实窄」——插件运行时想读什么就能读到什么
（`auth.adminPassword`、源的 `apiKey` 都在里面），窄标注只会让人误以为边界已经收住了。

三条不显然的决定（外加一条后来变硬了的）：

- **白名单，不是黑名单。** 秘密会换名字、会新增（下一版多个 `smtpPassword` 就再漏一次），
  而「插件需要哪几条键」是个能一次数清的问题。默认拒绝让新增必须经过人的判断，
  改动点写在 `plugins/manager.ts` 的类型上，并有对应测试。
- **投影发生在组合根。** `app.ts` 是唯一同时认识「完整配置」与「插件」两边的地方。
  决定放在那里，插件子系统就不知道自己被挡掉了什么，也不会哪天有人「顺手」把整个对象传进去。
- **视图里的数组是副本。** 共享同一个数组时，插件一次 `push` 就改到运行期配置本体，
  进而改变下一次扫描的目录。
- **`dataDir` 被排除的理由现在比其它键都硬**：会话与消息库 `sessions.sqlite` 就落在它下面
  （见[会话与消息的持久化](#会话与消息的持久化)），把 `dataDir` 交给任何一个插件等于把用户的
  **全部对话历史**递到磁盘上手写的 JS 手上。插件需要存东西时走 `ctx.dataDir`，
  那是 `<dataDir>/plugins/<自己的 id>`，由框架拼、由框架校验（见下一节）。
  所以「插件要一个数据目录」这件事**没有**变成白名单的新键 —— `dataRoot` 走的是
  `PluginManager` 的第三个构造参数，框架私有，不流到 `ctx.config` 也不流到 `shared.config`。

`test/plugin-config.test.ts` 钉住这条边界：真起一个 app，fixture 插件把 `shared.config` 的键与
`ctx.config` 的**整个对象**交回测试，`deepEqual` 连多出来的键一起报错；另有一句断言「口令与
apiKey 确实存在于交给 app 的配置里」，防止有人清空测试配置后守卫悄悄变成空话。

这不是沙箱。插件是**进程内**的任意 JS，真想读 `atri.config.json` 或 import 仓内模块，拦是拦不住的。
白名单收住的是「**框架主动把秘密递到插件手上**」这条默认路径 —— 插件由许多人写、由用户自行安装，
靠作者自觉不去读口令是不成立的；能成立的是框架本来就没给。

> 对照 AstrBot。以下按 **PyPI sdist `astrbot==4.28.2`** 的源码（GitHub 不可达时它是可靠来源），
> 文件与行号都按那个版本：
>
> - 它的「分开管理」做在**对外 HTTP 面**：内部 dashboard API 全量；对外的 Open API 由脚本按
>   `PUBLIC_OPEN_API_SCOPES` 白名单从全量 `openspec/openapi-v1.yaml` 派生，用 API key 鉴权，
>   并由 `tests/unit/test_openapi_scope_docs.py` 断言每个公开操作都声明了 `x-astrbot-scope`。
> - 它的**插件层没有这道投影**：`core_lifecycle.py:240-254` 把整份 `astrbot_config` 直接交给
>   `StarContext`（那里的注释就写着「初始化提供给插件的上下文」），`star/context.py:597-612`
>   的 `get_config()` 原样返回，没有字段过滤。
> - 于是插件能读到 `dashboard` 段（`core/config/default.py:237-263`）里的 `jwt_secret`
>   ——它由 `os.urandom(32)` 生成后**写回配置文件**（`dashboard/server.py:432-439`）——以及
>   `totp.secret` 和 `provider_sources` / `provider` 里的 `api_keys`
>   （`core/provider/manager.py:44-47` 读那两段，`provider/sources/openai_source.py:359`
>   把 `api_keys` 挂在实例上）。唯一拿不到的是**明文登录口令**：落盘的只有
>   `pbkdf2_password` 与 md5 哈希，首次启动生成的明文口令挂在 `AstrBotConfig` 的**对象属性**上
>   （`core/config/astrbot_config.py:113-128`；它是 `dict` 子类，属性不进 dict 所以不会被保存），
>   打印一次即丢。但 `jwt_secret` 比口令更直接：有它就能自签管理员令牌。
> - 更深的一层：AstrBot 的插件除了 config 还直接拿到 `provider_manager`（公开属性，
>   注释写作「模型提供商管理器」）与 `_db` 句柄，
>   所以在那种形状里「把 config 过滤掉」并不等于收住能力。**我们这条边界之所以成立，
>   是因为 `ctx` 给的全是「只看自己、不给了出口」的东西**：`logger`（写日志）、
>   `config`（白名单那一份）、`effect` / `subscribe`（把自己已经要做的清理交出来）、
>   `plugins()`（同伴的投影，逐键拼）、`dataDir`（**它自己**那一个数据目录的路径）。
>   没有 provider、没有数据库句柄、没有 HTTP 出口，也没有 `dataDir` 本体。
>   哪天要往 `ctx` 加这三样中的任何一样，白名单就不再是边界了，
>   那时该谈的是**能力授予**而不是字段遮蔽。
>
> 我们抄的是它「派生一个低信任面 + 用测试把关」的形状（边界写在数据里，不写在注释里），
> 而不是它插件层的宽松度。
> 若将来要支持在控制台里编辑某个插件的配置项（AstrBot 有这一层：插件用 `StarConfigMetadata`
> 声明自己的设置项，这一条来自它的文档站，我没在 4.28.2 的源码里逐处核对），
> 新增的应当是**该插件专属的一段**，而不是把 `AppConfig` 重新交出去。

### 插件数据：与代码分离，卸载不删

`ctx.dataDir` 给的是 `<config.dataDir>/plugins/<插件 id>`，首次访问时才创建（`0700`，幂等）。
它解决的是「插件没有地方放东西」：唯一的替代本来是插件自己那个目录，而那是**用户从上游拷来的
代码** —— 升级时整个被替换、想改名就改名，把数据写在那儿等于写在一条会被覆盖的路上。

四条决定，理由都不显然：

- **目录的键是 `id`，不是磁盘目录名。** 用户重命名插件目录、或把插件从 `./plugins` 挪进
  `./apps/server/plugins`，都是日常操作；键若用目录名，动一次就等于清空该插件的数据。
  代价是 `id` 由作者手写、可以写成 `../escape`，所以它必须过形状校验
  （`/^[a-z0-9][a-z0-9._-]{0,63}$/`；排除大写不是严格性偏好，是因为 `Foo` 与 `foo`
  在大小写不敏感的文件系统上撞同一个目录、在 Linux 上不撞，于是同一份数据在不同机器待在两处，
  而开发者在自己机器上看不见）。
- **校验落在 `load()`，不落在派生路径那一刻。** 这条反转过一次，两个方向的理由都记下来：
  原写法是「让加载成功、等插件真去要 `ctx.dataDir` 时才报错」，担心的是 id 拼错这种格式问题
  不该升级成全站故障。但那个担心已经被另一条改动取消了（`#scanDir` 逐条 try/catch，坏插件
  只把自己记成 `failed`），而不合规的 id 在那之前就已经流出去了：它进日志（含 `\n` 能伪造
  一整行）、进 `list_plugins` 给模型看的文本、进 `GET /plugins`。现在就剩一条规则：
  **不能让当不了目录名的 id 进入登记表**。`ctx.dataDir` 里那道校验保留 —— 它是
  `join(#dataRoot, id)` 之前的直接防线，而 `PluginContext` 的构造点不在框架的管辖里。
- **同一个 id 不允许被两个目录声明。** `id` 是 `ctx.dataDir` 的唯一坐标，两份插件声明同一个
  id 就意味着框架**主动**把前一份存着 token 的目录递给后一份 —— 那不是「插件自己找到了」，
  是信任边界上唯一一条被递出去的通路，所以直接拒绝（后登记的那条记为 `failed`）。
  判据包含被禁用与失败的记录，不只 `active`：那样「先到先得」是确定的，而「谁活着谁优先」
  会让同一对插件在重启后互换数据目录。
- **惰性创建。** 不调用这个 getter 就一次 `mkdir` 都不发生：启动不因此多碰盘。
  测试把两面都钉住（「访问过所以建了」与「没访问所以没建」）。
- **给路径，不给读写访问器。** `ctx.readData()/writeData()` 那种形状要框架替所有插件决定
  「一个文件还是多个、什么格式、要不要原子写」，表面会跟着每种需求长一次；给一个目录就够了，
  插件想用 json、sqlite 还是别的，是它的事。

**登记表的键是目录，不是 id。** 这条与上面「数据目录的键是 id」刻意相反，因为它们是两件事：
前者问「这个槽位是谁」，后者问「这个插件的数据存哪儿」。以自报 id 做槽位键时，
一次坏加载就能顶掉**另一个目录里那份健康**的实例（旧 `load()` 的同 id 预 teardown 就是这个行为），
而加载完全可以在拿到 id 之前就失败（`index.js` 求值就炸、导出的对象没有 id）—— 那时没有 id 可用作键。
所以槽位键是 `resolve()` 之后的绝对目录，对外的 id 是 `meta.id`，由 `#find()` 线性反查；
「拿到 id 之前就失败」的那条记录用目录名顶上，因为线协议里没有「没有 id」这个表达。

**加载失败是一条记录，不是一次启动故障。** `#scanDir` **逐条** try/catch（包整圈循环或包在
`loadAll()` 外面都不行：那会把「一个坏了」变成「它后面那些根本没被看过」），`load()` 在抛出之前
先把这一颗写成 `failed` 记录再原样重抛 —— 一处更新状态，异常交给两个方向不同的消费者：
启动侧吞掉继续扫，`reload()` 与 `POST /plugins/:id/reload` 的调用方照旧拿到原因。
没有选「给 `load()` 加一个安静模式参数」：一个函数两种形状，正是这条注释要预防的那种走散。

**框架从不删它。** `unload` / `reload` / `setEnabled(false)` / `unloadAll` / `stop()` 都不碰这个
目录 —— 整个 `apps/server/src` 里没有任何删除文件的调用，而这条从今天起是**契约而不是巧合**
（`plugins.test.ts` 里「卸载与换目录都不丢数据」那条断言会拦住以后任何人加删除）。
也不提供 `purgeData` 之类的参数：那会成为第一个由 API 触发的不可逆删除，而且与「插件目录同样
归用户所有、框架从不删」这条一致性冲突。清理是操作者自己 `rm -rf data/plugins/<id>` 的事。

`GET /plugins` 与 `PluginInfo` 一个字段都没加。`PluginInfo` 同时被 `#view()`（给控制台）和
`#peers()`（给插件）复用，往里加数据目录就等于再多一处「靠人记得不给」的投影 —— 而控制台
要显示路径的话，它已经有 `dir`（目录名）可以辨认了。

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

会话库排在 `app.stop()` 的**最后**关：`http.close()` 先掐掉在途 SSE 与 WS，那一刻之后不应再有
新的写库请求；而插件的 `teardown` 理论上也可能触发写（今天 `ctx` 里没有会话句柄，排在它后面
才对未来也成立）。`close()` 幂等 —— 信号处理与 `t.after` 可能各关一次。
**不做显式 `wal_checkpoint`**：`db.close()` 作为最后一个连接时 SQLite 会自动回收 WAL，
而显式 checkpoint 在别的进程持读锁时会返回 busy，那才是能把关停卡住的东西
（`stream.test.ts` 里「关停不被在途流拖住（<3s）」那条预算就是靠这两点保住的）。

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
