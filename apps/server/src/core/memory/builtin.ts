/**
 * 内置记忆供应商：关键词 + 时间衰减打分，存储在会话库（`sessions.sqlite`）的
 * `memories` 表里（迁移见 `core/session/db.ts`）。
 *
 * 刻意不做的事，各有一条理由：
 * - **不做向量召回**：embedding 要一个外部 API 依赖与一份密钥，而内置方案的全部
 *   价值是「零配置开箱可用、确定性可控」。要向量检索就换一个插件 provider ——
 *   那正是 `memory.provider` 配置存在的意义。
 * - **不建 FTS5 索引**：node:sqlite 是否带 FTS5 随 Node 的编译选项变，赌不起；
 *   LIKE 预筛 + JS 打分在每档五千条的保留上限内是同步、可预算的。
 * - **不自动做 LLM 摘要**：每轮一次模型调用是用户真金白银的账单，走 `autoRecord`
 *   存原文（截断），精炼留给模型主动的 `memory_write` 与日记任务（Phase 5c）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openSessionDb } from "#core/session/db.ts";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";
import type { MemoryItem, MemoryProvider, MemoryQuery, MemoryWrite } from "./types.ts";

/** 单条记忆正文的上限（字符）。再长就该由模型/日记先提炼成要点。 */
export const MAX_MEMORY_CONTENT_CHARS = 4_000;
/** 每个配置档保留的记忆条数上限；超出按写入时间 FIFO 淘汰。本仓自选值。 */
export const MAX_PROFILE_MEMORIES = 5_000;
interface MemoryRow {
  seq: number;
  id: string;
  kind: string;
  content: string;
  keywords: string;
  created_at: string;
  last_hit_at: string | null;
  hit_count: number;
}

/**
 * 抽取召回用的关键词：CJK 字符按二元组（bigram），ASCII 段按 ≥2 字符的整词。
 *
 * 中文没有现成分词器，二元组是零依赖下检索召回率的最低保障 ——「生日」能被
 * 「今天是我生日」的 `生日` 命中。其余字符一律当**分隔符**而不是删除：删掉会让
 * `2026-01-01` 粘成 `20260101`，检索「2026」就再也命中不了它。词数封顶 64：
 * 一段四千字的原文能抽出上千个 bigram，而打分只要「有没有命中」。
 */
export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  let ascii = "";
  let prevCjk: string | undefined;
  const flushAscii = (): void => {
    if (ascii.length >= 2) seen.add(ascii);
    ascii = "";
  };
  for (const raw of text.toLowerCase()) {
    if (/[a-z0-9]/.test(raw)) {
      ascii += raw;
      prevCjk = undefined;
      continue;
    }
    const code = raw.codePointAt(0) ?? 0;
    // 粗判 CJK（> U+2E7F 覆盖 CJK 部首扩展与常用区）：这类文字走单字 + bigram，
    // 拉丁等字母文字走整词。bigram 用局部变量记前一个 CJK 字符即可，无需共享状态。
    if (code > 0x2e7f) {
      flushAscii();
      seen.add(raw);
      if (prevCjk !== undefined) seen.add(prevCjk + raw);
      prevCjk = raw;
      continue;
    }
    // 其余（标点、空白、其它符号）是分隔符：结束当前词与当前 bigram 链。
    flushAscii();
    prevCjk = undefined;
  }
  flushAscii();
  return [...seen].slice(0, 64);
}

export class BuiltinMemoryProvider implements MemoryProvider {
  readonly id = "builtin";
  readonly description = "关键词命中 + 时间衰减打分，存在本地会话库里";

  readonly #logger: Logger;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #maxPerProfile: number;

  constructor({
    dataDir,
    logger,
    now = () => new Date(),
    maxPerProfile = MAX_PROFILE_MEMORIES,
  }: {
    dataDir: string;
    logger: Logger;
    /** 测试注入假时钟；生产用系统时间。 */
    now?: () => Date;
    /** 保留上限（测试注入小值以验证淘汰）；生产用常量。 */
    maxPerProfile?: number;
  }) {
    this.#logger = logger;
    this.#now = now;
    this.#maxPerProfile = maxPerProfile;
    // 与 SessionManager 各开一条连接，同一份库文件。WAL + 5s busy timeout 下
    // 两条连接的短事务互不阻塞；两侧都是同步短查询，不会出现长读持锁。
    this.#db = openSessionDb(dataDir, logger);
  }

  /** 关停时由组合根调用：先于（或后于）会话库自己的 close 都安全，SQLite 按连接计数。 */
  close(): void {
    try {
      this.#db.close();
    } catch {
      /* 关停竞态下可能已被关闭 */
    }
  }

  async recall(query: MemoryQuery): Promise<MemoryItem[]> {
    const queryKeywords = extractKeywords(query.query);
    if (queryKeywords.length === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT seq, id, kind, content, keywords, created_at, last_hit_at, hit_count
           FROM memories WHERE profile_id = ? ORDER BY seq DESC`,
      )
      .all(query.profileId) as unknown as MemoryRow[];
    const wanted = new Set(queryKeywords);
    const now = this.#now().getTime();
    type Scored = { row: MemoryRow; score: number };
    const scored: Scored[] = [];
    for (const row of rows) {
      const owned = new Set(row.keywords.split(" ").filter(Boolean));
      let hits = 0;
      for (const kw of wanted) if (owned.has(kw)) hits += 1;
      if (hits === 0) continue;
      const ageDays = Math.max(0, (now - Date.parse(row.created_at)) / 86_400_000);
      // 命中数是主分；新近度按 30 天半衰期折算成增益，常被召回的老记忆再吃一点加成
      //（它反复被证明「有用」）。权重是本仓自选的，没有上游依据。
      const recency = 1 / (1 + ageDays / 30);
      const boost = Math.min(row.hit_count, 5) * 0.1;
      scored.push({ row, score: hits * (1 + recency) + boost });
    }
    scored.sort((a, b) => b.score - a.score || b.row.seq - a.row.seq);
    const top = scored.slice(0, query.limit);

    if (top.length > 0) {
      // 命中即奖励：更新命中时间与计数，让「反复有用的记忆」在下一轮排得更靠前。
      // 逐条 UPDATE 而不是一条 CASE：条目数 ≤ limit，且都在一个隐式事务外也无妨
      //（失败只影响排序增益，不影响本轮结果）。
      const stamp = this.#now().toISOString();
      const touch = this.#db.prepare(
        "UPDATE memories SET last_hit_at = ?, hit_count = hit_count + 1 WHERE seq = ?",
      );
      for (const { row } of top) {
        try {
          touch.run(stamp, row.seq);
        } catch (err) {
          this.#logger.warn(`更新记忆命中计数失败: ${errorMessage(err)}`);
          break;
        }
      }
    }

    return top.map(({ row }) => ({
      id: row.id,
      content: row.content,
      kind: row.kind as MemoryItem["kind"],
      occurredAt: row.created_at,
    }));
  }

  async write(record: MemoryWrite): Promise<boolean> {
    const content = record.content.trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
    if (content === "") return false;
    const keywords = extractKeywords(content).join(" ");
    if (keywords === "") return false;
    const now = this.#now().toISOString();
    try {
      this.#db
        .prepare(
          `INSERT INTO memories (id, profile_id, session_id, kind, content, keywords, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          record.profileId,
          record.sessionId,
          record.kind,
          content,
          keywords,
          record.source,
          now,
        );
    } catch (err) {
      this.#logger.error(`写入记忆失败: ${errorMessage(err)}`);
      return false;
    }
    this.#trim(record.profileId);
    return true;
  }

  async readRecent(query: {
    profileId: string;
    since: string;
    kinds?: MemoryItem["kind"][];
    limit: number;
  }): Promise<MemoryItem[]> {
    // kind 过滤在 JS 里做：条目数有保留上限兜底，SQLite 端少一个 IN 动态拼接。
    const rows = this.#db
      .prepare(
        `SELECT seq, id, kind, content, created_at FROM memories
          WHERE profile_id = ? AND created_at >= ? ORDER BY seq DESC`,
      )
      .all(query.profileId, query.since) as unknown as MemoryRow[];
    const wanted = query.kinds === undefined ? null : new Set(query.kinds);
    return rows
      .filter((row) => wanted === null || wanted.has(row.kind as MemoryItem["kind"]))
      .slice(0, query.limit)
      .map((row) => ({
        id: row.id,
        content: row.content,
        kind: row.kind as MemoryItem["kind"],
        occurredAt: row.created_at,
      }));
  }

  /** FIFO 淘汰到保留上限。失败只记日志：多留几条旧记忆无害。 */
  #trim(profileId: string): void {
    try {
      this.#db
        .prepare(
          `DELETE FROM memories WHERE profile_id = ? AND seq NOT IN (
             SELECT seq FROM memories WHERE profile_id = ? ORDER BY seq DESC LIMIT ?
           )`,
        )
        .run(profileId, profileId, this.#maxPerProfile);
    } catch (err) {
      this.#logger.warn(`清理超额记忆失败: ${errorMessage(err)}`);
    }
  }
}
