import { WebSocket } from "ws";
import { errorMessage } from "#core/errors.ts";
import { OneBot11Adapter, type OneBot11AdapterOptions } from "./onebot11.ts";

/**
 * SnowLuma 适配器（OneBot 11，正向 WebSocket）。
 *
 * SnowLuma 暴露 OneBot 11 WebSocket 服务，atri-bot 作为客户端连入；
 * 消息段、图片下载与 action 调用复用 `onebot11.ts`，这里只负责连接、
 * 鉴权头与断线重连。与 NapCat 的方向相反，但协议层是同一份。
 */

export const SNOWLUMA_TYPE = "snowluma";

/** 连接断开后的重试间隔。固定值先够用；以后需要再按指数退避。 */
export const SNOWLUMA_RECONNECT_MS = 3_000;

/** 日志/错误里不展示 URL 的 query 与 userinfo：token 可能被用户塞在那里。 */
function safeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return "(无效 URL)";
  }
}

export interface SnowLumaAdapterOptions extends Omit<OneBot11AdapterOptions, "platformName"> {
  /** SnowLuma 暴露的 WebSocket 地址，例如 ws://127.0.0.1:3001/ws。 */
  url: string;
  /** 可选的 access token；非空时以 Authorization: Bearer 发送。 */
  token: string;
  reconnectMs?: number;
}

export class SnowLumaAdapter extends OneBot11Adapter {
  #url: string;
  #token: string;
  #reconnectMs: number;

  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #running = false;
  #stopping = false;

  constructor(options: SnowLumaAdapterOptions) {
    super({ ...options, platformName: "SnowLuma" });
    this.#url = options.url.trim();
    this.#token = options.token.trim();
    this.#reconnectMs = options.reconnectMs ?? SNOWLUMA_RECONNECT_MS;
  }

  protected canSend(): boolean {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  protected sendRaw(text: string): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error(this.unavailableMessage());
    }
    socket.send(text);
  }

  protected unavailableMessage(): string {
    return "SnowLuma 尚未连接";
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#url === "") throw new Error("SnowLuma WebSocket URL 不能为空");
    let parsed: URL;
    try {
      parsed = new URL(this.#url);
    } catch (err) {
      throw new Error(`SnowLuma WebSocket URL 无效：${safeUrlForLog(this.#url)}`, { cause: err });
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("SnowLuma WebSocket URL 必须以 ws:// 或 wss:// 开头");
    }

    this.#running = true;
    this.#stopping = false;
    this.logger.info(`SnowLuma 正在连接 ${safeUrlForLog(this.#url)}`);
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopping = true;
    // 先把防抖窗口里攒着的消息发出去，再关连接（否则用户最后几句话会静默消失）。
    await this.flushIntake();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    this.resetPending("SnowLuma 适配器已停止");
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1001, "atri-bot 停止");
      } catch {
        socket.terminate();
      }
    }
  }

  #connect(): void {
    if (!this.#running) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.#url,
        this.#token === "" ? {} : { headers: { Authorization: `Bearer ${this.#token}` } },
      );
    } catch (err) {
      this.logger.warn(`SnowLuma 建立连接失败: ${errorMessage(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#socket !== socket) return;
      this.logger.info("SnowLuma 已连接");
      this.onTransportConnected();
    });
    socket.on("message", (data) => this.handleFrame(data));
    socket.on("error", (err) => {
      this.logger.warn(`SnowLuma 连接出错: ${errorMessage(err)}`);
    });
    socket.on("close", (code, reason) => {
      if (this.#socket === socket) this.#socket = null;
      this.onTransportClosed(`SnowLuma 连接已断开（${code}）`);
      if (this.#stopping || !this.#running) return;
      const detail = reason.length > 0 ? `：${reason.toString("utf8")}` : "";
      this.logger.warn(`SnowLuma 连接断开（code ${code}${detail}），${this.#reconnectMs}ms 后重连`);
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#reconnectMs);
  }
}
