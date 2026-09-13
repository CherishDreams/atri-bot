/**
 * 「这个会话有一次对话还没结束」的对外文案。
 *
 * 导出的理由：两个出口要说同一句话 —— 非流式端点拿到的是 `handleMessage` 抛出的 409，
 * 流式端点拿到的是 `api/server.ts` 在开流前的预检。同一个意思两种写法迟早走散，
 * 所以句子只留一份。它随着锁搬到同一个文件里：句子描述的正是这把锁的状态。
 */
export const SESSION_BUSY_MESSAGE = "这个会话有一次对话还没结束，请等它完成后再发下一条";

/**
 * 跨配置档共享的会话锁：`sessionId -> 持有它的配置档 id`。
 *
 * ## 为什么它必须存在、而且必须在每个配置档之外
 *
 * 挡的是「一轮对话的读-改-写」被另一个请求插队：`handleMessage` 先读全量历史、
 * 再 await 上游几十秒、然后逐步 append。同会话两个请求各自拿到的快照都不含对方，
 * 交错落库后会出现「A 的助手消息与它的工具结果之间插进 B 的消息」那种历史 ——
 * 而 `AgentEngine.#historyFor` 的配对修复会把那半截 `toolCalls` **降级成正文**，
 * 于是坏掉的历史不但存下来了，还会被当成正常历史喂给下一次请求。静默写坏历史
 * 是本仓最贵的一类错。
 *
 * 这条理由决定了它**不能属于任何一个引擎**：多配置档之后有 N 个 `AgentEngine`，
 * 每个各持一份 `Set` 的话，「配置档 A 与 B 同时写同一个会话」就没人挡了。
 * 所以它由组合根构造、注入给每个引擎。
 *
 * 三条边界要说清：
 * - 这是**进程内**的 Map，多进程各自有各自的（与「一个数据目录只跑一个实例」一致，
 *   见 README 的生产部署一节）。
 * - 锁加在这一层而不是存储层：SQLite 只能给「两条 INSERT 串行」，而缺的是「一整轮的
 *   读-改-写串行」；放存储层还会迫使 `appendMessage` 变 async，波及引擎与六个 handler。
 *   （`docs/architecture.md` 里那条「存储不该知道轮次」的拒绝理由仍然成立 ——
 *   放在 `core/session/` 只是**位置**，不是归属：它管的是「一轮对话」，不是「一行数据」。）
 * - 释放写在 `finally`，所以**上游报错与客户端断开都不会把会话永久锁死**。
 *
 * 刻意保留 `tryEnter` / `release` 这一对，而不是提供 `runExclusive(fn)`：
 * 后者会把「忘记释放」变成不可能，但也会把 `handleMessage` 里那条
 * **忘记释放 = 该会话从此每次 409** 的纪律从视野里抹掉。本仓选择让纪律可见。
 */
export class SessionLock {
  #holder = new Map<string, string>();

  /**
   * 占用这个会话。已被占着时返回 `false`，**且不改动现有的持有者**。
   *
   * @param profileId 谁在占 —— `isInUse` 要用它回答「这个配置档现在还能不能删」。
   */
  tryEnter(sessionId: string, profileId: string): boolean {
    if (this.#holder.has(sessionId)) return false;
    this.#holder.set(sessionId, profileId);
    return true;
  }

  /**
   * 释放。
   *
   * 不检查持有者是不是自己：今天唯一的调用点在 `finally` 里，与 `tryEnter` 严格配平。
   * 如果将来出现「一个持有者能释放别人的锁」的真实需求，那时再把 profileId 传进来判，
   * 而不是现在为假想的误用加一层校验（那会掩盖真正的漏释放）。
   */
  release(sessionId: string): void {
    this.#holder.delete(sessionId);
  }

  /** 这个会话此刻有没有一轮对话在跑。 */
  has(sessionId: string): boolean {
    return this.#holder.has(sessionId);
  }

  /** 这个配置档此刻有没有占着任何一个会话。 */
  isInUse(profileId: string): boolean {
    for (const holder of this.#holder.values()) {
      if (holder === profileId) return true;
    }
    return false;
  }
}
