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

| 命令                           | 说明                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm check`                   | **提交前必须跑**：typecheck → lint → format:check → static:check → codegen:check → test   |
| `pnpm static:check`            | 三道「编译器与测试都看不见」的检查：分层方向 + 说明符写法、按行号的交叉引用、内置工具登记 |
| `pnpm lint` / `lint:fix`       | `oxlint --deny-warnings .` / `oxlint --fix .`                                             |
| `pnpm format` / `format:check` | oxfmt 改写 / 只校验                                                                       |
| `pnpm codegen`                 | 按 `apps/server/openapi.json` 重新生成前端 SDK                                            |
| `pnpm test`                    | 全部包；服务端是 `node --test "test/**/*.test.ts"`                                        |
| `pnpm build`                   | `packages/shared` + `apps/dashboard`（服务端不产出构建物）                                |
| `pnpm start`                   | 起服务端（= `pnpm --filter @atri/server start`）                                          |

四条容易踩的规则：

- **仓库没有 CI**，`pnpm check` 没人替你跑。**你就是 CI**——没跑过就不要说「改好了」。
- `static:check` 的三道检查都只认**结构性事实**（谁 import 谁、注释里的行号形态、文件与清单是否
  一一对应）。它们各自都带一条「防空跑」断言：本仓初版的两条检查把 `fileURLToPath` 返回的
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
- 依赖一律走**构造参数**。不要引入全局单例、模块级可变状态、或「import 一下就自动注册」的副作用。
  这条是测试能直接 `createApp(config)` 起真服务、而不必 mock 掉半个世界的原因。
- 每个模块往里收一层：`index.ts` 薄入口 → `app.ts` 装配 → `core/` 逻辑 → `api/` 传输。

新增能力时的落点：入站适配 → `adapters/`；出站模型 → `core/provider/factory.ts` 的 `TYPES` 表；
工具能力 → `core/tool/`（注册表不 import 具体工具、也不读配置，内置工具由组合根注册；
工具需要别层的数据时**由组合根注入访问器**，不要在 `core/tool/` 里 import 那一层 ——
`list_plugins` 收 `() => plugins.list()` 就是这个形状，分层规则没有检查守着）；
业务逻辑 → `core/`；HTTP 表面 → `api/server.ts` + `openapi.json`。

**内置工具一颗一个文件**：`core/tool/builtins/<id>.ts` 只导出自己那颗的 `ToolDefinition`，
`core/tool/builtins.ts` 逐颗 import 并组成清单 —— 对照 `provider/` 那边
（`openai.ts` / `anthropic.ts` 各一份实现，`factory.ts` 负责挑）。**不要**加
`builtins/index.ts` 这类 re-export 中间层：清单是唯一的装配点，多一处出口就会变成
「改了工具文件但忘了登记」，而登记与否没有任何检查在守（注册表按注入的东西说话）。

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
  要扩大它就是「在 `#peers()` 里显式加一行 + 同步 `test/plugins.test.ts` 那句不该有 dir/error/dataDir」，
  而不是把 `#view()` 那份给控制台的形状直接递给插件。
  `ctx.dataDir` 是这条规矩的一个样本：它给的是 `<dataDir>/plugins/<自己的 id>`，
  由框架拼、由框架校验、由框架私有参数（`PluginStorage`，**不进白名单**）注入 ——
  插件要一个地方存东西，不等于它该看见 `dataDir` 本体（那下面躺着 `sessions.sqlite`）。
  多配置档之后它是 `<dataDir>/profiles/<配置档 id>/plugins/<插件 id>`，
  而 `ctx.config.pluginDirs` 仍是**部署级那一份**（插件全局安装，每档只决定开不开）：
  这条键的**值没有**跟着配置档变，所以 `test/plugin-config.test.ts` 的键集合断言之外，
  `test/plugins.test.ts` 还钉了一句「两个管理器的 `pluginDirs` 逐元素相等」。
  要往 profile 里加「每档私有安装目录」这类键之前，先读 architecture.md 的插件一节：
  它被否过一次，理由是安装是文件系统动作，多配置档同步不了它。
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
  chat 侧侧栏占 272px，顶栏自身 `x=272`，左侧控件 `x=288` 是**正确**的（`272+16`），
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
  文字 `ink` / `ink-muted` / `ink-faint`，强调 `primary`(+`-hover`/`-pressed`/`-soft`) / `ring`，
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
- `src/api/client.ts` 是**唯一的** HTTP/WS 出口。401 在那里统一转成 `UnauthorizedError`，
  调用方不要各自判断状态码。
- **凭证只走 `HttpOnly` Cookie**，前端不持有也不存储任何令牌。
  不要往 `localStorage` 放任何凭证（唯一的 `localStorage` 用法是记住模型选择，那不是凭证）。
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
| `test/openapi-response-shape.test.ts` | **响应体字段**：真实驱动 27 个端点，逐字段比 `type`/`required`/`enum`/状态码            | 字段改了路径没变 → 前端类型骗人        |
| `test/openapi-request.test.ts`        | **请求侧与鉴权侧**：省略必填必须 400、畸形 JSON 必须 400、匿名访问与规格的 401 双向一致 | 运行时校验被删 / 新路由忘了声明 401    |

红了统一按这句话办：**改 `openapi.json`，然后 `pnpm codegen` 并提交生成物；不要为了让检查变绿去改这三个测试。**
唯一允许「登记差异」的地方是响应形状文件里的 `EMPTY_OK`（目前只有 `adapters` 一项，理由写在它的注释里）。

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

- 解析顺序：**内置默认值 → `atri.config.json` → 环境变量**。密钥走环境变量，结构性设置走文件。
- **两个看起来像 bug、其实不是的形状，别顺手「修正」**：
  `AppConfig.logLevel` 是 `string` 而不是 `"debug"|"info"|"warn"|"error"` 联合（未知级别今天
  退化成 info，收紧成联合会让 `ATRI_LOG_LEVEL=verbose` 从「安静地跑」变成「启动失败」）；
  `staticDir` 在磁盘上是**顶层键**、在 `AppConfig` 里却嵌在 `auth` 段下
  （`config.ts` 读顶层、`api/server.ts` 读 `config.auth.staticDir`），把它「归位」会同时
  改配置文件格式与读取路径。两者都是行为变更，不是类型清理。
  同理 `FileConfig` 必须带 `[key: string]: unknown` —— 读-改-写要原样保留我们不认识的键，
  封闭的类型会让下一次写入丢掉用户的配置。
- **`atri.config.json` 已被 gitignore**，因为它含明文口令与 `apiKey`。
  自动生成的口令会写进它——绝不要把它加进版本控制，也不要贴进对话或日志。
- `atri.config.example.json` 与 `.env.example` 只放占位符，**不放真实凭证**。
- 改配置相关的行为时，同步更新 `.env.example`、`atri.config.example.json` 与 README 的变量表。
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
