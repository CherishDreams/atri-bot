/**
 * 记忆服务：按配置档在「内置实现」与「插件供应商」之间选择，并负责两件宿主侧的事 ——
 * 把召回结果格式化成可注入的上下文块、把一轮交互自动记录下去。
 *
 * 选择协议（与 companion 的 external-memory-provider 同一条）：
 * - **一次只选一个 provider**，`memory.provider` 指到不存在/未加载的插件时**不回退内置**，
 *   只记一次 warn 然后本轮无记忆 —— 静默换方案的症状是「记忆忽好忽坏而配置没变」，
 *   那比没有记忆更难排查。warn 只发一次：它每轮都会发生，刷屏会把真正的故障淹没。
 * - **provider 抛错不向上抛**：记忆是增益不是依赖，召回失败的一轮照样回答。
 */
import type { MemoryConfig } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { MemoryItem, MemoryProvider, MemoryQuery } from "./types.ts";

export const DEFAULT_MEMORY_TOP_K = 3;
export const MAX_MEMORY_TOP_K = 10;

/** 组合根注入的配置现读（每次召回/写入现读文件，保存后下一轮生效）。 */
export type MemoryConfigReader = () => MemoryConfig;

/** 一轮对话里记忆服务需要的坐标。 */
export interface MemoryTurn {
  profileId: string;
  sessionId: string;
  userText: string;
}

/** interaction 自动记录时两边正文的截断上限（字符）。 */
const INTERACTION_PART_CHARS = 2_000;

export class MemoryService {
  readonly #logger: Logger;
  readonly #resolveConfig: MemoryConfigReader;
  readonly #builtin: MemoryProvider;
  readonly #pluginProviders: () => MemoryProvider[];
  /** 已经 warn 过的「配置指到了不存在的 provider」—— 每个 id 只说一次。 */
  #missingWarned = new Set<string>();

  constructor({
    logger,
    resolveConfig,
    builtin,
    pluginProviders,
  }: {
    logger: Logger;
    resolveConfig: MemoryConfigReader;
    builtin: MemoryProvider;
    pluginProviders: () => MemoryProvider[];
  }) {
    this.#logger = logger;
    this.#resolveConfig = resolveConfig;
    this.#builtin = builtin;
    this.#pluginProviders = pluginProviders;
  }

  /** 当前生效的 provider；未启用或指到缺失的供应商时为 `null`。 */
  providerFor(profileId: string): MemoryProvider | null {
    const config = this.#resolveConfig();
    if (!config.enabled) return null;
    const wanted = config.provider === "" ? "builtin" : config.provider || "builtin";
    if (wanted === "builtin") return this.#builtin;
    const found = this.#pluginProviders().find((provider) => provider.id === wanted);
    if (found) return found;
    if (!this.#missingWarned.has(wanted)) {
      this.#missingWarned.add(wanted);
      this.#logger.warn(
        `配置档「${profileId}」的记忆供应商「${wanted}」当前不存在（插件未启用或未提供），` +
          "本轮起不注入记忆；修正 memory.provider 或重新启用那个插件后自动恢复",
      );
    }
    return null;
  }

  /** 本轮要注入 system 的记忆块；没有可说的话返回 `null`。 */
  async contextFor(turn: MemoryTurn): Promise<string | null> {
    const provider = this.providerFor(turn.profileId);
    if (provider === null || turn.userText.trim() === "") return null;
    const topK = clampTopK(this.#resolveConfig().topK);
    const query: MemoryQuery = {
      profileId: turn.profileId,
      sessionId: turn.sessionId,
      query: turn.userText,
      limit: topK,
    };
    let items: MemoryItem[];
    try {
      items = await provider.recall(query);
    } catch (err) {
      this.#logger.warn(`记忆召回失败（provider ${provider.id}）: ${errorMessage(err)}`);
      return null;
    }
    if (items.length === 0) return null;
    return formatMemoryBlock(items);
  }

  /**
   * 一轮结束后把交互自动存下去（`autoRecord` 关闭或 provider 不可用时是空操作）。
   * 永不抛错：记录失败只影响记忆，不能影响这一轮的回复。
   */
  async recordInteraction(turn: MemoryTurn, replyText: string): Promise<void> {
    const config = this.#resolveConfig();
    if (!config.enabled || config.autoRecord === false) return;
    const provider = this.providerFor(turn.profileId);
    if (provider === null) return;
    const userText = turn.userText.trim().slice(0, INTERACTION_PART_CHARS);
    const reply = replyText.trim().slice(0, INTERACTION_PART_CHARS);
    if (userText === "" && reply === "") return;
    try {
      const ok = await provider.write({
        profileId: turn.profileId,
        sessionId: turn.sessionId,
        kind: "interaction",
        content: `用户：${userText}\n助手：${reply}`,
        source: "interaction",
      });
      if (!ok) this.#logger.warn(`记忆供应商「${provider.id}」拒绝写入本轮交互，已跳过`);
    } catch (err) {
      this.#logger.warn(`记录本轮交互失败（provider ${provider.id}）: ${errorMessage(err)}`);
    }
  }

  /**
   * 日记巩固用：按时间窗读原始条目。provider 不支持（协议可选）或失败时
   * 返回 `null` —— 与「缺失的供应商不降级」同一条判据。
   */
  async readRecent(profileId: string, since: string, limit = 200): Promise<MemoryItem[] | null> {
    const provider = this.providerFor(profileId);
    if (provider === null || provider.readRecent === undefined) return null;
    try {
      return await provider.readRecent({ profileId, since, limit });
    } catch (err) {
      this.#logger.warn(`按时间读取记忆失败（provider ${provider.id}）: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * 宿主侧的写入（日记巩固用）。与 `remember` 的差别：kind 与来源由调用方给定，
   * 会话坐标为空 —— 巩固产物属于整份档，不属于某一次对话。
   */
  async writeAs(
    profileId: string,
    kind: "diary" | "fact",
    content: string,
    source: string,
  ): Promise<boolean> {
    const provider = this.providerFor(profileId);
    if (provider === null) return false;
    try {
      return await provider.write({ profileId, sessionId: "", kind, content, source });
    } catch (err) {
      this.#logger.warn(`记忆写入失败（provider ${provider.id}）: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * 记忆页的召回测试：与真实注入同一条路径（providerFor + recall），但返回
   * 结构化条目。返回 `error` 时 items 为 null（未启用/供应商缺失/召回失败各自
   * 有原因）—— 测试工具要让失败可读，不能把失败伪装成「没有召回」。
   */
  async testRecall(
    profileId: string,
    query: string,
    limit: number,
  ): Promise<{ items: MemoryItem[] | null; error: string | null }> {
    const provider = this.providerFor(profileId);
    if (provider === null) {
      return { items: null, error: "记忆功能未启用，或配置指向的供应商不可用。" };
    }
    if (query.trim() === "") return { items: null, error: "请输入要测试的查询文本。" };
    try {
      const items = await provider.recall({
        profileId,
        sessionId: "",
        query,
        limit: clampTopK(limit),
      });
      return { items, error: null };
    } catch (err) {
      return { items: null, error: `召回失败：${errorMessage(err)}` };
    }
  }

  /** 模型工具 `memory_write` 的入口。返回给模型看的回执文本。 */
  async remember(turn: MemoryTurn, content: string): Promise<string> {
    const provider = this.providerFor(turn.profileId);
    if (provider === null) return "记忆功能未启用，这条没有记下。";
    const trimmed = content.trim();
    if (trimmed === "") return "要记住的内容是空的，请把想记的事实写进 content。";
    try {
      const ok = await provider.write({
        profileId: turn.profileId,
        sessionId: turn.sessionId,
        kind: "fact",
        content: trimmed,
        source: "tool",
      });
      return ok ? "已记住。" : "没有记住：供应商拒绝写入（内容为空或存储故障）。";
    } catch (err) {
      this.#logger.warn(`memory_write 失败（provider ${provider.id}）: ${errorMessage(err)}`);
      return "记忆写入失败。";
    }
  }

  /** 模型工具 `memory_search` 的入口。返回给模型看的检索结果文本。 */
  async search(turn: MemoryTurn, query: string, limit?: number): Promise<string> {
    const provider = this.providerFor(turn.profileId);
    if (provider === null) return "记忆功能未启用。";
    const trimmed = query.trim();
    if (trimmed === "") return "请提供要检索的关键词（query）。";
    const effective = clampTopK(limit ?? this.#resolveConfig().topK);
    let items: MemoryItem[];
    try {
      items = await provider.recall({
        profileId: turn.profileId,
        sessionId: turn.sessionId,
        query: trimmed,
        limit: effective,
      });
    } catch (err) {
      this.#logger.warn(`memory_search 失败（provider ${provider.id}）: ${errorMessage(err)}`);
      return "记忆检索失败。";
    }
    if (items.length === 0) return "没有检索到相关记忆。";
    return items.map((item, index) => `${index + 1}. ${item.content}`).join("\n");
  }
}

/** 把召回条目排成一段 system 注入块。空清单由调用方挡住，这里不做判空。 */
export function formatMemoryBlock(items: MemoryItem[]): string {
  const lines = items.map((item, index) => {
    const when = item.occurredAt !== undefined ? `（${item.occurredAt.slice(0, 10)}）` : "";
    return `${index + 1}. ${when}${item.content}`;
  });
  return [
    "【长期记忆】以下是按本轮输入检索到的过往相关记忆，仅供参考、不是本轮对话：",
    ...lines,
  ].join("\n");
}

function clampTopK(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MEMORY_TOP_K;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_MEMORY_TOP_K);
}
