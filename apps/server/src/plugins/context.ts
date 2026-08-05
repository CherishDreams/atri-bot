import type { Logger } from "../core/logger.ts";
import { errorMessage } from "../core/errors.ts";

/**
 * 传给插件上下文的配置：插件可见的运行期配置（`PluginRuntimeConfig` 那份白名单视图）
 * 与插件自己声明的 `config` 段合并后的结果，同名时插件的键优先。
 */
export type PluginContextConfig = Record<string, unknown>;

/** `effect()` 接受的两种副作用形状（其余一律抛错）。 */
export type Disposable = (() => void | Promise<void>) | { dispose: () => void | Promise<void> };

/** EventEmitter 风格的订阅对象。`on`/`off` 可选：有些实现只提供其中一个。 */
export interface Subscribable {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
}

export interface PluginContextDeps {
  id: string;
  logger: Logger;
  config: PluginContextConfig;
}

interface Registration {
  release: () => Promise<void>;
  label?: string;
}

/** 对象形状（插件是用户手写的 JS，这里只用来收窄，不做校验）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 插件运行时上下文。每个插件实例独享一个实例。
 *
 * 核心是 `effect()`：插件把副作用（定时器、事件订阅、socket…）交给框架登记，
 * 框架在实例卸载/重载时按注册的**逆序**自动释放。这样资源清理由机制保证，
 * 而不是靠插件作者手写 teardown 记得清干净。
 */
export class PluginContext {
  #disposables: Registration[] = [];
  #disposed = false;

  id: string;
  logger: Logger;
  config: PluginContextConfig;

  constructor({ id, logger, config }: PluginContextDeps) {
    this.id = id;
    this.logger = logger;
    this.config = config;
  }

  /** 是否已卸载。卸载后调用 effect 会直接报错，避免泄漏。 */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * 登记一个副作用。接受：
   *   - 一个函数：卸载时调用它（可返回 Promise）
   *   - 一个带 `.dispose()` 的对象：卸载时调用其 dispose()
   *   - 一个订阅：`{ on(type, fn), off(type, fn) }` + 事件名 + 处理器
   * 返回一个可手动提前释放的函数。
   *
   * 参数是 `unknown` 而不是 `Disposable`：插件是用户手写的 JS，编译器管不到它，
   * 「传错了要抛哪一句」由下面的运行时分派决定，而不是由类型系统提前替它决定。
   */
  effect(target: unknown, label?: string): () => Promise<void> | void {
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
  subscribe(
    emitter: Subscribable,
    event: string,
    handler: (...args: unknown[]) => void,
  ): () => Promise<void> | void {
    emitter.on?.(event, handler);
    return this.effect(() => emitter.off?.(event, handler), `subscribe:${event}`);
  }

  #toDisposer(target: unknown): () => Promise<void> {
    if (typeof target === "function") return async () => target();
    // 用局部变量承接一次：`typeof target.dispose === "function"` 的收窄在
    // `Record<string, unknown>` 上不会跨语句保留，换个名字判就能省掉断言。
    const dispose = isRecord(target) ? target.dispose : undefined;
    if (typeof dispose === "function") return async () => dispose();
    throw new Error("effect 需要传入函数或带 dispose() 的对象");
  }

  /** 逆序释放全部副作用。幂等，可安全重复调用。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { release, label } of this.#disposables.toReversed()) {
      try {
        await release();
      } catch (err) {
        this.logger.warn(
          `插件 ${this.id} 释放 effect 失败（${label ?? "匿名"}）: ${errorMessage(err)}`,
        );
      }
    }
    this.#disposables = [];
  }
}
