import type { AdapterInfo } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
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
  logger: Logger;
}

/**
 * 适配器把外部界面（HTTP webhook、QQ、Discord、CLI…）接入 agent 引擎。
 * 它们是可选启用的：`config.adapters.<id>.enabled` 打开某一个。
 * 纯 agent 部署可以不启用任何一个。
 *
 * 这里**不注入 `engine`**。以前有一个「持有但从不读取」的 `engine` 字段，理由是
 * 「等第一个接入端落地时它会经 `register()` 交给适配器自己」—— 与本仓删掉
 * `AgentEngine` 的 `config` / `plugins` 那两个注入了却没人读的字段是同一条判断
 *（见 architecture.md 的依赖方向一节）：一个不工作的接缝不会自己变有用，只会让类型标注
 * 先一步说谎。真做适配器时按它实际需要的东西注入，那时这个形状才有依据。
 */
export class AdapterManager {
  #adapters = new Map<string, Adapter>();
  config: AdapterManagerConfig;
  logger: Logger;

  constructor({ config, logger }: AdapterManagerDeps) {
    this.config = config;
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
