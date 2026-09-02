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
 * 把一批**更早**的消息放到日志头部，按 id 去重，返回真正新增的条数。
 *
 * 写成模块级函数而不是 store 的私有方法：Pinia 把 actions 挂到另一个对象上执行，
 * `this.#x()` 取不到那个名字，会直接抛 TypeError（见 AGENTS.md 的前端约定）。
 *
 * 草稿安全由两条事实保证，**不要改成通用 merge**：
 * 1. 草稿与正在生成的那条永远在**尾部**（`beginDraft` 用 push），而 prepend 只动头部；
 *    `appendDelta` / `confirmDraft` / `insertBeforeDraft` 全是按 id 找，索引位移不影响它们。
 * 2. 「更早」那批的 seq 严格小于当前页最旧一条，因此不可能包含 `streamingId` 指向的那条
 *    —— 它连当前页都不在。
 *
 * 与 `ingestInto` 的分工：那个按「同角色 + 同内容 + pending」把乐观占位换成服务端版本，
 * 那是**尾部**的事；这里只需要 id 集合去重（跨页交界处同一行会被两页都带到）。
 */
function prependOlder(log: Message[], older: Message[]): number {
  const seen = new Set(log.map((m) => m.id));
  const fresh = older.filter((m) => !seen.has(m.id));
  log.unshift(...fresh);
  return fresh.length;
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
    /**
     * 当前会话「更早消息」的游标；null 表示已经翻到最早。
     * 来自 `GET /sessions/:id` 的 `nextCursor`。**换会话时必须清空**（见 `open()`），
     * 残留上一个会话的游标会 prepend 出别的会话的消息，而按 id 去重挡不住它。
     */
    cursor: null as string | null,
    /** 「加载更早的消息」在途。与 `loading` 分开：那个换整屏骨架，这个只该让按钮转圈。 */
    loadingEarlier: false,
    /** 会话列表的游标；null 表示已经翻到最早。 */
    listCursor: null as string | null,
    /** 「加载更早的会话」在途。 */
    loadingMoreSessions: false,
    /**
     * 代际计数：`open()`（换会话）与 `refresh()`（列表被整份替换）都自增它。
     *
     * 存在的唯一理由是「跨 await 的过期检查没法靠读那些值本身做」。`loadEarlier()` 在
     * await **之前**判过 `active` 与 `cursor`，可那两道守卫挡不住「请求在途时用户切了会话」：
     * 响应回来时 `this.log` 已经是**另一个会话**的日志，`prependOlder` 就把 A 的三十条旧消息
     * 拼进了 B 的对话里，还把 A 的游标写进了 B 的 cursor —— 按 id 去重挡不住（不同会话的
     * 消息 id 本来就不同）。真实浏览器里量到过。
     *
     * 为什么不用「比较 id 就够了」：新建会话、删除后重建、`refresh()` 回到最新那一页
     * 都不改变 `active?.id`，但都让在途的那一页作废。
     */
    epoch: 0,
    error: null as string | null,
  }),

  getters: {
    streaming: (state): boolean => state.streamingId !== null,
    /** 列表还能不能往前翻。模板里判这个，而不是判 `listCursor !== null` 的裸写法。 */
    hasMoreSessions: (state): boolean => state.listCursor !== null,
    hasMoreMessages: (state): boolean => state.cursor !== null,
  },

  actions: {
    /**
     * 重新拉列表。
     *
     * 语义是「回到最新那一页」：整份替换 `sessions` 并重置 `listCursor`，所以之前翻出来的
     * 更早条目会被丢弃。刻意的简单 —— 否则每次新建/删除都要判断「那一页还在不在范围内」。
     */
    async refresh(): Promise<void> {
      // 列表即将被整份替换：任何在途的「加载更早的会话」都不该再把结果拼回来。
      this.epoch += 1;
      const { sessions, nextCursor } = await api.listSessions();
      this.sessions = sessions;
      this.listCursor = nextCursor;
    },

    /**
     * 取更早的一页会话，接在列表**头部**。
     *
     * 数组是创建序（旧→新），而默认页取的是**最新**的一批，所以「更早的那些」在这一页的
     * **前面** —— push 到尾部会把顺序拼反，而列表反序这件事不会报错、只会看着别扭。
     * 与消息那边同一个道理（`prependOlder`），也同一个入口位置（列表顶部）。
     */
    async loadMoreSessions(): Promise<number> {
      const cursor = this.listCursor;
      const epoch = this.epoch;
      if (cursor === null) return 0;
      this.loadingMoreSessions = true;
      try {
        const { sessions, nextCursor } = await api.listSessions({ before: cursor });
        // 同 `loadEarlier()`：await 之前判过的守卫管不了在途期间发生的一次 `refresh()`
        // —— 那一页是**上一个列表**的更早，拼进来会静默跳过若干会话。
        if (this.epoch !== epoch) return 0;
        const seen = new Set(this.sessions.map((s) => s.id));
        const fresh = sessions.filter((s) => !seen.has(s.id));
        this.sessions.unshift(...fresh);
        this.listCursor = nextCursor;
        return fresh.length;
      } catch (err) {
        this.error = err instanceof Error ? err.message : "加载更早的会话失败";
        return 0;
      } finally {
        this.loadingMoreSessions = false;
      }
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
     * 打开会话详情：拉元数据与**最近一页**消息。
     * 直接访问 /chat/:id 或刷新页面时靠它恢复对话；更早的历史在库里，不在这一页里。
     */
    async open(id: string): Promise<Session | null> {
      this.loading = true;
      this.error = null;
      // 作废一切在途的分页请求（见 state 的 `epoch`）：切会话之后，上一条消息流上还没回来的
      // 那一页不属于这个会话。
      this.epoch += 1;
      // 换会话先清游标：残留上一个会话的那一串会 prepend 出**别的会话**的消息，
      // 而按 id 去重挡不住（不同会话的消息 id 本来就不同）。失败分支同样清，
      // 于是两个出口都是「干净的一页」，不需要调用方再补一次 reset。
      this.cursor = null;
      try {
        const { session, nextCursor } = await api.getSession(id);
        const { messages, ...meta } = session;
        this.active = meta;
        this.log = messages;
        this.cursor = nextCursor;
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

    /**
     * 取更早的一页消息接到日志头部，返回真正新增的条数（调用方据此决定要不要恢复滚动）。
     *
     * 流式期间直接拒绝（组件层已经把按钮禁用，这里是第二道）：那一刻尾部挂着草稿，
     * 「服务端整条替换草稿」与「头部 prepend 一批」同时发生，会让两件事在两次 await
     * 之间被别人看见 —— 宁可不做，也别让用户看到一条跳走的回复。
     *
     * 失败**自己吞掉并置 `error`**（与 `open()` 同一约定）：两个调用点都在模板里直接调它，
     * 不吞就是一个 unhandled rejection，而用户看到的是「按钮转了一圈又变回可点」——
     * 什么都不说。游标保持不变，所以重试仍然有效。
     */
    async loadEarlier(): Promise<number> {
      // 收窄到 const：`this.cursor` 的判空结果在跨 `await` 之后不一定还跟着（而 Pinia 的
      // action 本来就被挂在另一个对象上执行），局部常量能让编译器一路知道它不是 null。
      const cursor = this.cursor;
      const activeId = this.active?.id ?? null;
      const epoch = this.epoch;
      if (activeId === null || cursor === null) return 0;
      if (this.sending || this.streamingId !== null) return 0;
      this.loadingEarlier = true;
      try {
        const { session, nextCursor } = await api.getSession(activeId, { before: cursor });
        // **await 之后再判一次过期**，这才是这条用例的落点：await 之前那两道守卫读的是
        // 出发那一刻的世界。响应回来时代际或活跃会话已经变了，这一页就不属于这里 ——
        // 既不 prepend，也不把别的会话的游标写进来。
        if (this.epoch !== epoch || this.active?.id !== activeId) return 0;
        const added = prependOlder(this.log, session.messages);
        this.cursor = nextCursor;
        return added;
      } catch (err) {
        this.error = err instanceof Error ? err.message : "加载更早的消息失败";
        return 0;
      } finally {
        this.loadingEarlier = false;
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
        // 但**一个字节都没开始**的失败一定要把那条空草稿摘掉（409「这个会话有一次对话还没
        // 结束」、401「登录失效」、404 会话不见了）：留着就是一条永远转圈的「正在输入」，
        // 而那比一句明确的错更让用户以为系统还在干活。
        // 只在草稿仍是本次发送挂的那一条、且它还是空的时动手 —— 中途已有增量到达的话，
        // `streamingId` 早就跟着中间消息换到新草稿上了，那种草稿不该被这里清掉。
        if (this.streamingId === draftId && this.log.some((m) => m.id === draftId && !m.content)) {
          this.dropDraft();
        }
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
