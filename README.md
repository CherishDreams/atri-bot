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

配置分**三层**，实际落在六个文件里（人格与计划任务也是部署级运行期资源）：

| 层               | 文件                             | 里面是什么                                                                                               | 谁写它                                            |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 部署级（启动）   | `atri.config.json`（仓库根）     | 监听地址与端口、日志级别、数据目录、插件安装目录、静态目录、登录口令                                     | 手写；`auth.adminPassword` 由服务端首次启动时填入 |
| 部署级（运行期） | `data/providers.json`            | 供应商：`providerSources`（连接与密钥）与 `providers`（模型实例清单 + 全局默认）                         | 控制台的「供应商」页，或手写                      |
| 部署级（运行期） | `data/adapters.json`             | 接入平台实例：类型、绑定配置、启停、平台字段                                                             | 控制台的「接入平台」页，或旧配置迁移              |
| 部署级（运行期） | `data/personas.json`             | 可复用的人格：`id` / 名称 / 说明 / 系统提示词                                                            | 控制台的「人格配置」页                            |
| 部署级（运行期） | `data/cron.json`                 | 计划任务：名称、cron、提示词、所用配置档、启停与最近一次结果                                             | 控制台的「计划任务」页                            |
| 配置档           | `data/profiles/<id>/config.json` | 这份「跑法」开哪些工具、单轮最多几步、开哪些插件、用哪个人格、默认用哪个模型、这一档的白名单与管理员名单 | 控制台的「配置文件」页，或手写                    |

为什么供应商不按配置档各存一份：它里面是**密钥与端点**，按档复制只会让同一个 `apiKey`
躺在 N 个文件里，而「换一档换一套后端」在真实使用里从来没有发生过（bot 侧发消息根本不传
model）。这一条分界与 AstrBot 一致：除了配置文件，其余都是全局的，配置档只管启用与默认值。

控制台采用 AstrBot 式的**顶栏 + 分组侧栏 + 整页内容**，把三层分成
**一个「配置文件」页 + 六个整页**：

- **「配置文件」页**（`/config`）：左上角显示并切换当前配置，左侧五类（默认模型 / 人格 /
  工具 / 运行参数 / 访问控制），右侧是该分类的配置项。五类都写
  `data/profiles/<id>/config.json`，都**先改草稿、点「保存」才写回**（离开或切档时会拦一道）。
  访问控制是这一档的名单，绑定到这一档的所有接入平台共用它。`/tools` 与 `/access`
  是转进对应分类的旧链接。
- **「人格配置」页**（`/personas`）：全局人格库，新建 / 编辑 / 删除人格提示词；被配置档引用的
  人格删除会回 409。配置档只在「配置文件 → 人格」里选用哪一份，本体不按档复制。
- **「插件」页**（`/plugins`）：已安装的插件、它们在这份配置里的启用状态，以及按
  `_conf_schema.json` 渲染的配置表单。页头可以直接切换配置；启停与配置都是**即时动作**，
  保存配置后插件自动重载。抽屉里有未保存改动时，先保存或关闭抽屉再切配置。
- **「供应商」页**（`/providers`）：部署级全局一份，增删源与模型**即时**写回
  `data/providers.json`。`/provider` 是它的旧链接。
- **「接入平台」页**（`/adapters`）：新增、编辑、删除、启用/禁用接入平台实例（目前 NapCat）。
  配置写进 `data/adapters.json`，全程在网页完成，不需要手写 JSON。
- **「计划任务」页**（`/cron`）：按 5 段 cron 定时执行提示词。任务选用一份配置档，
  结果写进任务自己的内部会话，可在页面上跳到该会话；支持立即执行、启停与删除。
- **「日志」页**（`/logs`）：服务端最近 500 行日志，按级别过滤、实时追加、跟随滚动。
  日志只在内存里，重启即清空；它不属于任何配置，也不进 `data/`。
- 配置本身的增删不单独占一页：在「配置文件」页左上角的切换器里点「管理配置」。
  创建后**不能改名**（id 是目录名），删除会连同 `profiles/<id>/` 一起移除。

主导航按「运行 / 个性化配置 / 接入与扩展 / 系统」分组（对齐 AstrBot）：

| 分组       | 菜单项                   |
| ---------- | ------------------------ |
| 运行       | 控制台                   |
| 个性化配置 | 配置文件、人格配置、插件 |
| 接入与扩展 | 供应商、接入平台         |
| 系统       | 计划任务、日志           |

「配置文件」页只放本档的五类。人格库与计划任务虽然也回答「这台 bot 怎么跑」，但它们是部署级
资源（一份人格可被多档引用、任务自己保存所用配置档），所以各自是主导航的一项，而不是配置文件
页里的分类；访问控制相反，它的名单按档保存，所以留在配置文件页。供应商与接入平台改的是外部
连接与平台实例（端口、token、启停、重连），不属于「这一跑法」。插件与工作台也不是同一种写入
语义：它的配置是 schema 驱动的「改一项、保存即重载」，合在一页会让两套写入方式并存。
日志更不在配置文件页里：它是进程级输出，不属于任何一份配置。

解析顺序对**启动那一份**成立：**内置默认值 → `atri.config.json` → 环境变量**。
环境变量可参考 `.env.example`；`atri.config.example.json` 复制成 `atri.config.json`，
`providers.example.json` 复制成 `data/providers.json`，
`atri.profile.example.json` 复制成 `data/profiles/<你的 id>/config.json`。
密钥放在环境变量里，结构性设置放在文件里。

为什么运行期的几份都住在 `data/` 而不是仓库根的一个 `configs/` 目录：`.gitignore` 忽略的是
**精确名** `atri.config.json`，把带 `apiKey` 的兄弟文件放进仓库根就是「未跟踪但也不忽略」——
一次顺手 `git add -A` 会把所有配置档的密钥提交进版本库。`data/` 整体被忽略，
并且权限是 `0700`。

第一次启动时，服务端会把配置搬到位并各打一条日志：

- `atri.config.json` 里的 `tools` / `maxToolSteps` **一次性搬进**
  `data/profiles/default/config.json`（`seedProfile`）。
- 供应商搬进 `data/providers.json`：各配置档文件里有过 `providers` / `providerSources`
  就从**各档合并**（那是上一版的形状；同名冲突由字典序最小的那份档赢，其余逐条点名），
  一份档里都没有就取 `atri.config.json` 里那一段（那是最初的安装）。

搬过之后那些旧位置里的段**不再生效**（框架不删你的文件，但每次启动都会 warn 一次提醒
它们已经是个摆设，并说清真源在哪个文件）。`default` 这个名字没有任何运行期特权：
它只是第一次落盘的位置，控制台会优先把界面切到它，而每个请求仍然把档名写在 URL 上。

### 接入平台管理

适配器实例住在**运行期**的 `data/adapters.json`，控制台的「接入平台」页负责新增、编辑、
删除与启停；用户不需要改任何 JSON。每个实例有一个 `profile`，说它**跑在哪份配置**上：
平台占的资源（监听端口、webhook、平台 token）属于部署，而「用哪套模型与工具」才按配置分。

绑定指不到一份可用配置时，那个实例**不会被启动**，原因显示在卡片上，也写进日志 ——
不退回 `default`，也不挑第一个能用的档：跑错一套配置没有任何症状，平台侧的流量照样进来。
`GET /adapters` 把几件事分开报：`enabled`（开关）、`bound`（绑的配置现在可用）、
`running`（实例是否成功启动）与 `error`（上一次启动失败的原因）。

旧版 `atri.config.json` 的 `adapters` 段只在 `data/adapters.json` 不存在时**迁移一次**；
迁移之后它不再生效，控制台会提示这一点。要加第二个同类型账号，就在页面上再添加一个实例。

#### NapCat 适配器

仓库内置的 NapCat 适配器走 **OneBot 11 反向 WebSocket**（与 AstrBot 一致）：
**atri-bot 监听，NapCat 作为 WebSocket 客户端连进来**。先在控制台「接入平台」页添加
NapCat，填写：

- 监听地址：`0.0.0.0`（容器/远程都能连）或 `127.0.0.1`（仅本机）
- 监听端口：`6199`
- WebSocket 路径：`/ws`
- Access Token：添加时页面会自动生成，也可以改成自己的
- 配置：选一份可用配置
- 启用：打开

保存后 atri-bot 开始监听；`/adapters` 的 `running` 表示**监听器已启动**，NapCat 客户端
是否连上、何时重连看服务端日志。然后在 NapCat WebUI 的「网络配置」里新建
**WebSocket 客户端**：

- URL：`ws://<atri-bot 所在主机>:6199/ws`；如果 NapCat 在 Docker 而 atri-bot 在宿主机，
  用 `ws://host.docker.internal:6199/ws`（仓库的 compose 已加 `host-gateway`）。
- Token：与表单里的 Access Token 一致。

服务端同时接受 `Authorization: Bearer <token>` 与 `?access_token=<token>` 两种写法。
Token 保存在 `data/adapters.json`（目录 `0700`、文件 `0600`），不要写进日志或提交。

> 之前版本的正向 WS 实例不会自动转换：旧配置里的 `url` 是「NapCat 服务器地址」，
> 而反向模式需要的是「atri-bot 的监听地址/端口/路径」，方向已经反过来。请在页面里
> 编辑或重新添加一次，并把 NapCat 的网络配置改成 WebSocket 客户端。

- 私聊按 QQ 号各建一条内部会话；群聊按群号建一条，所有成员共享，模型看到的每条消息带
  `[群名片或昵称]` 前缀。群聊目前对**所有**文本消息响应，不要求 `@` 机器人。
- 会话映射落在 `data/adapters/<实例 id>/sessions.json`（目录 `0700`、文件 `0600`）；
  里面只有「外部会话 → 内部会话 id」，不含消息内容或凭证。删掉映射或从控制台删掉会话后，
  下一条消息会新建一条会话。
- 图片会**实际下载**并作为多模态附件交给模型：支持 PNG / JPEG / GIF / WebP，单张上限
  4 MiB、单条最多 4 张；下载失败或超限时退回 `[图片]` 占位，消息本身不会丢。所选模型
  必须支持视觉输入，否则上游会拒绝带图的请求。`at` 归一成 `@QQ号`，语音/文件等仍是占位。
  长回复按 1500 字左右在换行/空格处切块发送；机器人自己的消息会被忽略。
- 客户端断开后由 NapCat 自己重连，atri-bot 的监听不关闭；连接/断线写服务端日志。
- 收到与回复都会写结构化日志，例如：
  `[napcat:privateMessage:123456]: 你好`、`[napcat:groupMessage:456]: [群名片] 大家好`、
  `发送[napcat:privateMessage:123456]:你好`。图片消息在日志里显示 `[图片]`；群聊内容带
  发送人前缀，「日志」页可以直接按 `privateMessage` / `groupMessage` / QQ 号搜索。
- v1 不做正向 WebSocket（不需要 NapCat 再开 WS 服务器）、图片上传、好友/加群请求处理；
  这些是后续的适配器能力。

##### 用 Docker 跑 NapCat（本地调试）

仓库根的 `docker-compose.yml` 负责协议端；QQ 登录态、配置、日志与插件都落在
`.napcat/`（已 gitignore，可以直接打开排查）：

```bash
docker compose up -d napcat
docker compose logs -f napcat
```

- WebUI：<http://127.0.0.1:6099>。登录 token 在 `.napcat/config/webui.json`
  （首次启动后生成；也可以看容器日志里的 WebUI 地址）。
- 扫码登录 QQ 后，先在控制台「接入平台」页添加 NapCat（监听 `0.0.0.0:6199`、
  路径 `/ws`，页面会生成 token），再到 WebUI 的「网络配置」里新增 **WebSocket 客户端**：
  URL 填 `ws://host.docker.internal:6199/ws`（compose 已让容器可以访问宿主机），
  Token 填页面生成的那一个。
- 端口在 compose 里只绑定 `127.0.0.1`。要从别的机器访问 WebUI，改端口绑定前先想清楚
  它等同于协议端的管理入口。
- `docker compose down` 只停容器，`.napcat/` 里的数据保留；升级用
  `docker compose pull && docker compose up -d`。
- 挂载目录默认按 root（UID/GID 0）写；普通用户可先执行
  `NAPCAT_UID=$(id -u) NAPCAT_GID=$(id -g) docker compose up -d`。

## 人格、访问控制与计划任务

### 人格

人格是**全局资源**（`data/personas.json`），一份人格包含 id、名称、说明与系统提示词；
每份配置档在 `config.json` 里只保存一个 `personaId` 引用。这样同一个人格可被多份配置复用，
改一次所有引用它的配置下一轮就生效，不会出现 N 份会漂移的副本。

提示词作为 **system 消息**注入每一轮请求，**不写进会话历史**：它没有「什么时候说过」的语义，
写进 sqlite 会让历史详情多出一条假消息，也会在修改人格后留下旧版本。切换人格不需要重建引擎；
组合根在保存后同步正在运行的引擎。

### 白名单与管理员

访问控制是**配置档的属性**（`data/profiles/<id>/config.json` 的 `access` 段），不是平台实例的：

- 每份档一张名单：开启白名单、允许的私聊用户 id 或群 id、管理员用户 id；
- 绑定到这一档的所有接入平台共用它；换一档就是另一张，互不影响；
- 在「配置文件 → 访问控制」里改，和本档其他项一起点「保存」；保存后下一条消息立即按新名单
  判断，不重启 WebSocket 监听。

管理员**始终越过白名单**，这是白名单配错时不让机器人彻底失联的逃生口。群聊按群 id 判白名单，
私聊按发送人 id。被挡下的消息只写一条带事件键的日志，不记录正文。

名单里存的是平台坐标（QQ 号、群号）。把两个不同平台绑到同一份配置档时，它们的 id 会共用
这一张表；需要各自独立的名单，就把它们绑到不同的配置档。

### 计划任务

任务保存在 `data/cron.json`，字段是名称、5 段 cron、提示词、所用配置档与启停。调度器使用
**服务器本地时区**，最小粒度是分钟；服务启动时不为过去的时刻补跑。到点后用指定配置档的
人格、模型与工具跑一轮，结果写进任务自己的内部会话（第一次执行时创建）。

任务可以在控制台「立即执行」，也可以禁用后保留配置。今天的版本不把结果主动发到 QQ/其他平台：
主动发送需要平台侧寻址与额外权限，先把「按时跑一轮、结果可查」做对。

## 登录鉴权

控制台使用**单一管理员账号**保护。默认不配任何东西也能跑：未提供口令时，
服务端启动会生成一个随机口令、写进 `atri.config.json` 的 `auth.adminPassword`，
并**在日志里打印一次**——那是拿到初始口令的唯一途径，请立即保存。
`atri.config.json` 已被 `.gitignore` 忽略，因为它含有明文口令。
服务端**每次启动**都会把这个文件收紧到 `0600`：它里面除了口令，还可能留着一次性 seed
搬走之后**失效但仍是明文**的 `providerSources.*.apiKey`（那几段现在只是残留，界面上改
provider 配置不会再写这个文件，所以收紧不能等某次保存，只能在启动做）。

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

这一段属于**部署级全局的一份**，写在 `data/providers.json`（不是 `atri.config.json`，
也不再是各配置档的文件）：

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

而「这一档默认用清单里的哪一个」写在**这一档自己的文件**里：

```json
{ "name": "工作", "defaultProvider": "claude-sonnet" }
```

它存的是**实例 id**而不是模型名（实例 id 才是选路的第一级判据，而模型名不再全局唯一）。
没写这一项时用上面 `providers.default` 那一个。控制台的模型选择器改的就是这一键，
所以它跟着配置档走、跟着备份走，而不是跟着某个浏览器走。

`type` 决定用哪个实现，目前支持 `openai`（含所有 OpenAI 兼容网关）与 `anthropic`：

| 字段        | openai                           | anthropic                                              |
| ----------- | -------------------------------- | ------------------------------------------------------ |
| `baseUrl`   | 默认 `https://api.openai.com/v1` | 默认 `https://api.anthropic.com/v1`                    |
| 鉴权        | `Authorization: Bearer`          | `x-api-key` + `anthropic-version`（默认 `2023-06-01`） |
| `maxTokens` | 不发送（由上游决定）             | **必填**，默认 `8192`                                  |
| `headers`   | 额外请求头                       | 同左                                                   |
| `timeoutMs` | 默认 `120000`（毫秒）            | 同左                                                   |

图片输入按两家自己的线协议编码：OpenAI 兼容接口发 `image_url` 内容块（data URI），
Anthropic 发 base64 `image` 内容块。适配器下载的图片会随消息落库并进入历史，
所以后续轮次仍能看见它；直接聊天接口目前不接收图片。模型本身需要支持视觉，
只配了一个纯文本模型时上游会拒绝请求。

`timeoutMs` 在两条路径上**不是同一个意思**：非流式（一次请求一次回答、拉模型列表）按
**总预算**算；流式按**空闲上限**算 —— 连续这么多毫秒没有任何增量才算卡住，
正在往前推的长回复不会被掐断。之所以要分开：引擎是在 `chatStream` 返回**之后**才落库助手那条，
中途掐死等于把一次已经成功的生成记成一次故障，而用户看到的是「消息没了，只有一句错误」。

**provider source**：`{ type, name?, baseUrl?, apiKey?, timeoutMs? }`，id 由键名给出，
创建后不可改名（改名要重写所有引用者，得不偿失）。
**provider（模型实例）**：`{ source, model, name?, enabled? }`，`enabled` 默认 `true`；
实例上的同名键（`baseUrl`/`timeoutMs`/`name`…）会**覆盖** source 上那一份。

`default` 是保留键（字符串），指向**全局**默认 provider 的 id；也可以改成在某个 provider
上写 `"default": true`。一条消息最终用哪个模型的次序是：
**请求里带的 → 这一档的 `defaultProvider` → 全局 `providers.default` → 第一个注册的**。
请求里带的值既可以是**实例 id**，也可以是模型名；控制台的模型选择器**不**往消息里塞这一项，
它改的是档默认，所以两份档可以各打各的模型而不必先切档。
模型名对不上任何 provider 时**仍会退回默认 provider**——
上游的模型列表通常比本地配置新，本地列表不该当成硬闸门。

单个 provider 配错（类型拼错、引用了不存在的 source）只会记一条日志，不影响其它
provider 启动，并且在控制台的「供应商」页里以 `loaded: false` + 原因显示出来；
但如果配了 `default` 而它恰好加载失败，**不会静默换个 provider**——
否则请求会悄悄打到另一个模型上，只留一条 warn 日志说明会回退。
某一档的 `defaultProvider` 指着没加载成功的那一个时同样是只 warn 不报错。
`enabled: false` 是**有意关闭**，只记 info 日志、不算故障，也不出现在模型选择器里。

`data/providers.json` 整个被改坏（手改成半截 JSON）时服务**照常起**：供应商注册表退化成
空的、每条消息走回声兜底，而「供应商」页会把那句读不出来的原因显示出来。
这是刻意的：那一时刻操作者最需要这个服务活着好去改这个文件，而把所有配置档都标成
不可用等于把改它的机会一起收走。

一个 provider 都没配时，回复退化为**回声**（`[回声:模型名] 原文`）以便先把链路跑通。
一旦有 provider 注册，调用失败就会如实抛错，不会伪装成正常回复。

密钥解析顺序：环境变量 `ATRI_<SOURCE_ID>_API_KEY` → 源自己的 `apiKey`。
**注入的才是真的**：两处都写了的时候环境变量赢，所以容器部署可以把密钥完全留在文件之外
（见 `.env.example`）。反过来说，文件里留下的那条 `apiKey` 在有环境变量时不会再被用到 ——
它只是「没注入时的兜底」。注意变量名跟**源**的 id 走，不是模型。

### 在控制台里配置

「供应商」页（`/providers`；旧的 `/provider` 与上一版配置页里的「供应商」分类都指向这里）
可以直接增删源与模型，改动**写回
`data/providers.json`**（全局那一份）并立即生效，不需要重启——在这里保存一次，每一档下一次
发消息用的就是它。这一页不跟着「配置文件」页那个「保存」键走，改动是即时的。
「获取模型列表」会拿**已保存的**凭证去打上游的 `GET /models`，所以源有未保存改动时按钮会
变成「保存并获取模型列表」。上游没有 `/models` 时可以用「自定义模型」手填模型 id 绕过。

「配置文件」页的「默认模型」分类改的是当前配置档的 `defaultProvider`（清单里挑一个实例），
**要按保存**；chat 顶栏那个模型选择器是它的快捷入口，写的是同一个键、走同一个服务端校验，
所以两处显示的永远是同一个默认，换浏览器、换设备也一样。

工具与单轮步数也在「配置文件」页的「本档配置」组里：它们都是**这一档**的属性，同样要点保存。
插件启停与插件配置在「插件」页，保存即生效。

两点需要知情：

- **`GET /provider-sources` 会明文返回 `apiKey`**，表单也是明文渲染（便于核对粘贴
  是否出错）。该接口仅管理员可访问，但密钥确实会回到浏览器，请不要在共享机器上使用。
- `baseUrl` 指向内网地址时，服务端会**代为请求**那个地址。这属于管理员的正常用法
  （自建网关），因此不做地址白名单；但这也意味着「供应商」页等同于一台内网请求代理，
  不要把管理员账号给不可信的人。

### 日志

「日志」页（`/logs`）显示服务端进程内存缓冲区里最近 500 行。SSE 实时推送；默认跟随底部，
向上翻之后停止自动滚动并出现「回到最新」；可按级别过滤，也可以只清空当前显示。

- 只收录 `ATRI_LOG_LEVEL` 允许的级别（默认 `info`），所以默认看不到 `debug`。
- 日志**不落盘**：服务重启即清空。需要长期保存或检索请收集进程的 stdout/stderr，
  而不是指望 `dataDir` 里有一个不断变大的日志文件。
- 只有登录后可访问。错误消息可能带文件系统绝对路径，但口令、密钥与令牌从不写进日志。
- `logger.*` 的 `meta` 参数只进控制台，不进日志页：任意对象的序列化形状不稳定，
  也不该把一份上下文顺手带到第二个出口。要展示的内容请写进消息本身。

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

`dataDir`（默认 `data/`，可用 `ATRI_DATA_DIR` 或配置文件里的 `dataDir` 改）下是这些运行状态：
`sessions.sqlite`（全部对话历史）、`providers.json`（供应商：连接、密钥与全局默认）、
`adapters.json`（接入平台实例与平台 token）、`adapters/<实例 id>/sessions.json`
（外部会话到内部会话的映射）、`profiles/<id>/config.json`（各配置档的跑法，
含「默认用清单里哪一个」），以及 `profiles/<id>/plugins/<插件 id>/`
（插件自己的数据与配置值；其中 `config.json` 由框架按 schema 读-改-写，其余内容框架不管理）。
**登录口令在 `atri.config.json`。** **需要备份的就是这几样**，
其余（`apps/dashboard/dist`）可由源码重新构建。
`providers.json`、`adapters.json` 与配置档文件里都可能有明文 `apiKey`/token，
所以它们与 `dataDir` 一起带走时要按同一档秘密对待。
整个 `dataDir` 的权限是 `0700`：保护落在**目录**上，`sessions.sqlite` 的 WAL 边车
（`-wal` / `-shm`）由 SQLite 按 umask 反复重建，逐文件收紧是一次性的假安全感。
`plugins/` 下**有目录不等于那个插件在跑**：加载失败的插件也留下了它已经写过的数据
（框架不会因为卸载/禁用插件删任何东西；删除整份配置时它的目录才一起消失），
是否可用请看控制台的插件页或 `list_plugins`。

- **容器里把 `dataDir` 挂成 volume**，否则重建容器等于清空所有历史。
- **`data/` 与 `atri.config.json` 都相对仓库根解析，从哪儿启动都一样。** 这个默认值曾经是
  `process.cwd()`，而 `pnpm dev` / `pnpm start` 都经 `pnpm --filter` 执行、cwd 是 `apps/server/`：
  从那套启动方式升上来的部署，配置与对话库留在 `apps/server/` 下，而服务端现在读的是仓库根。
  合并一次即可（`mv apps/server/atri.config.json .`，再把 `apps/server/data/` 并进 `data/`）。
  **两处都已经有 `sessions.sqlite` 时不要覆盖**——两份历史合不到一个库里，只能挑一份用、
  另一份改名留着；实在想保持原样就给老位置显式设 `ATRI_ROOT=apps/server`。
- **一个数据目录只跑一个实例。** 同会话串行那把锁是进程内的 `Map`（`core/session/lock.ts`，
  由组合根构造并注入每一份配置档的引擎，见 architecture.md 的「一轮对话为什么要串行」），
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
  目录里还可以放一份可选的 `_conf_schema.json`：它声明这个插件有哪些用户可配置项，
  控制台按它渲染表单，值落在插件自己的数据目录（见[插件配置](#插件配置)）。
  要存数据用 `ctx.dataDir`（见[插件的动态加载](#插件的动态加载)），**不要**写进插件自己那个目录 ——
  那个目录是会被升级覆盖、被用户改名的。参见 `apps/server/plugins/hello`。
- **适配器** —— 入站平台。消息类适配器继承 `adapters/message.ts` 的 `MessageAdapter`，
  实现 `start()` / `stop()` / `sendText()`；`adapters/templates.ts` 声明可添加的类型与表单字段，
  `AdapterConfigStore` 把实例存到 `data/adapters.json`，`AdapterManager` 管增删改与启停。
  会话映射、发送人前缀、按会话串行与长回复切块由基类统一处理。
  控制台的「接入平台」页是唯一写入口。仓库内置 `NapCat`（OneBot 11 反向 WebSocket），
  见上面的 [NapCat 适配器](#napcat-适配器)。
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
  在 `data/providers.json`（**部署级全局一份**，不属于任何配置档）里按类型声明，
  或者在控制台的「供应商」页里配。引擎从不 import 具体的模型 SDK。
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
并在 `stop()` 时 `unloadAll()`。重载 / 启用 / 禁用 / 卸载与配置都只在「插件」页操作；
控制台保持会话工作区两栏，不再有右侧插件面板。

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

- `logger`、`config`：日志器与**插件可见的运行期配置**。`config` 是白名单视图，目前只有
  `pluginDirs` 一条键；口令、provider 的 `apiKey` 这类运行期配置不会交到插件手上
  （理由见 [插件可见的配置](./docs/architecture.md#插件可见的配置白名单视图)）。
  插件默认导出里声明的 `config` 段会合并进来，同名时插件的键优先。
- `pluginConfig`：**用户为这个插件填的值**。键由插件目录里的 `_conf_schema.json` 声明；
  值是 schema 默认值被 `<dataDir>/profiles/<配置档 id>/plugins/<插件 id>/config.json`
  里的合法项覆盖之后的结果。它**不**并进 `ctx.config`：后者是框架主动交出去的白名单，
  前者是用户数据，混在一起就分不清「框架给的」与「用户填的」。
- `ctx.effect(fn | { dispose() }, label?)`：登记副作用，卸载时逆序自动释放，返回提前释放函数
- `ctx.subscribe(emitter, event, handler)`：订阅 emitter，并在卸载时自动退订
- `ctx.dataDir`：这个插件**自己**的数据目录（绝对路径），首次访问时才创建。
  从这份档的数据目录读回来的东西，换一份档就是另一份（同一个插件被两份档各开一次，
  就是两份独立的登录态 / 缓存 / 限流预算）。
  存东西请用它，别往插件自己的目录里写 —— 那个目录是用户从上游拷来的代码，
  升级会被整个替换、改名会换目录，写在那儿的数据跟着一起没。
  目录位置是 `<dataDir>/profiles/<配置档 id>/plugins/<你的 id>`，所以**卸载、禁用、
  重命名插件目录都不会丢数据**，
  框架也不会因为这些动作删它（要只清理这一个插件的数据，请自己
  `rm -rf data/profiles/<配置档 id>/plugins/<id>`）；只有**删除整份配置**时，
  它的整个 `profiles/<id>/` 目录才一起消失。
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

### 插件配置

插件目录里放一份 `_conf_schema.json`（与 AstrBot 同名同格式），控制台的「插件」页就会
按它渲染一张表单。v1 支持六种类型：

```json
{
  "greeting": { "type": "string", "description": "问候语", "default": "你好" },
  "max_items": { "type": "int", "description": "条目上限", "default": 5, "min": 1, "max": 50 },
  "ratio": { "type": "float", "description": "阈值", "default": 0.5, "min": 0, "max": 1 },
  "verbose": { "type": "bool", "description": "详细日志", "default": false },
  "style": {
    "type": "select",
    "description": "风格",
    "options": ["简洁", "详细"],
    "default": "简洁"
  },
  "prompt": { "type": "text", "description": "提示词", "default": "" }
}
```

几条约定：

- `description` 必填；`default` 的类型必须与 `type` 一致，`select` 的默认值必须在
  `options` 里；`min` / `max` 只用于 `int` / `float`。schema 顶层是对象、最多 100 项。
- schema 不合法（坏 JSON、不支持的 `type`、缺 `description`…）只会让表单不可用，
  原因显示在抽屉顶部；**插件本身照常加载与运行**。
- 值是**每份配置档各一份**的：`<dataDir>/profiles/<配置档 id>/plugins/<插件 id>/config.json`，
  目录 `0700`、文件 `0600`。框架只覆盖 schema 声明过的键，手写的其它键原样保留；
  `config.json` 是这个目录里的**保留文件名**，插件自己存东西请换一个名字。
- 保存后，`active` / `failed` 的插件自动重载，`setup()` 重新跑并读到新的 `ctx.pluginConfig`；
  禁用中的插件只落盘、不加载。重载失败不会回滚已保存的值，响应里的 `reloadError` 把
  「保存成功」与「生效失败」分开说。
- 配置文件坏到读不出来时插件记为 `failed`，但表单仍然可以打开；保存会以表单值重建它 ——
  这是操作者的修复路径。重建会丢掉坏文件里已经无法解析的字节。

## API

基础路径 `/api/v1`：

| 方法            | 路径                                            | 说明                                                                                                |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET             | `/health`                                       | 存活检查（公开）                                                                                    |
| POST            | `/auth/login`、`/auth/logout`                   | 登录 / 登出（公开，见上）                                                                           |
| GET             | `/auth/me`、`/auth/status`                      | 当前用户 / 是否需要登录                                                                             |
| GET / POST      | `/sessions`                                     | 列出（默认最新 100 个，创建序 + `nextCursor`）/ 创建会话                                            |
| GET / DELETE    | `/sessions/:id`                                 | 读取（默认**最新 100 条**消息 + `nextCursor`）/ 删除会话                                            |
| POST            | `/sessions/:id/messages`                        | 发送用户消息，等完整回复后返回（同会话串行，占用中返回 409）                                        |
| POST            | `/sessions/:id/messages/stream`                 | 同上，但以 SSE 逐段推送回复增量（409 在开流**之前**判，所以是状态码而不是流里的错误帧）             |
| GET             | `/providers`、`/plugins`、`/adapters`、`/tools` | 供控制台使用的状态                                                                                  |
| GET/POST        | `/adapters`                                     | 列出 / 新增接入平台实例                                                                             |
| GET             | `/adapters/templates`                           | 可添加的适配器类型与表单字段                                                                        |
| GET/POST/DELETE | `/adapters/{id}`                                | 读取（含平台字段）/ 更新 / 删除一个实例                                                             |
| POST            | `/adapters/{id}/enable`                         | 启用或禁用实例，body `{ "enabled": true }`                                                          |
| GET / POST      | `/personas`                                     | 列出 / 新建人格                                                                                     |
| POST / DELETE   | `/personas/{id}`                                | 更新 / 删除人格（仍被配置档引用时删除回 409）                                                       |
| GET / POST      | `/cron`                                         | 列出 / 新建计划任务                                                                                 |
| POST / DELETE   | `/cron/{id}`                                    | 更新 / 删除计划任务                                                                                 |
| POST            | `/cron/{id}/run`                                | 立即执行（202 `{ started: true }`，结果看列表里的状态）                                             |
| GET             | `/logs`                                         | 最近的程序日志（默认 200 条，最多 500 条）                                                          |
| GET             | `/logs/stream`                                  | 实时日志流（SSE，先补发历史再推送；`after` 续传）                                                   |
| POST/DELETE     | `/providers`、`/providers/:id`                  | 新增 / 修改 / 删除模型实例                                                                          |
| GET             | `/provider-sources`                             | 列出 provider source（**明文含 apiKey**）                                                           |
| POST/DELETE     | `/provider-sources`、`/provider-sources/:id`    | 新增 / 修改 / 删除 provider source                                                                  |
| POST            | `/provider-sources/:id/models`                  | 按已保存的凭证拉取上游模型列表                                                                      |
| POST            | `/plugins/:id/reload`                           | 重载插件（销毁旧实例并重新求值代码）                                                                |
| POST            | `/plugins/:id/unload`                           | 卸载插件（释放副作用并移除）                                                                        |
| POST            | `/plugins/:id/enable`                           | 在**这份配置档**里启用 / 禁用插件，body `{ "enabled": true }`（插件本身是全局安装的）               |
| GET             | `/plugins/:id/config`                           | 读这个插件的 schema 与当前生效值；schema / 配置坏了也会返回原因（`schemaError` / `configError`）    |
| POST            | `/plugins/:id/config`                           | 保存插件配置，body `{ values: [{ key, value }] }`；保存后尝试重载，失败原因在 `reloadError`         |
| POST            | `/tools/:id/enable`                             | 启用 / 禁用工具，body `{ "enabled": true }`（必填）                                                 |
| GET             | `/profiles`                                     | 列出全部配置档及其加载状态（含 `failed` 与它的原因）                                                |
| POST            | `/profiles`                                     | 新建配置档，body `{ id, name? }`                                                                    |
| GET             | `/profiles/:id/config`                          | 读一份配置档的可编辑内容（工作台草稿起点：默认模型 / 人格 / 步数 / 工具 / 插件 / 准入名单一次读回） |
| POST            | `/profiles/:id/config`                          | 保存这批改动（只发 diff；插件失败项在响应的 `failed` 里点名；改动当场生效）                         |
| POST            | `/profiles/:id/default-provider`                | 设这一档默认的 provider 实例，body `{ "providerId": "<实例 id>" }`；`null` 取消档级默认             |
| DELETE          | `/profiles/:id`                                 | 删除一份配置（连同 `profiles/<id>/` 目录；正被某个会话占用时返回 409）                              |

除标注「公开」的路径外，其余接口都需要登录（未登录返回 401）。

**下面这些路径还必须带 `?profile=<配置档 id>`**：`/tools*`、`/plugins*`、
`/sessions/:id/messages[/stream]`。缺了它一律 **400**，
不会回落到 `default` —— 「界面在 B、写进 A、还回 201」这类错只有在服务端拒绝猜的时候才可能被发现。
`/health`、`/auth/*`、`/sessions*`（列表与增删会话本身）、`/adapters*`、`/logs*`、
`/profiles*`、`/personas*`、`/cron*`、以及**整个 `/providers*` 与 `/provider-sources*`** 都不需要：
前两样是对话历史与配置档清单本身，人格与计划任务是部署级资源（计划任务自己保存所用配置档），
供应商是部署级全局一份（按档各要一个 `profile` 反而会让「在 A 上改了源、B 以为自己也有」变成可能）。

`/profiles/:id/*` 那一族（default-provider / config）的档 id 在**路径**里，
所以既不要求也不接受 `?profile=` —— 同一个值写两遍，两处不一致时听谁的是个没有答案的问题。
对话历史是**全局一份** sqlite，不属于任何一份配置档。

**供应商**的写操作落在 `data/providers.json` 上，**档级跑法**（工具开关、插件启用清单、
档默认用哪个模型）落在 `data/profiles/<id>/config.json` 上；都是读-改-写、文件权限 `0600`，
改完立刻生效、**不需要重启**：provider 靠重建注册表生效，工具靠每次现读文件
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
