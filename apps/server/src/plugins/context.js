/**
 * 插件运行时上下文。每个插件实例独享一个实例。
 *
 * 核心是 `effect()`：插件把副作用（定时器、事件订阅、socket…）交给框架登记，
 * 框架在实例卸载/重载时按注册的**逆序**自动释放。这样资源清理由机制保证，
 * 而不是靠插件作者手写 teardown 记得清干净。
 */
export class PluginContext {
  #disposables = [];
  #disposed = false;

  constructor({ id, logger, config }) {
    this.id = id;
    this.logger = logger;
    this.config = config;
  }

  /** 是否已卸载。卸载后调用 effect 会直接报错，避免泄漏。 */
  get disposed() {
    return this.#disposed;
  }

  /**
   * 登记一个副作用。接受：
   *   - 一个函数：卸载时调用它（可返回 Promise）
   *   - 一个带 `.dispose()` 的对象：卸载时调用其 dispose()
   *   - 一个订阅：`{ on(type, fn), off(type, fn) }` + 事件名 + 处理器
   * 返回一个可手动提前释放的函数。
   */
  effect(target, label) {
    if (this.#disposed) {
      throw new Error(`插件 ${this.id} 已卸载，不能再登记 effect`);
    }
    const release = this.#toDisposer(target);
    this.#disposables.push({ release, label });

    let done = false;
    return () => {
      if (done) return;
      done = true;
      const idx = this.#disposables.findIndex((d) => d.release === release);
      if (idx >= 0) this.#disposables.splice(idx, 1);
      return release();
    };
  }

  /** 订阅一个 EventEmitter 风格的对象，卸载时自动退订。 */
  subscribe(emitter, event, handler) {
    emitter.on?.(event, handler);
    return this.effect(() => emitter.off?.(event, handler), `subscribe:${event}`);
  }

  #toDisposer(target) {
    if (typeof target === "function") return async () => target();
    if (target && typeof target.dispose === "function") {
      return async () => target.dispose();
    }
    throw new Error("effect 需要传入函数或带 dispose() 的对象");
  }

  /** 逆序释放全部副作用。幂等，可安全重复调用。 */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { release, label } of this.#disposables.toReversed()) {
      try {
        await release();
      } catch (err) {
        this.logger.warn(`插件 ${this.id} 释放 effect 失败（${label ?? "匿名"}）: ${err.message}`);
      }
    }
    this.#disposables = [];
  }
}
