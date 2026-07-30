import { randomUUID } from "node:crypto";
import type { Message, Session, SessionDetail } from "@atri/shared";

/**
 * 内存会话存储。对外接口（create/get/append/list）就是引擎所依赖的形状；
 * 之后要换成持久化存储时，可以直接平替。
 *
 * 内部记录就是 `SessionDetail`（摘要字段 + 完整消息），`#publicView` 负责在出口
 * 把 `messages` 摘掉换成 `messageCount`，所以「列表不搬运全文」这条约束是由类型保证的。
 */
export class SessionManager {
  #sessions = new Map<string, SessionDetail>();

  create({ title = "新会话" }: { title?: string } = {}): Session {
    const now = new Date().toISOString();
    const session: SessionDetail = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.#sessions.set(session.id, session);
    return this.#publicView(session);
  }

  get(id: string): Session | null {
    const s = this.#sessions.get(id);
    return s ? this.#publicView(s) : null;
  }

  /**
   * 会话详情：公开字段 + 完整消息历史。
   * 前端刷新或直接打开 /chat/:id 时靠它把对话恢复出来；
   * `get()` 保持不含消息（列表接口只需要元数据，也不该把全部内容搬过来）。
   */
  getDetail(id: string): SessionDetail | null {
    const s = this.#sessions.get(id);
    if (!s) return null;
    return { ...this.#publicView(s), messages: [...s.messages] };
  }

  /** 内部访问器，包含消息内容；仅供引擎使用。 */
  getWithMessages(id: string): SessionDetail | null {
    return this.#sessions.get(id) ?? null;
  }

  list(): Session[] {
    return [...this.#sessions.values()].map((s) => this.#publicView(s));
  }

  appendMessage(sessionId: string, message: Message): Message {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new Error(`未知会话: ${sessionId}`);
    s.messages.push(message);
    s.updatedAt = new Date().toISOString();
    return message;
  }

  delete(id: string): boolean {
    return this.#sessions.delete(id);
  }

  #publicView(s: SessionDetail): Session {
    const { messages: _messages, ...rest } = s;
    return { ...rest, messageCount: s.messages.length };
  }
}
