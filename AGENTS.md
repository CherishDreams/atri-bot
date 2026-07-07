# AGENTS.md

给在本仓工作的 agent 的规范。这里的每条约束都对应一次真实的踩坑或一次刻意的取舍，
**不是通用最佳实践**。与本仓相关的一切都用中文书写（注释、日志、错误消息、文档、提交信息）。

产品说明与用户向文档在 [`README.md`](./README.md)，设计取舍在 [`docs/architecture.md`](./docs/architecture.md)。
本文只写「怎么在这里干活」。

## 仓库形态

pnpm monorepo，三个包：`apps/server`（agent 引擎 + API）、`apps/dashboard`（Vue 3 控制台）、
`packages/shared`（两个 app 共享的类型、常量、线协议）。

- Node `>=20.19.0`；pnpm 由根 `package.json` 的 `packageManager` 字段固定，**不要用别的包管理器**。
- `apps/server` 是**纯 JavaScript**（`allowJs: true, checkJs: false`），靠 tsc 产出 `.d.ts`。
  它是 `verbatimModuleSyntax` + `strict` + `noUncheckedIndexedAccess` 的严格环境，写 JS 也要按类型写。
- **依赖极简是刻意维护的属性**。服务端运行时依赖只有 `ws` 一个。加依赖前先确认没有几十行手写就能解决的问题，
  并说明为什么必须引入。

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

| 命令                           | 说明                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `pnpm check`                   | **提交前必须跑**：typecheck → lint → format:check → codegen:check → test |
| `pnpm lint` / `lint:fix`       | `oxlint --deny-warnings .` / `oxlint --fix .`                            |
| `pnpm format` / `format:check` | oxfmt 改写 / 只校验                                                      |
| `pnpm codegen`                 | 按 `apps/server/openapi.json` 重新生成前端 SDK                           |
| `pnpm test`                    | 全部包；服务端是 `node --test`                                           |
| `pnpm build`                   | 全部包                                                                   |
| `pnpm start`                   | 起服务端（= `pnpm --filter @atri/server start`）                         |

三条容易踩的规则：

- **仓库没有 CI**，`pnpm check` 没人替你跑。**你就是 CI**——没跑过就不要说「改好了」。
- `pnpm lint` 带 `--deny-warnings`，**告警即失败**。而 `oxlint` 单独运行时仅有 warning 会退出 0，
  直接跑 `oxlint` 看到 0 退出码就以为通过了是错的，用 `pnpm lint`。
- `codegen:check` 用 `git status --porcelain` 判断生成物漂移，**改了接口就必须先 commit 生成物**。
  顺序反了会看到一条误导性的 `A ` 红灯（它其实是「你还没提交新增的生成文件」）。

## 分层（硬约束）

```
api/ ─────┐
adapters/ ┴─> core/ ─> (无)
plugins/  ─> 只依赖注入给它的 ctx
```

- **`core/` 不得 import `api/`、`adapters/`、`plugins/` 里的任何东西。**
- **没有任何模块 import `api/`**。传输层是最外层、可整体替换（换 gRPC / CLI 不碰业务逻辑）。
- `app.js` 是**唯一**的组合根。装配只在那一处发生；其余模块不知道别人是谁。
- 依赖一律走**构造参数**。不要引入全局单例、模块级可变状态、或「import 一下就自动注册」的副作用。
  这条是测试能直接 `createApp(config)` 起真服务、而不必 mock 掉半个世界的原因。
- 每个模块往里收一层：`index.js` 薄入口 → `app.js` 装配 → `core/` 逻辑 → `api/` 传输。

新增能力时的落点：入站适配 → `adapters/`；出站模型 → `core/provider/factory.js` 的 `TYPES` 表；
业务逻辑 → `core/`；HTTP 表面 → `api/server.js` + `openapi.json`。

### 命名上不要混用两个词

**adapter** 是入站接入（QQ、Discord、webhook…），契约是长驻的 `start()`/`stop()`；
**provider** 是出站模型调用，契约是每请求的 `chat()`。两者形状不同，故意不用同一个词。
也不要新造「model adapter」之类的混合称呼。

## 代码风格

由 `.oxfmtrc.json` 与 `.oxlintrc.json` 强制，`pnpm format` 会全部改好。人的部分：

- **双引号**、100 列、分号、尾逗号 `all`、2 空格。`sortPackageJson: true` 会重排 `package.json` 的键。
- `import type` 必须显式（`verbatimModuleSyntax`），否则运行时 import 一个不存在的绑定。
- 数组排序/反转用 `toSorted()` / `toReversed()`，不要 `sort()` / `reverse()`
  （`unicorn(no-array-sort)`：后两者原地修改数组）。
- 包装捕获到的错误时**带上 cause**，否则堆栈里丢了原始错误，排查变成猜：

  ```js
  throw new Error(`解析 ${filePath} 失败: ${err.message}`, { cause: err });
  ```

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
如果某处写法看起来多余或奇怪，它**几乎一定是有原因的**：先读注释和 `git log`，不要先动手「简化」。

用户可见的字符串（HTTP 错误、日志、UI 文案）一律中文。
口令、密钥、令牌**永不写进日志或响应体**。

## 测试

用内置 `node:test` + `node:assert/strict`，**不引入测试框架**。测试放在 `apps/server/test/*.test.js`。

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
const { loadConfig } = await import(".../apps/server/src/config/config.js");
const { createApp } = await import(".../apps/server/src/app.js");
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
- 主题色在 `uno.config.ts` 的 `theme.colors`（`bg` / `panel` / `fg` / `muted` / `accent` / `danger`），
  不是旧 `styles.css`。注意这套是**暗色 token**，落在浅色外壳上会显得「丑」——按设计稿写具体值。
- 顶栏高度 `--atri-header-h` 定义在 `src/uno.css` 的 `:root`，顶栏与内容区偏移共用它，**不要写死 60px**。
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

改接口的完整动作：改代码 → 同步改 `openapi.json` → `pnpm codegen` → 提交生成物。
`apps/server/test/openapi.test.js` 会比对**真实注册的路由**与规格里的路径，
所以「加了端点但忘了写进规格」会被它抓住——**不要为了让测试通过去改这个测试**，它自动覆盖新路由。

生成物**豁免 oxlint/oxfmt**（两者 `ignorePatterns`）。这不只是为了省事：
若格式化会改动生成物，「重新生成后无差异」这条检查就永远不成立。

`api/client.ts` 手写而不用生成客户端的两个原因别丢掉：生成客户端默认把错误当**返回值**而不是抛异常；
以及 `bodySerializer` 一旦缺失，只有走全局 `fetch` 的 SSE 接口会坏（axios 路径自己会序列化，看不出来）。
WebSocket 描述不了，永远手写。

## 配置与安全

- 解析顺序：**内置默认值 → `atri.config.json` → 环境变量**。密钥走环境变量，结构性设置走文件。
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
