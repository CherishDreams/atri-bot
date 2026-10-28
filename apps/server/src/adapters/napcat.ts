import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { errorMessage } from "#core/errors.ts";
import { OneBot11Adapter, type OneBot11AdapterOptions } from "./onebot11.ts";

/**
 * NapCat 适配器（OneBot 11，反向 WebSocket）。
 *
 * 方向与 AstrBot 一致：**atri-bot 监听，NapCat 作为 WebSocket 客户端连进来**。
 * NapCat 侧在网络配置里新建「WebSocket 客户端」，URL 指向这里的 `监听地址:端口/路径`，
 * token 与这里一致。这样容器里的 NapCat 可以主动连宿主机上的 atri-bot，
 * 不需要 atri-bot 反过来访问 NapCat 的端口。
 *
 * OneBot 11 的消息段、图片下载与 action 调用都在 `onebot11.ts`；这里只负责
 * 反向 WS 的监听、鉴权与连接生命周期。
 */

export const NAPCAT_TYPE = "napcat";

export interface NapCatAdapterOptions extends Omit<OneBot11AdapterOptions, "platformName"> {
  /** 监听地址：0.0.0.0 供容器连入，127.0.0.1 仅本机。 */
  host: string;
  /** 监听端口（测试可传 "0" 让系统分配）。 */
  port: string;
  /** WebSocket 路径，例如 /ws。 */
  path: string;
  /** 与 NapCat WebSocket 客户端一致的 access token。 */
  token: string;
}

export class NapCatAdapter extends OneBot11Adapter {
  #host: string;
  #port: string;
  #path: string;
  #token: string;

  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #running = false;
  #stopping = false;

  constructor(options: NapCatAdapterOptions) {
    super({ ...options, platformName: "NapCat" });
    this.#host = options.host.trim();
    this.#port = options.port.trim();
    this.#path = options.path.trim();
    this.#token = options.token;
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
    return "NapCat 客户端尚未连接";
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
    // 先把防抖窗口里攒着的消息发出去，再关连接（否则用户最后几句话会静默消失）。
    await this.flushIntake();
    this.#running = false;
    this.#stopping = true;
    this.resetPending("NapCat 适配器已停止");

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

    ws.on("message", (data) => this.handleFrame(data));
    ws.on("error", (err) => {
      this.logger.warn(`NapCat 客户端连接出错: ${errorMessage(err)}`);
    });
    ws.on("close", (code, reason) => {
      if (this.#socket === ws) this.#socket = null;
      this.onTransportClosed(`NapCat 客户端连接已断开（${code}）`);
      if (this.#stopping) {
        this.logger.info("NapCat 客户端已断开");
        return;
      }
      const detail = reason.length > 0 ? `：${reason.toString("utf8")}` : "";
      this.logger.warn(`NapCat 客户端断开（code ${code}${detail}），等待它重连`);
    });

    this.onTransportConnected();
  }
}
