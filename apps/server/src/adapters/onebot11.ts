import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import type { RawData } from "ws";
import type { MessageImage } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import { MessageAdapter, type InboundConversation, type MessageAdapterDeps } from "./message.ts";

/**
 * OneBot 11 的协议公共层。
 *
 * NapCat 与 SnowLuma 都讲 OneBot 11，差别只在**怎么连**：
 * - NapCat：atri-bot 监听反向 WebSocket，NapCat 连入；
 * - SnowLuma：atri-bot 作为客户端连到 SnowLuma 暴露的 WebSocket。
 *
 * 消息段解析、图片下载、action 请求/响应、登录信息与自问自答过滤都在这里；
 * 传输子类只实现 `canSend` / `sendRaw` / `unavailableMessage` 与连接生命周期。
 * 这样新增第三个 OneBot 11 实现时不需要复制协议代码。
 */

export const ONEBOT_ACTIONS = {
  getLoginInfo: "get_login_info",
  getImage: "get_image",
  sendPrivateMsg: "send_private_msg",
  sendGroupMsg: "send_group_msg",
} as const;

export const ONEBOT_SEGMENTS = {
  text: "text",
  at: "at",
  image: "image",
  face: "face",
  record: "record",
  video: "video",
  file: "file",
  json: "json",
  xml: "xml",
  markdown: "markdown",
  forward: "forward",
  reply: "reply",
} as const;

export const ONEBOT_MESSAGE_TYPES = {
  private: "private",
  group: "group",
} as const;

export const ONEBOT_POST_TYPES = {
  message: "message",
  metaEvent: "meta_event",
} as const;

export const ONEBOT_DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/**
 * 图片的工作量上限：单张 4 MiB、单条最多 4 张。
 *
 * 消息会原样落进 sqlite 并随历史回喂给模型，不能无上限地收。超过的照片仍然保留
 * `[图片]` 占位，不静默消失。两条都是本仓自选的保护值，不是 OneBot 的协议限制。
 */
export const ONEBOT_MAX_IMAGES_PER_MESSAGE = 4;
export const ONEBOT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_MAX_REDIRECTS = 3;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OneBotImageRef {
  /** 平台给出的直接下载地址，可能为空或已过期。 */
  url: string;
  /** 图片文件标识，用于 `get_image` 刷新出新的 URL。 */
  file: string;
}

export interface ParsedOneBotMessage {
  /** 去掉图片段之后的正文；纯图片消息为空串。 */
  text: string;
  images: OneBotImageRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function textOfSegment(segment: unknown): string {
  if (typeof segment === "string") return segment;
  if (!isRecord(segment)) return "";
  const type = typeof segment.type === "string" ? segment.type : "";
  const data = isRecord(segment.data) ? segment.data : {};
  switch (type) {
    case ONEBOT_SEGMENTS.text:
      return typeof data.text === "string" ? data.text : "";
    case ONEBOT_SEGMENTS.at: {
      const qq = asString(data.qq);
      return qq === null ? "@某人" : qq === "all" ? "@全体成员" : `@${qq}`;
    }
    case ONEBOT_SEGMENTS.image:
      // 真正有 url/file 的图片段在 `parseOneBotMessage` 里已被抽走；走到这里说明
      // 图片段没有任何可取来源，只能保留占位。
      return "[图片]";
    case ONEBOT_SEGMENTS.face:
      return "[表情]";
    case ONEBOT_SEGMENTS.record:
      return "[语音]";
    case ONEBOT_SEGMENTS.video:
      return "[视频]";
    case ONEBOT_SEGMENTS.file:
      return "[文件]";
    case ONEBOT_SEGMENTS.json:
    case ONEBOT_SEGMENTS.xml:
      return "[卡片]";
    case ONEBOT_SEGMENTS.markdown:
      return "[Markdown]";
    case ONEBOT_SEGMENTS.forward:
      return "[转发消息]";
    case ONEBOT_SEGMENTS.reply:
      // 被回复的那条消息本身不在这里，塞一个空占位只会污染上下文。
      return "";
    default:
      return type === "" ? "" : `[${type}]`;
  }
}

function imageRefOfSegment(segment: unknown): OneBotImageRef | null {
  if (!isRecord(segment) || segment.type !== ONEBOT_SEGMENTS.image) return null;
  const data = isRecord(segment.data) ? segment.data : {};
  const url = asString(data.url)?.trim() ?? "";
  // `path` 在部分实现里是本地绝对路径。我们只把它当文件标识交给 get_image，
  // 绝不直接读宿主机的任意路径。
  const file = asString(data.file)?.trim() || asString(data.path)?.trim() || "";
  if (url === "" && file === "") return null;
  return { url, file };
}

/**
 * 把 OneBot 11 的消息段拆成正文与图片引用。
 *
 * `message` 的数组写法是 OneBot 11 的默认输出；字符串写法（CQ 码）只在旧实现里出现，
 * 原样保留而不是尝试解析 —— 本仓没有第二个需要 CQ 码的入口，写一个半吊子解析器
 * 只会让真正的文本被误伤。
 */
export function parseOneBotMessage(message: unknown, rawMessage?: unknown): ParsedOneBotMessage {
  let text = "";
  const images: OneBotImageRef[] = [];
  if (Array.isArray(message)) {
    for (const segment of message) {
      const image = imageRefOfSegment(segment);
      if (image !== null) {
        images.push(image);
        continue;
      }
      text += textOfSegment(segment);
    }
    // 只有**空数组**才回退到 raw_message；非空但全是 reply 之类的段应该视为
    // 没有可读内容，而不是把一串 CQ 码喂给模型。
    if (message.length === 0 && typeof rawMessage === "string") text = rawMessage;
  } else if (typeof message === "string") {
    text = message;
  } else if (typeof rawMessage === "string") {
    text = rawMessage;
  }
  return { text: text.trim(), images };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 按文件头判断格式，不信任服务端给的 content-type。 */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const head = bytes.subarray(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") {
    if (bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  }
  return null;
}

function imageMediaType(bytes: Buffer, contentType: string | null): string | null {
  const sniffed = sniffImageType(bytes);
  if (sniffed !== null) return sniffed;
  const declared = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared === "image/jpg") return "image/jpeg";
  return SUPPORTED_IMAGE_TYPES.has(declared) ? declared : null;
}

function decodeInlineImage(value: string): MessageImage | null {
  let payload: string | null = null;
  let declared = "";
  if (value.startsWith("base64://")) {
    payload = value.slice("base64://".length);
  } else if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma > 0 && value.slice(0, comma).endsWith(";base64")) {
      declared = value.slice("data:".length, comma - ";base64".length);
      payload = value.slice(comma + 1);
    }
  }
  if (payload === null || payload === "") return null;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0 || bytes.length > ONEBOT_MAX_IMAGE_BYTES) return null;
  const mediaType = imageMediaType(bytes, declared);
  return mediaType === null ? null : { data: bytes.toString("base64"), mediaType };
}

/**
 * 平台图片地址的黑名单。
 *
 * 备注：**不拦回环/私网**是刻意的取舍 —— NapCat/SnowLuma 常与本服务在同一台机器
 * 或同一 Docker 网络里，图片 URL 可能就是 `127.0.0.1`/`10.x`。这里挡住的是
 * 云元数据与链路本地地址（169.254/16、100.64/10、fe80::/10）这类**几乎只有 SSRF
 * 会用到**的目标；完整的私网隔离要靠部署网络，而不是这段代码。
 */
function isBlockedImageAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "0.0.0.0" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return true;

  const [first, second] = lower.split(".").map((part) => Number(part));
  if (first === 169 && second === 254) return true;
  if (first === 100 && second !== undefined && second >= 64 && second <= 127) return true;

  if (lower.includes(":")) {
    const head = Number.parseInt(lower.split(":")[0] ?? "", 16);
    if (Number.isFinite(head) && head >= 0xfe80 && head <= 0xfebf) return true;
  }
  return false;
}

/** 校验目标不是明显的元数据/链路本地地址。每次重定向都要重新校验。 */
async function assertImageUrlAllowed(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("图片地址只允许 http 或 https");
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("图片地址无法解析");
  }
  if (addresses.some((item) => isBlockedImageAddress(item.address))) {
    throw new Error("图片地址指向受限网络");
  }
}

/** 手动跟随重定向：`redirect: "follow"` 会在不经过地址校验的情况下跳到内网。 */
async function fetchImage(url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= IMAGE_MAX_REDIRECTS; hop += 1) {
    await assertImageUrlAllowed(current);
    const response = await fetch(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`图片地址返回了 ${response.status} 但没有 Location`);
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("图片地址重定向次数过多");
}

/** 按块读取并在超过上限时立刻中断；不能等 `arrayBuffer()` 把整段内容收进内存。 */
async function readCappedImage(response: Response, limit: number): Promise<Buffer> {
  const body = response.body;
  if (!body) throw new Error("图片响应没有响应体");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error("图片超过 4 MiB 上限");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

/** 下载并校验一张图片；不可用或超限时抛错，由调用方决定是否保留占位。 */
export async function downloadOneBotImage(value: string): Promise<MessageImage> {
  const inline = decodeInlineImage(value);
  if (inline !== null) return inline;
  if (!isHttpUrl(value)) throw new Error("图片段没有可下载的地址");

  const signal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
  const response = await fetchImage(new URL(value), signal);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > ONEBOT_MAX_IMAGE_BYTES) {
    throw new Error("图片超过 4 MiB 上限");
  }
  const bytes = await readCappedImage(response, ONEBOT_MAX_IMAGE_BYTES);
  const mediaType = imageMediaType(bytes, response.headers.get("content-type"));
  if (mediaType === null) throw new Error("不支持的图片格式");
  return { data: bytes.toString("base64"), mediaType };
}

function appendImagePlaceholders(text: string, count: number): string {
  if (count <= 0) return text;
  const marker = count === 1 ? "[图片]" : `[图片×${count}]`;
  return text === "" ? marker : `${text} ${marker}`;
}

function senderName(sender: Record<string, unknown>, fallback: string): string {
  const card = typeof sender.card === "string" ? sender.card.trim() : "";
  const nickname = typeof sender.nickname === "string" ? sender.nickname.trim() : "";
  return card || nickname || fallback;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export interface OneBot11AdapterOptions extends MessageAdapterDeps {
  /** 日志与错误文案里的平台名，例如 NapCat / SnowLuma。 */
  platformName: string;
  actionTimeoutMs?: number;
}

/**
 * OneBot 11 消息适配器基类。
 *
 * 传输层子类只需要实现三件事：
 * - `canSend()`：当前是否可以把帧写出去；
 * - `sendRaw()`：把已经序列化好的 JSON 帧写出去；
 * - `unavailableMessage()`：未连接时给用户/日志看的那句话。
 * 连接建立后调用 `onTransportConnected()`，收到帧时调用 `handleFrame()`，
 * 连接断开时调用 `onTransportClosed()`。
 */
export abstract class OneBot11Adapter extends MessageAdapter {
  readonly name: string;

  #actionTimeoutMs: number;
  #pending = new Map<string, PendingCall>();
  #echoSeq = 0;
  #selfId = "";
  /**
   * 图片下载是异步的，而消息顺序是同步到达的。没有这条按会话的队列时，
   * 「先发图、再发一句话」可能因为图片慢而让后一句先进入引擎。
   */
  #incoming = new Map<string, Promise<void>>();

  constructor(options: OneBot11AdapterOptions) {
    super(options);
    this.name = options.platformName;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? ONEBOT_DEFAULT_ACTION_TIMEOUT_MS;
  }

  protected abstract canSend(): boolean;
  protected abstract sendRaw(text: string): void;
  protected abstract unavailableMessage(): string;

  /** 传输层收到一帧时调用。 */
  protected handleFrame(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText(data));
    } catch {
      this.logger.debug(`${this.name} 发来非 JSON 帧，已忽略`);
      return;
    }
    if (!isRecord(parsed)) return;

    // 动作响应带 echo、不带 post_type；事件则相反。
    if (parsed.echo !== undefined && parsed.post_type === undefined) {
      this.#settleAction(parsed);
      return;
    }
    if (parsed.post_type === ONEBOT_POST_TYPES.message) {
      this.#onMessageEvent(parsed);
      return;
    }
    if (parsed.post_type === ONEBOT_POST_TYPES.metaEvent) {
      const id = asString(parsed.self_id);
      if (id !== null && this.#selfId === "") this.#selfId = id;
    }
  }

  /** 传输层连接建立后调用：拉一次登录信息，供自问自答过滤使用。 */
  protected onTransportConnected(): void {
    void this.#loadLoginInfo();
  }

  /** 传输层断开后调用：让所有在途 action 立刻失败，而不是等超时。 */
  protected onTransportClosed(reason: string): void {
    this.#rejectPending(reason);
  }

  /** 停止适配器时清空在途 action。 */
  protected resetPending(reason: string): void {
    this.#rejectPending(reason);
  }

  /**
   * 调用任意 OneBot 11 action。
   *
   * 这是 `call_action` 机制的核心：框架没有包装的功能（群列表、文件上传、拍一拍、
   * 撤回……）都从这一个入口走。是否支持由平台返回的 retcode 决定，不在核心层
   * 按平台名写分支。
   */
  callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.canSend()) return Promise.reject(new Error(this.unavailableMessage()));
    const echo = `${this.id}-${++this.#echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`${this.name} 调用 ${action} 超时`));
      }, this.#actionTimeoutMs);
      this.#pending.set(echo, { resolve, reject, timer });
      try {
        this.sendRaw(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #settleAction(response: Record<string, unknown>): void {
    const echo = asString(response.echo);
    if (echo === null) return;
    const pending = this.#pending.get(echo);
    if (pending === undefined) return;
    this.#pending.delete(echo);
    clearTimeout(pending.timer);

    const retcode = Number(response.retcode ?? -1);
    if (retcode === 0 && response.status !== "failed") {
      pending.resolve(response.data);
      return;
    }
    const detail =
      typeof response.message === "string"
        ? response.message
        : typeof response.wording === "string"
          ? response.wording
          : "未知错误";
    pending.reject(new Error(`${this.name} 调用失败（retcode ${retcode}）：${detail}`));
  }

  #rejectPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  async #loadLoginInfo(): Promise<void> {
    try {
      const data = await this.callAction(ONEBOT_ACTIONS.getLoginInfo, {});
      if (!isRecord(data)) return;
      const id = asString(data.user_id);
      if (id !== null) this.#selfId = id;
      const nickname = typeof data.nickname === "string" ? data.nickname : "未知";
      this.logger.info(`${this.name} 登录账号: ${nickname}（${this.#selfId || "?"}）`);
    } catch (err) {
      this.logger.warn(`${this.name} ${ONEBOT_ACTIONS.getLoginInfo} 失败: ${errorMessage(err)}`);
    }
  }

  #onMessageEvent(event: Record<string, unknown>): void {
    const messageType = event.message_type;
    if (
      messageType !== ONEBOT_MESSAGE_TYPES.private &&
      messageType !== ONEBOT_MESSAGE_TYPES.group
    ) {
      this.logger.debug(`${this.name} 忽略消息类型 ${String(messageType)}`);
      return;
    }

    const eventSelfId = asString(event.self_id);
    if (eventSelfId !== null && this.#selfId === "") this.#selfId = eventSelfId;

    const userId = asString(event.user_id);
    if (userId === null) return;
    // 自己的消息不能再喂给引擎，否则每句话都会触发一次自问自答。
    if (this.#selfId !== "" && userId === this.#selfId) return;

    const parsed = parseOneBotMessage(event.message, event.raw_message);
    if (parsed.text === "" && parsed.images.length === 0) return;

    const sender = isRecord(event.sender) ? event.sender : {};
    const name = senderName(sender, userId);
    const messageId = asString(event.message_id) ?? undefined;
    let conversation: InboundConversation;
    if (messageType === ONEBOT_MESSAGE_TYPES.group) {
      const groupId = asString(event.group_id);
      if (groupId === null) return;
      conversation = { kind: "group", id: groupId, label: groupId };
    } else {
      conversation = { kind: "private", id: userId, label: name };
    }

    const key = `${conversation.kind}:${conversation.id}`;
    const previous = this.#incoming.get(key) ?? Promise.resolve();
    const task = previous.then(() =>
      this.#deliverInbound({
        sender: { id: userId, name },
        conversation,
        parsed,
        messageId,
        sessionTitle:
          conversation.kind === "group" ? `QQ 群 ${conversation.id}` : `QQ 私聊 ${name}`,
      }),
    );
    const settled = task.catch((err) => {
      this.logger.error(`${this.name} 处理入站消息失败: ${errorMessage(err)}`);
    });
    this.#incoming.set(key, settled);
    void settled.finally(() => {
      if (this.#incoming.get(key) === settled) this.#incoming.delete(key);
    });
  }

  async #deliverInbound({
    sender,
    conversation,
    parsed,
    messageId,
    sessionTitle,
  }: {
    sender: { id: string; name: string };
    conversation: InboundConversation;
    parsed: ParsedOneBotMessage;
    messageId: string | undefined;
    sessionTitle: string;
  }): Promise<void> {
    const { images, failed } = await this.#loadImages(parsed.images);
    const text = appendImagePlaceholders(parsed.text, failed);
    // 图片全部失败且原文为空时，text 已经是 `[图片]`；两者都空只可能是图片引用
    // 在解析阶段就被丢弃（例如段里既没有 url 也没有 file），这时没什么可发的。
    if (text === "" && images.length === 0) return;

    await this.receive({
      sender,
      conversation,
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(messageId === undefined ? {} : { messageId }),
      sessionTitle,
    });
  }

  /**
   * 按顺序下载图片，并把「超过上限 / 下载失败」折算成占位数量。
   * 失败只写一条 warn：图片是增强信息，不能让整条消息消失。
   */
  async #loadImages(refs: OneBotImageRef[]): Promise<{ images: MessageImage[]; failed: number }> {
    const selected = refs.slice(0, ONEBOT_MAX_IMAGES_PER_MESSAGE);
    let failed = refs.length - selected.length;
    if (failed > 0) {
      this.logger.warn(
        `${this.name} 单条消息有 ${refs.length} 张图片，只处理前 ${ONEBOT_MAX_IMAGES_PER_MESSAGE} 张`,
      );
    }

    const images: MessageImage[] = [];
    for (const ref of selected) {
      try {
        images.push(await this.#loadImage(ref));
      } catch (err) {
        failed += 1;
        this.logger.warn(`${this.name} 图片获取失败: ${errorMessage(err)}`);
      }
    }
    return { images, failed };
  }

  async #loadImage(ref: OneBotImageRef): Promise<MessageImage> {
    // 先按顺序试直接候选：url 优先，其次 file（它有时本身就是 http 地址或 base64）。
    const candidates = [...new Set([ref.url, ref.file].filter((value) => value !== ""))];
    let lastError: unknown = new Error("图片段没有可下载的地址");
    for (const candidate of candidates) {
      try {
        return await downloadOneBotImage(candidate);
      } catch (err) {
        lastError = err;
      }
    }

    // 图片 URL 带时效；`file` 标识还能让 get_image 换一张新链接。
    if (ref.file !== "" && !ref.file.startsWith("base64://") && !ref.file.startsWith("data:")) {
      const refreshed = await this.#refreshImageUrl(ref.file);
      if (refreshed !== null) {
        try {
          return await downloadOneBotImage(refreshed);
        } catch (err) {
          lastError = err;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** @returns 新 URL（或 data URI）；拿不到时返回 null。 */
  async #refreshImageUrl(file: string): Promise<string | null> {
    try {
      const data = await this.callAction(ONEBOT_ACTIONS.getImage, { file });
      if (!isRecord(data)) return null;
      const url = asString(data.url)?.trim() ?? "";
      if (isHttpUrl(url)) return url;
      const inline = asString(data.base64)?.trim() ?? "";
      if (inline !== "") return inline.startsWith("data:") ? inline : `base64://${inline}`;
    } catch (err) {
      this.logger.warn(`${this.name} ${ONEBOT_ACTIONS.getImage} 失败: ${errorMessage(err)}`);
    }
    return null;
  }

  protected async sendText(conversation: InboundConversation, text: string): Promise<void> {
    const target = Number(conversation.id);
    if (!Number.isSafeInteger(target) || target <= 0) {
      throw new Error(`${this.name} 会话 id 不是有效数字：${conversation.id}`);
    }
    const message = [{ type: ONEBOT_SEGMENTS.text, data: { text } }];
    if (conversation.kind === "group") {
      await this.callAction(ONEBOT_ACTIONS.sendGroupMsg, { group_id: target, message });
      return;
    }
    await this.callAction(ONEBOT_ACTIONS.sendPrivateMsg, { user_id: target, message });
  }

  /**
   * 发送图片（表情包）。OneBot 11 的图片段用 `base64://` 协议内联图片字节，
   * 不需要先上传拿到文件 id —— 表情包本来就是本地素材。
   */
  protected override async sendImage(
    conversation: InboundConversation,
    image: MessageImage,
  ): Promise<void> {
    const target = Number(conversation.id);
    if (!Number.isSafeInteger(target) || target <= 0) {
      throw new Error(`${this.name} 会话 id 不是有效数字：${conversation.id}`);
    }
    const message = [{ type: ONEBOT_SEGMENTS.image, data: { file: `base64://${image.data}` } }];
    if (conversation.kind === "group") {
      await this.callAction(ONEBOT_ACTIONS.sendGroupMsg, { group_id: target, message });
      return;
    }
    await this.callAction(ONEBOT_ACTIONS.sendPrivateMsg, { user_id: target, message });
  }
}
