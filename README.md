# atri-bot

一个**可扩展的 agent 平台**：服务端负责运行 agent 引擎、适配器与插件，另配一个 Web 控制台。
项目采用 pnpm monorepo 组织，使后端、前端与共享代码可以各自独立演进，同时共享类型。

## 目录结构

```
atri-bot/
├── apps/
│   ├── server/          # 主程序（agent 引擎 + API）
│   │   ├── src/
│   │   │   ├── index.js     # 薄入口：配置 -> 应用 -> 启动 -> 关闭
│   │   │   ├── app.js       # 组合根（在一处完成所有装配）
│   │   │   ├── config/      # 配置加载（默认值 -> 文件 -> 环境变量）
│   │   │   ├── core/        # 引擎、会话、provider、logger（全部逻辑）
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

- Node >= 20.19
- pnpm 11（`corepack enable`，或由 `packageManager` 字段自动安装）

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
| `pnpm typecheck`     | 对全部包做类型检查                                 |
| `pnpm lint`          | oxlint 检查（告警即失败）                          |
| `pnpm format`        | oxfmt 统一格式                                     |
| `pnpm format:check`  | 只校验格式，不改文件                               |
| `pnpm test`          | 运行全部测试                                       |
| `pnpm check`         | 依次跑 typecheck / lint / 格式 / 生成物漂移 / 测试 |
| `pnpm codegen`       | 按 `apps/server/openapi.json` 重新生成前端客户端   |
| `pnpm clean`         | 清理构建产物                                       |

仓库没有配置 CI，`pnpm check` 需要手动运行（提交前跑一次）。

## 配置

解析顺序：**内置默认值 → `atri.config.json` → 环境变量**。
环境变量可参考 `.env.example`；基于文件的设置可复制 `atri.config.example.json` 为 `atri.config.json`。
密钥放在环境变量里，结构性设置放在文件里。

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

| 变量                  | 默认值                | 说明                                                        |
| --------------------- | --------------------- | ----------------------------------------------------------- |
| `ATRI_ADMIN_USER`     | `admin`               | 管理员用户名                                                |
| `ATRI_ADMIN_PASSWORD` | 无（自动生成）        | 管理员口令                                                  |
| `ATRI_COOKIE_NAME`    | `atri_session`        | 会话 Cookie 名                                              |
| `ATRI_COOKIE_SECURE`  | 关                    | 加 `Secure` 属性，仅 HTTPS 有效；本仓默认明文 HTTP 故默认关 |
| `ATRI_STATIC_DIR`     | `apps/dashboard/dist` | 控制台构建产物目录                                          |

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
- 口令比对用 `timingSafeEqual` 对 **sha256 定长摘要**做比较，避免长度差异泄露信息；
  用户名与口令**都**参与比对（用户名不存在时也照常走完），
  且失败一律返回同一句「账号或密码错误」，不区分是哪一项错了。
- `/api/v1` 下除上述公开路径外**一律需要登录**。鉴权闸门设在路由匹配**之前**，
  因此未登录访问不存在的 API 路径返回 **401 而非 404**——
  否则匿名调用者可以靠 401/404 的差异枚举出哪些端点存在。
- WebSocket 复用同一个 Cookie 完成握手（浏览器无法为 WS 握手自定义请求头），
  未登录的连接在握手阶段即被以 401 拒绝。

## 模型 provider

在 `atri.config.json` 的 `providers` 段声明。`type` 决定用哪个实现，目前支持
`openai`（含所有 OpenAI 兼容网关）与 `anthropic`：

```json
{
  "providers": {
    "default": "deepseek",
    "deepseek": {
      "type": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "",
      "models": ["deepseek-chat"]
    },
    "claude": { "type": "anthropic", "apiKey": "", "models": ["claude-sonnet-4-5"] }
  }
}
```

| 字段        | openai                           | anthropic                                              |
| ----------- | -------------------------------- | ------------------------------------------------------ |
| `baseUrl`   | 默认 `https://api.openai.com/v1` | 默认 `https://api.anthropic.com/v1`                    |
| 鉴权        | `Authorization: Bearer`          | `x-api-key` + `anthropic-version`（默认 `2023-06-01`） |
| `models`    | 供控制台与选路使用               | 同左                                                   |
| `maxTokens` | 不发送（由上游决定）             | **必填**，默认 `8192`                                  |
| `headers`   | 额外请求头                       | 同左                                                   |
| `timeoutMs` | 默认 `120000`                    | 同左                                                   |

`default` 是保留键（字符串），指向默认 provider 的 id；也可以改成在某个 provider
上写 `"default": true`。没配默认值时的选路顺序是：**显式模型名命中 → 默认 provider → 第一个注册的**。
模型名对不上任何 provider 的 `models` 时**仍会退回默认 provider**——
上游的模型列表通常比本地配置新，本地列表不该当成硬闸门。

单个 provider 配错（类型拼错、构造抛错）只会记一条日志，不影响其它 provider 启动；
但如果配了 `default` 而它恰好加载失败，**不会静默换个 provider**——
否则请求会悄悄打到另一个模型上，只留一条 warn 日志说明会回退。

一个 provider 都没配时，回复退化为**回声**（`[回声:模型名] 原文`）以便先把链路跑通。
一旦有 provider 注册，调用失败就会如实抛错，不会伪装成正常回复。

密钥解析顺序：provider 自己的 `apiKey` → 环境变量 `ATRI_<ID>_API_KEY`。
因为密钥留在磁盘文件里终究不如注入环境变量安全，容器部署建议只用后者
（见 `.env.example`）。

## 生产部署

`pnpm build` 后，服务端会托管 `apps/dashboard/dist` 并做 **SPA 回退**，
因此只跑一个进程即可对外服务；`pnpm dev:dashboard` 只在开发时需要。

```bash
pnpm build
pnpm start            # 或 node apps/server/src/index.js
# 打开 http://127.0.0.1:6185
```

带哈希的静态资源长缓存，`index.html` 使用 `no-cache`（否则发版后浏览器会拿旧外壳）。
静态目录之外的路径一律 403，不会读出仓库外的文件。

## 扩展方式

- **插件** —— 一个目录，内含 `index.js`，默认导出
  `{ id, name, version, description?, config?, setup(ctx), teardown?() }`
  （也支持默认导出工厂函数 `(shared) => 上述对象`）。目录来自配置中的 `pluginDirs`。
  参见 `apps/server/plugins/hello`。
- **适配器** —— 实现 `start()`/`stop()` 并注册到 `AdapterManager`；
  在 `config.adapters.<id>.enabled` 中按需启用。纯 agent 部署可以不启用任何一个。
- **Provider** —— 模型的出站适配。内置 `openai` 与 `anthropic` 两种实现，
  在 `atri.config.json` 的 `providers` 段按类型声明即可，引擎从不 import 具体的模型 SDK。
  详见[模型 provider](#模型-provider)。

> 命名上注意区分两端：**adapter** 指入站接入（QQ、Discord、webhook…），
> 契约是长驻的 `start()`/`stop()`；**provider** 指出站模型调用，
> 契约是每次请求的 `chat()`。两者是不同形状的接口，故意不用同一个词。

### 插件的动态加载

把「模块加载」和「实例创建」分开设计：

- 模块只 import 一次；ESM 没有移除模块的 API，因此重载时用 cache-busting
  （带 `?v=` 查询参数）重新 import，拿到重新求值过的代码。
- 每次加载都由框架创建插件实例，其副作用通过 `ctx.effect()` 登记；卸载时框架
  **逆序**自动释放，无需手写清理。

`PluginManager` 提供 `load(dir)` / `reload(id)` / `unload(id)` / `setEnabled(id, bool)`，
并在 `stop()` 时 `unloadAll()`。控制台右侧面板可执行重载 / 启用 / 禁用 / 卸载。

插件上下文 `ctx` 暴露：

- `logger`、`config`：日志器与配置（只读）
- `ctx.effect(fn | { dispose() }, label?)`：登记副作用，卸载时逆序自动释放，返回提前释放函数
- `ctx.subscribe(emitter, event, handler)`：订阅 emitter，并在卸载时自动退订

## API

基础路径 `/api/v1`：

| 方法         | 路径                                  | 说明                                        |
| ------------ | ------------------------------------- | ------------------------------------------- |
| GET          | `/health`                             | 存活检查（公开）                            |
| POST         | `/auth/login`、`/auth/logout`         | 登录 / 登出（公开，见上）                   |
| GET          | `/auth/me`、`/auth/status`            | 当前用户 / 是否需要登录                     |
| GET / POST   | `/sessions`                           | 列出 / 创建会话                             |
| GET / DELETE | `/sessions/:id`                       | 读取（含完整消息历史）/ 删除会话            |
| POST         | `/sessions/:id/messages`              | 发送用户消息，等完整回复后返回              |
| POST         | `/sessions/:id/messages/stream`       | 同上，但以 SSE 逐段推送回复增量             |
| GET          | `/providers`、`/plugins`、`/adapters` | 供控制台使用的状态                          |
| POST         | `/plugins/:id/reload`                 | 重载插件（销毁旧实例并重新求值代码）        |
| POST         | `/plugins/:id/unload`                 | 卸载插件（释放副作用并移除）                |
| POST         | `/plugins/:id/enable`                 | 启用 / 禁用插件，body `{ "enabled": true }` |

除标注「公开」的路径外，其余接口都需要登录（未登录返回 401）。

WebSocket 位于 `/ws`，向客户端推送 `message` / `stream` / `error` / `unauthorized` 帧。
收到 `unauthorized` 表示会话在连接期间失效，客户端应清空登录态并回到登录页。

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

生成物不参与 oxlint/oxfmt（见两者配置的 `ignorePatterns`），以保证
「重新生成后无差异」这条检查是可信的。

手写的 `apps/dashboard/src/api/client.ts` 是唯一的调用入口，负责三件生成物不管的事：
统一把失败转成异常（生成客户端默认把 AxiosError 当返回值）、把 401 归一成
`UnauthorizedError`、以及给 axios 配上 `withCredentials` 与 `bodySerializer`。
WebSocket 不属于 OpenAPI 能描述的范围，那一段也是手写的。
