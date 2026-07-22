import { defineStore } from "pinia";
import * as api from "../api/client.js";
import type { Message, Session } from "../api/generated/index.js";

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
    /** 正在流式接收的助手消息 id；为 null 表示当前没有活跃的流。 */
    streamingId: null as string | null,
    /** 打开会话详情时的加载状态，供页面渲染骨架与空态。 */
    loading: false,
    error: null as string | null,
  }),

  getters: {
    streaming: (state): boolean => state.streamingId !== null,
  },

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

    /** 没有活跃会话时兜底创建一个，保证发送永远有落点。 */
    async ensureActive(): Promise<void> {
      if (this.active) return;
      const { session } = await api.createSession("首个会话");
      this.active = session;
      await this.refresh();
    },

    /**
     * 发送一条消息，并把回复以流式方式接到日志里。
     *
     * 这里刻意不看 `onDelta` 拼出来的文本，而是等末帧的 `message`：
     * 服务端已经把增量拼好并落库，用它的版本能保证前端显示与数据库一致
     * （也顺带拿到规范的消息 id 与时间戳）。
     *
     * `model` 为 provider 实例 id；留空则让服务端按自己的三级选路挑一个。
     */
    async send(text: string, model?: string): Promise<void> {
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

      // 助手气泡先以空内容占位，增量往它身上追加，用户才能立刻看到「正在输入」。
      const draftId = crypto.randomUUID();
      const draft: PendingMessage = {
        id: draftId,
        sessionId: active.id,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        pending: true,
      };
      this.log.push(draft);

      this.sending = true;
      this.streamingId = draftId;
      this.error = null;

      try {
        let sawFinal = false;
        for await (const chunk of api.sendMessageStream(active.id, text, model)) {
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.delta) this.appendDelta(draftId, chunk.delta);
          if (chunk.done) {
            sawFinal = true;
            // 末帧带回服务端落库的那条消息，用它替换掉草稿。
            if (chunk.message) this.ingest(chunk.message);
          }
        }
        // 流正常结束却没有末帧，说明连接被中途切断；留着草稿会让用户
        // 以为回复完整了，所以明确报错而不是静默保留半截内容。
        if (!sawFinal) throw new Error("回复流意外中断");
        dropPending(this.log, userMsg.id);
      } catch (err) {
        dropPending(this.log, userMsg.id);
        // 已经收到的部分内容保留下来，只把错误挂在旁边——把半截回复删掉
        // 会让用户连自己看到了什么都不知道。
        this.error = err instanceof Error ? err.message : "发送失败";
        if (this.error === "回复流意外中断") this.dropDraft(draftId);
      } finally {
        this.sending = false;
        this.streamingId = null;
      }
    },

    /** 追加一段增量到指定草稿消息上。 */
    appendDelta(id: string, delta: string): void {
      const target = this.log.find((m) => m.id === id);
      if (target) target.content += delta;
    },

    /** 丢弃某条草稿（流中断时用），避免留下一个永远在「输入中」的气泡。 */
    dropDraft(id: string): void {
      const i = this.log.findIndex((m) => m.id === id);
      if (i !== -1) this.log.splice(i, 1);
    },

    /** 并入一条服务端消息（WebSocket 帧与流式末帧共用）。 */
    ingest(message: Message): void {
      if (message.sessionId !== this.active?.id) return;
      // 草稿替换：流式末帧的 id 与草稿不同，靠「同角色 + 同内容 + pending」对上号。
      ingestInto(this.log, message);
    },
  },
});
