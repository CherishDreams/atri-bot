import { defineStore } from "pinia";
import * as api from "../api/client.js";
import type { Message, Session } from "../api/generated/index.js";

/** 乐观插入的本地消息：服务端回显到达前先占位，用 pending 标记以便对上号。 */
interface PendingMessage extends Message {
  pending?: boolean;
}

/**
 * 中间消息：要求执行工具的助手消息、以及工具的结果。
 * 它们到达不代表这一轮结束 —— 后面还有至少一次补全。
 */
function isIntermediate(message: Message): boolean {
  return message.role === "tool" || (message.role === "assistant" && !!message.toolCalls?.length);
}

/**
 * 把服务端消息并入日志，按 id 去重。
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

/**
 * 把当前草稿**就地**换成服务端确认过的那条。
 *
 * 为什么不能只靠 `ingestInto` 的「同角色 + 同内容」匹配：多步循环里第一步的
 * 助手消息正文常常是空的（它只带 `toolCalls`），而草稿也是空正文 ——
 * 于是那条草稿会被这条中间消息顶掉，`id` 跟着换掉，之后所有
 * `appendDelta(旧草稿 id)` 都找不到目标，**第二步之后的正文会静默丢失**。
 * 页面看起来就是「模型说完第一步之后再也不出字」。
 */
function confirmDraft(log: Message[], draftId: string, message: Message): boolean {
  const i = log.findIndex((m) => m.id === draftId);
  if (i === -1) return false;
  log[i] = message;
  return true;
}

/** 把工具结果插在**当前草稿之前**：它属于上一步，排到草稿后面就成了颠倒的因果。 */
function insertBeforeDraft(log: Message[], draftId: string, message: Message): void {
  if (log.some((m) => m.id === message.id)) return;
  const i = log.findIndex((m) => m.id === draftId);
  if (i === -1) {
    log.push(message);
    return;
  }
  log.splice(i, 0, message);
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
     * 挂一条空的助手草稿并把它设为当前流式目标。
     *
     * 多步循环中每一步都要一条新草稿：上一步的助手消息一旦被服务端确认，
     * 它的 id 就不再是草稿 id，增量必须改挂到新草稿上，否则丢字。
     */
    beginDraft(): string | null {
      const active = this.active;
      if (!active) return null;
      const id = crypto.randomUUID();
      const draft: PendingMessage = {
        id,
        sessionId: active.id,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        pending: true,
      };
      this.log.push(draft);
      this.streamingId = id;
      return id;
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
      const draftId = this.beginDraft();
      if (draftId === null) return;

      this.sending = true;
      this.error = null;

      try {
        let sawFinal = false;
        for await (const chunk of api.sendMessageStream(active.id, text, model)) {
          if (chunk.error) throw new Error(chunk.error);
          // 增量永远挂在「当前草稿」上，而不是发送时捕获的那个 id：
          // 中间消息到达时草稿会被换成服务端消息并再开一条新的。
          if (chunk.delta) this.appendDelta(chunk.delta);
          // 中间帧（done 为假但带 message）与末帧走同一个 ingest：
          // 谁先到谁就把草稿确认掉，重复到达的那一份按 id 去重。
          if (chunk.message) this.ingest(chunk.message);
          if (chunk.done) sawFinal = true;
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
        if (this.error === "回复流意外中断") this.dropDraft();
      } finally {
        this.sending = false;
        this.streamingId = null;
      }
    },

    /** 追加一段增量到**当前**草稿上。 */
    appendDelta(delta: string): void {
      const id = this.streamingId;
      if (id === null) return;
      const target = this.log.find((m) => m.id === id);
      if (target) target.content += delta;
    },

    /** 丢弃当前草稿（流中断时用），避免留下一个永远在「输入中」的气泡。 */
    dropDraft(): void {
      const id = this.streamingId;
      if (id === null) return;
      const i = this.log.findIndex((m) => m.id === id);
      if (i !== -1) this.log.splice(i, 1);
      this.streamingId = null;
    },

    /**
     * 并入一条服务端消息（WebSocket 帧与流式帧共用）。
     *
     * 先按 id 去重：同一条消息会从 SSE 与 WS **两条通道各到一次**，而下面的
     * `confirmDraft` 是「把当前草稿换成它」——不去重就会第二次落到新草稿上，
     * 于是那条工具调用在界面上出现两遍（真实浏览器里量到过）。
     *
     * 三条分支的次序也是有讲究的：草稿代表「正在生成的那一条」，
     * 所以助手消息要**替换**它、工具结果要**排在它前面**、其余（含用户回显）走通用合并。
     */
    ingest(message: Message): void {
      if (message.sessionId !== this.active?.id) return;
      if (this.log.some((m) => m.id === message.id)) return;
      const draftId = this.streamingId;

      if (draftId !== null && message.role === "assistant") {
        if (confirmDraft(this.log, draftId, message)) {
          // 中间消息之后还有下一步，所以立刻再挂一条草稿，避免出现「没有正在输入」的空窗。
          if (isIntermediate(message)) this.beginDraft();
          else this.streamingId = null;
          return;
        }
      }

      if (draftId !== null && message.role === "tool") {
        insertBeforeDraft(this.log, draftId, message);
        return;
      }

      ingestInto(this.log, message);
    },
  },
});
