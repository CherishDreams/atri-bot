import { createLogger } from "./core/logger.ts";
import { AgentEngine } from "./core/agent/engine.js";
import { SessionManager } from "./core/session/manager.ts";
import { ProviderRegistry } from "./core/provider/registry.ts";
import { createProviders, readDefaultProviderId } from "./core/provider/factory.js";
import { ProviderConfigStore } from "./core/provider/store.js";
import { AuthManager } from "./core/auth/manager.ts";
import { PluginManager } from "./plugins/manager.js";
import { AdapterManager } from "./adapters/manager.js";
import { createHttpServer } from "./api/server.js";

/**
 * 组合根（composition root）：唯一知道各部件如何拼装的地方。
 * 下层通过构造函数注入协作者，彼此互不感知，
 * 从而让 core/ 不掺杂任何传输层细节。
 */
export async function createApp(config) {
  const logger = createLogger(config.logLevel);

  const auth = new AuthManager(config, logger);
  // 必须早于 HTTP 服务启动：未配置口令时要先把随机口令写进配置文件。
  await auth.init();

  const sessions = new SessionManager();
  const providers = new ProviderRegistry();

  // provider 配置的读写入口。启动时读一次，之后每次界面改动都经由它落盘。
  const providerConfig = new ProviderConfigStore(config, logger);

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
        "没有可用的模型 provider，将使用回声兜底（请在 atri.config.json 里配置 providers）",
      );
    }
    return providers;
  }

  rebuildProviders();

  const plugins = new PluginManager(config, logger);
  const engine = new AgentEngine({ config, sessions, providers, plugins, logger });

  const adapters = new AdapterManager({ config, engine, logger });

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
    },
  };
}
