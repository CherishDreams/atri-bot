import type { AdapterInfo } from "@atri/shared";
import type { AgentEngine } from "#core/agent/engine.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import { ADAPTER_ACTION_LIMITS } from "./constants.ts";
import type { AdapterConfigStore, AdapterEntryConfig } from "./store.ts";
import type { InboundConversation, MessageAdapter } from "./message.ts";
import {
  adapterTemplate,
  assertAdapterId,
  settingsEntries,
  validateAdapterSettings,
} from "./templates.ts";

/** 一个接入端的最小契约：长驻的 `start()`/`stop()`（与每请求的 provider 刻意不同词）。 */
export interface Adapter {
  name?: string;
  start(): Promise<void> | void;
  stop?(): Promise<void> | void;
  /**
   * 调用平台原始动作。没有包装成具体方法的平台能力（群列表、上传文件、拍一拍……）
   * 都从这里走；不支持时可以不实现，管理器会回一条明确的「不支持」。
   */
  callAction?(action: string, params: Record<string, unknown>): Promise<unknown>;
}

/** `call_action` 的统一结果。上游/连接失败也走 200，让界面与插件读 `ok` 而不是猜状态码。 */
export interface AdapterActionResult {
  adapterId: string;
  action: string;
  ok: boolean;
  data?: unknown;
  error?: string | null;
}

/**
 * 适配器拿到的目标：**能跑一轮对话的那个引擎**。
 *
 * 故意只到这一层，而不是把 `ProfileBundle` 递进来：它声明在 `api/http.ts`，
 * 而 `adapters/` 按分层不得 import `api/`。绑定怎么解析由组合根注入。
 */
export interface AdapterTarget {
  engine: AgentEngine;
}

/** 按实例配置构造一个适配器；类型分派由组合根完成，管理器不认识具体平台。 */
export type AdapterFactory = (id: string, config: AdapterEntryConfig) => Adapter;

export interface AdapterManagerDeps {
  store: AdapterConfigStore;
  logger: Logger;
  resolveProfile: (profileId: string) => AdapterTarget | null;
  createAdapter: AdapterFactory;
  /**
   * 删除适配器时清掉它的会话映射目录。由组合根注入（适配器层不拼 dataDir）：
   * 不清的话，重建同名适配器会接上旧的外部会话映射，用户看到的是一段莫名其妙的旧上下文。
   */
  removeAdapterState?: (id: string) => void;
}

export interface AdapterCreateInput {
  id: string;
  type: string;
  name?: string;
  enabled?: boolean;
  profile: string;
  settings: unknown;
}

export interface AdapterUpdateInput {
  name?: string;
  enabled?: boolean;
  profile?: string;
  settings?: unknown;
}

/** 控制台编辑表单需要的那一份：状态 + 平台字段（含 token，仅登录后可见）。 */
export interface AdapterDetail {
  adapter: AdapterInfo;
  config: {
    type: string;
    name: string;
    enabled: boolean;
    profile: string;
    settings: { key: string; value: string }[];
  };
}

interface ManagedAdapter {
  config: AdapterEntryConfig;
  adapter: Adapter | null;
  running: boolean;
  error: string | null;
}

/**
 * 适配器的运行期管理：配置来自 `AdapterConfigStore`，实例由注入的工厂按需构造。
 *
 * 与旧版的区别是「注册」不再是启动时的一次性动作：控制台可以新增、删除、修改、
 * 启停，每一条都对应一次（可能失败的）实例构造/销毁。因此状态必须按实例记录，
 * 不能只留一个 `Map<id, Adapter>`。
 *
 * 绑定规则没有变：**不静默改绑**。配置档不可用就不启动，把原因写进实例的 `error`；
 * 一份适配器配错不会拖垮其余适配器。
 */
export class AdapterManager {
  #records = new Map<string, ManagedAdapter>();
  #store: AdapterConfigStore;
  logger: Logger;
  resolveProfile: (profileId: string) => AdapterTarget | null;
  #createAdapter: AdapterFactory;
  #removeAdapterState: ((id: string) => void) | undefined;

  constructor({
    store,
    logger,
    resolveProfile,
    createAdapter,
    removeAdapterState,
  }: AdapterManagerDeps) {
    this.#store = store;
    this.logger = logger;
    this.resolveProfile = resolveProfile;
    this.#createAdapter = createAdapter;
    this.#removeAdapterState = removeAdapterState;
  }

  async startAll(): Promise<void> {
    for (const { id, config } of this.#store.list()) {
      this.#records.set(id, { config, adapter: null, running: false, error: null });
    }
    let started = 0;
    for (const [id, record] of this.#records) {
      if (!record.config.enabled) continue;
      await this.#start(id, record);
      if (record.running) started += 1;
    }
    this.logger.info(`已启动 ${started} 个适配器`);
  }

  async stopAll(): Promise<void> {
    for (const [id, record] of this.#records) {
      await this.#stop(id, record);
    }
  }

  list(): AdapterInfo[] {
    return this.#store.list().map(({ id, config }) => this.#view(id, config));
  }

  detail(id: string): AdapterDetail {
    const record = this.#record(id);
    return {
      adapter: this.#view(id, record.config),
      config: this.#configView(id, record.config),
    };
  }

  async create(input: AdapterCreateInput): Promise<AdapterDetail> {
    assertAdapterId(input.id);
    if (adapterTemplate(input.type) === null) {
      throw new ApiError(`不支持的适配器类型：${input.type}`, 400);
    }
    const profile = input.profile.trim();
    if (profile === "") throw new ApiError("必须选择一份配置档", 400);
    const settings = validateAdapterSettings(input.type, input.settings);
    if (this.#store.has(input.id)) {
      throw new ApiError(`适配器「${input.id}」已经存在`, 409);
    }

    const name = input.name?.trim();
    const config: AdapterEntryConfig = {
      type: input.type,
      ...(name === undefined || name === "" ? {} : { name }),
      enabled: input.enabled !== false,
      profile,
      settings,
    };
    this.#store.create(input.id, config);
    const record: ManagedAdapter = { config, adapter: null, running: false, error: null };
    this.#records.set(input.id, record);
    if (config.enabled) await this.#start(input.id, record);
    return this.detail(input.id);
  }

  async update(id: string, patch: AdapterUpdateInput): Promise<AdapterDetail> {
    const record = this.#record(id);
    const next: AdapterEntryConfig = {
      ...record.config,
      ...(patch.name === undefined
        ? {}
        : { name: patch.name.trim() === "" ? undefined : patch.name.trim() }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.profile === undefined ? {} : { profile: patch.profile.trim() }),
    };
    if (next.profile === "") throw new ApiError("必须选择一份配置档", 400);
    if (patch.settings !== undefined) {
      next.settings = validateAdapterSettings(next.type, patch.settings);
    }
    if (next.name === undefined) delete next.name;

    // 先落盘再停旧实例：写盘失败时那一侧必须什么都没发生（旧适配器继续跑、内存配置不变）。
    // 反过来会留下「文件没改成、实例却已经被停掉」的半截状态。
    this.#store.replace(id, next);
    record.config = next;
    record.error = null;
    await this.#stop(id, record);
    if (next.enabled) await this.#start(id, record);
    return this.detail(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<AdapterDetail> {
    const record = this.#record(id);
    this.#store.setEnabled(id, enabled);
    record.config.enabled = enabled;
    if (enabled) await this.#start(id, record);
    else await this.#stop(id, record);
    return this.detail(id);
  }

  /**
   * 调用平台原始动作（AstrBot 的 `call_action` 形状）。
   *
   * 不在管理器里维护动作白名单：OneBot 11 的扩展动作随实现版本变化，黑名单/白名单
   * 都会过期。管理器只做三件事：目标存在、参数形状、结果/错误统一包装。
   *
   * `expectedProfile` 是插件入口用的：插件属于某一份配置档，只允许操作绑定到这份档的
   * 适配器。管理员 HTTP 入口不传它，按实例 id 操作。
   *
   * 未运行 / 上游失败 / 平台不支持都返回 `ok: false` 的 200 结果，而不是抛 5xx：
   * 这是一次「探测 + 执行」的开发者动作，界面与插件需要拿到原因本身。
   */
  /**
   * 主动消息引擎的会话发现：这一档**正在运行**的 MessageAdapter 各自上报
   * 「外部会话 -> 内部会话」映射，键按 `<profileId>:<kind>:<id>` 解析回外部坐标。
   */
  conversationEntries(profileId: string): {
    adapterId: string;
    conversation: InboundConversation;
    sessionId: string;
  }[] {
    const out: { adapterId: string; conversation: InboundConversation; sessionId: string }[] = [];
    for (const [id, record] of this.#records) {
      if (record.config.profile !== profileId || !record.running) continue;
      const adapter = record.adapter;
      if (
        adapter === null ||
        typeof (adapter as MessageAdapter).conversationEntries !== "function"
      ) {
        continue;
      }
      for (const entry of (adapter as MessageAdapter).conversationEntries()) {
        // 键由基类拼出（`<profileId>:<kind>:<id>`）；解析失败的一律跳过。
        const parts = entry.key.split(":");
        if (parts.length < 3 || parts[0] !== profileId) continue;
        const kind = parts[1] === "group" ? "group" : "private";
        out.push({
          adapterId: id,
          conversation: { kind, id: parts.slice(2).join(":") },
          sessionId: entry.sessionId,
        });
      }
    }
    return out;
  }

  /**
   * 主动消息引擎的发送通道。与 `callAction` 同一条边界纪律：必须属于声明的
   * 配置档、实例在跑、且必须是 MessageAdapter（有会话语义）—— 三者都验。
   * 长度上限按适配器自己的设置走（与回复切块同一份）。
   */
  async sendToConversation(
    id: string,
    conversation: InboundConversation,
    text: string,
    expectedProfile?: string,
  ): Promise<void> {
    const record = this.#record(id);
    if (expectedProfile !== undefined && record.config.profile !== expectedProfile) {
      throw new ApiError(`适配器「${id}」不属于这份配置档`, 403);
    }
    if (!record.running || record.adapter === null) {
      throw new ApiError(`适配器「${id}」当前没有在运行`, 409);
    }
    const adapter = record.adapter;
    if (!("sendTo" in adapter) || typeof (adapter as MessageAdapter).sendTo !== "function") {
      throw new ApiError(`适配器「${id}」不支持会话消息发送`, 400);
    }
    await (adapter as MessageAdapter).sendTo(conversation, text);
  }

  async callAction(
    id: string,
    action: string,
    params: unknown,
    expectedProfile?: string,
  ): Promise<AdapterActionResult> {
    const record = this.#record(id);
    if (expectedProfile !== undefined && record.config.profile !== expectedProfile) {
      throw new ApiError(`适配器「${id}」不属于这份配置档`, 403);
    }

    const name = action.trim();
    if (name === "") throw new ApiError("action 不能为空", 400);
    if (name.length > ADAPTER_ACTION_LIMITS.maxNameLength) {
      throw new ApiError(`action 太长（最多 ${ADAPTER_ACTION_LIMITS.maxNameLength} 字符）`, 400);
    }
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new ApiError("params 必须是一个对象", 400);
    }
    let paramsSize: number;
    try {
      const serialized = JSON.stringify(params);
      if (serialized === undefined) throw new Error("结果不是可序列化的 JSON");
      paramsSize = serialized.length;
    } catch (err) {
      throw new ApiError(`params 不能序列化为 JSON：${errorMessage(err)}`, 400);
    }
    if (paramsSize > ADAPTER_ACTION_LIMITS.maxParamsChars) {
      throw new ApiError(
        `params 太大（${paramsSize} 字符，上限 ${ADAPTER_ACTION_LIMITS.maxParamsChars}）`,
        400,
      );
    }

    if (!record.running || record.adapter === null) {
      return { adapterId: id, action: name, ok: false, error: "适配器当前未运行" };
    }
    const call = record.adapter.callAction;
    if (typeof call !== "function") {
      return { adapterId: id, action: name, ok: false, error: "该适配器不支持原始动作" };
    }

    this.logger.info(`适配器原始动作: ${id} -> ${name}`);
    try {
      const data = await call.call(record.adapter, name, params as Record<string, unknown>);
      return { adapterId: id, action: name, ok: true, data };
    } catch (err) {
      const message = errorMessage(err).slice(0, ADAPTER_ACTION_LIMITS.maxErrorChars);
      this.logger.warn(`适配器原始动作失败: ${id} -> ${name}: ${message}`);
      return { adapterId: id, action: name, ok: false, error: message };
    }
  }

  async remove(id: string): Promise<void> {
    const record = this.#record(id);
    await this.#stop(id, record);
    this.#store.remove(id);
    this.#records.delete(id);
    // 配置已经删掉之后才清数据：如果 store.remove 失败，请求回 5xx 时旧映射
    // 必须还在，否则下一次启动会拿一个不存在的配置去接旧会话。
    try {
      this.#removeAdapterState?.(id);
    } catch (err) {
      this.logger.warn(`清理适配器「${id}」的会话映射失败: ${errorMessage(err)}`);
    }
  }

  #record(id: string): ManagedAdapter {
    const record = this.#records.get(id);
    if (record === undefined) throw new ApiError(`未知适配器: ${id}`, 404);
    return record;
  }

  async #start(id: string, record: ManagedAdapter): Promise<void> {
    if (record.running) return;
    const profile = record.config.profile.trim();
    if (profile === "") {
      record.error = "没有绑定配置档";
      this.logger.error(`适配器「${id}」未启动：没有绑定配置档`);
      return;
    }
    if (this.resolveProfile(profile) === null) {
      record.error = `绑定的配置档「${profile}」当前不可用`;
      this.logger.error(
        `适配器「${id}」未启动：它绑定的配置档「${profile}」不可用（不存在或加载失败，详见 GET /profiles）`,
      );
      return;
    }

    let adapter: Adapter | null = null;
    try {
      adapter = this.#createAdapter(id, record.config);
      await adapter.start();
      record.adapter = adapter;
      record.running = true;
      record.error = null;
      this.logger.info(`适配器已启动: ${id}（配置档「${profile}」）`);
    } catch (err) {
      if (adapter !== null) {
        try {
          await adapter.stop?.();
        } catch (stopErr) {
          this.logger.warn(`适配器「${id}」启动失败后的清理也失败: ${errorMessage(stopErr)}`);
        }
      }
      record.adapter = null;
      record.running = false;
      record.error = errorMessage(err);
      this.logger.error(`适配器「${id}」启动失败: ${errorMessage(err)}`);
    }
  }

  async #stop(id: string, record: ManagedAdapter): Promise<void> {
    const adapter = record.adapter;
    record.adapter = null;
    record.running = false;
    if (adapter === null) return;
    try {
      await adapter.stop?.();
      this.logger.info(`适配器已停止: ${id}`);
    } catch (err) {
      this.logger.warn(`适配器「${id}」停止失败: ${errorMessage(err)}`);
    }
  }

  #view(id: string, config: AdapterEntryConfig): AdapterInfo {
    const profile = config.profile.trim();
    return {
      id,
      name: config.name ?? adapterTemplate(config.type)?.name ?? id,
      type: config.type,
      enabled: config.enabled,
      profile: profile === "" ? null : profile,
      bound: profile !== "" && this.resolveProfile(profile) !== null,
      running: this.#records.get(id)?.running ?? false,
      error: this.#records.get(id)?.error ?? null,
    };
  }

  #configView(id: string, config: AdapterEntryConfig): AdapterDetail["config"] {
    return {
      type: config.type,
      name: config.name ?? adapterTemplate(config.type)?.name ?? id,
      enabled: config.enabled,
      profile: config.profile,
      settings: settingsEntries(config.type, config.settings),
    };
  }
}
