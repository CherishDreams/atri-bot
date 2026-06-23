import { createLogger } from "./core/logger.js";
import { AgentEngine } from "./core/agent/engine.js";
import { SessionManager } from "./core/session/manager.js";
import { ProviderRegistry } from "./core/provider/registry.js";
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
