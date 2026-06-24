import { defineStore } from "pinia";
import type { Message, Session } from "@atri/shared";
import { ApiClient } from "../api/client.js";

const api = new ApiClient();

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
      await this.refresh();
      return session;
    },

    select(session: Session): void {
      this.active = session;
      this.log = [];
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

      const userMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: active.id,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      this.log.push(userMsg);

      this.sending = true;
      try {
        const { message } = await api.sendMessage(active.id, text);
        this.log.push(message as Message);
      } finally {
        this.sending = false;
      }
    },

    /**
     * 服务端会回显双方消息；用户轮次已由上面的乐观插入覆盖，
     * 因此这里只追加助手回复，且必须是当前活跃会话的。
     */
    appendAssistant(message: Message): void {
      if (message.role !== "assistant") return;
      if (message.sessionId !== this.active?.id) return;
      this.log.push(message);
    },
  },
});
