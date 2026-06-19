/**
 * 适配器把外部界面（HTTP webhook、QQ、Discord、CLI…）接入 agent 引擎。
 * 它们是可选启用的：`config.adapters.<id>.enabled` 打开某一个。
 * 纯 agent 部署可以不启用任何一个。
 */
export class AdapterManager {
  /** @type {Map<string, {start(): Promise<void>, stop(): Promise<void>}>} */
  #adapters = new Map();

  constructor({ config, engine, logger }) {
    this.config = config;
    this.engine = engine;
    this.logger = logger;
  }

  register(id, adapter) {
    this.#adapters.set(id, adapter);
    return adapter;
  }

  async startAll() {
    const cfg = this.config.adapters ?? {};
    for (const [id, adapter] of this.#adapters) {
      if (cfg[id]?.enabled === false) continue;
      try {
        await adapter.start();
        this.logger.info(`适配器已启动: ${id}`);
      } catch (err) {
        this.logger.error(`适配器 ${id} 启动失败: ${err.message}`);
      }
    }
  }

  async stopAll() {
    for (const [id, adapter] of this.#adapters) {
      try {
        await adapter.stop?.();
      } catch (err) {
        this.logger.warn(`适配器 ${id} 停止失败: ${err.message}`);
      }
    }
  }

  /** 已启用的适配器，供 dashboard 状态视图使用。 */
  list() {
    const cfg = this.config.adapters ?? {};
    return [...this.#adapters.entries()].map(([id, a]) => ({
      id,
      name: a.name ?? id,
      enabled: cfg[id]?.enabled !== false,
    }));
  }
}
