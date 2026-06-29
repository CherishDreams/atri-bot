import { defineStore } from "pinia";
import type { Message, Session } from "@atri/shared";
import { ApiClient } from "../api/client.js";

const api = new ApiClient();

/** 乐观插入的本地消息：服务端回显到达前先占位，用 pending 标记以便对上号。 */
interface PendingMessage extends Message {
  pending?: boolean;
}

/**
 * 把一条服务端消息并入日志，按 id 去重。
 *
 * 助手回复会同时从 HTTP 响应和 WebSocket 帧到达，不去重就是两条；
 * 用户轮次的乐观占位用的是本地 uuid，与服务端 id 不同，
 * 因此靠「同角色 + 同内容 + 尚未确认」把占位替换成服务端版本。
 *
 * 写成模块级函数而非 store 的私有方法：Pinia 会把 actions 挂到另一个
 * 对象上执行，`this.#x()` 那种私有名字取不到，会直接抛 TypeError。
 */
function ingestInto(log: Message[], message: Message): void {
  if (log.some((m) => m.id === message.id)) return;

  const i = log.findIndex(
    (m) =>
      (m as PendingMessage).pending === true &&
      m.role === message.role &&
      m.content === message.content,
  );
  if (i !== -1) {
    log[i] = message;
    return;
  }
  log.push(message);
}

/** 移除仍未确认的乐观占位；已被服务端回显替换过则什么都不做。 */
function dropPending(log: Message[], id: string): void {
  const i = log.findIndex((m) => m.id === id);
  if (i !== -1 && (log[i] as PendingMessage).pending) log.splice(i, 1);
}

/**
 * 会话与当前对话。语义与旧的 vanilla 版本保持一致：
 * 新建/切换会话都会清空本地日志，发送时先乐观插入用户消息。
 */
export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    sessions: [] as Session[],
    active: null as Session | null,
    log: [] as Message[],
    sending: false,
    /** 打开会话详情时的加载状态，供页面渲染骨架与空态。 */
    loading: false,
    error: null as string | null,
  }),

  actions: {
    async refresh(): Promise<void> {
      const { sessions } = await api.listSessions();
      this.sessions = sessions;
    },

    async create(title?: string): Promise<Session> {
      const { session } = await api.createSession(title);
      this.active = session;
      this.log = [];
      this.error = null;
      await this.refresh();
      return session;
    },

    /**
     * 打开会话详情：拉取元数据与完整消息历史。
     * 直接访问 /chat/:id 或刷新页面时靠它恢复对话。
     */
    async open(id: string): Promise<Session | null> {
      this.loading = true;
      this.error = null;
      try {
        const { session } = await api.getSession(id);
        const { messages, ...meta } = session;
        this.active = meta;
        this.log = messages;
        // 详情里的元数据比列表新（updatedAt / messageCount），顺手同步。
        const i = this.sessions.findIndex((s) => s.id === meta.id);
        if (i !== -1) this.sessions[i] = meta;
        return meta;
      } catch (err) {
        this.active = null;
        this.log = [];
        this.error = err instanceof Error ? err.message : "会话加载失败";
        return null;
      } finally {
        this.loading = false;
      }
    },

    select(session: Session): void {
      this.active = session;
      this.log = [];
      this.error = null;
    },

    /** 没有活跃会话时兜底创建一个，保证发送永远有落点。 */
    async ensureActive(): Promise<void> {
      if (this.active) return;
      const { session } = await api.createSession("首个会话");
      this.active = session;
      await this.refresh();
    },

    async send(text: string): Promise<void> {
      await this.ensureActive();
      const active = this.active;
      if (!active) return;

      const userMsg: PendingMessage = {
        id: crypto.randomUUID(),
        sessionId: active.id,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      this.log.push(userMsg);

      this.sending = true;
      this.error = null;
      try {
        const { message } = await api.sendMessage(active.id, text);
        this.ingest(message);
        dropPending(this.log, userMsg.id);
      } catch (err) {
        dropPending(this.log, userMsg.id);
        this.error = err instanceof Error ? err.message : "发送失败";
      } finally {
        this.sending = false;
      }
    },

    /** 并入一条服务端消息（WebSocket 帧与 HTTP 响应共用）。 */
    ingest(message: Message): void {
      if (message.sessionId !== this.active?.id) return;
      ingestInto(this.log, message);
    },
  },
});
