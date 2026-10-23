import { randomUUID } from "node:crypto";
import type { CronLastStatus } from "@atri/shared";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import { readConfigFileAt, writeConfigFileAt } from "#config/file.ts";
import { parseCron } from "./cron.ts";

/** 落盘的完整任务。`nextRunAt` / `running` 是视图算出来的，不存。 */
export interface CronJobRecord {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  profile: string;
  enabled: boolean;
  createdAt: string;
  sessionId: string | null;
  lastRunAt: string | null;
  lastStatus: CronLastStatus | null;
  lastError: string | null;
}

export interface CronJobFields {
  name: string;
  cron: string;
  prompt: string;
  profile: string;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJob(raw: unknown): CronJobRecord | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const profile = typeof raw.profile === "string" ? raw.profile.trim() : "";
  if (id === "" || name === "" || prompt === "" || profile === "" || cron === "") return null;
  try {
    parseCron(cron);
  } catch {
    return null;
  }
  const status = raw.lastStatus;
  const lastStatus = status === "success" || status === "error" ? status : null;
  return {
    id,
    name,
    cron,
    prompt,
    profile,
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
    lastStatus,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
  };
}

/**
 * `data/cron.json` 的读写。与人格库同一条：小文件、同步读写、不做第二份缓存真相。
 * 文件坏掉时任务为空且拒绝写入，避免下一次保存把用户的任务列表覆盖掉。
 */
export class CronStore {
  #filePath: string;
  #logger: Logger;
  #broken = false;
  #jobs = new Map<string, CronJobRecord>();

  constructor({ filePath, logger }: { filePath: string; logger: Logger }) {
    this.#filePath = filePath;
    this.#logger = logger;
    this.#load();
  }

  list(): CronJobRecord[] {
    return [...this.#jobs.values()].map((job) => ({ ...job }));
  }

  get(id: string): CronJobRecord | null {
    const found = this.#jobs.get(id);
    return found === undefined ? null : { ...found };
  }

  create(fields: CronJobFields): CronJobRecord {
    const job: CronJobRecord = {
      id: randomUUID(),
      ...fields,
      createdAt: new Date().toISOString(),
      sessionId: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
    };
    const next = new Map(this.#jobs);
    next.set(job.id, job);
    // 与 AdapterConfigStore 同一条：写盘成功之后才把新表交给读路径。
    // 文件坏掉时 `#persistJobs` 会先抛，内存表保持原样。
    this.#persistJobs(next);
    this.#jobs = next;
    return { ...job };
  }

  update(id: string, fields: CronJobFields): CronJobRecord {
    const current = this.#jobs.get(id);
    if (current === undefined) throw new ApiError("没有这条计划任务", 404);
    const nextRecord: CronJobRecord = { ...current, ...fields };
    const next = new Map(this.#jobs);
    next.set(id, nextRecord);
    this.#persistJobs(next);
    this.#jobs = next;
    return { ...nextRecord };
  }

  remove(id: string): boolean {
    if (!this.#jobs.has(id)) return false;
    const next = new Map(this.#jobs);
    next.delete(id);
    this.#persistJobs(next);
    this.#jobs = next;
    return true;
  }

  setSession(id: string, sessionId: string): void {
    const job = this.#jobs.get(id);
    if (job === undefined) return;
    const next = new Map(this.#jobs);
    next.set(id, { ...job, sessionId });
    this.#persistJobs(next);
    this.#jobs = next;
  }

  recordRun(
    id: string,
    result: { at: string; status: CronLastStatus; error: string | null },
  ): void {
    const job = this.#jobs.get(id);
    if (job === undefined) return;
    const next = new Map(this.#jobs);
    next.set(id, {
      ...job,
      lastRunAt: result.at,
      lastStatus: result.status,
      lastError: result.error,
    });
    this.#persistJobs(next);
    this.#jobs = next;
  }

  #load(): void {
    let file: Record<string, unknown>;
    try {
      file = readConfigFileAt(this.#filePath);
    } catch (err) {
      this.#broken = true;
      this.#logger.error(
        `读取计划任务失败，任务暂时为空（修好文件前不会写入）：${errorMessage(err)}`,
      );
      return;
    }
    if (!Object.hasOwn(file, "jobs")) return;
    if (!Array.isArray(file.jobs)) {
      this.#broken = true;
      this.#logger.error("计划任务的 jobs 必须是数组；修好文件前不会写入");
      return;
    }
    for (const raw of file.jobs) {
      const job = normalizeJob(raw);
      if (job === null) {
        this.#logger.warn("计划任务里有一条格式不正确的条目，已忽略");
        continue;
      }
      this.#jobs.set(job.id, job);
    }
  }

  #persistJobs(jobs: Map<string, CronJobRecord>): void {
    if (this.#broken) {
      throw new ApiError("计划任务文件读取失败，修好它之前不能写入", 500);
    }
    try {
      writeConfigFileAt(this.#filePath, { jobs: [...jobs.values()].map((job) => ({ ...job })) });
    } catch (err) {
      this.#logger.error(`写入计划任务失败: ${errorMessage(err)}`);
      throw new ApiError("保存计划任务失败，详情见服务端日志", 500, { cause: err });
    }
  }
}
