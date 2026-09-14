import type { AdapterInfo } from "@atri/shared";
import type { AgentEngine } from "#core/agent/engine.ts";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { AdapterToggle } from "#config/file.ts";

/** 一个接入端的最小契约：长驻的 `start()`/`stop()`（与每请求的 provider 刻意不同词）。 */
export interface Adapter {
  name?: string;
  start(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

/**
 * AdapterManager 实际读写的配置键。
 *
 * `adapters` 必填，与 `AppConfig.adapters` 一致（`loadConfig()` 给的是 `{}` 而不是
 * undefined）。以前这里写成可选，于是每次读都要补一个 `?? {}`：两处防御，一处不可达，
 * 而读的人分不清哪个是真可能的形状。
 */
export interface AdapterManagerConfig {
  adapters: Record<string, AdapterToggle>;
}

/**
 * 一个适配器真正需要的东西：**能跑一轮对话的那个引擎**。
 *
 * 故意只到这一层，而不是把整份配置档的对象图（`ProfileBundle`）递进来：
 * `ProfileBundle` 声明在 `api/http.ts`，而 `adapters/` 按分层不得 import `api/`
 *（方向表里 adapters 只允许 core / config / adapters）。所以组合根注入一个访问器，
 * 适配器经它拿到引擎，拿不到 provider 注册表、存储、插件管理器 —— 那些它今天没有读取点。
 * 与 `list_plugins` 收 `() => plugins.list()` 是同一条形状。
 */
export interface AdapterTarget {
  engine: AgentEngine;
}

export interface AdapterManagerDeps {
  config: AdapterManagerConfig;
  logger: Logger;
  /**
   * 按配置档 id 取那一跑法；该档不存在或 `failed` 时返回 `null`。
   * 由组合根注入，绑定的解析规则（有没有默认、失败要不要换一个）不留在适配器这一层。
   */
  resolveProfile: (profileId: string) => AdapterTarget | null;
}

/**
 * 适配器把外部界面（HTTP webhook、QQ、Discord、CLI…）接入 agent 引擎。
 * 它们是可选启用的：`config.adapters.<id>.enabled` 打开某一个。
 * 纯 agent 部署可以不启用任何一个。
 *
 * 每个适配器**绑定到一份配置档**（`config.adapters.<id>.profile`）：同一个部署可以让
 * QQ 走「便宜模型 + 不开工具」、webhook 走「长上下文 + 开满工具」。绑定怎么解析成对象图
 * 由注入的 `resolveProfile` 决定，本层不认识 `ProfileDirectory`。
 *
 * 这里**不注入 `engine`**，也没有一个「持有但从不读取」的引擎字段：以前那种形状与
 * 本仓删掉 `AgentEngine` 的 `config` / `plugins` 两个没人读的字段是同一条判断
 *（见 architecture.md 的依赖方向一节）。现在注入的是访问器，而且它的返回值被真的读了一次
 *（`startAll` 用它判绑定），所以这个接缝不是等着被用到的摆设。
 */
export class AdapterManager {
  #adapters = new Map<string, Adapter>();
  config: AdapterManagerConfig;
  logger: Logger;
  resolveProfile: (profileId: string) => AdapterTarget | null;

  constructor({ config, logger, resolveProfile }: AdapterManagerDeps) {
    this.config = config;
    this.logger = logger;
    this.resolveProfile = resolveProfile;
  }

  register(id: string, adapter: Adapter): Adapter {
    this.#adapters.set(id, adapter);
    return adapter;
  }

  /**
   * 启动所有「已启用且绑定可用」的适配器。
   *
   * **不静默改绑**：绑定指不到一份可用的档时，这个适配器就是不启动，并单独报一条说清
   * 是「没写 profile」还是「那一档不可用」。换成「那就用 default 吧」或「用第一个档」
   * 会让一个配置错误表现成「服务在跑，但某个平台用的是另一套模型」—— 与
   * `rebuildProviders` 里「配了默认 provider 但它没加载成功时不静默回退到第一个」
   * 是同一条判断，只是这里更值得守：平台侧的流量是持续进来的，跑错一套没有任何症状。
   *
   * 单个适配器失败不拖垮其余：`start()` 抛错（端口被占）只记一条 error，
   * 与 `PluginManager.#scanDir`、`createProviders` 同一条规矩。
   */
  async startAll(): Promise<void> {
    const cfg = this.config.adapters;
    for (const [id, adapter] of this.#adapters) {
      const toggle = cfg[id];
      if (toggle?.enabled === false) continue;
      const profileId = typeof toggle?.profile === "string" ? toggle.profile : "";
      if (profileId === "") {
        this.logger.error(
          `适配器 ${id} 未启动：没绑定配置档。在 atri.config.json 的 adapters.${id}.profile 里写一份配置档 id。`,
        );
        continue;
      }
      if (this.resolveProfile(profileId) === null) {
        // 两种情况合并成一句：档压根不存在，与档存在但 `failed`（读不出、建不起对象图）。
        // 对「要不要启动这个平台」而言它们是同一个结论，而差别在 `GET /profiles` 里看得见。
        this.logger.error(
          `适配器 ${id} 未启动：它绑定的配置档「${profileId}」不可用（不存在或加载失败，详见 GET /profiles）`,
        );
        continue;
      }
      try {
        await adapter.start();
        this.logger.info(`适配器已启动: ${id}（配置档「${profileId}」）`);
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
    const cfg = this.config.adapters;
    return [...this.#adapters.entries()].map(([id, a]) => {
      const toggle = cfg[id];
      const profile =
        typeof toggle?.profile === "string" && toggle.profile !== "" ? toggle.profile : null;
      return {
        id,
        name: a.name ?? id,
        // 绑定缺失也要能在这里看得见：否则控制台显示「已启用」而它其实一条流量都收不到
        //（`startAll` 会拒启动），操作者只能去翻日志。
        enabled: toggle?.enabled !== false,
        profile,
        // 只对「已启用且写了绑定」的那部分才有意义：`enabled: false` 的档是不是可用不关心。
        bound: profile !== null && this.resolveProfile(profile) !== null,
      };
    });
  }
}
