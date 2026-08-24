import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorMessage } from "#core/errors.ts";
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

/** schema 版本。**只增不改**：`MIGRATIONS[i]` 是把库从 v(i+1) 升到 v(i+2) 的 DDL。 */
export const SCHEMA_VERSION = 1;

/**
 * 迁移脚本，按版本顺序。**以后改表时的三条规矩**（改任何一条都要连带改这里）：
 *
 * 1. 只往**末尾追加**，绝不修改已有条目 —— 改了就意味着别人机器上那个「已经执行过旧条目」
 *    的库永远不会执行新条目，而 `user_version` 已经跳过去了，症状是运行期某条 SQL 报
 *    `no such column`，离根因极远。
 * 2. 追加的同时把 `SCHEMA_VERSION` 加 1。
 * 3. 迁移必须**纯加性**（`ALTER TABLE ADD COLUMN` / 建新索引）。SQLite 的 `ADD COLUMN` 本身
 *    就要求新列可空或有默认值，这条约束是天然的；「一条事务里 DDL + 数据回填」在本仓
 *    还没有先例，真要动数据时再单独谈。
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
];

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
  mkdirSync(dataDir, { recursive: true });

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
    // 都做不干净。
    db.close();
    throw err;
  }

  try {
    // 收紧权限：配置文件是明文密钥，会话库是**用户的对话内容**，理由不同但结论一样。
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
      db.exec("ROLLBACK");
      throw new Error(`会话库升级失败（v${v} → v${v + 1}）: ${errorMessage(err)}`, { cause: err });
    }
  }
}
