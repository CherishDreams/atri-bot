import { API_PREFIX, WS_PATH } from "@atri/shared";
import type { ServerFrame, Session } from "@atri/shared";

/** 基于服务端 HTTP + WebSocket API 的轻薄类型化客户端。 */
export class ApiClient {
  constructor(private base = "") {}

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `请求失败: ${res.status}`);
    return body as T;
  }

  listSessions() {
    return this.#json<{ sessions: Session[] }>("/sessions");
  }

  createSession(title?: string) {
    return this.#json<{ session: Session }>("/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  sendMessage(sessionId: string, content: string) {
    return this.#json<{ message: unknown }>(
      `/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ content }) },
    );
  }

  /** 订阅出站事件。返回取消订阅函数。 */
  connect(onFrame: (frame: ServerFrame) => void): () => void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
    ws.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(ev.data) as ServerFrame);
      } catch {
        /* 忽略格式错误的帧 */
      }
    };
    return () => ws.close();
  }
}
