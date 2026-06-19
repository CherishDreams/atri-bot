import { randomUUID } from "node:crypto";

/**
 * 内存会话存储。对外接口（create/get/append/list）就是引擎所依赖的形状；
 * 之后要换成持久化存储时，可以直接平替。
 */
export class SessionManager {
  #sessions = new Map();

  constructor(_config) {}

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
