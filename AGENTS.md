# AGENTS.md

给在本仓工作的 agent 的规范。这里的每条约束都对应一次真实的踩坑或一次刻意的取舍，
**不是通用最佳实践**。与本仓相关的一切都用中文书写（注释、日志、错误消息、文档、提交信息）。

产品说明与用户向文档在 [`README.md`](./README.md)，设计取舍在 [`docs/architecture.md`](./docs/architecture.md)。
本文只写「怎么在这里干活」。

## 仓库形态

pnpm monorepo，三个包：`apps/server`（agent 引擎 + API）、`apps/dashboard`（Vue 3 控制台）、
`packages/shared`（两个 app 共享的类型、常量、线协议）。

- Node `>=22.18.0`；pnpm 由根 `package.json` 的 `packageManager` 字段固定，**不要用别的包管理器**。
  下限卡在 22.18 是因为它是「TypeScript 类型擦除默认开启」的那个版本（2025-07-31，LTS Jod）——
  本仓**不编译、不装 tsx**，`dev`/`start`/`test` 都直接跑 `.ts` 源码，靠的正是这个默认开启的擦除。
  `.npmrc` 里 `engine-strict=true` 让这条下限有牙齿：Node 20 上 `pnpm install` 会直接失败，
  这比让人跑到一半撞见语法错误好。`@types/node` 的主版本必须跟这条保持一致。
- `apps/server` 是 **TypeScript**，`noEmit` 只做类型检查（不产出 `dist`，也没有任何 `.d.ts` 消费者）。
  `verbatimModuleSyntax` + `strict` + `noUncheckedIndexedAccess` 全开，类型标注就是运行时契约的一部分。
- **依赖极简是刻意维护的属性**。服务端的外部运行时依赖只有 `ws` 一个
  （`dependencies` 里另一条 `@atri/shared` 是 workspace 内部包，不算外部依赖）。
  加依赖前先确认没有几十行手写就能解决的问题，并说明为什么必须引入。
  纯类型的 devDependency（如 `@types/ws`）不在这条约束内 —— 它不进 `dependencies`、
  不改变运行时足迹，但同样要少：`ws` 自己不产出类型声明，没有它 `import { WebSocketServer }`
  就是 `TS7016`。也**不要**为「类型太严」去写手工的模块声明，那份假声明比不写更坏。
- **`node:*` 内置模块不算外部依赖**（会话与消息的存储用的就是 `node:sqlite`）。
  引它的前提是 `engines.node >= 22.18.0` 已经落在**免旗标区间**里 —— `node:sqlite` 从
  v22.13.0 / v23.4.0 起不再需要 `--experimental-sqlite`。任何「需要给 node 加旗标才能用」的
  方案都不能进本仓：`dev`/`start`/`test` 三条脚本都是裸跑 `.ts`，加旗标等于同时改三条脚本
  与所有文档里的启动方式。

## 上手

```bash
pnpm install
pnpm --filter @atri/shared build   # 必须。shared 的 dist 不入库，没有它另外两个包的类型解析会全红
```

`packages/shared` 的 `dist/` 被 `.gitignore` 忽略但在 `main`/`types` 里被引用。
**干净检出后第一件事就是构建它**，否则 `pnpm typecheck` 会给出几百条找不到模块的报错，看起来像仓库坏了。

启动：`pnpm dev`（服务端，127.0.0.1:6185）+ `pnpm dev:dashboard`（控制台，127.0.0.1:5173）。
控制台把 `/api`、`/ws` 代理到服务端，**两者要同时开**。
只跑一个进程时先 `pnpm build`，服务端会托管 `apps/dashboard/dist` 并做 SPA 回退。

首次启动服务端会生成管理员口令、写进 `atri.config.json` 并**打印一次**；那是拿到初始口令的唯一途径。

## 命令

| 命令                           | 说明                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm check`                   | **提交前必须跑**：typecheck → lint → format:check → static:check → codegen:check → test                   |
| `pnpm static:check`            | 四道「编译器与测试都看不见」的检查：分层方向 + 说明符写法、按行号的交叉引用、内置工具登记、主题键名存在性 |
| `pnpm lint` / `lint:fix`       | `oxlint --deny-warnings .` / `oxlint --fix .`                                                             |
| `pnpm format` / `format:check` | oxfmt 改写 / 只校验                                                                                       |
| `pnpm codegen`                 | 按 `apps/server/openapi.json` 重新生成前端 SDK                                                            |
| `pnpm test`                    | 全部包；服务端是 `node --test "test/**/*.test.ts"`                                                        |
| `pnpm build`                   | `packages/shared` + `apps/dashboard`（服务端不产出构建物）                                                |
| `pnpm start`                   | 起服务端（= `pnpm --filter @atri/server start`）                                                          |

四条容易踩的规则：

- **仓库没有 CI**，`pnpm check` 没人替你跑。**你就是 CI**——没跑过就不要说「改好了」。
- `static:check` 的四道检查都只认**结构性事实**（谁 import 谁、注释里的行号形态、文件与清单是否
  一一对应、主题覆盖的键名在不在 naive-ui 运行时的变量表里）。它们各自都带一条「防空跑」断言：本仓初版的两条检查把 `fileURLToPath` 返回的
  尾斜杠算进了字符串切片，于是遍历到 0 个文件却打印「通过」。**写检查的人必须试着让该检查变红一次**，
  这条判据对 `pnpm check` 里的任何一项都成立。
- `pnpm lint` 带 `--deny-warnings`，**告警即失败**。而 `oxlint` 单独运行时仅有 warning 会退出 0，
  直接跑 `oxlint` 看到 0 退出码就以为通过了是错的，用 `pnpm lint`。
- `codegen:check` 用 `git status --porcelain` 判断生成物漂移，**改了接口就必须先 commit 生成物**。
  顺序反了会看到一条误导性的 `A ` 红灯（它其实是「你还没提交新增的生成文件」）。

## 分层（硬约束）

```
api/ ─────┐
adapters/ ┴─> core/ ─> (无)
plugins/  ─> 只依赖注入给它的 ctx
config/   ── 与 core/ 双向（按文件看没有环）
```

- **`core/` 不得 import `api/`、`adapters/`、`plugins/` 里的任何东西。**
- `config/` 与 `core/` 互相依赖是既成事实，别把它当违规：`core/` 里要读-改-写配置文件的模块
  依赖 `config/file.ts`，而 `config/file.ts` 与 `config/profiles.ts` 只为 `errorMessage` /
  `ApiError` 依赖 `core/errors.ts` —— 两条边落在**不同文件**上，所以没有循环依赖。
  要按目录做机械检查时，判据必须是
  「同一对目录只允许一个方向」而不是「不允许双向」。原理见 architecture.md 的依赖方向一节。
- **除测试外没有任何模块 import `api/`**。传输层是最外层、可整体替换（换 gRPC / CLI 不碰业务逻辑）。
  测试是唯一的例外，而且是刻意的：`resolveStaticPath`（目录穿越那道 403）与 `Router`
  要能被直接单测，architecture.md 里「导出它以便测试」就是这条许可的来源；
  把规则写成绝对的一句，会让那三个 import 看起来像违规 —— 它确实曾经是（那句话与仓内事实不符）。
- `app.ts` 是**唯一**的组合根。装配只在那一处发生；其余模块不知道别人是谁。
  组合根（`src/` 根下的 `app.ts` / `index.ts`）**不许被任何模块 import**：它认识每一层，
  `core/` 只要 import 它一次，「core 不依赖上层」就在**传递依赖**上失效，而逐条 import
  看起来都合规。这一条现在有机械检查守（`scripts/check-layering.mjs`）。
- **`src/` 下新增顶层目录必须先在 `check-layering.mjs` 的 `ALLOWED` 里登记方向**，否则检查
  直接红 —— 不在表里的目录是违规，不是豁免。初版把它当成「不归我管」放过去，于是新目录可以
  自由 import 任何上层而全绿，那条硬约束的实际守法就变成了「没人加过新目录」。
- **`plugins/` 读 `config/` 只许 `import type`**。需要那一层的**实现**时由组合根注入 ——
  `persistEnabled`（启用状态写回）与 `ensurePrivateDir`（建插件数据目录）都是这个形状。
  判据不是风格：会 `mkdir` / `chmod` 的函数与 `ApiError` 那种纯工具叶子不是一类东西。
- 依赖一律走**构造参数**。不要引入全局单例、模块级可变状态、或「import 一下就自动注册」的副作用。
  这条是测试能直接 `createApp(config)` 起真服务、而不必 mock 掉半个世界的原因。
- 每个模块往里收一层：`index.ts` 薄入口 → `app.ts` 装配 → `core/` 逻辑 → `api/` 传输。

新增能力时的落点：入站适配 → `adapters/`（OneBot 11 共用 `adapters/onebot11.ts`，
消息类继承 `MessageAdapter`）；出站模型 → `core/provider/factory.ts` 的 `TYPES` 表；
工具能力 → `core/tool/`（注册表不 import 具体工具、也不读配置，内置工具由组合根注册；
工具需要别层的数据时**由组合根注入访问器**，不要在 `core/tool/` 里 import 那一层）；
业务逻辑 → `core/`；HTTP 表面 → `api/server.ts` + `openapi.json`。

**内置工具一颗一个文件**：`core/tool/builtins/<id>.ts` 只导出自己那颗的 `ToolDefinition`，
`core/tool/builtins.ts` 逐颗 import 并组成清单 —— 对照 `provider/` 那边
（`openai.ts` / `anthropic.ts` 各一份实现，`factory.ts` 负责挑）。**不要**加
`builtins/index.ts` 这类 re-export 中间层：清单是唯一的装配点，多一处出口就会变成
「改了工具文件但忘了登记」，而登记与否没有任何检查在守（注册表按注入的东西说话）。

**系统内省工具走内置插件，不走用户工具开关**：`apps/server/plugins/system/index.js`
声明 `tools(ctx)`，`list_plugins` 标 `internal: true`。`PluginManager.tools()` 作为
`ToolRegistry` 的动态来源，插件加载/卸载/重载时自动进退；`internal` 工具由引擎始终
声明，但不进 `GET /tools`、`ProfileConfig.tools` 与配置页。不要把它加回
`core/tool/builtins/`，也不要为它新增一个用户可见的开关。插件工具 id 必须唯一，
跨插件冲突在 `PluginManager.load()` 里直接拒绝。

### 信任边界只有一条：插件

`api/` / `core/` / `adapters/` 都是仓内代码，读配置的是我们自己写的逻辑；
**插件是磁盘上用户手写的 `index.js`**，`shared.config` 与 `ctx.config` 是框架主动交到它手上的东西。

- 交给插件的配置必须经 `plugins/manager.ts` 的 `pluginRuntimeConfig()` 投影，
  在 `app.ts` 装配处完成，**不要把 `config` 整个传过去**。
  （这不是沙箱：进程内的任意 JS 总能自己去读 `atri.config.json`；白名单收住的是
  「框架主动把秘密递到插件手上」这条默认路径。原理写在 architecture.md。）
- 那是**白名单**：新增可见键要同时改类型与 `test/plugin-config.test.ts` 里的键集合断言，
  让「插件能多看到一条」必须经过一次人的判断。不要用黑名单去列「不该看到的键」——
  秘密会换名字、会新增，黑名单每一次都迟到。
- **`ctx` 交出去的东西按同一条规矩办**。`ctx.plugins()` 返回 `PluginManager.#peers()` 逐键拼出的
  `PluginInfo`，不含同伴的 `dir` 与 `error`（后者可能带着 `resolve()` 之后的绝对路径）；
  `ctx.adapters()` 只返回绑定到本档的 `id/name/type/running`，`ctx.callAction()` 由组合根
  注入的端口执行并校验配置档边界 —— 插件不能借它操作别的档，也拿不到适配器的 token/目录；
  要扩大它就是「在 `#peers()` 里显式加一行 + 同步 `test/plugins.test.ts` 那句不该有 dir/error/dataDir」，
  而不是把 `#view()` 那份给控制台的形状直接递给插件。
  `ctx.dataDir` 是这条规矩的一个样本：它给的是
  `<dataDir>/profiles/<配置档 id>/plugins/<自己的 id>`，
  由框架拼、由框架校验、由框架私有参数（`PluginStorage`，**不进白名单**）注入 ——
  插件要一个地方存东西，不等于它该看见 `dataDir` 本体（那下面躺着 `sessions.sqlite`）。
  而 `ctx.config.pluginDirs` 仍是**部署级那一份**（插件全局安装，每档只决定开不开）：
  这条键的**值没有**跟着配置档变，所以 `test/plugin-config.test.ts` 的键集合断言之外，
  `test/plugins.test.ts` 还钉了一句「两个管理器的 `pluginDirs` 逐元素相等」。
  要往 profile 里加「每档私有安装目录」这类键之前，先读 architecture.md 的插件一节：
  它被否过一次，理由是安装是文件系统动作，多配置档同步不了它。
- **用户为插件填的值走 `ctx.pluginConfig`，不并进 `ctx.config`。** 插件目录里的
  `_conf_schema.json` 声明可配置项（`string` / `text` / `int` / `float` / `bool` /
  `select`），值写在 `<dataDir>/profiles/<配置档 id>/plugins/<插件 id>/config.json`
  —— 每档一份，目录 `0700`、文件 `0600`。`config.json` 是插件数据目录里的**保留文件名**：
  框架会读-改-写它，插件自己存东西要换一个名字。保存后 active / failed 的插件自动重载，
  禁用中的只落盘；schema 坏了不影响插件运行，只让表单不可用（`schemaError`）。
  这条与「交给插件的配置必须投影」是两件事：`pluginConfig` 是用户数据，不是
  `AppConfig` 的视图，所以它不该出现在 `test/plugin-config.test.ts` 的键集合里。
- 窄的类型标注**不等于**窄的现实。上面那条「构造参数只声明自己读写的键」只解决强度问题；
  对象真的传出去时，现实由运行时那个对象决定（这里曾经就是这么漏的：类型写的是
  `{ pluginDirs?: string[] }`，运行时交到插件手上的是整个 `AppConfig`）。

### 命名上不要混用三个词

**adapter** 是入站接入（QQ、Discord、webhook…），契约是长驻的 `start()`/`stop()`；
**provider** 是出站模型调用，契约是每请求的 `chat()`；
**tool** 是模型请求、本地执行、结果回喂的一次性动作，契约是 `run()`。
三者形状不同，故意不用同一个词。也不要新造「model adapter」「function tool」之类的混合称呼。

**「会话」在本仓有两个词义，别从一条推出另一条**：`core/auth/` 的**登录会话**（令牌，
刻意存在内存、重启即失效）与 `core/session/` 的**对话会话**（消息历史，落在
`dataDir` 下的 sqlite、重启不丢）。写文档与注释时要么说全，要么换新词 ——
architecture.md 与 README 里各有一句「重启即全部失效」只在前一个意义上成立，
读的人若不确定，就会得出「对话历史会丢」这个错结论。

### 适配器

- 入站平台只住在 `adapters/`，`core/` 不知道任何平台。消息类适配器继承
  `adapters/message.ts` 的 `MessageAdapter`，只实现 `start()` / `stop()` / `sendText()`
  与平台事件解析；按外部会话串行、找/建内部会话、群聊发送人前缀、长回复切块与错误兜底
  都在基类里。不要把某一家的消息格式或重连策略塞进 `core/`。
- **实例管理是运行期的，不是让用户改 JSON**：`adapters/templates.ts` 声明类型与表单字段，
  `AdapterConfigStore` 写 `data/adapters.json`（`data/` 下，0600），`AdapterManager`
  管新增/编辑/删除/启停；控制台的「接入平台」页是唯一写入口。旧版 `atri.config.json`
  的 `adapters` 段只在运行期文件不存在时迁移一次，之后不再生效。
- 外部会话 → 内部会话的映射由 `JsonConversationSessions` 落盘到
  `data/adapters/<适配器 id>/sessions.json`（键含 profile id；目录 `0700`、文件 `0600`；
  坏文件从空表开始）。不要改成「每条消息新建会话」，也不要把它塞进 `core/session`：
  这是平台坐标到内部 UUID 的映射，不是消息历史的一部分。
- **准入控制在 `MessageAdapter.receive()` 里统一做**，不要下沉到某一家的适配器：
  白名单按平台坐标（私聊发送人 / 群 id）判断，管理员始终越过白名单。规则属于**配置档**
  （`data/profiles/<id>/config.json` 的 `access` 段），适配器通过注入的 `resolveAccess()`
  每条消息现读，保存档后立即生效、不重启长连接。被挡下的消息只记事件键与发送人，不记正文。
  两个不同平台绑到同一档会共用一张名单；需要隔离就绑到不同档。
- 群聊内容带 `[群名片或昵称]` 前缀，私聊不带；机器人自己的消息必须忽略。
  平台侧错误原文、堆栈与绝对路径只进服务端日志，用户只收到固定中文提示。
- 接收/回复事件用统一日志标签记录：
  `[<适配器 id>:<privateMessage|groupMessage>:<会话 id>]: <内容>` 与
  `发送[<...>]:<内容>`；第一段是实例 id（如 `napcat`），不是配置档 id。
  群聊内容带发送人前缀；发送人 id/message_id 与回复摘要只在 debug 写。
  平台昵称与内容里的换行必须收成空格，否则用户可伪造日志行。
- **OneBot 11 的协议层是共享的**：`adapters/onebot11.ts` 负责消息段解析、图片下载、
  action 请求/响应与登录信息；`adapters/napcat.ts` 只实现反向 WS 监听，`adapters/snowluma.ts`
  只实现正向 WS 客户端与重连。新增 OneBot 11 实现时不要再复制一份段解析；平台差异
  放进各自的类与模板，不要进 `core/`。
- NapCat 走 OneBot 11 **反向 WebSocket**：atri-bot 监听 `host:port/path`，NapCat 作为
  WebSocket 客户端连入；token 用 `Authorization: Bearer` 或 `?access_token=` 校验，
  **不打印 token**。客户端断开后由 NapCat 自己重连，监听不关。
  SnowLuma 走**正向 WebSocket**：atri-bot 连它，token 以 `Authorization: Bearer` 发送
  （可留空），断开后按固定间隔重连。
  入站图片会优先按 `url` 下载、失败再用 `get_image` 刷新，成功则转 base64 随
  `Message.images` 落库；单张 4 MiB、单条最多 4 张，失败/超限退回 `[图片]` 占位。
  provider 各自把 `images` 翻成自己的多模态内容块（OpenAI `image_url`、Anthropic
  base64 `image`）。不做图片上传与请求处理；协议细节见 `adapters/onebot11.ts`、
  `adapters/napcat.ts`、`adapters/snowluma.ts` 与 architecture.md。
- **`call_action` 是逃生口，不是核心 API**：`Adapter.callAction()` 与
  `AdapterManager.callAction()` 把原始 action 原样转发；HTTP 入口是
  `POST /adapters/{id}/action`，插件入口是 `ctx.callAction()`。不要为每个平台动作
  在 core 里加一个 if 分支；先走 call_action 验证，确有稳定语义再包装成工具/端点。
  参数与错误要设上限，且错误文本不得回显 token/apiKey。

### 人格、访问控制与计划任务

- 人格是**全局资源**（`data/personas.json`），配置档只存 `personaId`。提示词作为
  **每轮请求的 system 消息**注入，不写进会话历史；组合根在保存后同步到运行中的引擎。
  不要改成「保存时把人格复制进档文件」或「把 system 消息落库」—— 前者会产生漂移副本，
  后者会在历史详情里出现一条假消息。
- 白名单与管理员**属于配置档**：一份档一张名单，绑定到这一档的适配器共用它。
  不要改成部署级全局一份 —— 换档就换名单是用户要的差异化；平台坐标提醒写在
  `AccessPanel` 的说明里：需要隔离时把不同平台绑到不同档。
- 计划任务是部署级资源（`data/cron.json`），任务自己保存 `profile` 与 `sessionId`。
  `core/cron/cron.ts` 是 5 段 cron 解析器（不引依赖），`manager.ts` 通过注入的
  `resolveEngine(profileId)` 执行，所以任务的模型、人格与工具和手动发消息同源。
  调度按服务器本地时区、最小粒度分钟，启动时不补跑过去；结果只写任务自己的会话，
  **不要偷偷主动发到平台**（寻址与权限另算）。
- 控制台主导航按「运行 / 个性化配置 / 接入与扩展 / 系统」分组（对齐 AstrBot）：
  个性化配置 = 配置文件 / 人格配置 / 插件；系统 = 计划任务 / 日志。
  **配置文件页只放本档的五类**（默认模型 / 人格 / 工具 / 运行参数 / 访问控制），
  都走草稿 + 保存。人格库与计划任务是部署级资源，各自是独立整页（`/personas` 与
  `/cron`），不要拆回配置文件页的分类 —— 它们不跟随 URL 上的档名。供应商、接入平台与
  日志也是标 `noProfile` 的独立整页，插件页按档独立一页：它们改的是外部连接、第三方
  代码或进程输出，不是「这一档怎么跑」。

## 代码风格

由 `.oxfmtrc.json` 与 `.oxlintrc.json` 强制，`pnpm format` 会全部改好。人的部分：

- **双引号**、100 列、分号、尾逗号 `all`、2 空格。`sortPackageJson: true` 会重排 `package.json` 的键。
- `import type` 必须显式（`verbatimModuleSyntax`），否则运行时 import 一个不存在的绑定。
- **相对 import 的扩展名两个包不一样，别「统一」它**：`apps/server` 写 `from "./x.ts"`，
  `packages/shared` 写 `from "./types.js"`。判据只有一条 —— **这个包会不会被 node 直接执行源码**。
  服务端会（靠类型擦除，而擦除不改写 import 说明符，写 `.js` 就解析不到文件）；
  shared 不会（它先 `tsc` 出 `dist`，那边只认 `.js`）。另外服务端只允许**可擦除**的 TS 语法
  （`erasableSyntaxOnly: true`）：`enum`、有运行时语义的 `namespace`、构造函数参数属性
  都会被类型检查直接拒绝 —— 它们不是风格偏好，是「运行时跑不起来」的分界线。
- **需要向上跳（`../`）的 import 用 `#` 别名，同目录与向下进子目录仍写 `./x.ts`**。别名表在
  `apps/server/package.json` 的 `imports: { "#*": "./src/*" }`，于是 `#core/errors.ts` 就是
  `src/core/errors.ts`。向下不改（`app.ts` 的 `./core/logger.ts` 照旧）不是因为省事，而是因为
  **`#` 只覆盖 `src/`**：`test/` 自己的 `./helpers/config.ts` 没有对应别名（`#helpers/...` 会指到
  `src/helpers`），与其两边形状不一样，不如把别名限定在「向上跳」这一种真正会绕晕人的方向上。
  两个看起来更自然的选择都被实测否掉：`tsconfig.json` 的 `paths`（`@/*`）**只骗得过 `tsc`** ——
  Node 不读 tsconfig，擦除又不改写说明符，结果是「typecheck 全绿、运行时 `ERR_MODULE_NOT_FOUND`」；
  带斜杠的键 `"#/*"` **Node 能解析、`tsc` 不能**（整树 TS2307）。`imports` 的解析由 Node 自己完成，
  所以它是**服从**上面那条判据（说明符必须由 Node 能解析），而不是绕开它。
  两个边界别越过：`packages/shared` **不得**加 `imports`（它的 `exports` 与 `files` 都指 `dist/`，
  再配一份指向 `src/` 的映射会让 dashboard 走 `dist`、shared 内部走 `src`，同一常量解析出两份副本）；
  `fileURLToPath(new URL("../openapi.json", import.meta.url))` 这类**URL 解析**不归别名管，
  也永远不能写成 `#` —— `#` 在 URL 里是片段分隔符，会静默得到错路径而不报错。
- 类型标注不许「替测试降强度」：各模块的构造参数声明**自己实际读写的那几个配置键**
  （`ProviderStoreConfig { filePath: string | null }` 这种），而不是收一个 `Partial<AppConfig>` 或
  拿 `as unknown as AppConfig` 糊过去。前者让 `config.filePath` 之类必然存在的读取也变成可选、
  把 `?? undefined` 一路传染下去；后者是把 `noUncheckedIndexedAccess` 的好处整个丢掉。
  **必填不代表「调用方必须传真值」**：那个 `| null` 恰恰是它必填的理由 —— 可选参数让「漏传」
  和「故意只读」长得一模一样，而漏传的后果是「服务照跑、任何保存都失败」，
  失败信息还写着「没有落盘位置」，读的人会以为是自己没配好。
  `as` 只用在真边界上（`JSON.parse`、`response.json()`、动态 import 的插件模块、
  配置文件读回来的顶层对象），并且必须写清「为什么这里只能是这个形状」。
  **但这条只适用于仓内代码**：窄标注只是强度问题，不改变运行时那个对象。配置真要交到插件手上时，
  得在装配处投影出实际可见的那一份（见上面「信任边界只有一条：插件」）。
- 数组排序/反转用 `toSorted()` / `toReversed()`，不要 `sort()` / `reverse()`
  （`unicorn(no-array-sort)`：后两者原地修改数组）。
- 包装捕获到的错误时**带上 cause**，否则堆栈里丢了原始错误，排查变成猜：

  ```ts
  throw new Error(`解析 ${filePath} 失败: ${errorMessage(err)}`, { cause: err });
  ```

  （`err` 是 `unknown`，所以不能直接写 `err.message` —— 走 `core/errors.ts` 的
  `errorMessage`/`errorStack`，别在每处 catch 里各写一遍三元。）

- `oxlint` 的 `plugins` 字段**会覆盖默认插件集**，想用的必须全部列出（当前 unicorn / oxc / typescript / vue）。
- 仓内目前**零** `oxlint-disable` / `oxfmt-ignore` 注释。不要靠抑制让 `pnpm check` 变绿；
  真需要时在提交信息里说明理由。唯一例外是自动生成的 `auto-imports.d.ts` / `components.d.ts`（已 gitignore）。

### 注释写「为什么」

这是本仓最重要的一条风格约定。注释解释**为何这样写、否定了哪些替代方案**，
而不是复述代码在做什么。数值、时长、超时都要带来源（设计稿 / 上游实现 / 实测）。

```ts
// 好：n-dropdown 的触发元素是默认插槽，写成 #trigger 会让整个按钮不渲染
//     （源码 Dropdown.mjs 里 trigger: normalizeSlot(() => this.$slots.default?.())）。

// 差：设置 dropdown 的 trigger。
```

被否定的方案要留下痕迹——否则下一个人会把已经踩过的坑再踩一次。
引用别的代码时**写符号名而不是行号**（`AgentEngine.#historyFor`、`AdapterManager.startAll`、
`loadConfig()`），不要写「文件名 + `:` + 行号」那种形态（形如 `engine.ts:NN`，别照抄这个例子）。
理由不是审美：一次 +70 行的改动会让它们全部指错，而指错的引用**比不写更坏** ——
它会被当成事实读，且没有任何编译器或测试会告诉你它断了。
这一条由 `pnpm check` 里的 `scripts/check-refs.mjs` 守着（仓内一旦出现那种形态就红）。
如果某处写法看起来多余或奇怪，它**几乎一定是有原因的**：先读注释和 `git log`，不要先动手「简化」。

用户可见的字符串（HTTP 错误、日志、UI 文案）一律中文。
口令、密钥、令牌**永不写进日志或响应体**。

## 测试

用内置 `node:test` + `node:assert/strict`，**不引入测试框架**。测试放在 `apps/server/test/*.test.ts`。

测试也在 `tsconfig.json` 的 `include` 里，因此 `pnpm typecheck` **会**检查测试 —— 这从 JS 时代起
就是新增的严格度。`test/helpers/config.ts` 的 `makeTestConfig()` 存在的唯一理由是：迁移前
六个测试各抄了一份几乎相同的 config（只差 `providers`/`staticDir`/口令），而 `AppConfig`
的必填键要求它们逐字补全，抄六遍不如收成一处；它**不替**任何测试补它今天没有生效的键，
需要偏离默认就显式传参，让差异留在 diff 里看得见。除此之外测试文件之间不共享 helper：
`startApp`/`login`/`call` 这些桩照旧各写一份（本仓的既有风格，比提前抽象好）。

```js
test("...", async (t) => {
  const app = await createApp(config); // createApp 是 async
  await app.start();
  t.after(() => app.stop()); // 清理挂在 t 上
});
```

- **`port: 0` + `app.address().port`**，避免测试之间抢端口。
- 临时目录用 `mkdtempSync(join(tmpdir(), "atri-..."))` 配 `t.after(() => rmSync(root, { recursive: true, force: true }))`。
- ⚠️ **不要删掉看起来「未使用」的 `t` 参数**。它被 `t.after` 当清理钩子用，
  曾经为了消一条「未使用变量」把 `t` 删掉，导致桩上游泄漏、整个测试文件挂到超时。
  静态分析看不到 `t` 被谁用，这里要按运行时判断。
- **时间相关的逻辑注入假时钟**（`new AuthManager(config, logger, { now })`），把时间真正往前拨。
  回拨内部字段只能证明「字段被读了」，证明不了「时间到了就失效」。
- 依赖构建产物的测试用 `{ skip: 条件 }` 跳过而不是失败，否则干净检出上 `pnpm test` 会红，测试就不再是可信信号。
- 一个文件里的桩上游必须在 `t.after` 里关掉，否则 node:test 不会退出。

### 前端没有测试

`apps/dashboard` 的 `test` 脚本只是 `vue-tsc --noEmit`——**没有前端单测**。
因此前端行为**必须在真实浏览器里验证**，见下节。

## 验证纪律

### `vue-tsc` 不校验自动导入的全局组件属性

这是本仓最大的验证陷阱，已经因此漏掉过两个真 bug：
`position="absolute h-full"` 把内容区高度塌成 139px（`h-full` 被拼进类名，元素退回 static），
以及创建页草稿时序 bug。两者**类型检查全绿、页面是坏的**。

结论：**改了前端布局或交互，不能只看 typecheck 通过就说完成。** 要起真服务、开真浏览器、
量 DOM 几何。可复用的做法：

```js
const { loadConfig } = await import(".../apps/server/src/config/config.ts");
const { createApp } = await import(".../apps/server/src/app.ts");
const app = await createApp(loadConfig()); // async，漏 await 会得到 app.start is not a function
await app.start();
```

用 `playwright-core` 驱动 `chromium`（`/root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`），
`ATRI_PORT` / `ATRI_ADMIN_PASSWORD` / `ATRI_STATIC_DIR` 通过环境变量注入到临时 root。

量几何时的两个具体教训：

- **和容器自己的 `getBoundingClientRect()` 比，不要和视口绝对坐标比。**
  chat 侧侧栏占 232px（`theme/tokens.ts` 的 `layout.navW`，实测顶栏自身 `x=232`），
  左侧控件 `x=248` 是**正确**的（`232+16`），
  拿它跟 `x<200` 比会误报「不贴左」。
- **不要用 `console.error` 或 `requestfailed` 判定出错。** 登录前守卫**有意**探测 `/auth/me`
  并收到 401（那是「未登录」的正常表达），导航也会让在途请求变成 `ERR_ABORTED`。
  只收 `pageerror`，并过滤 `ERR_ABORTED`。

前端改动至少覆盖：多档视口（375 / 414 / 480 / 768 / 1280）、控件是否真的可达（不被挤出屏幕）、
关键元素的位置与宽高比、以及无未捕获异常。

分页与滚动锚定这类交互，判据还得再加两条（做会话历史翻页时补上的）：

- **状态要量 DOM，不要量状态位。** `disabled` 与「加载中…」文案都得从元素上读 ——
  自动导入的 naive-ui 组件属性不受 `vue-tsc` 校验，`loading` 写错名字照样编译通过。
- **锚定要比同一个元素。** 记 `scrollTop` 的变化量、或拿「第一个元素」前后相减，都是量法错：
  prepend 之后第一个元素已经是新拉来的那条，前后比的根本不是同一个东西。
  要按 `data-msg-id` 钉住一条，再看它 `rect.top` 的位移（≤ 1px）。
  顺带一句：**测试红了与被测的东西坏了是两件事** —— 这三条判据第一次跑时全「失败」，
  全是脚本自己的量法问题（没滚到顶就量按钮、比了不同元素、多档视口跑在翻页之后而按钮已消失）。

## 前端约定（apps/dashboard）

Vue 3 + vue-router + Pinia + UnoCSS(presetWind4) + naive-ui，`<script setup lang="ts">`。

- **naive-ui 组件自动导入**（resolver 正则匹配 `N[A-Z]` / `n-[a-z]`），不需要手工注册，
  也**不要**为它们写 import。但自动导入的组件属性不受 `vue-tsc` 校验（见上）。
- **`n-dropdown` 的触发元素是默认插槽，不是 `#trigger`**——写 `#trigger` 会让按钮完全不渲染，
  只在控制台留一句 `slot[trigger] should have exactly one child`。`n-popover` 则**支持** `#trigger`。
- **Pinia 的 action 里不能调 `this.#privateFn()`**。actions 被挂到另一个对象上执行，
  `this` 上没有那个私有名字，会抛 `TypeError`。私有辅助写成**模块级函数**
  （`stores/sessions.ts` 的 `ingestInto` / `dropPending` 就是这么来的）。
- **UnoCSS 必须 import `virtual:uno.css`**（在 `main.ts` 里，且要在本地 `./uno.css` 之后）。
  少了它，产物里一个工具类都不生成，样式层**静默失效**——症状是 CSS 从 ~12 kB 掉到 ~3 kB，没有任何报错。
- 主题色在 `apps/dashboard/uno.config.ts` 的 `theme.colors`，取值全部是 `var(--atri-*)`：
  底色 `canvas` / `surface` / `raised` / `tint`，分隔 `line` / `line-strong`，
  文字 `ink` / `ink-muted` / `ink-faint`，压在 primary 实心填充上的文字用 `on-primary`
  （不能用 `surface`：它在深色主题下会翻成深色），强调 `primary`(+`-hover`/`-pressed`/`-soft`) / `ring`，
  语义色 `info` / `success` / `warning` / `danger`(+`-hover`)。**名字以那份文件为准**：
  这里列出的每一个键都要能在 `theme.colors` 里找到，反之亦然 —— 照一个不存在的 token 名写
  （历史上这里列的是 `bg`/`panel`/`fg`/`muted`/`accent`）不会报错，只会**静默不生成那条 CSS**，
  与上面 `virtual:uno.css` 那一条是同一种失效形态。深浅两套值在 `src/theme/`
  （`tokens.ts` 出常量、`css-vars.ts` 出 `:root` 与深色覆盖，`ThemeToggle` 翻转），
  所以**不存在「只有暗色」这套 token** 了：按设计稿写具体值时要说清在哪一套下成立。
- 顶栏高度用 `--atri-header-h`，**不要写死 60px**。它的真源是 `src/theme/tokens.ts`，
  经 `src/theme/css-vars.ts` 变成 CSS 变量、再由 `uno.config.ts` 的 preflight 注入；
  `src/uno.css` 里那份 `:root` 已经删掉并留了说明 —— 再抄一份就是第二个真源，深浅翻转时它不跟着翻。
- **两个包的 import 别名不是一套，别去「统一」它**：`apps/dashboard` 用 `@/...`
  （`tsconfig.json` 的 `paths` + `vite.config.ts` 的 `alias`，两边都得配是因为 vue-tsc 读前者、
  Vite 读后者），而 `apps/server` 刻意用 `#...`。判据还是那一条 —— **谁来解析这个说明符**：
  dashboard 先经 Vite 编译，`paths` 骗不过运行时是因为运行时根本不看 tsconfig，而 Vite 会看；
  服务端直接由 Node 跑 `.ts` 源码，只有 `package.json` 的 `imports` 才可能被 Node 解析（见上面
  「代码风格」那条）。给其中一个包加另一种写法，就是给下一个「顺手统一」的人留坑。
- **状态若能从路由推出，就不要存本地**。平台切换的高亮是 `computed(() => route.path...)`，
  写成 `ref` 会立刻出现「停在 chat 但按钮显示 bot」——刷新、前进后退、直接粘贴深链时局部状态都不跟着走。
  **唯一的例外是配置工作台的草稿**（`stores/profileConfig.ts`）：路由说的是「哪一份档、
  哪一类」，而没保存的编辑在哪儿都不存在 —— 它不会被路由或服务端推出来。这个例外有代价，
  所以三件事一起到位才算成立：脏点看得见、保存键亮着、离开与切档都要拦。它也**不写
  `localStorage`**：草稿存在的意义就是被丢掉（存或弃），跨刷新留住只会让人以为没丢。
- `src/api/client.ts` 是**唯一的** HTTP/WS 出口。401 在那里统一转成 `UnauthorizedError`，
  调用方不要各自判断状态码。
- **凭证只走 `HttpOnly` Cookie**，前端不持有也不存储任何令牌，不要往 `localStorage` 放任何凭证。
  今天整个 dashboard **一处 `localStorage` 都没有**，这是刻意的，不要「顺手加回来」：
  以前那里按档记着选中的模型（`atri.selectedModel.<profile>`），而「这一档用哪个模型」
  是配置档的属性（写在 `data/profiles/<id>/config.json` 的 `defaultProvider`），
  存进浏览器就是第三个真源，症状是「换台机器行为不一样，而没有任何文件写着它」。
  判据与上面平台切换那条是同一句话：**能从路由或服务端配置推出的状态不要存本地**。
- 顶栏等跨平台复用的东西放 `components/shared/`；只在单个平台用的放 `components/<平台>/`。
  两个平台的顶栏**各自一份实现**（bot 左侧是 logo、chat 左侧是模型选择器），
  不要用 `isChat` 分支合成一个组件——那会把两边的改动绑在一起。

## OpenAPI 与生成物

`apps/server/openapi.json`（**入库、手写**）是接口规范的唯一源头，前端 SDK 由它生成：

```
apps/server/openapi.json  -->  pnpm codegen  -->  apps/dashboard/src/api/generated/（入库，不得手改）
```

**三道检查各管一层，谁也不替谁**（缺了哪一层都会有一种「规格说谎而检查全绿」的形态）：

| 检查                                  | 守住的东西                                                                              | 漏掉它会怎样                           |
| ------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `test/openapi.test.ts`                | 路径与方法：注册的路由 ↔ 规格里的 path                                                  | 加了端点忘写规格 → 前端 SDK 少一个方法 |
| `test/openapi-response-shape.test.ts` | **响应体字段**：真实驱动全部端点，逐字段比 `type`/`required`/`enum`/状态码              | 字段改了路径没变 → 前端类型骗人        |
| `test/openapi-request.test.ts`        | **请求侧与鉴权侧**：省略必填必须 400、畸形 JSON 必须 400、匿名访问与规格的 401 双向一致 | 运行时校验被删 / 新路由忘了声明 401    |

红了统一按这句话办：**改 `openapi.json`，然后 `pnpm codegen` 并提交生成物；不要为了让检查变绿去改这三个测试。**
响应形状检查不允许空数组：驱动必须为每个数组端点真的造出数据，不能靠豁免放过。

### 为什么规格是手写的，不由代码生成

自动生成规格的前提是「schema 存在于运行时代码里」，本仓三条路都要付依赖代价，且都被否掉：
`fastify` + `@fastify/swagger`（传递依赖 ~70 个包，含 `pino`/`semver`，直接违反下面的依赖极简）、
`hono` + `@hono/zod-openapi`（~7 包，但 Web Fetch 模型与现有 `node:http` 行为 —— WS 升级鉴权、
静态目录穿越 403、Cookie 逐属性、SSE 的 `cache-control: no-store` —— 冲突面最大）、
路由上声明 JSON Schema + `ajv`（5 包，最接近可用，但仍是为一个不对外发布的规格引入运行时依赖）。
外部对照：AstrBot 有 FastAPI 免费自动 openapi，可它喂给自家 `openapi-ts` 的仍是手写入库的
`openspec/openapi-v1.yaml` —— 因为它的规格是**对外契约**，要按 scope 精选。本仓的规格只服务
自己的 dashboard，没有精选需求，但也没有「自动生成就不会说谎」这回事：说谎的是字段，
上面那三道检查就是为此存在。**别把「改成自动生成」当成这个洞的解法。**

改接口的完整动作：改代码 → 同步改 `openapi.json` → `pnpm codegen` → **把生成物与改动同一个提交**
（`codegen:check` 用 `git status --porcelain` 判漂移，生成物留在工作树里不提交会被报成「不同步」）。
`openapi.test.ts` 自动覆盖新增路由，不需要手工登记。

生成物**豁免 oxlint/oxfmt**（两者 `ignorePatterns`）。这不只是为了省事：
若格式化会改动生成物，「重新生成后无差异」这条检查就永远不成立。

`api/client.ts` 手写而不用生成客户端的两个原因别丢掉：生成客户端默认把错误当**返回值**而不是抛异常；
以及 `bodySerializer` 一旦缺失，只有走全局 `fetch` 的 SSE 接口会坏（axios 路径自己会序列化，看不出来）。
WebSocket 描述不了，永远手写。

## 配置与安全

**配置分三层，界线不许漂**：

| 层               | 文件                             | 内容                                                                                        |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| 部署级（启动）   | `atri.config.json`               | 端口、数据目录、插件安装目录、口令                                                          |
| 部署级（运行期） | `data/providers.json`            | 供应商：源（连接与密钥）、模型实例清单、全局默认                                            |
| 部署级（运行期） | `data/adapters.json`             | 接入平台实例：类型、绑定配置、启停、平台字段                                                |
| 部署级（运行期） | `data/personas.json`             | 可复用的人格（名称、说明、系统提示词）；配置档只存引用                                      |
| 部署级（运行期） | `data/cron.json`                 | 计划任务（cron、提示词、所用配置档、最近结果）                                              |
| 配置档           | `data/profiles/<id>/config.json` | 跑法：工具开关、`maxToolSteps`、插件启用清单、`personaId`、`defaultProvider`、`access` 名单 |

判据是「**这个东西占的资源属于谁**」：密钥与端点属于部署（按档各存一份就是让同一个
`apiKey` 躺在 N 个文件里，轮换要改 N 处），而「开哪些工具、开哪些插件、默认打哪个模型」
属于那一跑法。想给某一族配置加「按档各一份」之前先读 architecture.md 的
「配置档：什么共享、什么各一份」—— 这一条**已经被翻过一次**（上一版是供应商按档隔离，
并用 `x-profile-scoped` 与一批作用域测试钉死），翻回来付的代价是重写那批守卫与契约。

- 解析顺序（只对**启动那一份**成立）：**内置默认值 → `atri.config.json` → 环境变量**。
  密钥走环境变量，结构性设置走文件。运行期的那几份由控制台的写操作维护；
  只有供应商与老配置档段需要启动时搬一次（`seedProfile` / `migrateProvidersToGlobal`，
  判据都是「目标文件在不在」）。人格与计划任务不做迁移：它们是本次新增的运行期资源。
- **两个看起来像 bug、其实不是的形状，别顺手「修正」**：
  `AppConfig.logLevel` 是 `string` 而不是 `"debug"|"info"|"warn"|"error"` 联合（未知级别今天
  退化成 info，收紧成联合会让 `ATRI_LOG_LEVEL=verbose` 从「安静地跑」变成「启动失败」）；
  `staticDir` 在磁盘上是**顶层键**、在 `AppConfig` 里却嵌在 `auth` 段下
  （`config.ts` 读顶层、`api/server.ts` 读 `config.auth.staticDir`），把它「归位」会同时
  改配置文件格式与读取路径。两者都是行为变更，不是类型清理。
  同理 `FileConfig` 必须带 `[key: string]: unknown` —— 读-改-写要原样保留我们不认识的键，
  封闭的类型会让下一次写入丢掉用户的配置。
- **`atri.config.json` 已被 gitignore**，因为它含明文口令。自动生成的口令会写进它——
  绝不要把它加进版本控制，也不要贴进对话或日志。`apiKey` 现在住在 `data/providers.json`，
  接入平台的 token 住在 `data/adapters.json`（同样由 `data/` 目录 0700 保护），
  它靠「`data/` 整目录被忽略 + 目录 0700」得到保护：**不要把运行期配置往仓库根放**，
  `.gitignore` 忽略的是**精确名** `atri.config.json`，根下的兄弟文件是「未跟踪但也不忽略」，
  一次 `git add -A` 就会把密钥提交进版本库。
- `atri.config.example.json`、`providers.example.json`、`atri.profile.example.json`
  与 `.env.example` 只放占位符，**不放真实凭证**。示例文件之间不要互相抄段落：
  供应商那两段只出现在 `providers.example.json`，`atri.profile.example.json` 里只留
  `defaultProvider` 那**一根引用**。
- 改配置相关的行为时，同步更新 `.env.example`、上面那几个 example 与 README 的变量表。
- 口令比对用 `timingSafeEqual` 对定长摘要比较，且**失败原因不区分**（不回「用户不存在」）。
  新增鉴权路径时不要泄露这个差异。

## 提交

Conventional Commits，**冒号后用中文**：

```
feat(server): provider 配置改为两层并支持从上游拉取模型列表
fix(dashboard): 修正 bot 顶栏在窄屏下汉堡按钮被挤出屏幕
```

常用 type：`feat` / `fix` / `test` / `docs` / `chore`。常用 scope：`server` / `dashboard` / `shared` /
`tooling` / `deps` / `config` / `plugin`。

- **标题写清改了什么（一句话能读懂），正文写为什么。** 正文要记下被否定的方案、以及为什么这么选。
  本仓的 `git log` 是设计史的一部分，`docs/architecture.md` 里的很多结论都来自提交正文。
- 一个提交只做一件事。格式化和逻辑改动分开提交。
- **提交前 `pnpm check` 必须全绿。**

## pnpm 的两个坑

本仓由 `packageManager` 固定为 **pnpm 12**（`.npmrc` 开了 `engine-strict`，版本不符直接报错）。
下面两条是 pnpm 11 起的行为，12 照旧：

1. **`onlyBuiltDependencies` 已被移除**，改用映射形式 `allowBuilds`（见 `pnpm-workspace.yaml`）。
   旧键写了不生效，且安装会以 `ERR_PNPM_IGNORED_BUILDS` 失败。
2. **`minimumReleaseAge` 自 pnpm 11 起默认开启（1 天）**，发布不足 24 小时的版本会被拒绝。
   `pnpm add` 遇到这种版本会**自动往 `pnpm-workspace.yaml` 塞一个 `minimumReleaseAgeExclude` 白名单**来绕过门禁。
   本仓刻意只用已过窗口的版本，因此**该键不该存在**；一旦出现，说明有人装了刚发布的版本，
   请改用窗口外的范围后把白名单删掉——不要让一次 `pnpm add` 顺手把供应链门禁永久关掉。

   还要注意：门禁会校验**已存在的 `pnpm-lock.yaml` 条目**，只改 `package.json` 的范围没用，
   `install` 会在校验这步直接中止。必须**删掉 `pnpm-lock.yaml` 与 `node_modules/.pnpm/lock.yaml`** 后重装才会真正重新解析。

## 文档

- [`README.md`](./README.md)：产品说明、API 表、配置与部署——面向使用者。
- [`docs/architecture.md`](./docs/architecture.md)：分层、依赖方向、以及**每个设计决定背后的理由**。
  踩过的坑写成「为什么不能那样写」，与 `AGENTS.md` 的分工是：本文写规则，那里写原理。

**改了行为就同步改文档**，尤其是命令表、环境变量表、API 表和架构里的分层图。
文档里出现不存在的命令（例如曾写过的 `pnpm start`）比没有文档更坏。
