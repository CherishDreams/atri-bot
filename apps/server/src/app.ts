import { join } from "node:path";
import { createLogger } from "./core/logger.ts";
import { AgentEngine } from "./core/agent/engine.ts";
import { SessionManager } from "./core/session/manager.ts";
import { ProviderRegistry } from "./core/provider/registry.ts";
import { createProviders, readDefaultProviderId } from "./core/provider/factory.ts";
import { ProviderConfigStore } from "./core/provider/store.ts";
import { ToolRegistry } from "./core/tool/registry.ts";
import { ToolConfigStore } from "./core/tool/store.ts";
import { createBuiltinTools } from "./core/tool/builtins.ts";
import { AuthManager } from "./core/auth/manager.ts";
import { PluginManager, pluginRuntimeConfig } from "./plugins/manager.ts";
import { AdapterManager } from "./adapters/manager.ts";
import { createHttpServer } from "./api/server.ts";
import type { AppConfig } from "./config/index.ts";
import { ensurePrivateDir, readConfigFile } from "./config/file.ts";
import {
  DEFAULT_PROFILE_ID,
  profileConfigPath,
  profilesRoot,
  runShapeKeysIn,
  seedProfile,
} from "./config/profiles.ts";

/**
 * 组合根（composition root）：唯一知道各部件如何拼装的地方。
 * 下层通过构造函数注入协作者，彼此互不感知，
 * 从而让 core/ 不掺杂任何传输层细节。
 */
export async function createApp(config: AppConfig) {
  const logger = createLogger(config.logLevel);

  const auth = new AuthManager(config, logger);
  // 必须早于 HTTP 服务启动：未配置口令时要先把随机口令写进配置文件。
  await auth.init();

  // 会话与消息落在 `config.dataDir` 下的 sqlite（建库与 schema 升级见 `core/session/db.ts`）。
  const sessions = new SessionManager(config, logger);
  const providers = new ProviderRegistry();

  // provider 配置的读写入口。启动时读一次，之后每次界面改动都经由它落盘。
  //
  // 「跑法」住在配置档文件里，不在 `atri.config.json`。顺序是有意的：先建目录、
  // 再一次性 seed、**然后**才构造任何存储 —— 存储一旦拿的就是配置档路径，
  // bootstrap 里那几段对这个进程就再也不存在了。
  const profilesDir = profilesRoot(config.dataDir);
  ensurePrivateDir(profilesDir);
  const profilePath = profileConfigPath(profilesDir, DEFAULT_PROFILE_ID);
  const bootstrap = readConfigFile(config.root);
  const moved = seedProfile(profilesDir, DEFAULT_PROFILE_ID, bootstrap);
  if (moved !== null) {
    logger.info(
      moved.length === 0
        ? `已创建配置档「${DEFAULT_PROFILE_ID}」（${profilePath}）`
        : `已把 atri.config.json 里的 ${moved.join(" / ")} 搬进配置档「${DEFAULT_PROFILE_ID}」——` +
            "这一段以后只在配置档文件里维护",
    );
  } else {
    // 配置档早就在了，而 bootstrap 里还留着那几段：它现在是一句谎话。不删用户的文件
    // （框架从不删它），但每次启动都要说一次，否则它会变成第二个真源。
    const leftover = runShapeKeysIn(bootstrap);
    if (leftover.length > 0) {
      logger.warn(
        `atri.config.json 里还留着 ${leftover.join(" / ")}，但配置档「${DEFAULT_PROFILE_ID}」已经存在 —— ` +
          `这些段**不再生效**，真源是 ${profilePath}。确认无误后可以把它们从 atri.config.json 里删掉。`,
      );
    }
  }
  const providerConfig = new ProviderConfigStore({ filePath: profilePath }, logger);

  // 插件是磁盘上用户手写的代码，`ctx.config` / `shared.config` 会直接交到它手上，
  // 所以在这里就投影成白名单视图（理由见 `plugins/manager.ts` 的 `PluginRuntimeConfig`）。
  // 构造提前到工具之前：`list_plugins` 那颗工具要从这里拿实时视图（构造只是存两个字段，
  // 真正的扫描仍在下面 `plugins.loadAll()` 那一步）。
  const plugins = new PluginManager(pluginRuntimeConfig(config), logger, {
    // 插件数据的根。与 `dataDir` 本体分开交出去：插件只能经 `ctx.dataDir` 看到
    // `<dataDir>/plugins/<自己的 id>`，拿不到根，也拿不到那下面的 `sessions.sqlite`。
    dataRoot: join(config.dataDir, "plugins"),
  });

  // 工具：注册表只管存在与执行，启用与否每次现读文件（见 `core/tool/store.ts`），
  // 所以控制台改完开关不需要重建任何东西 —— 也没有可重建的长驻状态。
  const tools = new ToolRegistry();
  // 传 getter 而不是 `plugins.list()` 的结果：此刻还没 `loadAll()`，而且插件能在运行期
  // 增删与启停，快照会让这颗工具继续说出装配那一刻的事实。
  for (const tool of createBuiltinTools({ listPlugins: () => plugins.list() })) {
    tools.register(tool);
  }
  const toolConfig = new ToolConfigStore({ filePath: profilePath }, logger);

  /**
   * 按当前配置装配 provider。
   *
   * 启动与「配置页改完保存」走的是**同一个函数**，因此不会出现两条装配路径
   * 慢慢走散的情况（例如忘记处理默认值回退）。
   *
   * 单个 provider 配错只记日志、不阻断启动：「其中一个后端坏了」应该能局部降级，
   * 而不是让整个服务起不来。
   */
  function rebuildProviders() {
    providers.clear();

    const entries = providerConfig.providerEntries();
    const { providers: built, errors } = createProviders(entries, {
      sources: providerConfig.sourceEntries(),
      logger,
    });
    for (const provider of built) providers.register(provider);
    for (const { id, message } of errors) logger.error(`provider「${id}」加载失败: ${message}`);

    const defaultId = readDefaultProviderId(entries);
    if (defaultId) {
      // 显式配了默认值但它没加载成功时，别静默回退到第一个——那会让请求
      // 悄悄打到另一个模型上。宁可留空，由注册表的回退规则处理并留下日志。
      if (providers.get(defaultId)) {
        providers.setDefault(defaultId);
      } else {
        logger.warn(`配置的默认 provider「${defaultId}」未加载成功，将回退到第一个可用 provider`);
      }
    }

    if (providers.size === 0) {
      logger.warn(
        `没有可用的模型 provider，将使用回声兜底（请在配置档文件 ${profilePath} 里配置 providers）`,
      );
    }
    return providers;
  }

  rebuildProviders();

  const engine = new AgentEngine({ sessions, providers, tools, toolConfig, logger });

  const adapters = new AdapterManager({ config, logger });

  const http = createHttpServer({
    config,
    logger,
    auth,
    sessions,
    providers,
    providerConfig,
    reloadProviders: rebuildProviders,
    plugins,
    adapters,
    tools,
    toolConfig,
    engine,
  });

  await plugins.loadAll();
  await adapters.startAll();

  return {
    async start() {
      await http.listen(config.port, config.host);
      // 用真实端口打印：config.port 可能是 0。
      logger.info(`atri-bot 正在监听 http://${config.host}:${http.address().port}`);
    },
    // 暴露监听地址，让 port: 0（随机端口）的调用方能拿到真实端口。
    address: () => http.address(),
    // 真实注册的 API 路由，供测试比对 openapi.json。
    routes: () => http.routes(),
    async stop() {
      await adapters.stopAll();
      await http.close();
      await plugins.unloadAll();
      // 库排在最后关：`http.close()` 先掐掉在途的 SSE 与 WS，那一刻之后不应再有新的写库请求；
      // 插件的 teardown 理论上也可能触发写（今天 ctx 里没有会话句柄，排在后面才对未来也成立）。
      sessions.close();
    },
  };
}
