import type { ServerFrame } from "@atri/shared";

/**
 * 出站事件的共享总线。
 *
 * ## 为什么不留在引擎里
 *
 * 引擎原来自己持 `listeners` 并由 `subscribe()` 暴露，`api/server.ts` 订阅一次把帧
 * 转成 WebSocket 广播。多配置档之后那是 **N 个引擎**：要么 N 次订阅（同一个 WebSocket
 * 客户端会收到 N 份重复帧），要么在删配置档时忘记退订（监听器泄在已卸载的对象图上，
 * 而那些对象还持有会话句柄）。两种都比原来更难查。
 *
 * 所以总线与锁一样由组合根构造、注入给每个引擎；HTTP 层只订阅一次，`close()` 退订一次。
 *
 * 方向上合法：`api/ → core/` 是既有的外向依赖（与 `auth.onSessionLost` 同一条），
 * `core/` 不知道订阅者是谁，更不 import `api/`。
 */
export class SessionEvents {
  #listeners = new Set<(frame: ServerFrame) => void>();

  /**
   * 订阅。**同一个函数只能登记一次**：`Set` 让重复订阅成为空操作，
   * 而这正是「同一个 handler 被两个配置档各接一次、于是每条消息广播两遍」的防线。
   *
   * @returns 退订函数，返回是否真的退掉了一个订阅（照 `AuthManager.onSessionLost` 的形状）
   */
  subscribe(fn: (frame: ServerFrame) => void): () => boolean {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * 把一帧发给此刻的每个订阅者。
   *
   * 同步、且**不 isolate 订阅者的异常**：一个 handler 抛错会打断这一轮广播。
   * 这不是漏掉 try/catch —— 唯一的订阅者是 WebSocket 广播，它抛错意味着传输层坏了，
   * 让那句错留在引擎的堆栈里比咽下去更容易查。（要改成逐个 try/catch 的话，
   * 就得同时决定「吞掉之后告警几次」，那是有真实需求时才值得做的判断。）
   */
  emit(frame: ServerFrame): void {
    for (const fn of this.#listeners) fn(frame);
  }

  /**
   * 此刻的订阅者数量。存在的理由是关停断言：`app.stop()` 之后必须是 0。
   *
   * 一个泄漏的订阅者在功能测试里完全隐形（没有 WebSocket 连着就什么都不发），
   * 所以这条计数是它唯一会被看见的时刻。
   */
  get listenerCount(): number {
    return this.#listeners.size;
  }
}
