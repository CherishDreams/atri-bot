import { API_PREFIX, WS_PATH } from "@atri/shared";
import type {
  AuthStatus,
  AuthUser,
  LoginResponse,
  PluginInfo,
  ServerFrame,
  Session,
} from "@atri/shared";

/** 会话失效（HTTP 401）时抛出，调用方据此清空登录态。 */
export class UnauthorizedError extends Error {}

/** 基于服务端 HTTP + WebSocket API 的轻薄类型化客户端。 */
export class ApiClient {
  constructor(private base = "") {}

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${API_PREFIX}${path}`, {
      // 令牌只在 HttpOnly Cookie 里，必须显式带上凭证。
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...init,
    });
    const body = await res.json();
    if (res.status === 401) {
      throw new UnauthorizedError((body as { error?: string }).error ?? "未认证");
    }
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `请求失败: ${res.status}`);
    return body as T;
  }

  // --- 鉴权 ---------------------------------------------------------------

  login(username: string, password: string) {
    return this.#json<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  logout() {
    return this.#json<{ ok: boolean }>("/auth/logout", { method: "POST" });
  }

  me() {
    return this.#json<{ user: AuthUser; expiresAt: string }>("/auth/me");
  }

  authStatus() {
    return this.#json<AuthStatus>("/auth/status");
  }

  // --- 会话 ---------------------------------------------------------------

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
    return this.#json<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  // --- 插件 ---------------------------------------------------------------

  listPlugins() {
    return this.#json<{ plugins: PluginInfo[] }>("/plugins");
  }

  reloadPlugin(id: string) {
    return this.#json<{ plugin: PluginInfo }>(`/plugins/${encodeURIComponent(id)}/reload`, {
      method: "POST",
    });
  }

  unloadPlugin(id: string) {
    return this.#json<{ id: string; unloaded: boolean }>(
      `/plugins/${encodeURIComponent(id)}/unload`,
      { method: "POST" },
    );
  }

  setPluginEnabled(id: string, enabled: boolean) {
    return this.#json<{ plugin: PluginInfo }>(`/plugins/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  }

  /** 订阅出站事件。返回取消订阅函数。 */
  connect(onFrame: (frame: ServerFrame) => void): () => void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
    ws.addEventListener("message", (ev) => {
      try {
        onFrame(JSON.parse(ev.data) as ServerFrame);
      } catch {
        /* 忽略格式错误的帧 */
      }
    });
    return () => ws.close();
  }
}
