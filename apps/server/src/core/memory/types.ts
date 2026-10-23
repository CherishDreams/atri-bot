/**
 * 记忆模块的类型层。
 *
 * 抽象的判据来自需求本身：「内置方案还是插件方案，从配置文件里选」。所以这里的
 * 接口是**供应商协议**（参照 private_companion 的 external-memory-provider）：
 * 宿主只约定「什么时候问你要什么、什么时候让你写什么」，检索方式（关键词、向量、
 * 图谱……）完全是 provider 自己的事。
 *
 * 两条协议纪律（与 companion 的 P6 契约同一条）：
 * - **一次请求只选一个 provider**，失败不降级到另一个 —— 静默换方案的症状是
 *   「记忆忽好忽坏而配置没有任何变化」，那比没有记忆更难排查。
 * - **write 失败返回 false、宿主不重试**：重试会放大第三方存储的故障，
 *   且「哪次真的写进去了」会变成不可知状态。
 */

/** 记忆条目的三类。kind 由宿主在写入时给定，provider 自决是否区分对待。 */
export type MemoryKind = "interaction" | "fact" | "diary";

/** 召回请求。`query` 是本轮的用户输入原样；provider 自己决定怎么切词、怎么打分。 */
export interface MemoryQuery {
  profileId: string;
  sessionId: string;
  query: string;
  limit: number;
}

/** 召回结果的一条。`id`/`occurredAt`/`kind` 都是可选的：协议只强约束 content。 */
export interface MemoryItem {
  id?: string;
  content: string;
  kind?: MemoryKind;
  /** ISO 时间；provider 能给出「这是什么时候的事」就给。 */
  occurredAt?: string;
}

/** 写入请求。`source` 标记写入通道（interaction=引擎自动、tool=模型、diary=日记任务）。 */
export interface MemoryWrite {
  profileId: string;
  sessionId: string;
  kind: MemoryKind;
  content: string;
  source: string;
}

/** 一个记忆供应商。`id` 是配置文件里 `memory.provider` 指向的那个名字，必须稳定。 */
export interface MemoryProvider {
  id: string;
  /** 一句话说明检索方式，配置页与诊断日志用。 */
  description?: string;
  recall(query: MemoryQuery): Promise<MemoryItem[]>;
  /** 返回 false 表示没写进去（宿主不重试，只记 warn）。 */
  write(record: MemoryWrite): Promise<boolean>;
}
