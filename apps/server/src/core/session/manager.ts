import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";
import type { Message, Role, Session, SessionDetail, ToolCall } from "@atri/shared";
import { ApiError, errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import { openSessionDb, type RawMessageRow, type RawSessionRow } from "./db.ts";

/**
 * `SessionManager` 实际读写的配置键。只声明这一条（与 `ProviderStoreConfig` /
 * `ToolStoreConfig` 同一规矩），而不是收一个 `Partial<AppConfig>`。
 *
 * **不采用** `ProviderConfigStore` 那条「root 缺省时退化为只读内存视图」的先例：`dataDir` 在
 * `AppConfig` 里必填且永远有值（`config/config.ts:80` 有 `"data"` 兜底），那条分支在真实运行里
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
 *   是一条能穿过大半测试的坏实现。`engine.ts:159-160` 那条「助手这条必须先进 history，再排它的
 *   结果」的注释就是这个不变量的文档，两家上游都靠它配对。
 * - **`appendMessage` 不做角色校验**，`role` 列也刻意没有 `CHECK`。引擎的 `#historyFor`
 *   （`engine.ts:229-241`）会在读取时把「带 `toolCalls` 却没配到结果」的孤儿调用退化成纯文本，
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
   * 会话详情：公开字段 + 消息历史。
   * 前端刷新或直接打开 /chat/:id 时靠它把对话恢复出来；`get()` 保持不含消息
   * （列表接口只需要元数据，也不该把全部内容搬过来）。
   */
  getDetail(id: string): SessionDetail | null {
    const row = this.#getOne(SQL_SESSION_WITH_COUNT + " WHERE s.id = ? LIMIT 1", id);
    if (!row) return null;
    return { ...this.#toSession(row), messages: this.#messagesOf(id) };
  }

  /**
   * 仅供引擎使用：一次给出会话摘要与**全部**历史（返回副本）。
   *
   * 内存版时代这个方法返回的是 Map 里那份活对象，之后 `appendMessage` 会 push 进同一个数组；
   * 库化后没有活引用可给。**这个差别是真的**：任何「先读这份、再追加、然后又读同一次的结果」
   * 的写法都会看不见刚写进去的消息。引擎已经按新的语义排好顺序 ——
   * `engine.ts:86-102` 的 `handleMessage` 是**先 append 用户消息、再读历史**，
   * 而 `#historyFor` 在一轮循环里只调用一次（`engine.ts:131`），之后每步只往自己那份
   * `history` 上 push（`:161`/`:185`），从不再回读存储。
   *
   * 这条耦合由测试钉住：改成「先读后 append」会立刻撞上
   * `engine-tools.test.ts` 的「回喂的那一次请求里必须同时有 tool_calls 与工具结果」
   *（历史里少一条 user）。
   *
   * 刻意不分页：引擎要的是「一次问上游时的完整上下文」，把分页塞进这里意味着模型会忘记它
   * 早先说过的话 —— 那是上下文窗口的策略，不是存储的关切。
   */
  getWithMessages(id: string): SessionDetail | null {
    return this.getDetail(id);
  }

  list(): Session[] {
    // `ORDER BY s.seq` 就是创建序（与内存版的 Map 插入序一致，包括「删掉再建排到末尾」）。
    // 会话列表刻意不改排序 —— dashboard 不做二次排序，改成 updatedAt 倒序会静默改变用户可见顺序。
    const rows = this.#all(SQL_SESSION_WITH_COUNT + " ORDER BY s.seq") as SessionRowWithCount[];
    return rows.map((row) => this.#toSession(row));
  }

  /**
   * 落一条消息并刷新会话的 `updatedAt`，两者在同一个事务里。
   *
   * 用 `UPDATE` 的 `changes` 同时完成存在性检查与刷新时间：一次查询两件事，而且天然把
   * 「会话被并发删除」变成 `changes === 0` → 未知会话。被否掉的写法是先 `SELECT 1`
   *（两次往返，且两次之间会话可能消失）。
   *
   * 上事务的理由：否则「`updatedAt` 刷了、消息没进去」是一个在列表上看得见（会话排到了最新）
   * 却在历史里查不到的状态 —— 正是 `engine.ts:191` 那句「不要出现只有半边看得见」要挡的东西。
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
        if (touched.changes === 0) throw new Error(`未知会话: ${sessionId}`);
        // `session_id` 绑的是**形参**而不是 `message.sessionId`：这一列是外键落点，
        // 得由被追加到的那个会话决定，而不是由调用方随手带的字段决定。
        this.#run(
          `INSERT INTO messages
             (id, session_id, role, content, tool_calls, tool_call_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          message.id,
          sessionId,
          message.role,
          message.content,
          // 可选字段必须显式转 null：`undefined` 在绑定层就抛 `ERR_INVALID_ARG_TYPE`（实测），
          // 而类型上它是 `string | undefined`，编译期不会提醒你。
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId ?? null,
          message.createdAt,
        );
      });
    } catch (err) {
      // 「未知会话」是被测的行为，原样抛（`session.test.ts` 与引擎都按这句话断言）。
      if (err instanceof Error && err.message.startsWith("未知会话:")) throw err;
      // 其余是存储故障（磁盘满、权限、库被外部改坏）。细节只进日志：SQLite 的错里带着
      // **库文件的绝对路径**，不能原样回给客户端 —— 与 `list_plugins` 不外传 error 原文同条理由。
      this.#logger?.error(`写入会话库失败: ${errorMessage(err)}`);
      throw new ApiError("保存会话失败，详情见服务端日志", 500);
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

  #messagesOf(sessionId: string): Message[] {
    const rows = this.#all(
      `SELECT seq, id, session_id, role, content, tool_calls, tool_call_id, created_at
         FROM messages WHERE session_id = ? ORDER BY seq`,
      sessionId,
    ) as RawMessageRow[];
    return rows.map((row) => this.#toMessage(row));
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

  /** 把两条及以上语句包成一个原子单元；任一步失败就整批回滚。 */
  #tx<T>(fn: () => T): T {
    const db = this.#handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
