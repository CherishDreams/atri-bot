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
│   └── dashboard/       # Vite + TS 的 Web UI（独立成包）
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

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 以文件监听方式运行服务端 |
| `pnpm dev:dashboard` | 运行控制台的开发服务器 |
| `pnpm build` | 构建全部包 |
| `pnpm typecheck` | 对全部包做类型检查 |
| `pnpm test` | 运行全部测试 |
| `pnpm clean` | 清理构建产物 |

## 配置

解析顺序：**内置默认值 → `atri.config.json` → 环境变量**。
环境变量可参考 `.env.example`；基于文件的设置可复制 `atri.config.example.json` 为 `atri.config.json`。
密钥放在环境变量里，结构性设置放在文件里。

## 扩展方式

- **插件** —— 一个目录，内含 `index.js`，默认导出
  `{ id, name, version, setup(ctx), teardown() }`。参见 `apps/server/plugins/hello`。
  目录来自配置中的 `pluginDirs`。
- **适配器** —— 实现 `start()`/`stop()` 并注册到 `AdapterManager`；
  在 `config.adapters.<id>.enabled` 中按需启用。纯 agent 部署可以不启用任何一个。
- **Provider** —— 向 `ProviderRegistry` 注册 `{ id, name, models, chat() }` 对象。
  引擎从不 import 具体的模型 SDK。

## API

基础路径 `/api/v1`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET / POST | `/sessions` | 列出 / 创建会话 |
| GET / DELETE | `/sessions/:id` | 读取 / 删除会话 |
| POST | `/sessions/:id/messages` | 发送用户消息并获取回复 |
| GET | `/providers`、`/plugins`、`/adapters` | 供控制台使用的状态 |

WebSocket 位于 `/ws`，向客户端推送 `message` / `stream` / `error` 帧。
