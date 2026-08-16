import type { AdapterInfo } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import type { AgentEngine } from "#core/agent/engine.ts";
import type { Logger } from "#core/logger.ts";
import type { AdapterToggle } from "#config/file.ts";

/** 一个接入端的最小契约：长驻的 `start()`/`stop()`（与每请求的 provider 刻意不同词）。 */
export interface Adapter {
  name?: string;
  start(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

/** AdapterManager 实际读写的配置键。 */
export interface AdapterManagerConfig {
  adapters?: Record<string, AdapterToggle>;
}

export interface AdapterManagerDeps {
  config: AdapterManagerConfig;
  /**
   * 目前只有持有、没有读取点：仓库里还没有任何适配器实现（`register()` 无调用方），
   * 等第一个接入端落地时它会经 `register()` 交给适配器自己。保留这个字段是为了
   * 不改动既有装配形状 —— 接线方式该由真实的适配器来决定。
   */
  engine: AgentEngine;
  logger: Logger;
}

/**
 * 适配器把外部界面（HTTP webhook、QQ、Discord、CLI…）接入 agent 引擎。
 * 它们是可选启用的：`config.adapters.<id>.enabled` 打开某一个。
 * 纯 agent 部署可以不启用任何一个。
 */
export class AdapterManager {
  #adapters = new Map<string, Adapter>();
  config: AdapterManagerConfig;
  engine: AgentEngine;
  logger: Logger;

  constructor({ config, engine, logger }: AdapterManagerDeps) {
    this.config = config;
    this.engine = engine;
    this.logger = logger;
  }

  register(id: string, adapter: Adapter): Adapter {
    this.#adapters.set(id, adapter);
    return adapter;
  }

  async startAll(): Promise<void> {
    const cfg = this.config.adapters ?? {};
    for (const [id, adapter] of this.#adapters) {
      if (cfg[id]?.enabled === false) continue;
      try {
        await adapter.start();
        this.logger.info(`适配器已启动: ${id}`);
      } catch (err) {
        this.logger.error(`适配器 ${id} 启动失败: ${errorMessage(err)}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [id, adapter] of this.#adapters) {
      try {
        await adapter.stop?.();
      } catch (err) {
        this.logger.warn(`适配器 ${id} 停止失败: ${errorMessage(err)}`);
      }
    }
  }

  /** 已启用的适配器，供 dashboard 状态视图使用。 */
  list(): AdapterInfo[] {
    const cfg = this.config.adapters ?? {};
    return [...this.#adapters.entries()].map(([id, a]) => ({
      id,
      name: a.name ?? id,
      enabled: cfg[id]?.enabled !== false,
    }));
  }
}
