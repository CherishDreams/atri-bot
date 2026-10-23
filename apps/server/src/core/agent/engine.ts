import { randomUUID } from "node:crypto";
import type { AdapterAccessControl, Message, MessageImage, SessionDetail } from "@atri/shared";
import { ApiError, errorStack } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { ProviderRegistry } from "#core/provider/registry.ts";
import type { ChatMessage, ChatTool } from "#core/provider/types.ts";
import type { SessionManager } from "#core/session/manager.ts";
import { SESSION_BUSY_MESSAGE, type SessionLock } from "#core/session/lock.ts";
import type { SessionEvents } from "./events.ts";
import type { ToolConfigStore } from "#core/tool/store.ts";
import type { ToolRegistry } from "#core/tool/registry.ts";
import type { ToolDefinition } from "#core/tool/types.ts";
import type { CommandRegistry } from "#core/command/registry.ts";
import type { CommandContext } from "#core/command/types.ts";
import { parseCommand, splitCommandArgs } from "#core/command/parser.ts";
import { DEFAULT_COMMAND_PREFIX } from "#core/command/types.ts";

/**
 * 引擎实际依赖的东西，与 `docs/architecture.md` 的装配示例一致。
 *
 * 曾经这里还注入过 `config` 与 `plugins`，但两个字段在全仓**没有任何读取点**，
 * 而 `core/` 按分层约束不得 import `plugins/` —— 也就是说那个接缝既不工作、
 * 又会让类型标注变成一次违规。要接插件钩子时，应该按当时的真实需求重新接线。
 *
 * `tools` 与 `toolConfig` 是真有了读取点才加进来的：前者负责执行，
 * 后者负责「本轮到底允许用哪几颗」（每次现读文件，见 `tool/store.ts`）。
 *
 * `lock` / `events` / `profileId` 属于**这个引擎之外**的共享状态，理由是它们必须跨配置档：
 * 每个配置档一个引擎，而「同一个会话不能同时跑两轮」与「一条消息只广播一次」都不是
 * 单个配置档内部的事。详见 `core/session/lock.ts` 与 `core/agent/events.ts`。
 */
export interface EngineDeps {
  sessions: SessionManager;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  logger: Logger;
  lock: SessionLock;
  events: SessionEvents;
  /** 这个引擎代表哪一份配置档 —— 只用来在共享锁里登记持有者。 */
  profileId: string;
  /**
   * 这一档默认用哪个 provider 实例；`null` 表示「没有档级默认，用全局那一个」。
   *
   * 生效次序是 `请求带的 model → 档.defaultProvider → 全局 providers.default`。
   * 第三级不在这里写：那是注册表自己的回退（`#resolveFor`），供应商全局一份之后
   * 它本来就是全局的。这里只补前两级的差。
   */
  defaultProviderId: string | null;
  /**
   * 这一档选用的人格提示。组合根在人格保存后更新它，下一次请求立刻生效；
   * 空串表示不注入 system 消息。
   */
  systemPrompt: string;
  /**
   * 指令注册表（可选：单元测试与不需要指令的嵌入式用法可以不注入）。
   * 每份配置档一个：内置指令 + 这一档的插件指令，随插件启停自动进退。
   */
  commands?: CommandRegistry;
  /**
   * 这一份档的准入控制现读。指令的 admin 权限要拿 `adminIds` 判断，
   * 注入访问器而不是让引擎缓存一份名单 —— 保存档后下一条消息就该用新规则
   * （与适配器的 `resolveAccess` 同一条理由）。
   */
  resolveAccess?: () => AdapterAccessControl;
  /**
   * 唤醒前缀：群聊消息必须以它开头才被处理，同时是指令的匹配前缀。
   * 可变（配置保存后由组合根热更新）；空串 = 关闭群聊唤醒门槛，此时指令
   * 仍按 `DEFAULT_COMMAND_PREFIX` 识别 —— 关门槛不该顺手关掉指令系统。
   * 缺省 `/`。
   */
  wakePrefix?: string;
}

/**
 * 发给上游的历史文本预算（字符）。本仓自选值，不是模型上下文的换算表：
 * 没有这个上限时，任何长会话都会在某一轮突然超过上游窗口，而且每次请求都要把全部历史
 * 搬进内存；有它之后至少有确定的边界，代价是很久以前的正文不再进入本轮上下文。
 *
 * `images` 不按 base64 字符计入这里，单独由 `MAX_CONTEXT_IMAGE_BYTES` 限制。
 */
export const MAX_CONTEXT_CHARS = 120_000;
/** 一轮请求最多携带的图片字节数（按 base64 解码后的估算）；更老的图片会被省略。 */
export const MAX_CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_OMITTED = "[图片已省略]";

/** 历史窗口只影响发给上游的那一份副本，不改 sqlite 里的消息。 */
function contextWindow(messages: Message[]): Message[] {
  let start = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const cost =
      message.content.length +
      (message.toolCalls?.reduce((sum, call) => sum + call.arguments.length, 0) ?? 0);
    // 最后一条（本轮用户消息）无论多大都必须发；否则模型看不见自己刚被问了什么。
    if (start < messages.length && used + cost > MAX_CONTEXT_CHARS) break;
    used += cost;
    start = i;
  }
  const window = messages.slice(start);
  // 窗口从中间切断时，开头的 tool 结果没有对应的 assistant 调用；上游会拒绝对话。
  while (window[0]?.role === "tool") window.shift();
  return window;
}

/**
 * 按“从新到旧”的顺序分配图片预算。
 *
 * 只改传给上游的副本：旧图片仍留在历史里，控制台还能看；但模型不会再为它们付
 * 一次 token/内存。整条消息的图片都被省略且正文为空时补一个占位，避免给上游发空内容。
 */
function capHistoryImages(messages: Message[]): Message[] {
  const copies = messages.map((message) => ({
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
  }));
  let remaining = MAX_CONTEXT_IMAGE_BYTES;
  for (let i = copies.length - 1; i >= 0; i -= 1) {
    const message = copies[i];
    if (!message?.images) continue;
    const kept: MessageImage[] = [];
    let dropped = false;
    for (const image of message.images) {
      // base64 的字符数约等于解码后字节数的 4/3；不必精确到字节，预算本来就是保守值。
      const cost = Math.ceil((image.data.length * 3) / 4);
      if (cost <= remaining) {
        kept.push(image);
        remaining -= cost;
      } else {
        dropped = true;
      }
    }
    message.images = kept.length > 0 ? kept : undefined;
    if (dropped) {
      message.content =
        message.content.trim() === "" ? IMAGE_OMITTED : `${message.content} ${IMAGE_OMITTED}`;
    }
  }
  return copies;
}

export interface HandleMessageOptions {
  sessionId: string;
  content: string;
  /**
   * 指令匹配用的文本。适配器路径下群聊正文带 `[发送人]` 前缀，而指令匹配必须针对
   * **原始输入**（`/help` 才是 `/help`，不是 `[张三] /help`）；控制台路径缺省时用
   * `content` 本身。只在指令匹配里用，不落库。
   */
  commandText?: string;
  /**
   * 平台发送人身份。指令的 admin 权限与指令上下文要用；控制台来源不带它
   *（登录态本身就是管理员凭证）。它只在运行期使用，**不落库**。
   */
  sender?: { id: string; name: string };
  /**
   * 消息来源。`platform` = 适配器；`console` = 控制台（视为管理员）；
   * `cron` = 计划任务 —— 定时提示词是写给模型的，不做指令匹配。
   */
  source?: "platform" | "console" | "cron";
  /** 随这条用户消息一起交给模型的图片；直接聊天接口不带它。 */
  images?: MessageImage[];
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
  /** 全局那一份注册表（供应商是部署级的，不再按配置档各建一套）。 */
  providers: ProviderRegistry;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  logger: Logger;
  lock: SessionLock;
  events: SessionEvents;
  profileId: string;
  /**
   * 这一档的默认 provider 实例。可变，因为改它是一次配置写入：
   * `POST /profiles/{id}/default-provider` 先落盘，再由组合根更新这里，
   * 下一次发消息立刻用的是新值 —— 不必等一次重载。
   */
  defaultProviderId: string | null;
  /**
   * 人格提示。与 `defaultProviderId` 一样可变：保存人格后不必重建引擎，
   * 下一条消息读到的是新提示词。
   */
  systemPrompt: string;
  commands?: CommandRegistry;
  resolveAccess?: () => AdapterAccessControl;
  wakePrefix: string;

  constructor({
    sessions,
    providers,
    tools,
    toolConfig,
    logger,
    lock,
    events,
    profileId,
    defaultProviderId,
    systemPrompt,
    commands,
    resolveAccess,
    wakePrefix = DEFAULT_COMMAND_PREFIX,
  }: EngineDeps) {
    this.sessions = sessions;
    this.providers = providers;
    this.tools = tools;
    this.toolConfig = toolConfig;
    this.logger = logger;
    this.lock = lock;
    this.events = events;
    this.profileId = profileId;
    this.defaultProviderId = defaultProviderId;
    this.systemPrompt = systemPrompt;
    this.commands = commands;
    this.resolveAccess = resolveAccess;
    this.wakePrefix = wakePrefix;
  }

  /**
   * 处理某个会话的一条入站用户消息，返回助手消息。
   * 流式输出时通过 `onDelta` 回调增量。
   */
  async handleMessage({
    sessionId,
    content,
    commandText,
    sender,
    source,
    images,
    model,
    onDelta,
    onMessage,
    signal,
  }: HandleMessageOptions): Promise<Message> {
    // 同一个会话只允许一轮对话在跑（为什么这把锁在引擎之外，见 `SessionLock` 的类注释）。
    // 非流式端点直接吃这个 409；流式端点靠 `lock.has()` 在开流前预检。
    if (!this.lock.tryEnter(sessionId, this.profileId)) {
      throw new ApiError(SESSION_BUSY_MESSAGE, 409);
    }
    try {
      // 指令匹配排在**落库之前**：命中即短路，工具循环与 provider 完全不参与 ——
      // 这是指令系统存在的意义（AstrBot 的同一条管线次序：指令优先于 LLM）。
      // 匹配没有命中（带了前缀但不是任何指令名）就落回正常路径，交给模型。
      const commandReply = await this.#tryCommand({
        sessionId,
        content,
        commandText,
        sender,
        source,
      });
      if (commandReply !== null) return commandReply;

      // 顺序是有意义的，而且是为了兼容库化后的读取语义：**先追加、再读历史**。
      // 内存版的 `getWithMessages` 返回 Map 里那份活对象，先读后追加也看得见这条用户消息；
      // 库化后每次读都是一份独立快照，反过来写就会把刚刚那条用户消息漏在上下文外面
      // ——模型会回答一个看不见自己问题的那一轮。（这条不是洁癖：改动前它真的漏了，
      // 由 `engine-tools.test.ts` 的「回喂的那一次请求里必须同时有 tool_calls 与工具结果」抓到。）
      const userMessage = this.#newMessage(sessionId, {
        role: "user",
        content,
        // 空数组不落键：Dashboard 与规格用「有没有 images」区分纯文本与多模态消息。
        ...(images && images.length > 0 ? { images } : {}),
      });
      this.sessions.appendMessage(sessionId, userMessage);
      const session = this.sessions.getWithMessages(sessionId);
      // 404 而不是普通 Error：会话可能在预检之后、这一行之前被另一个请求删掉
      // （`api/server.ts` 的 `sessions.has` 与这里之间必然有窗口），那不是「客户端请求写错了」
      // 400，也不是服务端故障 500，而是一个说得出名的 404。
      if (!session) throw new ApiError("会话不存在", 404);
      this.events.emit({ type: "message", message: userMessage });

      const reply = await this.#runLoop({
        session,
        // 请求没带 model 时用**这一档**的默认，而不是直接交给注册表：注册表现在是
        // 全局一份，它的 `default` 是部署级的默认，替不了「这一档默认用另一个模型」。
        model: model ?? this.defaultProviderId ?? undefined,
        onDelta,
        onMessage,
        signal,
      });
      return reply;
    } finally {
      // 写在 finally 是这条锁的全部要点：上游报错、工具抛错、客户端断开、撞步数上限
      // 都在这条链上，任何一处漏了释放，那个会话就**永久**发不出消息了。
      this.lock.release(sessionId);
    }
  }

  /**
   * 指令匹配与执行。命中返回落库后的助手消息；没命中返回 `null`（走正常 LLM 路径）。
   *
   * 用户消息**照常落库**：历史要看得见「敲过什么」，控制台才有回显；指令的回复也以
   * 助手消息落库，与普通回复同一条展示路径。它们会进入后续轮次的上下文窗口 ——
   * `/help` 的输出对模型无害，而「上一轮用过 /remind 约了什么」这类事实反而是有用的上下文。
   *
   * 前缀取自 `wakePrefix`（空串换缺省 `/`，见 `HandleMessageOptions.wakePrefix`）；
   * `commandText` 是去掉群聊发送人前缀的原始输入。cron 来源与没注入注册表的引擎
   * 都不做匹配：定时提示词是写给模型的，不该被「碰巧以 / 开头」劫走。
   */
  async #tryCommand({
    sessionId,
    content,
    commandText,
    sender,
    source,
  }: Pick<
    HandleMessageOptions,
    "sessionId" | "content" | "commandText" | "sender" | "source"
  >): Promise<Message | null> {
    if (this.commands === undefined || source === "cron") return null;
    const prefix = this.wakePrefix.trim() === "" ? DEFAULT_COMMAND_PREFIX : this.wakePrefix;
    const parsed = parseCommand(commandText ?? content, prefix);
    if (parsed === null) return null;
    const entry = this.commands.find(parsed.name);
    if (entry === null) return null;

    // 先落用户消息再执行：指令跑多久，用户敲的那条都已经在了。
    // 会话不存在的 404 由 `appendMessage` 抛出，与正常路径同一句话。
    const userMessage = this.#newMessage(sessionId, { role: "user", content });
    this.sessions.appendMessage(sessionId, userMessage);
    this.events.emit({ type: "message", message: userMessage });

    // console 来源经过登录鉴权，本身就是管理员；平台来源按档的管理员名单现读。
    const access = this.resolveAccess?.();
    const isAdmin =
      source !== "platform" ||
      (sender !== undefined && access?.adminIds.includes(sender.id) === true);
    const ctx: CommandContext = {
      profileId: this.profileId,
      sessionId,
      prefix,
      source: source === "console" ? "console" : "platform",
      senderId: sender?.id ?? null,
      senderName: sender?.name ?? null,
      isAdmin,
    };

    let text: string;
    if (entry.def.permission === "admin" && !isAdmin) {
      text = `指令「${prefix}${entry.def.name}」仅管理员可用。`;
    } else {
      try {
        text = await entry.def.run({ raw: parsed.raw, args: splitCommandArgs(parsed.raw) }, ctx);
      } catch (err) {
        // 指令抛错的原文只进日志：它可能带着插件自己的堆栈与路径，
        // 回给聊天窗口的就是一句固定话（与适配器的错误兜底同一条纪律）。
        this.logger.error(
          `指令「${entry.def.name}」（来源 ${entry.source}）执行失败: ${errorStack(err)}`,
        );
        text = "指令执行失败，详情见服务端日志。";
      }
    }

    const reply = this.#newMessage(sessionId, { role: "assistant", content: text });
    this.sessions.appendMessage(sessionId, reply);
    this.events.emit({ type: "message", message: reply });
    return reply;
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
    // `session` 是 `handleMessage` 里**追加用户消息之后**读到的快照，且这一轮之内不再回读存储：
    // 之后每一步都往上面这份 `history` 本地追加。换成持久化存储后这条顺序是正确性的一部分
    //（先读后写会让这轮的上游请求看不见用户刚说的那句），详见 `session/manager.ts` 的
    // `getWithMessages`。
    const cap = this.toolConfig.maxSteps();

    for (let step = 0; ; step++) {
      if (signal?.aborted) throw new Error("请求已取消");
      if (step >= cap) {
        throw new Error(
          `已达单轮工具调用步数上限（${cap}），已停止。` +
            `确认过工具确实是需要的，可以调高配置里的 maxToolSteps。`,
        );
      }

      // 人格只属于这一轮请求的报头，不写历史：它没有「什么时候说过」的语义，
      // 存进 sqlite 既会让历史详情多出一条假消息，也会在人格修改后留下旧版本。
      // 每一步都要重新拼一次：工具结果是在循环里追加到 history 的，提前拼好的
      // 数组不会跟着长，第二轮请求就会看不到工具结果。
      const prompt = this.systemPrompt.trim();
      const requestMessages: ChatMessage[] =
        prompt === "" ? history : [{ role: "system", content: prompt }, ...history];

      const result = onDelta
        ? await this.providers.chatStream({
            model,
            messages: requestMessages,
            tools: declared,
            onDelta,
            signal,
          })
        : await this.providers.chat({
            model,
            messages: requestMessages,
            tools: declared,
            signal,
          });

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
              await this.tools.run(call, { signal })
            : { toolCallId: call.id, name: call.name, content: refusal, isError: true };
        // 工具可能在取消之后才返回（工具实现不遵守 signal，注册表只能放弃等待）。
        // 这里停掉整轮，避免拿着已经断开的客户端继续执行后面的工具。
        if (signal?.aborted) throw new Error("请求已取消");
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
    // 帧里**不带配置档**，这不是漏了字段：对话历史是全局一份 sqlite（第一期决定），
    // 所以「哪个会话多了这条消息」已经说全了客户端要知道的事。真加上 profileId，
    // 反而会让人以为两份配置档的历史是隔开的。
    this.events.emit({ type: "message", message });
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
    const enabled = new Set(this.toolConfig.enabledIds());
    const known = this.tools.list();
    // 内部工具不进用户的开关配置，但始终交给模型：系统内省是程序自己的基础设施，
    // 不是「用户可以选择关闭」的能力授予。
    for (const tool of known) {
      if (tool.internal === true) enabled.add(tool.id);
    }
    const knownIds = new Set(known.map((tool) => tool.id));
    for (const id of enabled) {
      if (!knownIds.has(id)) this.logger.warn(`配置里启用了未注册的工具「${id}」，本轮已忽略`);
    }
    return this.tools.pick([...enabled]).map(toChatTool);
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
    // 先截窗口、再按预算分配图片；两步都只动副本。
    const window = capHistoryImages(contextWindow(session.messages));
    // 用 flatMap 而不是 `filter(...).map(m => m.toolCallId as string)`：filter 不窄化类型，
    // 那个 `as` 就落在**真边界之外**（AGENTS.md 的 `as` 白名单里没有它这一类）。
    const answered = new Set(
      window.flatMap((m) => (m.role === "tool" && m.toolCallId ? [m.toolCallId] : [])),
    );

    return window.map((m) => {
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
    message: Pick<Message, "role" | "content" | "images" | "toolCallId">,
    toolCalls: Message["toolCalls"],
  ): ChatMessage {
    return {
      role: message.role,
      content: message.content,
      ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

function toChatTool(tool: ToolDefinition): ChatTool {
  return { name: tool.id, description: tool.description, parameters: tool.parameters };
}
