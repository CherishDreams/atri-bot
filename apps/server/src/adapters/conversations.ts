import { dirname } from "node:path";
import type { Session } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { ConversationSessions } from "./message.ts";

/** 建会话所需的最小能力；`SessionManager` 天然满足它。 */
export interface SessionDirectory {
  has(id: string): boolean;
  create(input?: { title?: string }): Session;
}

/**
 * 映射文件的读写由组合根注入：`adapters/` 不自己拼权限与原子写，
 * 与插件配置的 `readConfigFileAt` / `writeConfigFileAt` 是同一份实现。
 */
export interface ConversationStateIo {
  ensureDir(dir: string): void;
  read(filePath: string): Record<string, unknown>;
  write(filePath: string, value: Record<string, unknown>): void;
}

export interface JsonConversationSessionsOptions {
  filePath: string;
  sessions: SessionDirectory;
  logger: Logger;
  io: ConversationStateIo;
}

/**
 * 外部会话 → 内部会话 id 的持久映射。
 *
 * 为什么要落盘：会话 id 是随机 UUID，重启后若只靠内存映射，同一个 QQ 私聊会被
 * 建成一条全新的会话，模型与用户都失去上一轮上下文。文件里只有「平台会话键 → 会话 id」，
 * 不含消息内容，也不含凭证。
 *
 * 键里带配置档 id（由调用方拼好）：同一个适配器改绑到另一份配置档时应该另起会话，
 * 否则上一份跑法的对话会跟到新跑法里。
 *
 * 文件坏掉/权限不足时**不阻止适配器启动**：从空表开始，下一轮消息建新会话并尝试
 * 重写文件。代价是丢一次上下文，而不是整个接入平台不可用。
 */
export class JsonConversationSessions implements ConversationSessions {
  #map = new Map<string, string>();
  #filePath: string;
  #sessions: SessionDirectory;
  #logger: Logger;
  #io: ConversationStateIo;

  constructor({ filePath, sessions, logger, io }: JsonConversationSessionsOptions) {
    this.#filePath = filePath;
    this.#sessions = sessions;
    this.#logger = logger;
    this.#io = io;
    this.#load();
  }

  #load(): void {
    try {
      const raw = this.#io.read(this.#filePath);
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value !== "") this.#map.set(key, value);
      }
    } catch (err) {
      this.#logger.warn(
        `读取适配器会话映射失败，将从空表开始（下一条消息会重建会话）：${errorMessage(err)}`,
      );
    }
  }

  getOrCreate(key: string, title: string): string {
    const existing = this.#map.get(key);
    // 会话可能已从控制台删除：此时映射指向一个不存在的 id，必须新建而不是把
    // 一条会 404 的会话 id 交给引擎（那会让每一次发言都静默失败）。
    if (existing !== undefined && this.#sessions.has(existing)) return existing;

    const session = this.#sessions.create({ title });
    this.#map.set(key, session.id);
    this.#save();
    return session.id;
  }

  #save(): void {
    try {
      this.#io.ensureDir(dirname(this.#filePath));
      this.#io.write(this.#filePath, Object.fromEntries(this.#map));
    } catch (err) {
      // 内存里的映射仍然有效；只是重启后会重新建会话。这里不能把异常抛回消息处理链，
      // 否则一次磁盘故障会让用户完全收不到回复。
      this.#logger.warn(`保存适配器会话映射失败（重启后会重建会话）：${errorMessage(err)}`);
    }
  }

  /** 已记录的会话数，供测试与诊断。 */
  get size(): number {
    return this.#map.size;
  }
}
