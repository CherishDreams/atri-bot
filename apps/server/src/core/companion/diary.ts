/**
 * 日记与记忆巩固：每天到点把当天的交互记录交给模型，提炼成一篇日记与
 * 若干条值得长期记住的事实，写回记忆（kind = diary / fact）。
 *
 * 这是记忆的**写入**侧闭环：interaction 是引擎自动记的原文（又长又糙），
 * diary/fact 是模型提炼后的成品（短而可召回）。没有这一步，召回质量随
 * 交互量的增长而稀释；有了它，「昨天的日记」本身就是一条高密度记忆。
 *
 * 调度与 ProactiveEngine 同构（分钟扫描 + 每档闸门），判重状态在内存：
 * 重启后同一天**可能**再写一篇 —— 与其为此落盘状态，不如接受一篇重复的
 * 日记（无害且罕见），事实去重靠写入方的幂等纪律做不到，留给未来需要时。
 */
import type { Logger } from "#core/logger.ts";
import { errorMessage } from "#core/errors.ts";

/** 一份可写日记的配置档。由组合根现拼（记忆服务与模型都在引擎之外）。 */
export interface DiaryTarget {
  profileId: string;
  enabled: boolean;
  /** 每天从几点起可以写（0–23，服务器本地时区）。 */
  hour: number;
  /**
   * 读今天的交互记录原文；provider 不支持时返回 `null`（日记巩固对它不可用，
   * 引擎记一条日志后跳过 —— 与 MemoryProvider.readRecent 的可选协议同一条）。
   * 返回空数组表示「今天没有交互」，同样无事可写。
   */
  interactions(): Promise<string[] | null>;
  /** 让模型把交互记录提炼成一篇日记（第一人称、简短）。 */
  composeDiary(dateKey: string, interactions: readonly string[]): Promise<string>;
  /** 让模型从交互记录里提炼值得长期记住的事实，一行一条。 */
  composeFacts(interactions: readonly string[]): Promise<string[]>;
  write(kind: "diary" | "fact", content: string): Promise<boolean>;
}

export interface DiaryDeps {
  logger: Logger;
  now?: () => Date;
  /** 扫描间隔（毫秒）。默认 10 分钟 —— 日记以天为粒度，再密只是空转。 */
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  targets(): DiaryTarget[];
}

/** 每条写回记忆的交互原文进入提炼提示词的截断上限（字符）。 */
const INTERACTION_SNIPPET_CHARS = 600;
/** 单次日记任务的交互条数上限。再多就该分两天写。 */
const MAX_INTERACTIONS_PER_RUN = 100;
/** 每天最多提炼几条事实（模型自由发挥的上限）。 */
const MAX_FACTS_PER_RUN = 5;

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export class DiaryEngine {
  readonly #deps: DiaryDeps;
  #timer: unknown = null;
  #stopped = false;
  /** 每档当天是否已经写过：`profileId -> dayKey`。 */
  #done = new Map<string, string>();
  /** 「provider 不支持 readRecent」只警告一次的档。 */
  #unsupportedWarned = new Set<string>();

  constructor(deps: DiaryDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#timer !== null) return;
    const interval = this.#deps.intervalMs ?? 10 * 60_000;
    const tick = async (): Promise<void> => {
      await this.#scan();
      if (this.#stopped) return;
      this.#timer = (this.#deps.setTimer ?? setTimeout)(tick, interval);
    };
    this.#timer = (this.#deps.setTimer ?? setTimeout)(tick, interval);
  }

  /** 立即扫一遍（测试与诊断用），可等待。 */
  async scanOnce(): Promise<void> {
    await this.#scan();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      (this.#deps.clearTimer ?? clearTimeout)(this.#timer as NodeJS.Timeout);
      this.#timer = null;
    }
  }

  async #scan(): Promise<void> {
    try {
      const now = (this.#deps.now ?? (() => new Date()))();
      const today = dayKeyOf(now);
      for (const target of this.#deps.targets()) {
        if (!target.enabled) continue;
        if (now.getHours() < target.hour) continue;
        if (this.#done.get(target.profileId) === today) continue;
        this.#done.set(target.profileId, today);
        // 判重先行：无论下面成功与否，一天只尝试一次 —— 失败留下「今天没写成日记」，
        // 重启后还有机会（内存状态清零），但同一天内不反复打扰模型。
        await this.#writeFor(target, now, today);
      }
    } catch (err) {
      this.#deps.logger.warn(`日记扫描失败: ${errorMessage(err)}`);
    }
  }

  async #writeFor(target: DiaryTarget, now: Date, today: string): Promise<void> {
    let interactions: string[] | null;
    try {
      interactions = await target.interactions();
    } catch (err) {
      this.#deps.logger.warn(`读取今日交互失败（${target.profileId}）: ${errorMessage(err)}`);
      return;
    }
    if (interactions === null) {
      if (!this.#unsupportedWarned.has(target.profileId)) {
        this.#unsupportedWarned.add(target.profileId);
        this.#deps.logger.warn(
          `配置档「${target.profileId}」的记忆供应商不支持按时间读取，日记巩固不可用`,
        );
      }
      return;
    }
    if (interactions.length === 0) return; // 今天没说话，没有可写的

    const snippets = interactions
      .slice(-MAX_INTERACTIONS_PER_RUN)
      .map((line) => line.slice(0, INTERACTION_SNIPPET_CHARS));

    let diary: string;
    let facts: string[];
    try {
      diary = (await target.composeDiary(today, snippets)).trim();
      facts = (await target.composeFacts(snippets))
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(0, MAX_FACTS_PER_RUN);
    } catch (err) {
      this.#deps.logger.warn(`日记生成失败（${target.profileId}）: ${errorMessage(err)}`);
      return;
    }

    if (diary !== "") {
      const ok = await target.write("diary", `【日记 ${today}】${diary}`);
      if (!ok) this.#deps.logger.warn(`日记写入被拒绝（${target.profileId}）`);
    }
    for (const fact of facts) {
      await target.write("fact", fact);
    }
    this.#deps.logger.info(
      `已写日记: 档 ${target.profileId}，交互 ${snippets.length} 条，事实 ${facts.length} 条`,
    );
  }
}
