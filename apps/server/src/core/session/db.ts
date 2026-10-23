import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorMessage } from "#core/errors.ts";
import { ensurePrivateDir } from "#config/file.ts";
import type { Logger } from "#core/logger.ts";

/**
 * 会话库的**连接层**：开库、运行期 pragma、schema 与版本升级。
 *
 * 与 `manager.ts` 分开是和 `core/provider/`（`store.ts` 落盘 + `registry.ts` 只存取）、
 * `core/tool/`（`store.ts` + `registry.ts`）同构：「连接与 schema 的生命周期」只有一条
 * 不变规则（往 `MIGRATIONS` 末尾追加），而「本领域怎么读写这些表」每条方法都有自己的语义。
 *
 * 刻意不叫 `store.ts` / `SessionStore`：本仓 `store` 这个词已经被 `ProviderConfigStore` 与
 * `ToolConfigStore` 占住，含义是「读写 `atri.config.json` 的配置存储」。再塞一个进去，
 * 「会话」的同词多义（登录令牌 vs 对话历史）就只是第一个撞上来的人。
 */

/** 库文件名，落在 `config.dataDir` 下。 */
export const SESSION_DB_NAME = "sessions.sqlite";

/**
 * 迁移脚本，按版本顺序。**以后改表时的三条规矩**（改任何一条都要连带改这里）：
 *
 * 1. 只往**末尾追加**，绝不修改已有条目 —— 改了就意味着别人机器上那个「已经执行过旧条目」
 *    的库永远不会执行新条目，而 `user_version` 已经跳过去了，症状是运行期某条 SQL 报
 *    `no such column`，离根因极远。
 * 2. 迁移必须**纯加性**（`ALTER TABLE ADD COLUMN` / 建新索引）。SQLite 的 `ADD COLUMN` 本身
 *    就要求新列可空或有默认值，这条约束是天然的；「一条事务里 DDL + 数据回填」在本仓
 *    还没有先例，真要动数据时再单独谈。
 * 3. 加一条迁移**不需要**同时改版本号：`SCHEMA_VERSION` 就是 `MIGRATIONS.length`（见下）。
 *    版本号以前是手写的，于是「追加了迁移但忘了 +1」会安静地不执行那条 DDL，
 *    而新代码期望的列不存在 —— 那正是本条要消灭的那类漂移。
 *
 * 条目里不用 `IF NOT EXISTS`：重复执行应当**立刻报错**，而不是静默跳过 —— 后者是
 * `CREATE TABLE IF NOT EXISTS` 一把梭最坏的地方（加列时它什么都不做，新代码期望的列不存在）。
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (
     seq        INTEGER PRIMARY KEY,
     id         TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;

   CREATE TABLE messages (
     seq          INTEGER PRIMARY KEY,
     id           TEXT NOT NULL UNIQUE,
     session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     role         TEXT NOT NULL,
     content      TEXT NOT NULL,
     tool_calls   TEXT,
     tool_call_id TEXT,
     created_at   TEXT NOT NULL
   ) STRICT;

   CREATE INDEX messages_by_session ON messages (session_id, seq);`,
  // 图片随消息落库（base64 JSON），因为平台侧 URL 会过期。旧库由这条加列迁移原地升级；
  // 纯文本消息该列为 NULL，不写 `[]`，与 `tool_calls` 的「没有这个键」保持一致。
  `ALTER TABLE messages ADD COLUMN images TEXT;`,
  // 内置记忆供应商的存储（core/memory/builtin.ts）。与消息同库不同表：
  // 记忆条目天然带 profile/session 坐标，单独开一个库只会复制一遍迁移与权限逻辑。
  // `keywords` 是写入时抽好的归一化词串（空格分隔），召回就是一次 LIKE 扫描 + JS 打分，
  // 不引 FTS5（node:sqlite 的编译特性随 Node 版本变，赌不起）也不引向量库。
  `CREATE TABLE memories (
     seq         INTEGER PRIMARY KEY,
     id          TEXT NOT NULL UNIQUE,
     profile_id  TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     kind        TEXT NOT NULL,
     content     TEXT NOT NULL,
     keywords    TEXT NOT NULL,
     source      TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     last_hit_at TEXT,
     hit_count   INTEGER NOT NULL DEFAULT 0
   ) STRICT;

   CREATE INDEX memories_by_profile ON memories (profile_id, seq);`,
];

/**
 * schema 版本 = 迁移条目数。**只增不改**：`MIGRATIONS[i]` 是把库从 v(i+1) 升到 v(i+2) 的 DDL。
 *
 * 派生而不是写死数字，是为了让「加了一条迁移却忘了改版本」这件事不可能发生：
 * 那种漏法不会报错，只会让新列静默缺席，等到某条 SQL 撞上 `no such column` 时
 * 离根因已经隔了一个启动。
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

export interface RawSessionRow {
  seq: number;
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface RawMessageRow {
  seq: number;
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  images: string | null;
  created_at: string;
}

export function sessionDbPath(dataDir: string): string {
  return join(dataDir, SESSION_DB_NAME);
}

/**
 * 打开（必要时创建）会话库，并把 schema 升到当前版本。
 *
 * 失败即抛，**不降级成「没有历史」**：理由与 `config/file.ts` 的 `readConfigFile` 完全同构 ——
 * 把坏库当成空库，下一次 `appendMessage` 就会在一个我们以为是空的库上写。
 */
export function openSessionDb(dataDir: string, logger?: Logger): DatabaseSync {
  const dbPath = sessionDbPath(dataDir);

  // `node:sqlite` 不创建父目录，否则目录不存在时得到一句 `ERR_SQLITE_CANTOPEN`，
  // 那比「数据目录不存在」难懂得多。
  //
  // 权限收到 0700，而且**必须落在目录上**：库文件自己 chmod 0600 挡不住 WAL 的两个边车 ——
  // `-wal` / `-shm` 由 SQLite 按 umask 创建，并在每次 checkpoint 后重建，逐文件收紧是一次性的
  // 假安全感；而 `synchronous = NORMAL` 下 checkpoint 是惰性的，也就是说**最新的、最敏感的
  // 那批对话内容**会以 0644 躺在磁盘上。目录 0700 之后文件自身的 mode 就无关紧要了
  // （别人连 stat 都做不到）。两道权限动作都在 `ensurePrivateDir` 里，它的注释写着
  // 为什么 `mkdir` 的 mode 单独不够。
  ensurePrivateDir(dataDir);

  let db: DatabaseSync;
  try {
    // busy timeout：默认是 0，即抢不到锁**立刻**报错。给 5 秒覆盖「同机另一个进程的一次性写」
    //（备份、人工查看）。这个数字是本仓自选的，没有上游依据 —— 与 `maxToolSteps` 同一种情况。
    db = new DatabaseSync(dbPath, { timeout: 5_000 });
  } catch (err) {
    throw new Error(
      `无法打开会话库 ${dbPath}：${errorMessage(err)}（可用 \`sqlite3 ${dbPath} .dump\` 尝试抢救，` +
        `或把该文件移走以新建一个库）`,
      { cause: err },
    );
  }

  try {
    // WAL：默认的 rollback journal 下读会阻写、写会阻读，而同一个库可能被第二个进程打开
    //（备份、人工查看）。代价只有 `-wal` / `-shm` 两个边车文件，以及关停时自动 checkpoint。
    // 进程内的串行不是靠它 —— `node:sqlite` 全同步、单连接，一次 appendMessage 是一段不可
    // 分割的 JS。
    db.exec("PRAGMA journal_mode = WAL");
    // WAL + NORMAL 是 SQLite 文档推荐的搭配：只有「掉电且 OS 一起挂」才可能丢最后一批已提交
    // 事务，进程崩溃不丢。这把每次追加消息的 fsync 摊掉，是本仓愿意付的交换。
    db.exec("PRAGMA synchronous = NORMAL");
    // 这里**不**下 `PRAGMA foreign_keys`：`node:sqlite` 从 v22.10 起默认开启外键约束
    //（`enableForeignKeyConstraints` 的默认值是 true），与 SQLite C 库的默认相反。
    // 重复设置无害，但会让下一个读的人以为我们自己也不确定。
    migrate(db);
  } catch (err) {
    // pragma 与 DDL 失败时库句柄必须关掉，否则文件一直被我方占着，用户连「移走文件重建」
    // 都做不干净。但**关掉自己的失败不能盖掉真正的原因**：`db.close()` 抛出来会让堆栈里
    // 只剩一条与故障无关的 SQLite 错，所以它单独吞。
    try {
      db.close();
    } catch {
      /* 已经有一句更要紧的错要往上抛了 */
    }
    // 包成中文是刻意的：这是本文件最后一处「原文直接往外走」的出口，而 pragma/DDL 的原文是
    // 英文、且带着库文件的绝对路径。它最终会落到启动日志与进程退出消息里，也可能被
    // `appendMessage` 的存储故障分支带进响应 —— 两种落点都不该出现 SQLite 的英文术语。
    throw new Error(
      `会话库初始化失败 ${dbPath}：${errorMessage(err)}` +
        `（可用 \`sqlite3 ${dbPath} ".integrity"\` 检查这个库）`,
      { cause: err },
    );
  }

  try {
    // 收紧库文件本身：主目录已经挡住了 `-wal` / `-shm` 两个边车（见上面那次 chmod），
    // 这一道是纵深防御，理由与配置文件同构 —— 那里是明文密钥，这里是**用户的对话内容**。
    // Windows 等不支持 POSIX 权限的环境忽略即可（照 `config/file.ts` 的先例）。
    chmodSync(dbPath, 0o600);
  } catch {
    /* 忽略 */
  }

  logger?.debug(`会话库已就绪 ${dbPath}（schema v${SCHEMA_VERSION}）`);
  return db;
}

/**
 * 按 `PRAGMA user_version` 补执行缺的迁移。
 *
 * 选它而不是建一张 `schema_migrations` 表：SQLite 内置了一个整数槽位，零依赖零新表，
 * 而我们要的只是「一个整数比大小」。也不用 `package.json` 的版本号 —— app 版本会因无关改动
 * bump，schema 版本必须只跟 DDL 走。
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `会话库的 schema 版本是 v${current}，比当前代码支持的 v${SCHEMA_VERSION} 更新；` +
        `请升级服务端，不要手工改库`,
    );
  }

  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v] as string);
      // `PRAGMA user_version = ?` 是语法错误（pragma 的值不是可绑定参数），只能拼串。
      // 这里拼得安全是因为 `v + 1` 由上面 for 的下标产生，不来自任何外部输入。
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      // 与 `SessionManager` 的 `#tx` 同一条理由：这条 DDL 失败时 SQLite 可能已经自己终止了
      // 事务，那句 `cannot rollback - no transaction is active` 会把真正的「哪条 DDL 为什么失败」
      // 顶掉 —— 而这是启动期唯一的一条线索。
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 原始错误才是要往上抛的那一个 */
      }
      throw new Error(`会话库升级失败（v${v} → v${v + 1}）: ${errorMessage(err)}`, { cause: err });
    }
  }
}
