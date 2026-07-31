import { randomUUID } from "node:crypto";
import type { Message, ServerFrame, SessionDetail } from "@atri/shared";
import type { Logger } from "../logger.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { ChatMessage } from "../provider/types.ts";
import type { SessionManager } from "../session/manager.ts";

/**
 * 引擎实际依赖的三样东西，与 `docs/architecture.md` 的装配示例一致。
 *
 * 曾经这里还注入过 `config` 与 `plugins`，但两个字段在全仓**没有任何读取点**，
 * 而 `core/` 按分层约束不得 import `plugins/` —— 也就是说那个接缝既不工作、
 * 又会让类型标注变成一次违规。要接插件钩子时，应该按当时的真实需求重新接线。
 */
export interface EngineDeps {
  sessions: SessionManager;
  providers: ProviderRegistry;
  logger: Logger;
}

export interface HandleMessageOptions {
  sessionId: string;
  content: string;
  model?: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * agent 引擎：把一条入站消息转成一条助手回复。
 *
 * agent 平台与普通 chatbot 的分界线就在这里 —— 这里的 run loop 是
 * 刻意留出的接缝。目前是单轮；工具调用与多步规划都能接入 `#runTurn`，
 * 而无需改变适配器和 API 所依赖的 `handleMessage` 公开契约。
 */
export class AgentEngine {
  sessions: SessionManager;
  providers: ProviderRegistry;
  logger: Logger;
  /** 出站事件的订阅者。公开是既有形状（`subscribe` 返回的退订函数也引用它）。 */
  listeners = new Set<(frame: ServerFrame) => void>();

  constructor({ sessions, providers, logger }: EngineDeps) {
    this.sessions = sessions;
    this.providers = providers;
    this.logger = logger;
  }

  /** API/适配器订阅出站事件（流式增量、消息）。 */
  subscribe(fn: (frame: ServerFrame) => void): () => boolean {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(frame: ServerFrame): void {
    for (const fn of this.listeners) fn(frame);
  }

  /**
   * 处理某个会话的一条入站用户消息，返回助手消息。
   * 流式输出时通过 `onDelta` 回调增量。
   */
  async handleMessage({
    sessionId,
    content,
    model,
    onDelta,
    signal,
  }: HandleMessageOptions): Promise<Message> {
    const session = this.sessions.getWithMessages(sessionId);
    if (!session) throw new Error(`未知会话: ${sessionId}`);

    const userMessage: Message = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    this.sessions.appendMessage(sessionId, userMessage);
    this.#emit({ type: "message", message: userMessage });

    const reply = await this.#runTurn({ session, model, onDelta, signal });

    this.sessions.appendMessage(sessionId, reply);
    this.#emit({ type: "message", message: reply });
    return reply;
  }

  /**
   * 有 `onDelta` 时走 provider 的真实流式接口，否则等完整回复。
   *
   * 两条路径的返回值相同，所以落库内容一致：流式是「边推边拼」，
   * 最终仍以拼接结果为准，不依赖前端把增量攒对。
   */
  async #runTurn({
    session,
    model,
    onDelta,
    signal,
  }: {
    session: SessionDetail;
    model?: string;
    onDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<Message> {
    const history: ChatMessage[] = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const result = onDelta
      ? await this.providers.chatStream({ model, messages: history, onDelta, signal })
      : await this.providers.chat({ model, messages: history, signal });

    return {
      id: randomUUID(),
      sessionId: session.id,
      role: "assistant",
      content: result?.content ?? "",
      createdAt: new Date().toISOString(),
    };
  }
}
