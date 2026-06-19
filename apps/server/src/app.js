import { createLogger } from "./core/logger.js";
import { AgentEngine } from "./core/agent/engine.js";
import { SessionManager } from "./core/session/manager.js";
import { ProviderRegistry } from "./core/provider/registry.js";
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

  const sessions = new SessionManager(config);
  const providers = new ProviderRegistry(config);
  const plugins = new PluginManager(config, logger);
  const engine = new AgentEngine({ config, sessions, providers, plugins, logger });

  const adapters = new AdapterManager({ config, engine, logger });

  const http = createHttpServer({
    config,
    logger,
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
      logger.info(`atri-bot 正在监听 http://${config.host}:${config.port}`);
    },
    async stop() {
      await adapters.stopAll();
      await http.close();
      await plugins.unloadAll();
    },
  };
}
