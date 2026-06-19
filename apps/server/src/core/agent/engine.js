import { randomUUID } from "node:crypto";

/**
 * agent 引擎：把一条入站消息转成一条助手回复。
 *
 * agent 平台与普通 chatbot 的分界线就在这里 —— 这里的 run loop 是
 * 刻意留出的接缝。目前是单轮；工具调用、多步规划与流式输出都能接入
 * `#runTurn`，而无需改变适配器和 API 所依赖的 `handleMessage` 公开契约。
 */
export class AgentEngine {
  constructor({ config, sessions, providers, plugins, logger }) {
    this.config = config;
    this.sessions = sessions;
    this.providers = providers;
    this.plugins = plugins;
    this.logger = logger;
    /** @type {Set<(frame: object) => void>} */
    this.listeners = new Set();
  }

  /** API/适配器订阅出站事件（流式增量、消息）。 */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(frame) {
    for (const fn of this.listeners) fn(frame);
  }

  /**
   * 处理某个会话的一条入站用户消息，返回助手消息。
   * 流式输出时通过 `onDelta` 回调增量。
   */
  async handleMessage({ sessionId, content, model, onDelta }) {
    const session = this.sessions.getWithMessages(sessionId);
    if (!session) throw new Error(`未知会话: ${sessionId}`);

    const userMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    this.sessions.appendMessage(sessionId, userMessage);
    this.#emit({ type: "message", message: userMessage });

    const reply = await this.#runTurn({ session, model, onDelta });

    this.sessions.appendMessage(sessionId, reply);
    this.#emit({ type: "message", message: reply });
    return reply;
  }

  /** @private */
  async #runTurn({ session, model, onDelta }) {
    const history = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result = await this.providers.chat({ model, messages: history });

    const text = result?.content ?? "";
    if (onDelta) {
      onDelta(text);
      onDelta("", true);
    }

    return {
      id: randomUUID(),
      sessionId: session.id,
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
    };
  }
}
