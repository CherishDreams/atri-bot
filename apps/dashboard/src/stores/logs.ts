import { defineStore } from "pinia";
import type { LogEntry } from "../api/generated/index.js";
import * as api from "../api/client.js";

const MAX_ENTRIES = 500;
const HISTORY_LIMIT = 200;
const RECONNECT_DELAY_MS = 1500;

export type LogConnection = "connecting" | "open" | "retrying" | "closed";

/**
 * 当前这一轮订阅的标识。`stop()` 与重新 `start()` 都会把它加一，
 * 旧循环在下一个检查点看到不一致就退出 —— 不需要在每一处 await 之后手动取消。
 */
let runId = 0;
let controller: AbortController | null = null;

function trim(entries: LogEntry[]): LogEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LogTarget {
  entries: LogEntry[];
  instance: string | null;
  lastSeenId: number;
  connection: LogConnection;
  error: string | null;
}

/**
 * 一条订阅循环：列表对账 → SSE 续传 → 断线重连。
 *
 * **每次重连都先读一次 `GET /logs`**，而不是只拿 `after` 去接。原因有两个：
 * - 服务重启后日志序号从 1 重新开始，旧的 `lastSeenId` 可能永远大于新序号，
 *   只带 `after` 会得到一条永远没有内容的流；
 * - 断线期间缓冲可能已经滚过一段，列表能把「还在缓冲里」的缺口补齐。
 * 新序号比手里的还小就整份换掉，否则只追加缺失的部分。
 */
async function consume(target: LogTarget, currentRun: number): Promise<void> {
  for (;;) {
    if (currentRun !== runId) return;
    const turn = new AbortController();
    controller = turn;
    try {
      target.connection = target.entries.length === 0 ? "connecting" : "retrying";
      const history = await api.listLogs(HISTORY_LIMIT);
      if (currentRun !== runId) return;

      const newest = history.logs.at(-1)?.id ?? 0;
      if (target.instance !== null && target.instance !== history.instance) {
        // 进程换了：序号可能恰好比旧水位大，也可能更小，唯一可靠的判据是实例 id。
        target.entries = history.logs;
        target.lastSeenId = newest;
      } else {
        const missing = history.logs.filter((entry) => entry.id > target.lastSeenId);
        if (missing.length > 0) target.entries = trim([...target.entries, ...missing]);
        if (newest > target.lastSeenId) target.lastSeenId = newest;
      }
      target.instance = history.instance;
      target.error = null;
      target.connection = "open";

      for await (const entry of api.streamLogs(target.lastSeenId, turn.signal)) {
        if (currentRun !== runId) return;
        if (target.instance !== entry.instance) {
          // 列表与流之间恰好重启过：以这条为起点重置，下一次重连会补齐历史。
          target.entries = [entry];
          target.lastSeenId = entry.id;
          target.instance = entry.instance;
        } else if (entry.id > target.lastSeenId) {
          // 服务端补发与实时推送可能有重叠；只认比手里更新的 id。
          target.entries = trim([...target.entries, entry]);
          target.lastSeenId = entry.id;
        }
        target.connection = "open";
      }
      if (currentRun !== runId) return;
      target.connection = "retrying";
    } catch (err) {
      if (currentRun !== runId || turn.signal.aborted) return;
      if (err instanceof api.UnauthorizedError) {
        target.connection = "closed";
        target.error = "登录已失效，请重新登录。";
        return;
      }
      target.connection = "retrying";
      target.error = `实时连接中断：${(err as Error).message}`;
    } finally {
      if (controller === turn) controller = null;
    }
    if (currentRun !== runId) return;
    await sleep(RECONNECT_DELAY_MS);
  }
}

/**
 * 日志页状态。
 *
 * `entries` 是**显示用的**最近 500 行；`lastSeenId` 是续传水位，清空列表时**不重置**它 ——
 * 否则下一次重连会把刚清掉的旧日志从缓冲区里再拉回来。服务端重启由序号回退检测处理。
 *
 * 自动滚动不在 store 里：它取决于用户此刻是否停在底部，是纯界面状态，
 * 放进 store 只会多一份需要和滚动位置同步的真源。
 */
export const useLogsStore = defineStore("logs", {
  state: () => ({
    entries: [] as LogEntry[],
    instance: null as string | null,
    lastSeenId: 0,
    connection: "connecting" as LogConnection,
    error: null as string | null,
  }),

  actions: {
    /** 启动订阅；会先停掉上一轮。这个 Promise 在停止之前不会 resolve。 */
    async start(): Promise<void> {
      runId += 1;
      controller?.abort();
      controller = null;
      this.connection = "connecting";
      this.error = null;
      await consume(this, runId);
    },

    stop(): void {
      runId += 1;
      controller?.abort();
      controller = null;
      this.connection = "closed";
    },

    /** 只清空当前页面；服务端缓冲区与续传水位都保留，所以旧行不会在重连时回来。 */
    clear(): void {
      this.entries = [];
    },

    retry(): void {
      void this.start();
    },
  },
});
