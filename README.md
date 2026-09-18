# atri-bot

一个**可扩展的 agent 平台**：服务端负责运行 agent 引擎、适配器与插件，另配一个 Web 控制台。
项目采用 pnpm monorepo 组织，使后端、前端与共享代码可以各自独立演进，同时共享类型。

## 目录结构

```
atri-bot/
├── apps/
│   ├── server/          # 主程序（agent 引擎 + API）
│   │   ├── src/
│   │   │   ├── index.ts     # 薄入口：配置 -> 应用 -> 启动 -> 关闭
│   │   │   ├── app.ts       # 组合根（在一处完成所有装配）
│   │   │   ├── config/      # 配置加载（默认值 -> 文件 -> 环境变量）
│   │   │   ├── core/        # 引擎、会话、provider、工具、logger（全部逻辑）
│   │   │   ├── api/         # HTTP + WebSocket 传输层（无业务逻辑）
│   │   │   ├── adapters/    # 可选启用的外部接入（webhook、QQ、Discord、CLI…）
│   │   │   └── plugins/     # 插件加载器
│   │   ├── plugins/     # 可直接放入的插件（参见 plugins/hello）
│   │   └── test/
│   └── dashboard/       # Vue 3 控制台（独立成包）
├── packages/
│   └── shared/          # 两个 app 共享的类型、线协议与常量
├── scripts/             # 仓库工具（clean 等）
├── tests/               # 跨包 / 集成测试
└── docs/
```

设计上借鉴了 AstrBot 的**分层思路**（薄入口、厚核心、前后端各自成项目、传输与逻辑解耦），
但采用 Node/pnpm 的 monorepo 惯例，而非 Python 的平铺顶层。

### 依赖方向

`api/` 和 `adapters/` 依赖 `core/`；`core/` 不依赖它上面的任何东西。
两个 app 都依赖 `packages/shared`。没有任何东西依赖 `api/`。

## 环境要求

- Node >= 22.18（服务端直接跑 TypeScript 源码，靠 Node 22.18 起默认开启的类型擦除，
  不需要构建步骤；低于它会得到 `UnknownSyntaxError`，而 `.npmrc` 的 `engine-strict`
  让 `pnpm install` 在这种机器上直接失败，好过跑到一半才崩）。
  这条下限同时也是 `node:sqlite`（会话与消息的存储）**免 `--experimental-sqlite` 旗标**的下限 ——
  它在 v22.13.0 / v23.4.0 起免旗标，所以本仓的三条脚本 `dev`/`start`/`test` 都不需要加旗标；
  把下限往下调到 22.13 以下会让服务端启动即失败。
- pnpm 12（由 `packageManager` 字段固定为 `pnpm@12.11.2`；`.npmrc` 开了 `engine-strict`，
  版本不符会直接报错，所以别用 11 及以下）

## 快速开始

```bash
pnpm install
pnpm --filter @atri/shared build   # 先构建一次共享类型
pnpm dev                           # 启动服务端，监听 127.0.0.1:6185
pnpm dev:dashboard                 # 启动控制台，监听 127.0.0.1:5173
```

控制台会把 `/api` 和 `/ws` 代理到服务端，因此运行 UI 需要两者同时启动。
首次启动时服务端会生成管理员口令并打印在日志里，见[登录鉴权](#登录鉴权)。

只想跑起来看看的话，可以先 `pnpm build` 再直接 `pnpm start`——
服务端会托管构建好的控制台，单个进程即可访问，不必再起 Vite。

## 常用命令

| 命令                 | 说明                                               |
| -------------------- | -------------------------------------------------- |
| `pnpm dev`           | 以文件监听方式运行服务端                           |
| `pnpm dev:dashboard` | 运行控制台的开发服务器                             |
| `pnpm build`         | 构建全部包                                         |
| `pnpm start`         | 启动服务端（托管构建好的控制台，单进程即可用）     |
| `pnpm typecheck`     | 对全部包做类型检查                                 |
| `pnpm lint`          | oxlint 检查（告警即失败）                          |
| `pnpm lint:fix`      | oxlint 自动修复                                    |
| `pnpm format`        | oxfmt 统一格式                                     |
| `pnpm format:check`  | 只校验格式，不改文件                               |
| `pnpm test`          | 运行全部测试                                       |
| `pnpm check`         | 依次跑 typecheck / lint / 格式 / 生成物漂移 / 测试 |
| `pnpm codegen`       | 按 `apps/server/openapi.json` 重新生成前端客户端   |
| `pnpm clean`         | 清理构建产物                                       |

仓库没有配置 CI，`pnpm check` 需要手动运行（提交前跑一次）。

## 配置

配置分**两层**，各有一个文件：

| 层     | 文件                             | 里面是什么                                                                       | 谁写它                                            |
| ------ | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| 部署级 | `atri.config.json`（仓库根）     | 监听地址与端口、日志级别、数据目录、插件安装目录、适配器开关、静态目录、登录口令 | 手写；`auth.adminPassword` 由服务端首次启动时填入 |
| 配置档 | `data/profiles/<id>/config.json` | 这份「跑法」用哪些模型、开哪些工具、单轮最多几步、开哪些插件                     | 控制台，或手写                                    |

解析顺序对**部署级**那一层成立：**内置默认值 → `atri.config.json` → 环境变量**。
环境变量可参考 `.env.example`；`atri.config.example.json` 复制成 `atri.config.json`，
`atri.profile.example.json` 复制成 `data/profiles/<你的 id>/config.json`。
密钥放在环境变量里，结构性设置放在文件里。

为什么配置档住在 `data/` 而不是仓库根的一个 `configs/` 目录：`.gitignore` 忽略的是
**精确名** `atri.config.json`，把带 `apiKey` 的兄弟文件放进仓库根就是「未跟踪但也不忽略」——
一次顺手 `git add -A` 会把所有配置档的密钥提交进版本库。`data/` 整体被忽略，
并且权限是 `0700`。

第一次启动时，服务端会把 `atri.config.json` 里的 `providers` / `providerSources` / `tools` /
`maxToolSteps` **一次性搬进** `data/profiles/default/config.json` 并打一条日志。
搬过之后那几段在 `atri.config.json` 里**不再生效**（框架不删你的文件，但每次启动都会 warn
一次提醒它们已经是个摆设）。`default` 这个名字没有任何特权：它只是第一次落盘的位置。

### 接入端绑定到配置档

`adapters.<id>.profile` 说这个平台**跑在哪份配置档**上。适配器本身留在部署级文件里：
它占的资源是部署级的（一个监听端口、一个 webhook 回调地址、一个平台的机器人 token），
要选的是「这个平台用哪一套模型与工具」。

绑定指不到一份可用配置档时，那个适配器**不会被启动**，并单独报一条 error ——
不退回 `default`，也不挑第一个能用的档：跑错一套配置没有任何症状，平台侧的流量照样进来。
`GET /adapters` 把两件事分开报：`enabled`（你没关掉它）与 `bound`（它绑的那份档现在可用），
两个都为真才真的在收流量。没写 `profile` 的适配器是 `enabled: true` + `bound: false`。

## 登录鉴权

控制台使用**单一管理员账号**保护。默认不配任何东西也能跑：未提供口令时，
服务端启动会生成一个随机口令、写进 `atri.config.json` 的 `auth.adminPassword`，
并**在日志里打印一次**——那是拿到初始口令的唯一途径，请立即保存。
`atri.config.json` 已被 `.gitignore` 忽略，因为它含有明文口令。

```bash
pnpm dev
# [warn] 未配置管理员口令，已生成随机口令并写入 atri.config.json:
#        ATRI_ADMIN_PASSWORD=<随机值>
```

更常见的做法是通过环境变量显式指定（优先级高于配置文件）：

| 变量                  | 默认值                | 说明                                                                                                                 |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ATRI_ADMIN_USER`     | `admin`               | 管理员用户名                                                                                                         |
| `ATRI_ADMIN_PASSWORD` | 无（自动生成）        | 管理员口令                                                                                                           |
| `ATRI_COOKIE_NAME`    | `atri_session`        | 会话 Cookie 名                                                                                                       |
| `ATRI_COOKIE_SECURE`  | 关                    | 加 `Secure` 属性，仅 HTTPS 有效；本仓默认明文 HTTP 故默认关                                                          |
| `ATRI_STATIC_DIR`     | `apps/dashboard/dist` | 控制台构建产物目录                                                                                                   |
| `ATRI_DATA_DIR`       | `data`                | 运行时数据目录：会话与消息库 `sessions.sqlite` 落在这里（相对项目根解析）                                            |
| `ATRI_ROOT`           | 仓库根                | 解析 `atri.config.json`、`dataDir`、`pluginDirs`、`staticDir` 的基准目录。**与启动目录无关**（默认由源文件位置推出） |

单轮工具步数上限 `maxToolSteps` **没有环境变量**：它属于配置档，改文件不用重启。
给它配一个环境变量只会得到第二个真源（而它只影响首次那一次搬移）。

### 认证接口

| 方法 | 路径           | 说明                                                         |
| ---- | -------------- | ------------------------------------------------------------ |
| POST | `/auth/login`  | body `{ username, password }`；成功下发 HttpOnly Cookie      |
| POST | `/auth/logout` | 幂等：未登录调用也返回 200                                   |
| GET  | `/auth/me`     | 返回当前用户与绝对过期时间（需登录）                         |
| GET  | `/auth/status` | 公开，返回 `{ required: boolean }`，供登录页判断是否展示表单 |

### 设计的几条要点

- **凭证不进响应体**，只走 `HttpOnly; SameSite=Lax` 的 Cookie，前端 JS 读不到令牌。
- 令牌是随机 UUID，服务端存**内存**，进程重启即全部失效。绝对有效期 **15 天**、
  空闲有效期 **7 天**：每次使用都会续期空闲计时，但无论如何 15 天后必须重新登录。
  这里的「会话」指**登录会话**；`/sessions` 那一组的**对话会话**（消息历史）持久化在
  `dataDir` 下的 sqlite，重启不会丢，两者不是一个东西（见[生产部署](#生产部署)的数据目录）。
  「不会丢」说的是从现在起的写入：从内存版升上来时，那些**原本只存在于旧进程内存里**的
  对话是拿不回来的 —— 第一次启动新版就是新库。
- 口令比对用 `timingSafeEqual` 对 **sha256 定长摘要**做比较，避免长度差异泄露信息；
  用户名与口令**都**参与比对（用户名不存在时也照常走完），
  且失败一律返回同一句「账号或密码错误」，不区分是哪一项错了。
- `/api/v1` 下除上述公开路径外**一律需要登录**。鉴权闸门设在路由匹配**之前**，
  因此未登录访问不存在的 API 路径返回 **401 而非 404**——
  否则匿名调用者可以靠 401/404 的差异枚举出哪些端点存在。
- WebSocket 复用同一个 Cookie 完成握手（浏览器无法为 WS 握手自定义请求头），
  未登录的连接在握手阶段即被以 401 拒绝。

## 模型 provider

分两层：**provider source**（一次连接：端点、密钥、超时）与 **provider**（一个模型实例）。
这样「一个网关下的多个模型」只写一次密钥，增删模型也不必碰凭证。

这一段属于**配置档**，写在 `data/profiles/<id>/config.json` 里（不是 `atri.config.json`）：

```json
{
  "providerSources": {
    "deepseek": {
      "type": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "",
      "timeoutMs": 120000
    },
    "claude": { "type": "anthropic", "apiKey": "", "timeoutMs": 120000 }
  },
  "providers": {
    "default": "deepseek-chat",
    "deepseek-chat": { "source": "deepseek", "model": "deepseek-chat" },
    "claude-sonnet": { "source": "claude", "model": "claude-sonnet-4-5", "enabled": false }
  }
}
```

`type` 决定用哪个实现，目前支持 `openai`（含所有 OpenAI 兼容网关）与 `anthropic`：

| 字段        | openai                           | anthropic                                              |
| ----------- | -------------------------------- | ------------------------------------------------------ |
| `baseUrl`   | 默认 `https://api.openai.com/v1` | 默认 `https://api.anthropic.com/v1`                    |
| 鉴权        | `Authorization: Bearer`          | `x-api-key` + `anthropic-version`（默认 `2023-06-01`） |
| `maxTokens` | 不发送（由上游决定）             | **必填**，默认 `8192`                                  |
| `headers`   | 额外请求头                       | 同左                                                   |
| `timeoutMs` | 默认 `120000`（毫秒）            | 同左                                                   |

**provider source**：`{ type, name?, baseUrl?, apiKey?, timeoutMs? }`，id 由键名给出，
创建后不可改名（改名要重写所有引用者，得不偿失）。
**provider（模型实例）**：`{ source, model, name?, enabled? }`，`enabled` 默认 `true`；
实例上的同名键（`baseUrl`/`timeoutMs`/`name`…）会**覆盖** source 上那一份。

`default` 是保留键（字符串），指向默认 provider 的 id；也可以改成在某个 provider
上写 `"default": true`。没配默认值时的选路顺序是：**显式模型名命中 → 默认 provider → 第一个注册的**。
显式值既可以是**实例 id**，也可以是模型名——控制台的模型选择器发上来的就是实例 id。
模型名对不上任何 provider 时**仍会退回默认 provider**——
上游的模型列表通常比本地配置新，本地列表不该当成硬闸门。

单个 provider 配错（类型拼错、引用了不存在的 source）只会记一条日志，不影响其它
provider 启动，并且在控制台的供应商配置页里以 `loaded: false` + 原因显示出来；
但如果配了 `default` 而它恰好加载失败，**不会静默换个 provider**——
否则请求会悄悄打到另一个模型上，只留一条 warn 日志说明会回退。
`enabled: false` 是**有意关闭**，只记 info 日志、不算故障，也不出现在模型选择器里。

一个 provider 都没配时，回复退化为**回声**（`[回声:模型名] 原文`）以便先把链路跑通。
一旦有 provider 注册，调用失败就会如实抛错，不会伪装成正常回复。

密钥解析顺序：环境变量 `ATRI_<SOURCE_ID>_API_KEY` → 源自己的 `apiKey`。
**注入的才是真的**：两处都写了的时候环境变量赢，所以容器部署可以把密钥完全留在文件之外
（见 `.env.example`）。反过来说，文件里留下的那条 `apiKey` 在有环境变量时不会再被用到 ——
它只是「没注入时的兜底」。注意变量名跟**源**的 id 走，不是模型。

### 在控制台里配置

「供应商配置」页可以直接增删源与模型，改动**写回配置档文件**（今天只有一份，
就是 `data/profiles/default/config.json`）并立即生效，
不需要重启。「获取模型列表」会拿**已保存的**凭证去打上游的 `GET /models`，
所以源有未保存改动时按钮会变成「保存并获取模型列表」。
上游没有 `/models` 时可以用「自定义模型」手填模型 id 绕过。

两点需要知情：

- **`GET /provider-sources` 会明文返回 `apiKey`**，表单也是明文渲染（便于核对粘贴
  是否出错）。该接口仅管理员可访问，但密钥确实会回到浏览器，请不要在共享机器上使用。
- `baseUrl` 指向内网地址时，服务端会**代为请求**那个地址。这属于管理员的正常用法
  （自建网关），因此不做地址白名单；但这也意味着该配置页等同于一台内网请求代理，
  不要把管理员账号给不可信的人。

## 生产部署

`pnpm build` 后，服务端会托管 `apps/dashboard/dist` 并做 **SPA 回退**，
因此只跑一个进程即可对外服务；`pnpm dev:dashboard` 只在开发时需要。

```bash
pnpm build
pnpm start            # 或 node apps/server/src/index.ts
# 打开 http://127.0.0.1:6185
```

带哈希的静态资源长缓存，`index.html` 使用 `no-cache`（否则发版后浏览器会拿旧外壳）。
静态目录之外的路径一律 403，不会读出仓库外的文件。

### 数据目录、备份与单实例

`dataDir`（默认 `data/`，可用 `ATRI_DATA_DIR` 或配置文件里的 `dataDir` 改）下有三样运行状态：
`sessions.sqlite`（全部对话历史）、`profiles/<id>/config.json`（各配置档的跑法）、
以及 `plugins/<插件 id>/`（各插件自己存的东西，框架不管理内容）。
**登录口令在 `atri.config.json`，各 provider 配置在配置档文件里**。**需要备份的就是这几样**，
其余（`apps/dashboard/dist`）可由源码重新构建。
整个 `dataDir` 的权限是 `0700`：保护落在**目录**上，`sessions.sqlite` 的 WAL 边车
（`-wal` / `-shm`）由 SQLite 按 umask 反复重建，逐文件收紧是一次性的假安全感。
`plugins/` 下**有目录不等于那个插件在跑**：加载失败的插件也留下了它已经写过的数据
（框架从不删任何东西），是否可用请看控制台的插件页或 `list_plugins`。

- **容器里把 `dataDir` 挂成 volume**，否则重建容器等于清空所有历史。
- **`data/` 与 `atri.config.json` 都相对仓库根解析，从哪儿启动都一样。** 这个默认值曾经是
  `process.cwd()`，而 `pnpm dev` / `pnpm start` 都经 `pnpm --filter` 执行、cwd 是 `apps/server/`：
  从那套启动方式升上来的部署，配置与对话库留在 `apps/server/` 下，而服务端现在读的是仓库根。
  合并一次即可（`mv apps/server/atri.config.json .`，再把 `apps/server/data/` 并进 `data/`）。
  **两处都已经有 `sessions.sqlite` 时不要覆盖**——两份历史合不到一个库里，只能挑一份用、
  另一份改名留着；实在想保持原样就给老位置显式设 `ATRI_ROOT=apps/server`。
- **一个数据目录只跑一个实例。** 同会话串行那把锁是进程内的 `Set`（`core/agent/engine.ts`），
  第二个进程看不见它；SQLite 侧只有文件锁 + 5 秒 busy timeout，抢不到会得到一句中文 500。
  想跑两份就给它们两个 `dataDir`。
- **备份用 `sqlite3 <db> ".backup 目标"`，或者先停服再整目录复制。**
  进程开着时只 `cp sessions.sqlite` 会**漏掉 `-wal` 边车里尚未 checkpoint 的消息** ——
  那是真的会丢用户对话，不是理论风险。同理不要手工删 `.sqlite-wal` / `.sqlite-shm`。
- **数据目录被收紧到 `0700`，库文件本身 `0600`**（Windows 等不支持 POSIX 权限的环境静默忽略）。
  挡住对话内容的是**目录**：WAL 模式下最近的写入躺在 `sessions.sqlite-wal` 里，那个边车由
  SQLite 按 umask 创建、并在每次 checkpoint 后重建，逐文件收紧追不上它。已有目录也会在每次
  启动时被重新 `chmod`（升级路径上你原来那个 `data/` 可能是 `0755`）。挂 volume 时权限跟着走，
  所以容器里不必额外处理，但**别把 `dataDir` 指到一个共享目录**上。
- 库损坏或打不开时服务端**启动即失败**并打印路径与一句自救提示，不会降级成「历史没了但还能跑」——
  那样下一次写入就会落在一个我们以为是空的库上。

## 扩展方式

- **插件** —— 一个目录，内含 `index.js`，默认导出
  `{ id, name, version, description?, config?, setup(ctx), teardown?() }`
  （也支持默认导出工厂函数 `(shared) => 上述对象`）。目录来自配置中的 `pluginDirs`。
  要存数据用 `ctx.dataDir`（见[插件的动态加载](#插件的动态加载)），**不要**写进插件自己那个目录 ——
  那个目录是会被升级覆盖、被用户改名的。参见 `apps/server/plugins/hello`。
- **适配器** —— 实现 `start()`/`stop()` 并注册到 `AdapterManager`；
  在 `config.adapters.<id>.enabled` 中按需启用。纯 agent 部署可以不启用任何一个。
- **工具（function calling）** —— 内置工具一颗一个文件（`apps/server/src/core/tool/builtins/`），
  在 `builtins.ts` 的清单里登记后由组合根注册进 `ToolRegistry`。目前有两颗：`current_time`
  （报此刻的日期与时钟，可传 IANA 时区）与 `list_plugins`（列已安装的插件及其加载结果）。
  启用走**配置档文件**的 `tools` 段，
  **默认全部关闭**（与适配器的默认启用刻意相反：少听一个端口是部署细节，
  给模型多一件可做的事是能力授予）：

  ```json
  { "tools": { "current_time": { "enabled": true } } }
  ```

  控制台「工具」页写的就是这一段，改完立刻生效、不需要重启。
  启用后引擎会真的执行它：模型要求调用 → 本地执行 → 结果回喂 → 模型再答，
  一条消息里最多循环 `maxToolSteps` 步（默认 5）。会话历史里因此会出现
  `role: "tool"` 的消息，控制台以紧凑条块显示调用与结果。
  插件注册自己的工具（`ctx.tool()`）还没有做 —— 那需要一次单独的能力授予设计。

- **Provider** —— 模型的出站适配。内置 `openai` 与 `anthropic` 两种实现，
  在配置档文件的 `providerSources`/`providers` 段按类型声明，
  或者在控制台的「供应商配置」页里配。引擎从不 import 具体的模型 SDK。
  详见[模型 provider](#模型-provider)。

> 命名上注意区分三端：**adapter** 指入站接入（QQ、Discord、webhook…），契约是长驻的
> `start()`/`stop()`；**provider** 指出站模型调用，契约是每次请求的 `chat()`；
> **tool** 指模型请求、本地执行、结果回喂的一次性动作，契约是 `run()`。
> 三者形状不同，故意不用同一个词，也不要新造「model adapter」「function tool」这类混合称呼。

### 插件的动态加载

把「模块加载」和「实例创建」分开设计：

- 模块只 import 一次；ESM 没有移除模块的 API，因此重载时用 cache-busting
  （带 `?v=` 查询参数）重新 import，拿到重新求值过的代码。
- 每次加载都由框架创建插件实例，其副作用通过 `ctx.effect()` 登记；卸载时框架
  **逆序**自动释放，无需手写清理。

`PluginManager` 提供 `load(dir)` / `reload(id)` / `unload(id)` / `setEnabled(id, bool)`，
并在 `stop()` 时 `unloadAll()`。控制台右侧面板可执行重载 / 启用 / 禁用 / 卸载。

**一颗插件坏了只影响它自己。** 加载（含 `setup()`）抛错的插件被记为 `failed` 并带上失败原因，
`loadAll()` 记下这一条后继续扫下一个 —— 启动不会因为它退出，控制台插件页显示原因与「重载」，
`list_plugins` 那颗工具也如实报告它「上次加载失败」。常见的三种失败与它们的修法：

| 失败原因                           | 怎么修                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `index.js` 没有导出 `id`           | 补上 `id`（工厂写法也要在返回的对象里带）               |
| `插件 id "..." 不能用作数据目录名` | 改成小写字母/数字开头、只含 `a-z0-9._-`、不超过 64 字符 |
| `插件 id "..." 与已加载的插件冲突` | 两份插件不能共用一个 id：改其中一个的 `id`              |

`id` 之所以要有这三条约束，是因为它同时是**日志里的标识**、**`ctx.dataDir` 的路径组件**与
**插件之间互相识别的键**：它能穿越目录、能伪造日志行、还能让后加载的一份拿到前一份的数据目录。

插件上下文 `ctx` 暴露：

- `logger`、`config`：日志器与**插件可见的配置**。`config` 是白名单视图，目前只有
  `pluginDirs` 一条键；口令、provider 的 `apiKey` 这类运行期配置不会交到插件手上
  （理由见 [插件可见的配置](./docs/architecture.md#插件可见的配置白名单视图)）。
  插件默认导出里声明的 `config` 段会合并进来，同名时插件的键优先。
- `ctx.effect(fn | { dispose() }, label?)`：登记副作用，卸载时逆序自动释放，返回提前释放函数
- `ctx.subscribe(emitter, event, handler)`：订阅 emitter，并在卸载时自动退订
- `ctx.dataDir`：这个插件**自己**的数据目录（绝对路径），首次访问时才创建。
  从这份档的数据目录读回来的东西，换一份档就是另一份（同一个插件被两份档各开一次，
  就是两份独立的登录态 / 缓存 / 限流预算）。
  存东西请用它，别往插件自己的目录里写 —— 那个目录是用户从上游拷来的代码，
  升级会被整个替换、改名会换目录，写在那儿的数据跟着一起没。
  目录位置是 `<dataDir>/profiles/<配置档 id>/plugins/<你的 id>`，所以**卸载、禁用、
  重命名插件目录都不会丢数据**，
  而框架从不删它（要清理请自己 `rm -rf data/profiles/<配置档 id>/plugins/<id>`）。
  id 必须能当目录名用（小写字母/数字开头，只含 `a-z0-9._-`，≤64 字符）——
  不合规的插件在登记那一刻就被拒，见上面的失败表
- **同一个 `index.js` 会按配置档各求值一次。** 插件安装是全局的（部署级 `pluginDirs`），
  每份配置档只决定开不开它；而每档拿到的是**自己那份模块实例**，所以模块顶层的
  一次性副作用（注册全局 handler、起定时器、读文件建缓存）会执行 N 次而不是 1 次。
  该放在 `setup()` 里的状态就放在 `setup()` 里 —— 那里本来就是一份配置档一次。
  这样做的理由不是洁癖：不各求值一份，两份配置档的同一个插件就会共享模块级的那个变量，
  后启动的一方把它盖掉，先启动的那方随后拿着别人的数据目录继续写。
- `ctx.plugins()`：**实时**列出此刻已登记的插件（含你自己，也含上一次加载失败的那些——
  它们的 `enabled` 为 `false`），每项只有 `id` / `name` / `version` / `description` / `enabled`
  五个键。拿不到同伴的目录，也拿不到它们的失败原因（那是第三方文本，里面可能有绝对路径）；
  要每次读现值而不是存下来，因为插件是在运行期被加载、重载与启停的

## API

基础路径 `/api/v1`：

| 方法         | 路径                                            | 说明                                                                                    |
| ------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| GET          | `/health`                                       | 存活检查（公开）                                                                        |
| POST         | `/auth/login`、`/auth/logout`                   | 登录 / 登出（公开，见上）                                                               |
| GET          | `/auth/me`、`/auth/status`                      | 当前用户 / 是否需要登录                                                                 |
| GET / POST   | `/sessions`                                     | 列出（默认最新 100 个，创建序 + `nextCursor`）/ 创建会话                                |
| GET / DELETE | `/sessions/:id`                                 | 读取（默认**最新 100 条**消息 + `nextCursor`）/ 删除会话                                |
| POST         | `/sessions/:id/messages`                        | 发送用户消息，等完整回复后返回（同会话串行，占用中返回 409）                            |
| POST         | `/sessions/:id/messages/stream`                 | 同上，但以 SSE 逐段推送回复增量（409 在开流**之前**判，所以是状态码而不是流里的错误帧） |
| GET          | `/providers`、`/plugins`、`/adapters`、`/tools` | 供控制台使用的状态                                                                      |
| POST/DELETE  | `/providers`、`/providers/:id`                  | 新增 / 修改 / 删除模型实例                                                              |
| GET          | `/provider-sources`                             | 列出 provider source（**明文含 apiKey**）                                               |
| POST/DELETE  | `/provider-sources`、`/provider-sources/:id`    | 新增 / 修改 / 删除 provider source                                                      |
| POST         | `/provider-sources/:id/models`                  | 按已保存的凭证拉取上游模型列表                                                          |
| POST         | `/plugins/:id/reload`                           | 重载插件（销毁旧实例并重新求值代码）                                                    |
| POST         | `/plugins/:id/unload`                           | 卸载插件（释放副作用并移除）                                                            |
| POST         | `/plugins/:id/enable`                           | 在**这份配置档**里启用 / 禁用插件，body `{ "enabled": true }`（插件本身是全局安装的）   |
| POST         | `/tools/:id/enable`                             | 启用 / 禁用工具，body `{ "enabled": true }`（必填）                                     |
| GET          | `/profiles`                                     | 列出全部配置档及其加载状态（含 `failed` 与它的原因）                                    |
| POST         | `/profiles`                                     | 新建配置档，body `{ id, name? }`                                                        |
| POST         | `/profiles/:id/rename`、`/profiles/:id/reload`  | 改显示名 / 重读配置文件并换上新的对象图                                                 |
| DELETE       | `/profiles/:id`                                 | 下线配置档（**不删文件**；它正被某个会话占用时返回 409）                                |

除标注「公开」的路径外，其余接口都需要登录（未登录返回 401）。

**下面这些路径还必须带 `?profile=<配置档 id>`**：`/providers*`、`/provider-sources*`、
`/tools*`、`/plugins*`、`/sessions/:id/messages[/stream]`。缺了它一律 **400**，
不会回落到 `default` —— 「界面在 B、写进 A、还回 201」这类错只有在服务端拒绝猜的时候才可能被发现。
`/health`、`/auth/*`、`/sessions*`（列表与增删会话本身）、`/adapters`、`/profiles*` 不需要：
对话历史是**全局一份** sqlite，不属于任何一份配置档。

**配置类**写操作落在**配置档文件**（`data/profiles/<id>/config.json`）上，读-改-写、
文件权限 `0600`，改完立刻生效、**不需要重启**：provider 靠重建注册表生效，工具靠每次现读文件
生效（启用状态不常驻内存，见 `docs/architecture.md`）。`atri.config.json` 现在唯一的写入者是
登录口令那一条路径。**会话与消息**则落在 `dataDir` 下的 `sessions.sqlite`
（同样 `0600`）—— 它们不是配置，不会写进任何配置文件，也不该被当成配置文件去 diff。
删除仍被引用的 provider source 会被拒绝并列出
引用者，除非带上 `?cascade=1`。详细的字段语义见[模型 provider](#模型-provider)。

WebSocket 位于 `/ws`，向客户端推送 `message` 与 `pong` 帧，并在**登录会话被显式作废**时
推送一帧 `unauthorized` 然后关闭那条连接：在另一个窗口点了登出，或服务端做了一次全量撤销。
令牌**到期**不发这一帧 —— 它表现为下一个请求的 401。两种情况客户端都走同一条路
（清空登录态并回登录页）。`reason` 是给人看的，别拿它做分派。

握手之后的连接只在该登录会话活着的时候收得到内容：作废时那一帧发完就 `close`，
不存在「窗口关着但还在读别人对话」的状态。服务正常关停/重启**不**发这一帧
（那会让每个开着控制台的浏览器在每次发版后被弹回登录页，读起来像被踢了）。

### 流式回复

`POST /sessions/:id/messages/stream` 与等完整回复的接口**并存**，而不是取代它：
批量调用方（适配器、脚本）不需要流式的复杂度，而 UI 要首字尽快可见。
两者走同一个引擎，落库内容一致。

响应是 `text/event-stream`，每个事件的 data 是一个 JSON 对象：

```
data: {"delta":"你","done":false}
data: {"delta":"好","done":false}
data: {"delta":"","done":true,"message":{...}}
```

两条容易踩的约定：

- **错误走事件，不走状态码**。响应头一旦发出就无法再改状态码，因此参数校验
  （空 `content`）与「会话不存在」都在**开流之前**判定并回 400/404，
  而开流之后上游才出错（密钥无效、限流）则以 `{"error":"...","done":true}` 事件下发。
- 客户端断开连接时服务端会**中断上游请求**，避免为已经没人接收的响应继续消耗 token。
  关停服务时也会先掐断进行中的流——否则 `server.close()` 会一直等这些长连接自然结束而挂住。

### OpenAPI 与前端客户端

`apps/server/openapi.json` 是接口规范的**唯一源头**，前端调用的类型化 SDK
由它生成到 `apps/dashboard/src/api/generated/`（生成物入库，不做手改）：

```bash
pnpm codegen        # openapi-ts -f openapi-ts.config.ts
```

`pnpm check` 里的 `codegen:check` 会重新生成一次并校验工作区没有变化，
所以**改了接口就必须同步提交生成物**。校验用的是 `git status --porcelain`
而不是 `git diff`：后者看不见未跟踪文件，新增端点时会漏报，而那正是最需要报警的情况。

`codegen:check` 只保证「生成物 = 规格」，**不保证规格说的是真话**。规格与实现之间由三道测试守着：
`test/openapi.test.ts` 管路径与方法，`test/openapi-response-shape.test.ts` 真实驱动全部端点、
逐字段比对响应体（`type`/`required`/枚举/状态码），`test/openapi-request.test.ts` 管请求侧与鉴权侧
（省略必填字段必须 400、畸形 JSON 必须 400、匿名访问与规格声明的 401 双向一致）。
因此**改任何一个接口字段的提交，都必须同时改 `openapi.json` 并重新 codegen**；
红了的正确反应是改规格，不是改这三个测试。

生成物不参与 oxlint/oxfmt（见两者配置的 `ignorePatterns`），以保证
「重新生成后无差异」这条检查是可信的。

手写的 `apps/dashboard/src/api/client.ts` 是唯一的调用入口，负责三件生成物不管的事：
统一把失败转成异常（生成客户端默认把 AxiosError 当返回值）、把 401 归一成
`UnauthorizedError`、以及给 axios 配上 `withCredentials` 与 `bodySerializer`。
WebSocket 不属于 OpenAPI 能描述的范围，那一段也是手写的。
