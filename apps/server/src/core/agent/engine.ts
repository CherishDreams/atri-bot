import { randomUUID } from "node:crypto";
import type { Message, ServerFrame, SessionDetail } from "@atri/shared";
import type { Logger } from "../logger.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { ChatMessage, ChatTool } from "../provider/types.ts";
import type { SessionManager } from "../session/manager.ts";
import type { ToolConfigStore } from "../tool/store.ts";
import type { ToolRegistry } from "../tool/registry.ts";
import type { ToolDefinition } from "../tool/types.ts";

/**
 * 引擎实际依赖的东西，与 `docs/architecture.md` 的装配示例一致。
 *
 * 曾经这里还注入过 `config` 与 `plugins`，但两个字段在全仓**没有任何读取点**，
 * 而 `core/` 按分层约束不得 import `plugins/` —— 也就是说那个接缝既不工作、
 * 又会让类型标注变成一次违规。要接插件钩子时，应该按当时的真实需求重新接线。
 *
 * `tools` 与 `toolConfig` 是这次真有了读取点才加进来的：前者负责执行，
 * 后者负责「本轮到底允许用哪几颗」（每次现读文件，见 `tool/store.ts`）。
 */
export interface EngineDeps {
  sessions: SessionManager;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  logger: Logger;
}

export interface HandleMessageOptions {
  sessionId: string;
  content: string;
  model?: string;
  onDelta?: (delta: string) => void;
  /**
   * 多步循环里每一条**中间**消息（带 `toolCalls` 的助手消息、以及工具结果）。
   *
   * 刻意不含两条：入站的用户消息（调用方自己发的，再推一遍只会让前端多一次去重），
   * 以及最终回复（它就是返回值）。这样「没启用工具时一帧都不多发」是可断言的。
   *
   * 为什么不复用 `subscribe()` 那条广播：SSE 响应不在广播链上
   * （`api/server.ts` 只把 `subscribe` 接给了 WebSocket 的 broadcast），
   * 流式端点要拿到中间消息必须走自己这条回调。
   */
  onMessage?: (message: Message) => void;
  signal?: AbortSignal;
}

/**
 * agent 引擎：把一条入站消息转成一条助手回复。
 *
 * agent 平台与普通 chatbot 的分界线就在这里：`#runLoop` 会执行模型要求的工具调用、
 * 把结果回喂、再问一次，直到模型不再要求调用（或到达步数上限）。
 * `handleMessage` 的公开契约不变 —— 适配器和 API 依赖的仍是「一条入站、一条最终回复」。
 */
export class AgentEngine {
  sessions: SessionManager;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  logger: Logger;
  /** 出站事件的订阅者。公开是既有形状（`subscribe` 返回的退订函数也引用它）。 */
  listeners = new Set<(frame: ServerFrame) => void>();

  constructor({ sessions, providers, tools, toolConfig, logger }: EngineDeps) {
    this.sessions = sessions;
    this.providers = providers;
    this.tools = tools;
    this.toolConfig = toolConfig;
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
    onMessage,
    signal,
  }: HandleMessageOptions): Promise<Message> {
    const session = this.sessions.getWithMessages(sessionId);
    if (!session) throw new Error(`未知会话: ${sessionId}`);

    const userMessage = this.#newMessage(session.id, { role: "user", content });
    this.sessions.appendMessage(session.id, userMessage);
    this.#emit({ type: "message", message: userMessage });

    return this.#runLoop({ session, model, onDelta, onMessage, signal });
  }

  /**
   * 多步循环。
   *
   * 终止条件只看「这一轮模型还要不要调用工具」，不看 `finish_reason` / `stop_reason` ——
   * OpenAI 兼容网关在这两个字段上的一致性太差（`provider/openai.ts` 已经在处理
   * 「网关把 error 塞进 200 流」），而 `toolCalls` 是我们自己能数的事实。
   *
   * 有 `onDelta` 时走流式、否则等完整回复，两条路径返回值相同，所以落库内容一致：
   * 流式是「边推边拼」，最终仍以拼接结果为准，不依赖前端把增量攒对。
   */
  async #runLoop({
    session,
    model,
    onDelta,
    onMessage,
    signal,
  }: {
    session: SessionDetail;
    model?: string;
    onDelta?: (delta: string) => void;
    onMessage?: (message: Message) => void;
    signal?: AbortSignal;
  }): Promise<Message> {
    // 工具集在一次运行内固定：中途翻开关会影响下一条消息，但不该让模型见过的
    // 工具列表在同一条消息里变来变去（与 `ProviderRegistry.clear()` 的注释同一条不变量）。
    const declared = this.#declaredTools();
    const allowed = new Set(declared.map((tool) => tool.name));
    const history = this.#historyFor(session);
    const cap = this.toolConfig.maxSteps();

    for (let step = 0; ; step++) {
      if (signal?.aborted) throw new Error("请求已取消");
      if (step >= cap) {
        throw new Error(
          `已达单轮工具调用步数上限（${cap}），已停止。` +
            `确认过工具确实是需要的，可以调高配置里的 maxToolSteps。`,
        );
      }

      const result = onDelta
        ? await this.providers.chatStream({
            model,
            messages: history,
            tools: declared,
            onDelta,
            signal,
          })
        : await this.providers.chat({ model, messages: history, tools: declared, signal });

      const calls = result?.toolCalls ?? [];
      const assistant = this.#record(session, {
        role: "assistant",
        content: result?.content ?? "",
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });
      // 助手这条必须先进 history，再排它的结果：两家上游都靠这个顺序把
      // 调用与结果配起来，反过来会被判成「有结果没有调用」。
      history.push(this.#toChatMessage(assistant, assistant.toolCalls));

      if (calls.length === 0) return assistant;
      // 它只是中间步，最终回复由返回值带出去；这里通知一次，SSE 才不至于
      // 整轮只显示最后一段字。
      onMessage?.(assistant);

      for (const call of calls) {
        // 只执行本轮**真的声明过**的工具。模型可以在没有声明任何工具时硬吐一个
        // `tool_calls`（兼容网关与自训模型都会这样），那时绝不能去执行它 ——
        // 那就是「配置里关掉的开关被模型远程打开」。拒绝执行的结果照样回喂，
        // 让模型有机会改用正常回答；步数上限兜住它反复这么干的代价。
        const refusal = allowed.has(call.name) ? null : `工具「${call.name}」本轮未授权执行`;
        const toolResult =
          refusal === null
            ? // 顺序执行：内置工具是本地代码，并行没有延迟收益，而帧顺序由此确定 ——
              // 并行时前端要靠 id 反推次序，那是一条更贵的路径。
              await this.tools.run(call)
            : { toolCallId: call.id, name: call.name, content: refusal, isError: true };
        const record = this.#record(session, {
          role: "tool",
          content: toolResult.content,
          toolCallId: toolResult.toolCallId,
        });
        history.push(this.#toChatMessage(record, undefined));
        onMessage?.(record);
      }
    }
  }

  /** 落库 + 广播，两者永远同时发生，避免出现「只有半边看得见」的状态。 */
  #record(
    session: SessionDetail,
    fields: Omit<Message, "id" | "sessionId" | "createdAt">,
  ): Message {
    const message = this.#newMessage(session.id, fields);
    this.sessions.appendMessage(session.id, message);
    this.#emit({ type: "message", message });
    return message;
  }

  #newMessage(sessionId: string, fields: Omit<Message, "id" | "sessionId" | "createdAt">): Message {
    return { id: randomUUID(), sessionId, createdAt: new Date().toISOString(), ...fields };
  }

  /**
   * 本轮交给模型的工具声明。
   *
   * 配置里写了但没注册的 id 会被**记一条 warn**而不是静默丢掉：否则「我明明开了」
   * 会变成一次只能靠猜的排查（`ProviderInfo.loaded`/`error` 存在的理由是同一条）。
   */
  #declaredTools(): ChatTool[] {
    const enabled = this.toolConfig.enabledIds();
    const known = new Set(this.tools.list().map((tool) => tool.id));
    for (const id of enabled) {
      if (!known.has(id)) this.logger.warn(`配置里启用了未注册的工具「${id}」，本轮已忽略`);
    }
    return this.tools.pick(enabled).map(toChatTool);
  }

  /**
   * 会话历史 -> 上游消息。
   *
   * 工具字段必须带上（旧实现只留 `role`/`content`，于是第二轮请求「有结果没有调用」）。
   * 另外做一次**配对修复**：带 `toolCalls` 却没有配到结果的助手消息，是上一轮被
   * 客户端断开或撞上步数上限留下的半截 —— 两家上游都会拒绝那种历史。
   * `SessionManager.appendMessage` 不做角色校验，所以兜底只能放在这里。
   */
  #historyFor(session: SessionDetail): ChatMessage[] {
    const answered = new Set(
      session.messages
        .filter((m) => m.role === "tool" && m.toolCallId)
        .map((m) => m.toolCallId as string),
    );

    return session.messages.map((m) => {
      const calls = m.toolCalls?.filter((call) => answered.has(call.id));
      // 一条都没配上的助手消息退化成纯文本（保留它说过的话，丢掉它没做完的要求）。
      return this.#toChatMessage(m, calls && calls.length > 0 ? calls : undefined);
    });
  }

  /**
   * 一条落库消息 -> 上游消息。
   *
   * `toolCalls` 由调用方**显式**给定，不默认取消息自带的那一份：历史修复会把
   * 「没配到结果」的调用判成无，若这里再 `?? message.toolCalls` 兜一次，
   * 那些半截调用就被重新带回上游了（正是这次修复要挡掉的东西）。
   */
  #toChatMessage(
    message: Pick<Message, "role" | "content" | "toolCallId">,
    toolCalls: Message["toolCalls"],
  ): ChatMessage {
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

function toChatTool(tool: ToolDefinition): ChatTool {
  return { name: tool.id, description: tool.description, parameters: tool.parameters };
}
