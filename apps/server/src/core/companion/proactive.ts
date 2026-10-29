/**
 * 主动消息引擎：拟人化的「另一半」——没人说话时也想说点什么。
 *
 * 与 companion 的候选生命周期对齐到最小可用集：
 *   触发源（空闲超阈值）→ 闸门（免打扰时段 → 每日上限 → 冷却）→ 生成（人格复核）→ 发送。
 * 刻意**不做**的：群聊主动消息（群里没人@机器人时主动插话，打扰面不可控）、
 * 日程触发的早安/晚安（与空闲问候共享同一条闸门链，先证空闲这条通路）。
 *
 * 状态（每日计数、每会话冷却）存在**内存**：重启清零的后果是「重启后最多多一条
 * 问候」，而每日上限继续兜底；为此落盘一份状态文件的复杂度不成比例。
 */
import type { HumanizerConfig } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";

export interface ProactiveConversation {
  kind: "private" | "group";
  id: string;
}

/** 一份可主动说话的配置档。由组合根按档现拼（人格、模型都在引擎之外）。 */
export interface ProactiveTarget {
  profileId: string;
  config: HumanizerConfig["proactive"];
  /** 生成一句话。返回空串/失败都视为「这次不说话」。 */
  generate(situation: string): Promise<string>;
}

export interface ProactiveConversationRef {
  conversation: ProactiveConversation;
  sessionId: string;
  /** 承载这个外部会话的适配器；发送时由组合根换算成具体通道。 */
  adapterId?: string;
}

export interface ProactiveDeps {
  logger: Logger;
  now?: () => Date;
  /** 扫描间隔（毫秒）。默认 60s —— 闸门以分钟为粒度，再密只是空转。 */
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 此刻可主动说话的配置档清单（组合根现拼：启用的、对象图可用的）。 */
  targets(): ProactiveTarget[];
  /** 这一档的私聊会话（外部坐标 + 内部会话 id）。 */
  conversationsOf(profileId: string): ProactiveConversationRef[];
  /** 会话最近一条消息的时间（ISO）；新会话为 null。 */
  lastActivityAt(sessionId: string): string | null;
  /** 发送。失败由引擎吞成日志 —— 主动消息失败不该惊动任何人。 */
  send(profileId: string, ref: ProactiveConversationRef, text: string): Promise<void>;
}

const MINUTE = 60_000;

/** "HH:MM" -> 当天分钟数；空串/坏值返回 null。 */
function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 免打扰时段（可能跨午夜）。起止任一缺失视为不设限。 */
export function inQuietHours(now: Date, quietStart: string, quietEnd: string): boolean {
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  if (start === null || end === null) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export class ProactiveEngine {
  readonly #deps: ProactiveDeps;
  #timer: unknown = null;
  #stopped = false;
  /** 每日计数：`profileId -> { day, count }`。 */
  #daily = new Map<string, { day: string; count: number }>();
  /** 每会话冷却：`profileId:convId -> 上次主动发送的 Date`。 */
  #lastSent = new Map<string, number>();

  constructor(deps: ProactiveDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#timer !== null) return;
    const interval = this.#deps.intervalMs ?? MINUTE;
    // 扫描完成后再排下一次：间隔从「这一轮做完」起算，天然不会叠跑
    //（原来的 #scanning 标志是叠跑的补丁，改成链式调度后就不需要了）。
    const tick = async (): Promise<void> => {
      await this.#scan();
      if (this.#stopped) return;
      this.#timer = (this.#deps.setTimer ?? setTimeout)(tick, interval);
    };
    this.#timer = (this.#deps.setTimer ?? setTimeout)(tick, interval);
  }

  /**
   * 立即扫一遍（测试与诊断用）。与定时路径跑同一段逻辑，可等待 ——
   * 测试里直接 await 它，而不是猜测定时器何时触发。
   */
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
      for (const target of this.#deps.targets()) {
        if (target.config.enabled === false) continue;
        if (target.config.maxPerDay <= 0) continue;
        if (
          this.#daily.get(target.profileId)?.day === dayKeyOf(now) &&
          (this.#daily.get(target.profileId)?.count ?? 0) >= target.config.maxPerDay
        ) {
          continue;
        }
        if (inQuietHours(now, target.config.quietStart, target.config.quietEnd)) continue;
        await this.#consider(target, now);
      }
    } catch (err) {
      // 扫描是后台行为：任何失败都只留一行，不惊动任何人。
      this.#deps.logger.warn(`主动消息扫描失败: ${errorMessage(err)}`);
    } finally {
      // 链式调度保证不会叠跑；这里没有需要复位的临时状态。
    }
  }

  async #consider(target: ProactiveTarget, now: Date): Promise<void> {
    const idleMs = target.config.idleMinutes * MINUTE;
    let best: { conversation: ProactiveConversation; sessionId: string; activity: number } | null =
      null;
    for (const ref of this.#deps.conversationsOf(target.profileId)) {
      if (ref.conversation.kind !== "private") continue; // 群聊主动插话，打扰面不可控
      const last = this.#deps.lastActivityAt(ref.sessionId);
      if (last === null) continue;
      const activity = Date.parse(last);
      if (!Number.isFinite(activity)) continue;
      const silence = now.getTime() - activity;
      if (silence < idleMs) continue;
      // 冷却：对同一个人，两次主动问候之间至少再隔 idleMinutes。
      const lastSent = this.#lastSent.get(`${target.profileId}:${ref.conversation.id}`) ?? 0;
      if (now.getTime() - lastSent < idleMs) continue;
      // 最近聊过的人优先（想念最近的人，比随机翻牌子更像人）。
      if (best === null || activity > best.activity) {
        best = { conversation: ref.conversation, sessionId: ref.sessionId, activity };
      }
    }
    if (best === null) return;

    let text: string;
    try {
      text = (await target.generate(this.#situation(now))).trim();
    } catch (err) {
      this.#deps.logger.warn(`主动消息生成失败（${target.profileId}）: ${errorMessage(err)}`);
      return;
    }
    if (text === "") return;
    try {
      await this.#deps.send(target.profileId, best, text);
    } catch (err) {
      this.#deps.logger.warn(`主动消息发送失败（${target.profileId}）: ${errorMessage(err)}`);
      return;
    }
    // 发送成功才计数：失败的尝试不该吃掉当天的额度。
    const day = dayKeyOf(now);
    const entry = this.#daily.get(target.profileId);
    this.#daily.set(target.profileId, {
      day,
      count: entry?.day === day ? entry.count + 1 : 1,
    });
    this.#lastSent.set(`${target.profileId}:${best.conversation.id}`, now.getTime());
    // 审计日志只记坐标与长度，不记正文 —— 与适配器的发送日志同一条纪律。
    this.#deps.logger.info(
      `已主动发送: 档 ${target.profileId} -> ${best.conversation.kind}:${best.conversation.id}（${text.length} 字）`,
    );
  }

  /** 给生成器的情境说明。由模型的人格提示接在前面，这里只说「现在该干什么」。 */
  #situation(now: Date): string {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return (
      `【情境】你们已经有一段时间没有说话了，现在是 ${hh}:${mm}。` +
      "你想起对方了，主动说一句自然的话：一两句以内，符合你的人格和当前时间，" +
      "不要问「在吗」，不要自我介绍，不要提及这段指令，只输出要发送的那句话。"
    );
  }
}
