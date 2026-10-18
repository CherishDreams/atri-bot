import type { CronJobInfo } from "@atri/shared";
import type { AgentEngine } from "#core/agent/engine.ts";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { SessionManager } from "#core/session/manager.ts";
import { nextCronTime, parseCron } from "./cron.ts";
import type { CronJobFields, CronJobRecord, CronStore } from "./store.ts";

export interface CronSchedulerDeps {
  store: CronStore;
  logger: Logger;
  sessions: SessionManager;
  /** 绑定的配置档不可用时返回 null；调度器不 import 配置档层。 */
  resolveEngine: (profileId: string) => AgentEngine | null;
  /** 测试注入假时钟；生产用系统时间。 */
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * 计划任务调度器。
 *
 * 精度是分钟，按**服务器本地时区**解释 cron；服务启动时不为过去的时刻补跑，
 * 只从「现在之后」的下一个触发点开始。这样重启不会因为停机一夜而刷出一串历史任务。
 *
 * 任务结果写进它自己的内部会话，不主动发到外部平台：主动发送需要平台侧寻址与权限，
 * 先把「按时跑一轮、结果可查」做对，比偷偷往某个群发消息安全。
 */
export class CronScheduler {
  #store: CronStore;
  #logger: Logger;
  #sessions: SessionManager;
  #resolveEngine: (profileId: string) => AgentEngine | null;
  #now: () => Date;
  #setTimer: (callback: () => void, delayMs: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  #timer: unknown = null;
  #scheduled = new Map<string, number>();
  #running = new Set<string>();

  constructor({
    store,
    logger,
    sessions,
    resolveEngine,
    now = () => new Date(),
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (handle) => clearTimeout(handle as NodeJS.Timeout),
  }: CronSchedulerDeps) {
    this.#store = store;
    this.#logger = logger;
    this.#sessions = sessions;
    this.#resolveEngine = resolveEngine;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  start(): void {
    this.#reschedule();
  }

  stop(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  /** 配置变了之后重算下一次触发；不打断正在跑的那一轮。 */
  reload(): void {
    this.#reschedule();
  }

  list(): CronJobInfo[] {
    const now = this.#now();
    return this.#store.list().map((job) => this.#view(job, now));
  }

  create(body: Record<string, unknown>): CronJobInfo {
    const fields = this.#validate(body);
    const job = this.#store.create(fields);
    this.#reschedule();
    return this.#view(job, this.#now());
  }

  update(id: string, body: Record<string, unknown>): CronJobInfo {
    const current = this.#store.get(id);
    if (current === null) throw new ApiError("没有这条计划任务", 404);
    const next = this.#validate(body, current);
    const job = this.#store.update(id, next);
    this.#reschedule();
    return this.#view(job, this.#now());
  }

  remove(id: string): void {
    if (!this.#store.remove(id)) throw new ApiError("没有这条计划任务", 404);
    this.#reschedule();
  }

  /**
   * 立即执行。接口只回「已开始」：一轮对话可能跑几分钟，HTTP 请求不应等它。
   * 执行状态通过 `list()` 的 `running` 与 `last*` 观察。
   */
  runNow(id: string): void {
    const job = this.#store.get(id);
    if (job === null) throw new ApiError("没有这条计划任务", 404);
    if (this.#running.has(id)) throw new ApiError("这条计划任务正在执行", 409);
    this.#running.add(id);
    void this.#execute(job).finally(() => this.#running.delete(id));
  }

  /**
   * 跑当前已经到点的任务，返回执行条数。定时器与测试共用这一条路径，
   * 避免「测试走的那条和真实跑的不是一条」。
   */
  async runDue(): Promise<number> {
    const now = this.#now();
    const due = this.#store
      .list()
      .filter((job) => job.enabled && this.#scheduled.has(job.id))
      .filter((job) => (this.#scheduled.get(job.id) ?? Infinity) <= now.getTime());

    let count = 0;
    try {
      for (const job of due) {
        if (this.#running.has(job.id)) continue;
        this.#running.add(job.id);
        count += 1;
        await this.#execute(job);
        this.#running.delete(job.id);
      }
    } finally {
      this.#reschedule();
    }
    return count;
  }

  async #execute(job: CronJobRecord): Promise<void> {
    try {
      const engine = this.#resolveEngine(job.profile);
      if (engine === null) throw new Error(`配置档「${job.profile}」当前不可用`);

      let sessionId = job.sessionId;
      if (sessionId === null || !this.#sessions.has(sessionId)) {
        sessionId = this.#sessions.create({ title: `计划任务 · ${job.name}` }).id;
        try {
          this.#store.setSession(job.id, sessionId);
        } catch (err) {
          this.#logger.error(`记录计划任务「${job.name}」的会话失败: ${errorMessage(err)}`);
        }
      }

      await engine.handleMessage({ sessionId, content: job.prompt });
      this.#record(job, "success", null);
      this.#logger.info(`计划任务「${job.name}」执行完成（配置档「${job.profile}」）`);
    } catch (err) {
      const reason = errorMessage(err);
      this.#record(job, "error", reason);
      this.#logger.error(`计划任务「${job.name}」执行失败: ${reason}`);
    }
  }

  #record(job: CronJobRecord, status: "success" | "error", error: string | null): void {
    try {
      this.#store.recordRun(job.id, {
        at: this.#now().toISOString(),
        status,
        error,
      });
    } catch (err) {
      this.#logger.error(`记录计划任务「${job.name}」的结果失败: ${errorMessage(err)}`);
    }
  }

  #view(job: CronJobRecord, now: Date): CronJobInfo {
    let nextRunAt: string | null = null;
    if (job.enabled) {
      try {
        nextRunAt = nextCronTime(parseCron(job.cron), now).toISOString();
      } catch {
        nextRunAt = null;
      }
    }
    return {
      id: job.id,
      name: job.name,
      cron: job.cron,
      prompt: job.prompt,
      profile: job.profile,
      enabled: job.enabled,
      sessionId: job.sessionId,
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
      lastError: job.lastError,
      nextRunAt,
      running: this.#running.has(job.id),
    };
  }

  #validate(body: Record<string, unknown>, current?: CronJobRecord): CronJobFields {
    const pick = <K extends keyof CronJobFields>(key: K): unknown =>
      body[key] === undefined ? current?.[key] : body[key];

    const name = typeof pick("name") === "string" ? (pick("name") as string).trim() : "";
    if (name === "") throw new ApiError("任务名称不能为空", 400);
    if (name.length > 80) throw new ApiError("任务名称最多 80 个字符", 400);

    const rawCron = typeof pick("cron") === "string" ? (pick("cron") as string).trim() : "";
    let cron: string;
    try {
      cron = parseCron(rawCron).expression;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("cron 格式不正确", 400);
    }

    const prompt = typeof pick("prompt") === "string" ? (pick("prompt") as string).trim() : "";
    if (prompt === "") throw new ApiError("任务提示词不能为空", 400);
    if (prompt.length > 8000) throw new ApiError("任务提示词最多 8000 个字符", 400);

    const profile = typeof pick("profile") === "string" ? (pick("profile") as string).trim() : "";
    if (profile === "") throw new ApiError("必须选择一份配置档", 400);
    if (this.#resolveEngine(profile) === null) {
      throw new ApiError(`配置档「${profile}」不存在或当前不可用`, 400);
    }

    const enabled = pick("enabled");
    if (typeof enabled !== "boolean") throw new ApiError("enabled 必须是布尔值", 400);

    return { name, cron, prompt, profile, enabled };
  }

  #reschedule(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const now = this.#now();
    this.#scheduled = new Map();
    for (const job of this.#store.list()) {
      if (!job.enabled) continue;
      try {
        this.#scheduled.set(job.id, nextCronTime(parseCron(job.cron), now).getTime());
      } catch {
        /* 持久化时已验证过；这里只是防御手改文件的坏值 */
      }
    }
    const earliest = Math.min(...this.#scheduled.values());
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(Math.max(0, earliest - now.getTime()) + 100, 24 * 60 * 60 * 1000);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.runDue();
    }, delay);
  }
}
