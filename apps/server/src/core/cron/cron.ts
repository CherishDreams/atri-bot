import { ApiError } from "#core/errors.ts";

/**
 * 5 段 cron 的最小实现：分 时 日 月 周。
 *
 * 不引入 `node-cron` / `croner` 是刻意的：本仓的调度精度只需要「分钟」，而依赖极简
 * 是维护中的属性。支持星号、单值、区间、步长（`*` 加 `/n`，或 `a-b/n`）与逗号列表；
 * 周日的 0/7 都认。
 * **使用服务器本地时区**：控制台会明确写出这一点，避免「按 UTC 写、按北京时间等」。
 */
export interface CronSpec {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** 日/周字段是否被限制；两者都限制时按 cron 传统取「或」。 */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

function parseNumber(raw: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(raw)) throw new ApiError(`${label}「${raw}」不是数字`, 400);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ApiError(`${label}「${raw}」超出 ${min}–${max}`, 400);
  }
  return value;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  const wildcard = raw === "*" || raw.startsWith("*/");
  for (const part of raw.split(",")) {
    if (part === "") throw new ApiError(`${label}里有一个空的列表项`, 400);
    const [rangeText, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new ApiError(`${label}「${part}」的 / 用法不对`, 400);
    let step = 1;
    if (stepText !== undefined) {
      step = parseNumber(stepText, 1, max, `${label}步长`);
    }

    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else if (rangeText !== undefined && rangeText.includes("-")) {
      const [a, b, rest] = rangeText.split("-");
      if (rest !== undefined) throw new ApiError(`${label}「${part}」的区间写法不对`, 400);
      start = parseNumber(a ?? "", min, max, label);
      end = parseNumber(b ?? "", min, max, label);
      if (start > end) throw new ApiError(`${label}「${part}」的区间起点大于终点`, 400);
    } else {
      start = parseNumber(rangeText ?? "", min, max, label);
      // `5/10` 在标准 cron 里表示「从 5 开始按 10 步到上界」。
      end = stepText === undefined ? start : max;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard };
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ApiError("cron 必须是 5 段：分 时 日 月 周（例如 `0 9 * * *`）", 400);
  }
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  const minute = parseField(minuteRaw ?? "", 0, 59, "分钟");
  const hour = parseField(hourRaw ?? "", 0, 23, "小时");
  const day = parseField(dayRaw ?? "", 1, 31, "日");
  const month = parseField(monthRaw ?? "", 1, 12, "月");
  const weekday = parseField(weekdayRaw ?? "", 0, 7, "星期");
  // 7 与 0 都是周日；先归一化再交给 Date.getDay()（它只返回 0–6）。
  if (weekday.values.has(7)) {
    weekday.values.delete(7);
    weekday.values.add(0);
  }
  return {
    expression: parts.join(" "),
    minutes: minute.values,
    hours: hour.values,
    days: day.values,
    months: month.values,
    weekdays: weekday.values,
    daysRestricted: !day.wildcard,
    weekdaysRestricted: !weekday.wildcard,
  };
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.minutes.has(date.getMinutes())) return false;
  if (!spec.hours.has(date.getHours())) return false;
  if (!spec.months.has(date.getMonth() + 1)) return false;
  const dayMatch = spec.days.has(date.getDate());
  const weekdayMatch = spec.weekdays.has(date.getDay());
  if (spec.daysRestricted && spec.weekdaysRestricted) return dayMatch || weekdayMatch;
  return dayMatch && weekdayMatch;
}

/** 严格晚于 `after` 的下一个触发时刻。最多向后找 366 天。 */
export function nextCronTime(spec: CronSpec, after: Date): Date {
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (matches(spec, date)) return new Date(date);
    date.setMinutes(date.getMinutes() + 1);
  }
  throw new ApiError(`cron「${spec.expression}」在一年内没有可执行时刻`, 400);
}
