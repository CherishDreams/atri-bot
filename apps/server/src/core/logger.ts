type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 用 `Record<string, number>` 而不是字面量对象：`createLogger` 的入参刻意是任意
 * 字符串（见下方 `threshold` 的注释），因此这里必须允许用未知键去索引。
 */
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_INFO = 20;

/**
 * 日志器的形状。各层只依赖这个形状，所以之后换成 pino/winston 不必动调用方
 * （依赖极简是刻意的：`AGENTS.md` 规定服务端外部运行时依赖只有 `ws`）。
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(): Logger;
}

export function createLogger(level: string = "info"): Logger {
  // 未知级别退化成 info 是既有行为（`ATRI_LOG_LEVEL=verbose` 今天不会让启动失败）。
  // 把入参收紧成 LogLevel 联合会让它变成「编译期过、运行时靠 ?? 兜住」，
  // 而改成抛错则是行为变更 —— 这里只把已有的兜底写成显式的。
  const threshold = LEVELS[level] ?? LEVEL_INFO;

  const emit = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if ((LEVELS[lvl] ?? LEVEL_INFO) < threshold) return;
    const line = `${new Date().toISOString()} [${lvl}] ${msg}`;
    const out = lvl === "error" || lvl === "warn" ? console.error : console.log;
    if (meta !== undefined) out(line, meta);
    else out(line);
  };

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: () => createLogger(level),
  };
}
