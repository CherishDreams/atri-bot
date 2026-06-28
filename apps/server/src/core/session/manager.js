import { randomUUID } from "node:crypto";

/**
 * 内存会话存储。对外接口（create/get/append/list）就是引擎所依赖的形状；
 * 之后要换成持久化存储时，可以直接平替。
 */
export class SessionManager {
  #sessions = new Map();

  create({ title = "新会话" } = {}) {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.#sessions.set(session.id, session);
    return this.#publicView(session);
  }

  get(id) {
    const s = this.#sessions.get(id);
    return s ? this.#publicView(s) : null;
  }

  /**
   * 会话详情：公开字段 + 完整消息历史。
   * 前端刷新或直接打开 /chat/:id 时靠它把对话恢复出来；
   * `get()` 保持不含消息（列表接口只需要元数据，也不该把全部内容搬过来）。
   */
  getDetail(id) {
    const s = this.#sessions.get(id);
    if (!s) return null;
    return { ...this.#publicView(s), messages: [...s.messages] };
  }

  /** 内部访问器，包含消息内容；仅供引擎使用。 */
  getWithMessages(id) {
    return this.#sessions.get(id) ?? null;
  }

  list() {
    return [...this.#sessions.values()].map((s) => this.#publicView(s));
  }

  appendMessage(sessionId, message) {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new Error(`未知会话: ${sessionId}`);
    s.messages.push(message);
    s.updatedAt = new Date().toISOString();
    return message;
  }

  delete(id) {
    return this.#sessions.delete(id);
  }

  #publicView(s) {
    const { messages: _messages, ...rest } = s;
    return { ...rest, messageCount: s.messages.length };
  }
}
