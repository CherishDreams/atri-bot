const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 极简结构化日志。之后可以换成 pino/winston，
 * 无需改动调用方 —— 各层只依赖这个形状。
 */
export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
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
