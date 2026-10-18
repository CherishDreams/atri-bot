import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { MessageImage } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import { MessageAdapter, type InboundConversation, type MessageAdapterDeps } from "./message.ts";

/**
 * NapCat 适配器（OneBot 11，反向 WebSocket）。
 *
 * 方向与 AstrBot 一致：**atri-bot 监听，NapCat 作为 WebSocket 客户端连进来**。
 * NapCat 侧在网络配置里新建「WebSocket 客户端」，URL 指向这里的 `监听地址:端口/路径`，
 * token 与这里一致。这样容器里的 NapCat 可以主动连宿主机上的 atri-bot，
 * 不需要 atri-bot 反过来访问 NapCat 的端口。
 *
 * 协议只覆盖本仓需要的子集：
 * - 入站：`post_type=message` 的私聊/群聊文本与图片事件；
 * - 出站：`send_private_msg` / `send_group_msg`；
 * - 连接建立后：`get_login_info` 记下机器人自己的 QQ 号，避免自问自答。
 *
 * 图片会下载后随消息交给引擎（见 `downloadImage`）：QQ 图片 URL 带时效，只把链接
 * 落库会在历史里变成破图。下载失败或超限才退回 `[图片]` 占位；语音、文件等仍是占位，
 * 也不做图片上传。完整 API 见 https://napcat.apifox.cn/llms.txt。
 */

export const NAPCAT_ADAPTER_ID = "napcat";

export interface NapCatAdapterOptions extends MessageAdapterDeps {
  /** 监听地址：0.0.0.0 供容器连入，127.0.0.1 仅本机。 */
  host: string;
  /** 监听端口（测试可传 "0" 让系统分配）。 */
  port: string;
  /** WebSocket 路径，例如 /ws。 */
  path: string;
  /** 与 NapCat WebSocket 客户端一致的 access token。 */
  token: string;
  actionTimeoutMs?: number;
}

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/**
 * 图片的工作量上限。
 *
 * 消息会原样落进 sqlite 并随历史回喂给模型，所以不能无上限地收：
 * 单张 4 MiB、单条最多 4 张。超过的照片仍然保留 `[图片]` 占位，不静默消失。
 * 这两条是本仓自选的保护值，不是 QQ 或 OneBot 的协议限制。
 */
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 下载是事件处理的一部分，不能让一张慢图拖住整个会话队列。 */
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

interface OneBotImageRef {
  /** NapCat 给出的直接下载地址，可能为空或已过期。 */
  url: string;
  /** 图片文件标识，用于 `get_image` 刷新出新的 URL。 */
  file: string;
}

export interface ParsedOneBotMessage {
  /** 去掉图片段之后的正文；纯图片消息为空串。 */
  text: string;
  images: OneBotImageRef[];
}

function textOfSegment(segment: unknown): string {
  if (typeof segment === "string") return segment;
  if (!isRecord(segment)) return "";
  const type = typeof segment.type === "string" ? segment.type : "";
  const data = isRecord(segment.data) ? segment.data : {};
  switch (type) {
    case "text":
      return typeof data.text === "string" ? data.text : "";
    case "at": {
      const qq = asString(data.qq);
      return qq === null ? "@某人" : qq === "all" ? "@全体成员" : `@${qq}`;
    }
    case "image":
      // 真正有 url/file 的图片段在 `parseOneBotMessage` 里已被抽走；走到这里说明
      // 图片段没有任何可取来源，只能保留占位。
      return "[图片]";
    case "face":
      return "[表情]";
    case "record":
      return "[语音]";
    case "video":
      return "[视频]";
    case "file":
      return "[文件]";
    case "json":
    case "xml":
      return "[卡片]";
    case "markdown":
      return "[Markdown]";
    case "forward":
      return "[转发消息]";
    case "reply":
      // 被回复的那条消息本身不在这里，塞一个空占位只会污染上下文。
      return "";
    default:
      return type === "" ? "" : `[${type}]`;
  }
}

function imageRefOfSegment(segment: unknown): OneBotImageRef | null {
  if (!isRecord(segment) || segment.type !== "image") return null;
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
 * `message` 的数组写法是 NapCat 的默认输出；字符串写法（CQ 码）只在旧实现里出现，
 * 原样保留而不是尝试解析 —— 本仓没有第二个需要 CQ 码的入口，写一个半吊子解析器
 * 只会让真正的文本被误伤。
 *
 * 图片不再变成正文里的 `[图片]`，而是交给 `NapCatAdapter` 下载后作为结构化附件
 * 带去引擎；只有下载失败时调用方才把占位符补回正文。
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
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const mediaType = imageMediaType(bytes, declared);
  return mediaType === null ? null : { data: bytes.toString("base64"), mediaType };
}

/** 下载并校验一张图片；不可用或超限时抛错，由调用方决定是否保留占位。 */
async function downloadImage(value: string): Promise<MessageImage> {
  const inline = decodeInlineImage(value);
  if (inline !== null) return inline;
  if (!isHttpUrl(value)) throw new Error("图片段没有可下载的地址");

  const response = await fetch(value, {
    redirect: "follow",
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
    throw new Error("图片超过 4 MiB 上限");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("图片超过 4 MiB 上限");
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

export class NapCatAdapter extends MessageAdapter {
  readonly name = "NapCat";

  #host: string;
  #port: string;
  #path: string;
  #token: string;
  #actionTimeoutMs: number;

  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #running = false;
  #stopping = false;
  #echoSeq = 0;
  #pending = new Map<string, PendingCall>();
  #selfId = "";
  /**
   * 图片下载是异步的，而消息顺序是同步到达的。没有这条按会话的队列时，
   * 「先发图、再发一句话」可能因为图片慢而让后一句先进入引擎。
   */
  #incoming = new Map<string, Promise<void>>();

  constructor(options: NapCatAdapterOptions) {
    super(options);
    this.#host = options.host.trim();
    this.#port = options.port.trim();
    this.#path = options.path.trim();
    this.#token = options.token;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    const port = Number(this.#port);
    if (
      this.#host === "" ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !this.#path.startsWith("/") ||
      this.#token === ""
    ) {
      throw new Error(
        "NapCat 反向 WebSocket 配置不完整：需要监听地址、0–65535 的端口、以 / 开头的路径和非空 Access Token",
      );
    }

    const server = new WebSocketServer({
      host: this.#host,
      port,
      path: this.#path,
      verifyClient: (info, done) => {
        if (this.#authorized(info.req)) {
          done(true);
          return;
        }
        done(false, 401, "Unauthorized");
      },
    });
    this.#server = server;
    this.#stopping = false;

    server.on("connection", (ws, req) => this.#onConnection(ws, req));

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          reject(err);
        };
        server.once("listening", onListening);
        server.once("error", onError);
      });
    } catch (err) {
      this.#server = null;
      try {
        server.close();
      } catch {
        /* bind 失败的清理失败没有第二条信息可给 */
      }
      throw new Error(
        `NapCat 无法监听 ${this.#host}:${this.#port}${this.#path}：${errorMessage(err)}`,
        { cause: err },
      );
    }

    server.on("error", (err) => {
      this.logger.warn(`NapCat 监听出错: ${errorMessage(err)}`);
    });
    this.#running = true;
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : this.#port;
    this.logger.info(`NapCat 反向 WebSocket 已监听 ${this.#host}:${actualPort}${this.#path}`);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopping = true;
    this.#rejectPending("NapCat 适配器已停止");

    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1001, "atri-bot 停止");
      } catch {
        socket.terminate();
      }
    }

    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    for (const client of server.clients) {
      try {
        client.close(1001, "atri-bot 停止");
      } catch {
        client.terminate();
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const client of server.clients) client.terminate();
        resolve();
      }, 1000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 实际监听地址，测试与诊断用（port 传 0 时能拿到系统分配的端口）。 */
  address(): AddressInfo | null {
    const address = this.#server?.address();
    return typeof address === "object" && address !== null ? address : null;
  }

  #authorized(req: IncomingMessage): boolean {
    if (this.#token === "") return false;
    const header = req.headers.authorization;
    if (typeof header === "string" && header === `Bearer ${this.#token}`) return true;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      return url.searchParams.get("access_token") === this.#token;
    } catch {
      return false;
    }
  }

  #onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (this.#socket !== null) {
      this.logger.warn("NapCat 新连接被拒绝：已有一个客户端连接");
      ws.close(1013, "已有连接");
      return;
    }
    this.#socket = ws;
    this.logger.info(`NapCat 客户端已连接（${req.socket.remoteAddress ?? "未知地址"}）`);

    ws.on("message", (data) => this.#onFrame(data));
    ws.on("error", (err) => {
      this.logger.warn(`NapCat 客户端连接出错: ${errorMessage(err)}`);
    });
    ws.on("close", (code, reason) => {
      if (this.#socket === ws) this.#socket = null;
      this.#rejectPending(`NapCat 客户端连接已断开（${code}）`);
      if (this.#stopping) {
        this.logger.info("NapCat 客户端已断开");
        return;
      }
      const detail = reason.length > 0 ? `：${reason.toString("utf8")}` : "";
      this.logger.warn(`NapCat 客户端断开（code ${code}${detail}），等待它重连`);
    });

    void this.#loadLoginInfo();
  }

  async #loadLoginInfo(): Promise<void> {
    try {
      const data = await this.#call("get_login_info", {});
      if (!isRecord(data)) return;
      const id = asString(data.user_id);
      if (id !== null) this.#selfId = id;
      const nickname = typeof data.nickname === "string" ? data.nickname : "未知";
      this.logger.info(`NapCat 登录账号: ${nickname}（${this.#selfId || "?"}）`);
    } catch (err) {
      this.logger.warn(`NapCat get_login_info 失败: ${errorMessage(err)}`);
    }
  }

  #onFrame(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText(data));
    } catch {
      this.logger.debug("NapCat 发来非 JSON 帧，已忽略");
      return;
    }
    if (!isRecord(parsed)) return;

    // 动作响应带 echo、不带 post_type；事件则相反。
    if (parsed.echo !== undefined && parsed.post_type === undefined) {
      this.#settleAction(parsed);
      return;
    }
    if (parsed.post_type === "message") {
      this.#onMessageEvent(parsed);
      return;
    }
    if (parsed.post_type === "meta_event") {
      const id = asString(parsed.self_id);
      if (id !== null && this.#selfId === "") this.#selfId = id;
    }
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
    pending.reject(new Error(`NapCat 调用失败（retcode ${retcode}）：${detail}`));
  }

  #call(action: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("NapCat 客户端尚未连接"));
    }
    const echo = `${this.id}-${++this.#echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`NapCat 调用 ${action} 超时`));
      }, this.#actionTimeoutMs);
      this.#pending.set(echo, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #rejectPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #onMessageEvent(event: Record<string, unknown>): void {
    const messageType = event.message_type;
    if (messageType !== "private" && messageType !== "group") {
      this.logger.debug(`NapCat 忽略消息类型 ${String(messageType)}`);
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
    if (messageType === "group") {
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
      this.logger.error(`NapCat 处理入站消息失败: ${errorMessage(err)}`);
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
    const selected = refs.slice(0, MAX_IMAGES_PER_MESSAGE);
    let failed = refs.length - selected.length;
    if (failed > 0) {
      this.logger.warn(
        `NapCat 单条消息有 ${refs.length} 张图片，只处理前 ${MAX_IMAGES_PER_MESSAGE} 张`,
      );
    }

    const images: MessageImage[] = [];
    for (const ref of selected) {
      try {
        images.push(await this.#loadImage(ref));
      } catch (err) {
        failed += 1;
        this.logger.warn(`NapCat 图片获取失败: ${errorMessage(err)}`);
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
        return await downloadImage(candidate);
      } catch (err) {
        lastError = err;
      }
    }

    // NapCat 的图片 URL 带时效；`file` 标识还能让 get_image 换一张新链接。
    if (ref.file !== "" && !ref.file.startsWith("base64://") && !ref.file.startsWith("data:")) {
      const refreshed = await this.#refreshImageUrl(ref.file);
      if (refreshed !== null) {
        try {
          return await downloadImage(refreshed);
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
      const data = await this.#call("get_image", { file });
      if (!isRecord(data)) return null;
      const url = asString(data.url)?.trim() ?? "";
      if (isHttpUrl(url)) return url;
      const inline = asString(data.base64)?.trim() ?? "";
      if (inline !== "") return inline.startsWith("data:") ? inline : `base64://${inline}`;
    } catch (err) {
      this.logger.warn(`NapCat get_image 失败: ${errorMessage(err)}`);
    }
    return null;
  }

  protected async sendText(conversation: InboundConversation, text: string): Promise<void> {
    const target = Number(conversation.id);
    if (!Number.isSafeInteger(target) || target <= 0) {
      throw new Error(`NapCat 会话 id 不是有效数字：${conversation.id}`);
    }
    const message = [{ type: "text", data: { text } }];
    if (conversation.kind === "group") {
      await this.#call("send_group_msg", { group_id: target, message });
      return;
    }
    await this.#call("send_private_msg", { user_id: target, message });
  }
}
