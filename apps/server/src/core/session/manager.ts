import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";
import type { Message, MessageImage, Role, Session, SessionDetail, ToolCall } from "@atri/shared";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import { openSessionDb, type RawMessageRow, type RawSessionRow } from "./db.ts";

/**
 * `SessionManager` 实际读写的配置键。只声明这一条（与 `ProviderStoreConfig` /
 * `ToolStoreConfig` 同一规矩），而不是收一个 `Partial<AppConfig>`。
 *
 * **不采用** `ProviderConfigStore` 那条「root 缺省时退化为只读内存视图」的先例：`dataDir` 在
 * `AppConfig` 里必填且永远有值（`loadConfig()` 那一侧有 `"data"` 兜底），那条分支在真实运行里
 * 永远不会走到；而多一条内存路径就是多一份会漂移的实现 —— 这里的差别不是「能不能写」这种
 * 一眼看得见的东西，而是「顺序对不对、游标对不对」这种要靠测试才看得见的东西。
 */
export interface SessionStoreConfig {
  /** 运行时数据目录，会话库落在 `<dataDir>/sessions.sqlite`。 */
  dataDir: string;
}

interface SessionRowWithCount extends RawSessionRow {
  message_count: number;
}

/**
 * 会话摘要 + 消息计数。计数用相关子查询而不是「先取会话、再逐条 `COUNT(*)`」：
 * 后者就是 N+1 —— `list()` 每一行都要一个数。
 * 末尾不写 `ORDER BY`，由调用方接上（`get` 接 WHERE、`list` 接 ORDER BY s.seq）。
 */
const SQL_SESSION_WITH_COUNT = `SELECT s.seq, s.id, s.title, s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s`;

/** 一页默认给多少条（`GET /sessions` 与 `GET /sessions/:id` 共用）。 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * 一页的上限。
 *
 * 与 `ToolConfigStore.maxSteps()` 的「夹到区间 + warn」**刻意相反**：那是配置文件里用户
 * 手写的数字，写歪了不该让服务起不来；这是**请求参数**，静默夹取等于「你要 500 条我只给
 * 100 条且不说」，而 400 让调用方立刻看见自己写错了。非法值不夹取也不忽略 —— 后者会让
 * 「前端拼错了参数」表现为「只回了 100 条」，与正确行为无法区分。
 */
export const MAX_PAGE_SIZE = 500;

/** 一页历史里最多带回的图片字节数（按 base64 解码后估算）。 */
const MAX_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_OMITTED = "[图片已省略]";

/**
 * 会话详情是 HTTP 视图，不是引擎上下文：一页 100 条消息在极端情况下可以带几百 MB
 * base64 图片。这里从新到旧分配一个页面预算，超出预算的旧图片不随响应发出
 *（数据库里的数据不动）；整条消息的图片都被省略且正文为空时补一个占位。
 */
function capPageImages(messages: Message[]): Message[] {
  const copies = messages.map((message) => ({
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
  }));
  let remaining = MAX_PAGE_IMAGE_BYTES;
  for (let i = copies.length - 1; i >= 0; i -= 1) {
    const message = copies[i];
    if (!message?.images) continue;
    const kept: MessageImage[] = [];
    let dropped = false;
    for (const image of message.images) {
      const cost = Math.ceil((image.data.length * 3) / 4);
      if (cost <= remaining) {
        kept.push(image);
        remaining -= cost;
      } else {
        dropped = true;
      }
    }
    message.images = kept.length > 0 ? kept : undefined;
    if (dropped) {
      message.content =
        message.content.trim() === "" ? IMAGE_OMITTED : `${message.content} ${IMAGE_OMITTED}`;
    }
  }
  return copies;
}

/**
 * 引擎一次最多读取多少条历史。上下文预算通常远早于此，但「先全量 SELECT 再裁剪」
 * 仍会把一个几十万条的会话整份搬进内存；这个上限是存储层的最后一道内存边界。
 */
const MAX_ENGINE_HISTORY_MESSAGES = 1_000;

/** 分页入参。两个都可缺省；非法值都是 400，不是「当没传」。 */
export interface PageOptions {
  /** 一页条数，默认 100、上限 500。 */
  limit?: number | undefined;
  /** 不透明游标（上一次响应的 `nextCursor`）。给出时只返回**比它更早**的条目。 */
  before?: string | null | undefined;
}

export interface SessionPage {
  /** 按创建序（旧→新）的一页会话。 */
  sessions: Session[];
  /** 取更早条目的游标；`null` 表示已经到最早。 */
  nextCursor: string | null;
}

export interface MessagePage {
  detail: SessionDetail;
  nextCursor: string | null;
}

/**
 * 游标属于哪一个序列。**编进游标本身**，而不是只在调用点区分。
 *
 * 以前 `GET /sessions` 给的 `nextCursor` 会被 `GET /sessions/:id` 照单收下，然后拿去过滤
 * **另一条** seq 序列 —— 不报错、不回 400，只是安静地给出一页不相干的消息。两个游标空间
 * 今天都是表的 rowid，数值上会互相撞对，所以只能靠串里这个标记把它们分开。
 */
type CursorKind = "sessions" | "messages";

/**
 * 游标 = base64url(`<kind>:<seq 的十进制>`)。
 *
 * 不透明而不是裸数字：裸 seq 会把「内部用 `INTEGER PRIMARY KEY` 排序」这件事写进 API 契约，
 * 将来加第二个排序键就是一次破坏性变更，而不透明串只是服务端自己换编解码。
 * 用 base64**url** 而不是标准 base64：游标要过 query string，而 `+` 会被解成空格、`=` 填充
 * 也要命 —— 那是一条只在真机发作的坏路径。
 */
function encodeCursor(kind: CursorKind, seq: number): string {
  return Buffer.from(`${kind}:${seq}`, "utf8").toString("base64url");
}

/** @throws ApiError 400 —— 形状不对、不属于本序列、非正整数、超出安全整数范围都是同一句错。 */
function decodeCursor(kind: CursorKind, raw: string): number {
  // 边界收窄：`Buffer.from(..., "base64url")` 对非法字符是**忽略**而不是抛，
  // 所以解出来的串可以是任何东西，判据只能落在「必须是 `<kind>:<纯数字>`」上。
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const match = /^([a-z]+):(\d+)$/.exec(text);
  const seq = Number(match?.[2]);
  if (!match || match[1] !== kind || !Number.isSafeInteger(seq) || seq <= 0) {
    throw new ApiError("before 不是合法的游标", 400);
  }
  return seq;
}

/**
 * 会话与消息的存储。库化自本仓最初的内存 `Map` 实现（`db.ts` 是它的连接层）。
 *
 * 签名全部保持**同步**：`node:sqlite` 本身是同步 API，所以这是一次平替，引擎与 HTTP 层的
 * 调用点一个字都不用改。
 *
 * 两条不能挪动的不变量：
 *
 * - **行的顺序就是插入序，唯一真相是 `messages.seq`**（`INTEGER PRIMARY KEY`，即 rowid 别名）。
 *   不能按 `created_at` 排：那是毫秒 ISO，同一轮多步循环里可以完全相同，而 `randomUUID` 不可排序；
 *   更要命的是 `ORDER BY created_at` 在 SQLite 上常因「相同 key 按 rowid 兜底」而**碰巧给对结果**，
 *   是一条能穿过大半测试的坏实现。`AgentEngine.#runLoop` 里那句「助手这条必须先进 history，
 *   再排它的结果」就是这个不变量的文档，两家上游都靠它配对。
 * - **`appendMessage` 不做角色校验**，`role` 列也刻意没有 `CHECK`。引擎的 `#historyFor`
 *   会在读取时把「带 `toolCalls` 却没配到结果」的孤儿调用退化成纯文本，
 *   那条兜底存在的前提就是「这样的历史能被写进库、也能被读出来」—— 上游打断留下的半截一轮
 *   是运行期的事实，不是脏数据。加了 CHECK 就把它变成写库失败。
 */
export class SessionManager {
  #db: DatabaseSync;
  #closed = false;
  #logger?: Logger;

  constructor(config: SessionStoreConfig, logger?: Logger) {
    this.#logger = logger;
    this.#db = openSessionDb(config.dataDir, logger);
  }

  /** 关闭库。幂等；`app.stop()` 在链尾调用它。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // 刻意不做显式 `PRAGMA wal_checkpoint`：`db.close()` 作为最后一个连接时 SQLite 会自动
    // 回收 WAL，而显式 checkpoint 在别的进程持读锁时会返回 busy —— 那才是能把关停卡住的地方。
    this.#db.close();
  }

  create(input: { title?: string } = {}): Session {
    const rawTitle = input.title;
    // 校验写在运行时边界上，而不是指望类型：`api/server.ts` 把整个 JSON body 原样递进来，
    // 而 STRICT 表会把整数 `123` 静默转成 `'123.0'` 存进 TEXT 列（实测），boolean 则会在绑定层
    // 抛 `ERR_INVALID_ARG_TYPE` 冒成 500。规格里 `Session.title` 是 `string`，所以非字符串就是 400。
    if (rawTitle !== undefined && typeof rawTitle !== "string") {
      throw new ApiError("title 必须是字符串", 400);
    }
    const title = typeof rawTitle === "string" ? rawTitle : "新会话";
    // 一次生成两处共用：既有语义里 createdAt 与 updatedAt 在创建时是同一个值。
    const now = new Date().toISOString();
    const id = randomUUID();
    this.#run(
      "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      id,
      title,
      now,
      now,
    );
    return { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  /**
   * 存在性检查。写端点（发消息、开流）只需要知道「有没有这个会话」，
   * 拿一份摘要再丢掉是白付一次计数子查询。
   */
  has(id: string): boolean {
    return this.#getOne("SELECT 1 AS ok FROM sessions WHERE id = ? LIMIT 1", id) !== undefined;
  }

  get(id: string): Session | null {
    const row = this.#getOne(SQL_SESSION_WITH_COUNT + " WHERE s.id = ? LIMIT 1", id);
    return row ? this.#toSession(row) : null;
  }

  /**
   * 会话详情：公开字段 + **一页**消息历史（默认最新 100 条）。
   * 前端刷新或直接打开 /chat/:id 时靠它把对话恢复出来；`get()` 保持不含消息
   * （列表接口只需要元数据，也不该把全部内容搬过来）。
   *
   * 返回的数组仍是**插入序（旧→新）**：截断而不改序。dashboard 至今不做二次排序，
   * 所以「把 DESC 直接吐出去」会让界面整个反序，而那条既有事实不会报错、只会静默失效。
   */
  getDetail(id: string, opts: PageOptions = {}): MessagePage | null {
    // 先校验分页参数再看资源存不存在：请求形状不对就是 400，与那个会话在不在**无关**。
    // 反过来写会让「未知 id + 非法 limit」回 404，等于用状态码泄露资源存在性，
    // 也让调用方要等到改对 id 之后才发现自己参数拼错。
    const page = this.#page(opts, "messages");
    const row = this.#getOne(SQL_SESSION_WITH_COUNT + " WHERE s.id = ? LIMIT 1", id);
    if (!row) return null;
    const rows = this.#allNamed(
      `SELECT seq, id, session_id, role, content, tool_calls, tool_call_id, images, created_at
         FROM messages
        WHERE session_id = :sid AND (:before IS NULL OR seq < :before)
        ORDER BY seq DESC LIMIT :limit`,
      // 多取一条只用来回答「还有更早的吗」，它不进响应（见 `#pageOf`）。
      // `:before IS NULL` 这种写法在 (session_id, seq) 索引上仍是有序扫描；
      // 混合匿名与编号参数（`?` 与 `?1`）会报 `column index out of range`，实测，所以全用命名参数。
      { sid: id, before: page.beforeSeq, limit: page.limit + 1 },
    ) as RawMessageRow[];
    const { items, nextCursor } = this.#pageOf(rows, page.limit, "messages");
    return {
      detail: {
        ...this.#toSession(row),
        messages: capPageImages(items.map((r) => this.#toMessage(r))),
      },
      nextCursor,
    };
  }

  /**
   * 仅供引擎使用：一次给出会话摘要与**最近 1000 条**历史（返回副本）。
   *
   * 内存版时代这个方法返回的是 Map 里那份活对象，之后 `appendMessage` 会 push 进同一个数组；
   * 库化后没有活引用可给。**这个差别是真的**：任何「先读这份、再追加、然后又读同一次的结果」
   * 的写法都会看不见刚写进去的消息。引擎已经按新的语义排好顺序 ——
   * `AgentEngine.handleMessage` 是**先 append 用户消息、再读历史**，
   * 而 `#historyFor` 在一轮循环里只调用一次，之后每步只往自己那份
   * `history` 上 push（都在 `#runLoop` 里），从不再回读存储。
   *
   * 这条耦合由测试钉住：改成「先读后 append」会立刻撞上
   * `engine-tools.test.ts` 的「回喂的那一次请求里必须同时有 tool_calls 与工具结果」
   *（历史里少一条 user）。
   *
   * 不分页（但有 1000 条的内存边界）：引擎要的是「一次问上游时的上下文」，
   * 真正的裁剪在 `AgentEngine.#historyFor` 按正文/图片预算做；存储层只保证不把
   * 一个超长会话整份搬进内存。更早的历史仍可通过 HTTP 分页读取。
   */
  getWithMessages(id: string): SessionDetail | null {
    return this.#detailOf(id);
  }

  /**
   * 会话列表：一页摘要（默认最新 100 个），按**创建序**（旧→新）。
   *
   * `ORDER BY s.seq` 就是创建序（与内存版的 Map 插入序一致，包括「删掉再建排到末尾」）。
   * 刻意不改排序 —— dashboard 不做二次排序，改成 updatedAt 倒序会静默改变用户可见的顺序；
   * 分页只截断（默认页取最新的一批），截断与改序是两件事。
   */
  list(opts: PageOptions = {}): SessionPage {
    const page = this.#page(opts, "sessions");
    const rows = this.#allNamed(
      SQL_SESSION_WITH_COUNT +
        " WHERE (:before IS NULL OR s.seq < :before) ORDER BY s.seq DESC LIMIT :limit",
      { before: page.beforeSeq, limit: page.limit + 1 },
    ) as SessionRowWithCount[];
    const { items, nextCursor } = this.#pageOf(rows, page.limit, "sessions");
    return { sessions: items.map((row) => this.#toSession(row)), nextCursor };
  }

  /**
   * 落一条消息并刷新会话的 `updatedAt`，两者在同一个事务里。
   *
   * 用 `UPDATE` 的 `changes` 同时完成存在性检查与刷新时间：一次查询两件事，而且天然把
   * 「会话被并发删除」变成 `changes === 0` → 一句 404「会话不存在」。被否掉的写法是先 `SELECT 1`
   * 再 `UPDATE`（两次往返，且两次之间会话可能消失）。
   *
   * 上事务的理由：否则「`updatedAt` 刷了、消息没进去」是一个在列表上看得见（会话排到了最新）
   * 却在历史里查不到的状态 —— 正是 `AgentEngine.handleMessage` 那句「不要出现只有半边看得见」
   * 要挡的东西。
   */
  appendMessage(sessionId: string, message: Message): Message {
    const now = new Date().toISOString();
    // 关闭状态的检查必须在 try **之外**：否则「存储已关闭」会被下面的故障分支包装成
    // 一句「保存会话失败（500）」，关停竞态里的调用方就拿不到真实原因了。
    this.#assertOpen();
    try {
      this.#tx(() => {
        const touched = this.#run(
          "UPDATE sessions SET updated_at = ? WHERE id = ?",
          now,
          sessionId,
        );
        if (touched.changes === 0) throw new ApiError("会话不存在", 404);
        // `session_id` 绑的是**形参**而不是 `message.sessionId`：这一列是外键落点，
        // 得由被追加到的那个会话决定，而不是由调用方随手带的字段决定。
        this.#run(
          `INSERT INTO messages
             (id, session_id, role, content, tool_calls, tool_call_id, images, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          message.id,
          sessionId,
          message.role,
          message.content,
          // 可选字段必须显式转 null：`undefined` 在绑定层就抛 `ERR_INVALID_ARG_TYPE`（实测），
          // 而类型上它是 `string | undefined`，编译期不会提醒你。
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId ?? null,
          message.images?.length ? JSON.stringify(message.images) : null,
          message.createdAt,
        );
      });
    } catch (err) {
      // 我们自己刻意抛的那些（现在只有「会话不存在」404）原样出去。
      // **判据是类型而不是消息文本**：旧写法判 `message.startsWith("未知会话:")`，
      // 于是有人改了那句术之后，真正的存储故障就会走进这个分支、带着 SQLite 原文回给客户端。
      if (err instanceof ApiError) throw err;
      // 其余是存储故障（磁盘满、权限、库被外部改坏）。细节只进日志：SQLite 的错里带着
      // **库文件的绝对路径**，不能原样回给客户端 —— 与 `list_plugins` 不外传 error 原文同条理由。
      this.#logger?.error(`写入会话库失败: ${errorMessage(err)}`);
      throw new ApiError("保存会话失败，详情见服务端日志", 500, { cause: err });
    }
    // 既有语义：返回入参同一个对象（引擎的 `#record` 就是拿它去广播的）。
    return message;
  }

  /**
   * 删除会话。**显式发两条 DELETE** 而不是只删会话靠 `ON DELETE CASCADE`：
   * 级联依赖「外键约束开着」这个 `node:sqlite` 默认值（以及未来没人传
   * `enableForeignKeyConstraints: false`），而「删干净」不该寄托在默认值上。
   * 级联留着当第二道保险。
   */
  delete(id: string): boolean {
    return this.#tx(() => {
      this.#run("DELETE FROM messages WHERE session_id = ?", id);
      return this.#run("DELETE FROM sessions WHERE id = ?", id).changes > 0;
    });
  }

  /** 不分页的详情：摘要 + 全部历史。只服务 `getWithMessages`（引擎要完整上下文）。 */
  #detailOf(id: string): SessionDetail | null {
    const row = this.#getOne(SQL_SESSION_WITH_COUNT + " WHERE s.id = ? LIMIT 1", id);
    if (!row) return null;
    return { ...this.#toSession(row), messages: this.#messagesOf(id) };
  }

  /**
   * 校验并归一分页入参。
   *
   * `limit` 走的是 `Number(query)` 的结果，所以 `abc` → NaN、`""` → 0、`50.5` → 非整数，
   * 全都落进同一条 400 —— 判据是「是不是 1..MAX 的整数」，不是「能不能解析」。
   * `before` 空串也判 400：只有**不传**才表示「从最新处开始」。
   */
  #page(
    { limit = DEFAULT_PAGE_SIZE, before }: PageOptions,
    kind: CursorKind,
  ): {
    limit: number;
    beforeSeq: number | null;
  } {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ApiError(`limit 必须是 1 到 ${MAX_PAGE_SIZE} 之间的整数`, 400);
    }
    return {
      limit,
      beforeSeq: before === undefined || before === null ? null : decodeCursor(kind, before),
    };
  }

  /**
   * 把「按 seq 倒序多取一条 → 判有没有更早 → 翻回插入序 → 出游标」收成一处，
   * 会话列表与消息历史共用同一段逻辑（它们只是两个不同的游标空间，靠 `kind` 分开）。
   *
   * `rows` 必须是 `ORDER BY seq DESC LIMIT limit+1` 取来的。
   */
  #pageOf<T extends { seq: number }>(
    rows: T[],
    limit: number,
    kind: CursorKind,
  ): { items: T[]; nextCursor: string | null } {
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const oldest = kept.at(-1);
    return {
      // 游标取**响应里最旧那一行**的 seq，不是被丢掉那一行的：下一页的条件是 `seq < cursor`，
      // 取被丢掉那行会把它自己排除掉、**静默漏一条**。那个 bug 在 UI 上表现为「中间少一句」，
      // 不报错也不重复 —— 只有「逐页拼接 == 全量」那条断言抓得住，所以先写那条测试。
      nextCursor: hasMore && oldest !== undefined ? encodeCursor(kind, oldest.seq) : null,
      // 倒序取、正序给。用 `toReversed()` 而不是 `reverse()`：后者原地改（AGENTS.md 的
      // unicorn/no-array-reverse），而这里的数组还要交出去。
      items: kept.toReversed(),
    };
  }

  #messagesOf(sessionId: string): Message[] {
    // 倒序 LIMIT 才是「最近的一批」；再翻回插入序交给引擎。更早的历史仍有分页接口可读，
    // 而引擎的上下文预算本来也会把它们裁掉。
    const rows = this.#all(
      `SELECT seq, id, session_id, role, content, tool_calls, tool_call_id, images, created_at
         FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
      sessionId,
      MAX_ENGINE_HISTORY_MESSAGES,
    ) as RawMessageRow[];
    return rows.map((row) => this.#toMessage(row)).toReversed();
  }

  /**
   * 行 → 领域对象。**必须逐字段构造**：`node:sqlite` 返回的行原型是 `null`（实测），
   * 直接 `as Message` 交出去的话，`JSON.stringify` 恰好正常（HTTP 面看不出问题），
   * 而 `assert.deepStrictEqual` 会红、任何原型敏感的代码会踩 —— 那是最坏的一种假绿。
   */
  #toMessage(row: RawMessageRow): Message {
    const message: Message = {
      id: row.id,
      sessionId: row.session_id,
      // `role` 列没有 CHECK（见类注释），运行时形状由写侧保证，这里只是收窄回 `Role`。
      role: row.role as Role,
      content: row.content,
      createdAt: row.created_at,
    };
    // 是 NULL 就**不带这个键**，而不是带一个 `toolCalls: null` —— 后者会让
    // `packages/shared` 的类型与 openapi 规格同时说谎（规格写的是 array，不是 null）。
    if (row.tool_calls !== null) {
      // `as` 用在这里是允许的：这是「自己写进去的 JSON 列」这个真边界，读回来只能是这个形状。
      message.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
    }
    if (row.images !== null) {
      message.images = JSON.parse(row.images) as MessageImage[];
    }
    if (row.tool_call_id !== null) message.toolCallId = row.tool_call_id;
    return message;
  }

  #toSession(row: SessionRowWithCount): Session {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    };
  }

  #handle(): DatabaseSync {
    this.#assertOpen();
    return this.#db;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("会话存储已关闭");
  }

  #run(sql: string, ...params: (string | number | null)[]): StatementResultingChanges {
    return this.#handle()
      .prepare(sql)
      .run(...params);
  }

  #getOne(sql: string, ...params: (string | number | null)[]): SessionRowWithCount | undefined {
    return this.#handle()
      .prepare(sql)
      .get(...params) as SessionRowWithCount | undefined;
  }

  #all(sql: string, ...params: (string | number | null)[]): unknown[] {
    return this.#handle()
      .prepare(sql)
      .all(...params);
  }

  /**
   * 命名参数版。分页那两条查询必须用它：同一个 `:before` 要在 SQL 里出现两次
   *（判空 + 比较），而混用匿名 `?` 与编号 `?1` 会报 `column index out of range`（实测）。
   */
  #allNamed(sql: string, params: Record<string, string | number | null>): unknown[] {
    return this.#handle().prepare(sql).all(params);
  }

  /** 把两条及以上语句包成一个原子单元；任一步失败就整批回滚。 */
  #tx<T>(fn: () => T): T {
    const db = this.#handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      // 回滚本身可能失败：SQLite 在某些错误里（实测延迟外键违例之后）已经**自己**终止了
      // 事务，这时 `ROLLBACK` 抛的是 `cannot rollback - no transaction is active`，
      // 于是原始那条错误被它盖掉 —— 排查的人看到的是「回滚失败」，真因已经从堆栈顶上消失了。
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 原始错误才是要往上抛的那一个 */
      }
      throw err;
    }
  }
}
