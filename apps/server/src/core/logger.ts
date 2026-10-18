import { randomUUID } from "node:crypto";
import type { LogEntry, LogLevel } from "@atri/shared";

/**
 * 用 `Record<string, number>` 而不是字面量对象：`createLogger` 的入参刻意是任意
 * 字符串（见下方 `threshold` 的注释），因此这里必须允许用未知键去索引。
 */
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_INFO = 20;

/**
 * 日志页的内存上限。数值不是随手取的：500 行足够覆盖一次排障的最近上下文，
 * 而每条消息再截到 4 KiB，最坏约 2 MiB —— 一个长期运行的进程扛得住。
 *
 * 刻意**不落盘**：`dataDir` 里的东西都是用户要备份的状态，日志是进程的瞬时输出；
 * 写文件会立刻带出轮转、清理、权限、磁盘满四件事，而「重启即清空」是这一版明确接受的
 * 语义。要持久化应该交给部署侧的 stdout 收集，而不是让框架自己写文件。
 */
export const LOG_BUFFER_CAPACITY = 500;
/** 打开日志页时默认补发多少行历史；SSE 断线重连也用它做一次对账。 */
export const LOG_DEFAULT_LIMIT = 200;
const LOG_MESSAGE_LIMIT = 4000;

/** `createLogger` 的旁路出口。实现只有 `LogStore`，抽成接口是为了单测不依赖 HTTP。 */
export interface LogSink {
  push(level: LogLevel, message: string, time: string): void;
}

/**
 * 进程内日志环形缓冲 + 订阅。
 *
 * 它挂在 logger 上，而不是挂在 HTTP 层：启动阶段的日志（建库、seed、插件加载）
 * 也必须能被日志页看到，而那时 HTTP 服务还没构造。顺序是组合根先建 store、再建 logger。
 */
export class LogStore {
  /**
   * 这一份缓冲区的进程实例。服务重启后 id 从 1 重新开始，单看 id 无法区分
   * 「新进程」与「旧进程只收到更少的行」；客户端靠它决定是否整份重置。
   */
  readonly instance = randomUUID();
  #entries: LogEntry[] = [];
  #nextId = 1;
  #listeners = new Set<(entry: LogEntry) => void>();

  push(level: LogLevel, message: string, time = new Date().toISOString()): void {
    const entry: LogEntry = {
      instance: this.instance,
      id: this.#nextId++,
      time,
      level,
      message:
        message.length > LOG_MESSAGE_LIMIT ? `${message.slice(0, LOG_MESSAGE_LIMIT)}…` : message,
    };
    this.#entries.push(entry);
    if (this.#entries.length > LOG_BUFFER_CAPACITY) this.#entries.shift();
    for (const listener of this.#listeners) {
      try {
        listener(entry);
      } catch {
        // 订阅者是 HTTP 长连接，socket 在竞态里可能已经断了。日志订阅的故障
        // **不能反向打断产生这条日志的业务** —— 那会把一次日志推送失败升级成请求失败。
      }
    }
  }

  /** 最近 `limit` 条，按 id 升序。调用方负责把 limit 夹在合法范围里。 */
  recent(limit = LOG_DEFAULT_LIMIT): LogEntry[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.#entries.slice(-Math.min(limit, LOG_BUFFER_CAPACITY));
  }

  /** id 大于 `id` 的日志，用于 SSE 断线续传。缓冲已经滚掉的部分自然补不回来。 */
  after(id: number): LogEntry[] {
    return this.#entries.filter((entry) => entry.id > id);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#entries.length;
  }
}

/**
 * 日志器的形状。各层只依赖这个形状，所以之后换成 pino/winston 不必动调用方
 * （依赖极简是刻意的：`AGENTS.md` 规定服务端外部运行时依赖只有 `ws`）。
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/*
 * 这里**没有** `child()`。它以前有（`() => Logger`，返回同级别的新实例），而全仓零调用点 ——
 * 留着它的代价不是那两行实现，是**每一个**测试替身都得替一个没人走的路径补上方法
 *（本仓有 6 份 silentLogger/quietLogger，各多写 3 行）。AGENTS.md 的口径是
 * 「确定没用就整个删」；真需要按请求/插件分频道时再加，那时它至少有一个调用方来定形状。
 */

export function createLogger(level: string = "info", sink?: LogSink): Logger {
  // 未知级别退化成 info 是既有行为（`ATRI_LOG_LEVEL=verbose` 今天不会让启动失败）。
  // 把入参收紧成 LogLevel 联合会让它变成「编译期过、运行时靠 ?? 兜住」，
  // 而改成抛错则是行为变更 —— 这里只把已有的兜底写成显式的。
  const threshold = LEVELS[level] ?? LEVEL_INFO;

  const emit = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if ((LEVELS[lvl] ?? LEVEL_INFO) < threshold) return;
    // 同一个时间戳同时给控制台与缓冲区：分成两次 `new Date()` 会让同一条日志在
    // 终端与页面上差几毫秒，排障时对不上。
    const time = new Date().toISOString();
    // `meta` 刻意**不进缓冲区**：它是调用方顺手挂的任意对象，形状不稳定，
    // 也可能带着不该出现在另一个出口里的上下文。今天没有调用方用它；
    // 将来要用，应该先把要展示的内容写进消息里，而不是把对象序列化出去。
    sink?.push(lvl, msg, time);
    const line = `${time} [${lvl}] ${msg}`;
    const out = lvl === "error" || lvl === "warn" ? console.error : console.log;
    if (meta !== undefined) out(line, meta);
    else out(line);
  };

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}
