import type { AdapterAccessControl, HumanizerConfig, MessageImage } from "@atri/shared";
import { ApiError, errorMessage, errorStack } from "#core/errors.ts";
import { DEFAULT_COMMAND_PREFIX } from "#core/command/types.ts";
import { smartChunk, stripMarkdown } from "#core/companion/chunk.ts";
import type { Logger } from "#core/logger.ts";
import type { AdapterTarget } from "./manager.ts";

/**
 * 平台无关的入站消息形状。
 *
 * 适配器只负责「把平台私有事件翻译成这一份」与「把文本发回平台」；剩下的事情
 * —— 按会话排队、找/建内部会话、给群消息加发送人前缀、切分长回复、错误兜底 ——
 * 都由 `MessageAdapter` 统一处理。这样第二个平台落地时只写传输，不重复这些策略。
 */
export type ConversationKind = "private" | "group";

export interface InboundSender {
  /** 平台侧的用户 id（QQ 号等），只用于识别与日志，不直接交给模型。 */
  id: string;
  /** 显示名。群聊优先群名片，私聊优先昵称。 */
  name: string;
}

export interface InboundConversation {
  kind: ConversationKind;
  /** 私聊是用户 id，群聊是群 id。 */
  id: string;
  /** 给人看的名字，没有时省略。 */
  label?: string;
}

export interface InboundMessage {
  sender: InboundSender;
  conversation: InboundConversation;
  /** 已经过消息段归一化的纯文本；纯图片消息为空串。 */
  text: string;
  /** 已经从平台下载并校验过的图片（base64 + MIME）。 */
  images?: MessageImage[];
  /** 平台消息 id，只用于日志/排查，可空。 */
  messageId?: string;
  /** 这个会话第一次建内部会话时用的标题。 */
  sessionTitle: string;
}

/**
 * 外部会话 → 内部会话 id 的映射。
 *
 * 抽成接口而不是直接收 `SessionManager`：基类的单测不需要真 sqlite，
 * 生产实现（`JsonConversationSessions`）负责把映射落盘并校验会话是否还在。
 */
export interface ConversationSessions {
  getOrCreate(key: string, title: string): string;
}

export interface MessageAdapterDeps {
  id: string;
  /** 这个适配器绑定的配置档 id。每个适配器只服务一份跑法。 */
  profileId: string;
  logger: Logger;
  /** 由组合根注入；配置档被删/加载失败时返回 null。 */
  resolveTarget: (profileId: string) => AdapterTarget | null;
  conversations: ConversationSessions;
  /**
   * 准入控制**属于绑定的配置档**，所以每收到一条消息现读一次；缺省为全部放行
   * （测试与嵌入式使用）。不缓存：保存档里的名单后，下一条消息就该用新规则。
   */
  resolveAccess?: () => AdapterAccessControl;
  /**
   * 唤醒前缀现读，**属于绑定的配置档**（与 `resolveAccess` 同一条理由：保存后
   * 下一条消息生效，不必重启长连接）。缺省为 `/`。只对群聊生效；空串关闭门槛。
   */
  resolveWakePrefix?: () => string;
  /**
   * 拟人化设置现读（防抖窗口 / 智能分段 / 去机器味），**属于绑定的配置档**。
   * 缺省为全默认值（防抖关闭、智能分段开）。
   */
  resolveHumanizer?: () => HumanizerConfig;
  /** 单条平台消息的最大长度，默认 1500。 */
  maxMessageLength?: number;
}

export const DEFAULT_MAX_MESSAGE_LENGTH = 1500;

/** 拟人化设置的缺省值：与 `config/profiles.ts` 的 `DEFAULT_HUMANIZER_CONFIG` 同值。 */
const DEFAULT_HUMANIZER: HumanizerConfig = {
  debounceSeconds: 0,
  smartChunk: true,
  stripMarkdown: false,
  timeAwareness: true,
  schedule: { sleepStart: "23:30", sleepEnd: "07:30", napMinutes: 0 },
  proactive: {
    enabled: false,
    idleMinutes: 180,
    maxPerDay: 3,
    quietStart: "23:30",
    quietEnd: "08:00",
  },
};

/** 日志里的一行字段：换行收成空格，避免平台侧的昵称伪造出新的日志行。 */
function oneLine(value: string, max = 120): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** 统一的适配器事件标签：`[napcat:privateMessage:123456]`。 */
function eventLabel(adapterId: string, conversation: InboundConversation): string {
  const type = conversation.kind === "group" ? "groupMessage" : "privateMessage";
  return `[${adapterId}:${type}:${oneLine(conversation.id, 80)}]`;
}

/**
 * 群聊把发送人写进模型看得到的内容里。
 *
 * 群是一个共享会话：不写发送人，模型会看到几条没有主语的发言，也无法回答
 * 「刚才谁说的」；而私聊只有两个人，加前缀只会占 token。
 *
 * 名字里的换行收成空格：它是平台侧用户可改的字段，带换行可以伪造出一行
 * 「[系统] …」的假上下文。
 */
export function formatInbound(message: InboundMessage): string {
  const text = message.text.trim();
  if (message.conversation.kind !== "group") return text;
  const name = message.sender.name.replace(/\s+/g, " ").trim() || message.sender.id;
  // 纯图片消息的正文为空，但群里的「谁发的」仍然必须留给模型。
  return text === "" ? `[${name}]` : `[${name}] ${text}`;
}

/**
 * 日志里的一行事件内容。图片是结构化附件，正文里不再有 `[图片]` 占位，
 * 所以日志单独补一个标记 —— 否则收到一张图在日志里会显示成一个冒号后面什么都没有。
 */
export function describeInbound(message: InboundMessage): string {
  const text = formatInbound(message);
  const count = message.images?.length ?? 0;
  const marker = count === 0 ? "" : count === 1 ? "[图片]" : `[图片×${count}]`;
  if (text === "") return marker;
  return marker === "" ? text : `${text} ${marker}`;
}

/**
 * 按平台长度上限切分长回复。
 *
 * 优先在换行处断，其次空格，最后硬切；切完两端去空白，但不做二次改写。
 * `max < 1` 或非整数时退回默认值 —— 这是内部常量，不是网络输入，没必要抛。
 */
export function chunkText(text: string, max: number = DEFAULT_MAX_MESSAGE_LENGTH): string[] {
  const limit = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_MESSAGE_LENGTH;
  if (text.length <= limit) return text === "" ? [] : [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 至少保留 60% 的容量再考虑断点，否则会出现很多极短的块。
    const floor = Math.floor(limit * 0.6);
    let cut = rest.lastIndexOf("\n", limit - 1);
    if (cut < floor) cut = rest.lastIndexOf(" ", limit - 1);
    if (cut < floor) cut = limit;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece !== "") chunks.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

/**
 * 消息适配器的公共骨架。
 *
 * 生命周期仍由 `AdapterManager` 管（`start`/`stop` 与绑定规则），这里只补齐
 * 「一条消息进来之后」的固定流程：
 *
 * 1. 同一个外部会话内**串行**处理。引擎本身有会话锁，但两个平台用户同时发言时，
 *    第二个会直接拿到 409、什么回复都没有；排队比把错误丢给用户更合理。
 * 2. 找到外部会话对应的内部会话（第一次出现时创建）。
 * 3. 调引擎跑一轮，把最终助手文本切块发回平台。工具中间消息不发：QQ/群里的用户
 *    只该看到最终答复。
 * 4. 引擎或发送失败只写服务端日志；给用户一句固定的中文错误，不把内部堆栈、
 *    文件路径带出去。
 *
 * 子类只实现 `start` / `stop` / `sendText`；接收事件的解析与动作调用是平台自己的事。
 */
export abstract class MessageAdapter {
  readonly id: string;
  readonly profileId: string;
  protected readonly logger: Logger;
  #resolveTarget: (profileId: string) => AdapterTarget | null;
  #conversations: ConversationSessions;
  #resolveAccess: () => AdapterAccessControl;
  #resolveWakePrefix: () => string;
  #resolveHumanizer: () => HumanizerConfig;
  #maxMessageLength: number;
  #queues = new Map<string, Promise<void>>();
  /**
   * 防抖缓冲：`会话键 -> { timer, messages, done }`。窗口内同会话的消息攒起来，
   * 沉默到点合并成一轮再进队列。`done` 让后到的消息 await 与首条相同的 Promise
   *（receive 的调用方约定是「处理完成后 resolve」）。
   */
  #debouncing = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      messages: InboundMessage[];
      resolveDone: () => void;
      done: Promise<void>;
    }
  >();

  constructor({
    id,
    profileId,
    logger,
    resolveTarget,
    conversations,
    resolveAccess = () => ({ whitelistEnabled: false, allowedIds: [], adminIds: [] }),
    resolveWakePrefix = () => DEFAULT_COMMAND_PREFIX,
    resolveHumanizer,
    maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH,
  }: MessageAdapterDeps) {
    this.id = id;
    this.profileId = profileId;
    this.logger = logger;
    this.#resolveTarget = resolveTarget;
    this.#conversations = conversations;
    this.#resolveAccess = resolveAccess;
    this.#resolveWakePrefix = resolveWakePrefix;
    this.#resolveHumanizer = resolveHumanizer ?? (() => DEFAULT_HUMANIZER);
    this.#maxMessageLength = maxMessageLength;
  }

  abstract start(): Promise<void> | void;
  abstract stop(): Promise<void> | void;

  /** 把一段文本发到对应会话。平台实现负责寻址与消息段编码。 */
  protected abstract sendText(conversation: InboundConversation, text: string): Promise<void>;

  /**
   * 平台适配器解析出一条消息后调用这里。返回的 Promise 在这一次处理（含回复发送）
   * 结束后 resolve；适配器通常 `void this.receive(...)`，不阻塞事件循环。
   */
  receive(message: InboundMessage): Promise<void> {
    const hasImages = (message.images?.length ?? 0) > 0;
    if (message.text.trim() === "" && !hasImages) return Promise.resolve();

    const label = eventLabel(this.id, message.conversation);
    if (!this.#allowed(message)) {
      // 被挡下的消息只记事件键与发送人，不记正文：它可能来自无关的群成员。
      this.logger.info(`${label} 已丢弃：发送人 ${oneLine(message.sender.id, 64)} 不在白名单`);
      return Promise.resolve();
    }
    // 群聊唤醒门槛属于**配置档**，排在白名单之后：没被准入的群谈唤醒没有意义。
    // 判据针对 `message.text`（原始输入）—— 下面 `formatInbound` 加的发送人前缀
    // 会破坏前缀匹配。私聊不设门槛（两个人对话，每条都值得回应）。
    if (message.conversation.kind === "group") {
      const prefix = this.#resolveWakePrefix().trim();
      if (prefix !== "" && !message.text.startsWith(prefix)) {
        this.logger.debug(`${label} 未唤醒（缺少前缀「${prefix}」），已忽略`);
        return Promise.resolve();
      }
    }
    // 连续输入防抖（拟人化）：沉默窗口内同会话的多条消息攒起来，到点合并成一轮。
    // 「对方还在打字」时逐条回复既吵又不合常理 —— companion 的同一条观察。
    // 窗口为 0 走原有直通路径，行为不变。防抖在日志之后：被挡下的消息不占窗口。
    const debounceSeconds = this.#resolveHumanizer().debounceSeconds;
    if (debounceSeconds > 0 && Number.isFinite(debounceSeconds)) {
      return this.#debounce(message, debounceSeconds * 1000);
    }

    const sender = oneLine(message.sender.name, 60) || message.sender.id;
    const messageId =
      message.messageId === undefined ? "" : ` message_id=${oneLine(message.messageId, 40)}`;
    this.logger.info(`${label}: ${oneLine(describeInbound(message), 1000)}`);
    this.logger.debug(
      `${label} sender=${message.sender.id}(${sender})${messageId}` +
        `${hasImages ? ` images=${message.images?.length ?? 0}` : ""}`,
    );
    return this.#enqueue(message);
  }

  /** 按会话排队、逐条处理。队列键不含 profile：一个适配器实例固定绑定一份配置档。 */
  #enqueue(message: InboundMessage): Promise<void> {
    const key = `${message.conversation.kind}:${message.conversation.id}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const task = previous.then(() => this.#process(message));
    // 队列链不能因为一条消息失败而断掉；错误在这里收口，下一次消息仍能接上。
    const settled = task.catch((err) => {
      this.logger.error(`适配器 ${this.id} 处理消息失败: ${errorStack(err)}`);
    });
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return settled;
  }

  /**
   * 防抖缓冲。同一会话的第一条消息起一个定时器并返回它的 Promise；窗口内的
   * 后续消息只追加、共享同一个 Promise（调用方「处理完才 resolve」的约定不变）。
   * 到点把攒下的消息**合并成一轮**走队列。合并时窗口内的重复日志不再逐条打：
   * 第一条已经打过，合并只会说「攒了几条」。
   */
  #debounce(message: InboundMessage, windowMs: number): Promise<void> {
    const key = `${message.conversation.kind}:${message.conversation.id}`;
    const pending = this.#debouncing.get(key);
    if (pending) {
      pending.messages.push(message);
      return pending.done;
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: {
      timer: NodeJS.Timeout;
      messages: InboundMessage[];
      resolveDone: () => void;
      done: Promise<void>;
    } = {
      timer: setTimeout(() => {
        this.#debouncing.delete(key);
        entry.resolveDone();
        const batch = entry.messages;
        const label = eventLabel(this.id, batch[0]!.conversation);
        if (batch.length > 1) {
          this.logger.debug(`${label} 防抖窗口攒了 ${batch.length} 条，合并处理`);
        }
        const merged = batch.length === 1 ? batch[0]! : this.#mergeBatch(batch);
        void this.#enqueue(merged);
      }, windowMs),
      messages: [message],
      resolveDone,
      done,
    };
    this.#debouncing.set(key, entry);
    return done;
  }

  /** 把窗口内攒下的多条消息并成一条：正文按到达顺序换行拼接，图片合并（上限 4 张）。 */
  #mergeBatch(batch: InboundMessage[]): InboundMessage {
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    const text = batch
      .map((m) => m.text.trim())
      .filter((t) => t !== "")
      .join("\n");
    const images = batch.flatMap((m) => m.images ?? []).slice(0, 4);
    return {
      sender: last.sender,
      conversation: first.conversation,
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(last.messageId === undefined ? {} : { messageId: last.messageId }),
      sessionTitle: first.sessionTitle,
    };
  }

  /**
   * 停止前把防抖窗口里还攒着的消息**立刻**发出。具体适配器的 `stop()` 应在关
   * 连接之前调用它 —— 否则用户最后几句话会静默消失，比处理失败更糟。
   * 每一批的等待者在这里放行（到点回调不会再跑，timer 已清）。
   */
  protected async flushIntake(): Promise<void> {
    const pending = [...this.#debouncing.values()];
    this.#debouncing.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      const batch = entry.messages;
      const merged = batch.length === 1 ? batch[0]! : this.#mergeBatch(batch);
      const settle = this.#enqueue(merged).then(
        () => undefined,
        () => undefined,
      );
      entry.resolveDone();
      await settle;
    }
  }

  /**
   * 管理员始终放行：这是「白名单把自己关在门外」的逃生口。
   * 群聊按**群 id** 判白名单，私聊按发送人 id；管理员名单只认发送人。
   */
  #allowed(message: InboundMessage): boolean {
    const access = this.#resolveAccess();
    if (!access.whitelistEnabled) return true;
    if (access.adminIds.includes(message.sender.id)) return true;
    const scope =
      message.conversation.kind === "group" ? message.conversation.id : message.sender.id;
    return access.allowedIds.includes(scope);
  }

  async #process(message: InboundMessage): Promise<void> {
    const label = eventLabel(this.id, message.conversation);
    const target = this.#resolveTarget(this.profileId);
    if (target === null) {
      this.logger.warn(`${label} 已丢弃：配置档「${this.profileId}」当前不可用`);
      return;
    }

    const sessionId = this.#conversations.getOrCreate(
      `${this.profileId}:${message.conversation.kind}:${message.conversation.id}`,
      message.sessionTitle,
    );

    try {
      const reply = await target.engine.handleMessage({
        sessionId,
        content: formatInbound(message),
        // 指令匹配针对原始输入：群聊正文会加发送人前缀，那会让 `/help` 变成
        // 「[张三] /help」。发送人身份随消息带给引擎，指令的 admin 权限要用。
        commandText: message.text,
        sender: message.sender,
        source: "platform",
        ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
      });
      const replyText = reply.content.trim();
      if (replyText === "") return;
      // 发送侧拟人化（只影响平台，控制台不受影响）：先剥标记、再智能分段。
      const humanizer = this.#resolveHumanizer();
      const text = humanizer.stripMarkdown ? stripMarkdown(replyText) : replyText;
      const chunks = humanizer.smartChunk
        ? smartChunk(text, this.#maxMessageLength)
        : chunkText(text, this.#maxMessageLength);
      for (const chunk of chunks) {
        await this.sendText(message.conversation, chunk);
        this.logger.info(`发送${label}:${oneLine(chunk, 1000)}`);
      }
      this.logger.debug(`${label} 已回复 ${chunks.length} 条（${text.length} 字）`);
    } catch (err) {
      // 409 表示这个内部会话正被别的入口占用；适配器已经按会话排队，这一般不是
      // 用户能解决的问题，再回一句「稍后再试」只会制造更多噪音。
      if (err instanceof ApiError && err.status === 409) {
        this.logger.warn(`${label} 会话正忙，已丢弃这一条`);
        return;
      }
      this.logger.error(`${label} 处理失败: ${errorStack(err)}`);
      await this.#replySafely(message.conversation, "处理消息时出错了，请稍后再试。");
    }
  }

  async #replySafely(conversation: InboundConversation, text: string): Promise<void> {
    try {
      await this.sendText(conversation, text);
    } catch (err) {
      this.logger.warn(`适配器 ${this.id} 发送错误提示失败: ${errorMessage(err)}`);
    }
  }
}
