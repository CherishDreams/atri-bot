/**
 * 时间与作息感知：每轮往 system 报头里注入「现在几点、此刻的状态」。
 *
 * 这是 companion「生活日程」的最小内置版：睡眠/起床/午休三个日程参数 +
 * 距上轮对话的间隔。模型知道自己「几点了、是不是刚睡醒」，回复的时态与称呼
 * 才有依据（深夜说早安是拟人化最刺眼的一种穿帮）。
 *
 * 与记忆召回同一条纪律：这段只进报头不落库；provider 抛错由引擎吞成 warn。
 */
import type { HumanizerConfig } from "@atri/shared";
import type { TurnInfo } from "#core/agent/context.ts";

export interface AwarenessDeps {
  config: HumanizerConfig;
  /** 服务器本地时区的当前时间；测试注入假时钟。 */
  now: () => Date;
  /** 这个会话最近一条消息的时间；查不到（新会话）为 null。 */
  lastActivityAt: (sessionId: string) => string | null;
}

/** 把 "HH:MM" 换成当天的分钟数；空串返回 null（不设这一项）。 */
function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 此刻按日程处于什么状态；没有日程（起止任一为空）时返回 null。 */
export function scheduleState(now: Date, schedule: HumanizerConfig["schedule"]): string | null {
  const sleepStart = minutesOf(schedule.sleepStart);
  const sleepEnd = minutesOf(schedule.sleepEnd);
  if (sleepStart === null || sleepEnd === null) return null;
  const minute = now.getHours() * 60 + now.getMinutes();
  // 睡眠区间可能跨午夜（23:30–07:30）：两种归属都要算。
  const asleep =
    sleepStart <= sleepEnd
      ? minute >= sleepStart && minute < sleepEnd
      : minute >= sleepStart || minute < sleepEnd;
  if (asleep) return "睡眠中";
  if (schedule.napMinutes > 0) {
    const napStart = 13 * 60;
    const napEnd = napStart + schedule.napMinutes;
    if (minute >= napStart && minute < napEnd) return "午休中";
  }
  return "清醒";
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 组装本轮的状态注入块；timeAwareness 关闭或无话可说时为 null。 */
export function awarenessBlock(turn: TurnInfo, deps: AwarenessDeps): string | null {
  if (!deps.config.timeAwareness) return null;
  const now = deps.now();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const lines = [
    `【当前状态】现在是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日（周${WEEKDAYS[now.getDay()] ?? ""}）${hh}:${mm}。`,
  ];
  const state = scheduleState(now, deps.config.schedule);
  if (state !== null) lines.push(`按作息日程，此刻的状态：${state}。`);
  const last = deps.lastActivityAt(turn.sessionId);
  if (last !== null) {
    const elapsedMs = now.getTime() - Date.parse(last);
    if (Number.isFinite(elapsedMs) && elapsedMs > 60_000) {
      const minutes = Math.floor(elapsedMs / 60_000);
      const gap =
        minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
      lines.push(`距这条消息之前最近的一次对话已过去约 ${gap}。`);
    }
  }
  return lines.length === 1 && state === null && last === null ? lines[0]! : lines.join("\n");
}
