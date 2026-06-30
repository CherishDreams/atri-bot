import { createLogger } from "./core/logger.js";
import { AgentEngine } from "./core/agent/engine.js";
import { SessionManager } from "./core/session/manager.js";
import { ProviderRegistry } from "./core/provider/registry.js";
import { createProviders, readDefaultProviderId } from "./core/provider/factory.js";
import { AuthManager } from "./core/auth/manager.js";
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

  const sessions = new SessionManager(config);
  const providers = new ProviderRegistry(config);

  // 按配置装配 provider。单个 provider 配错只记日志、不阻断启动：
  // 「其中一个后端坏了」应该能局部降级，而不是让整个服务起不来。
  const { providers: built, errors } = createProviders(config.providers, { logger });
  for (const provider of built) providers.register(provider);
  for (const { id, message } of errors) logger.error(`provider「${id}」加载失败: ${message}`);

  const defaultId = readDefaultProviderId(config.providers);
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

  const plugins = new PluginManager(config, logger);
  const engine = new AgentEngine({ config, sessions, providers, plugins, logger });

  const adapters = new AdapterManager({ config, engine, logger });

  const http = createHttpServer({
    config,
    logger,
    auth,
    sessions,
    providers,
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
    async stop() {
      await adapters.stopAll();
      await http.close();
      await plugins.unloadAll();
    },
  };
}
