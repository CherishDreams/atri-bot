import { ProviderError, toNetworkError } from "./errors.ts";

/** provider 侧的标签，用来把错误说成「哪一个后端的哪一次调用」。 */
export interface TimeoutLabel {
  provider: string;
  model?: string;
}

/**
 * 一次调用的**总预算**超时。给非流式路径用（`chat`、`listModels`）。
 *
 * 用 `AbortSignal.any` 组合调用方的取消信号与超时信号：任何一方触发都能中断请求。
 * 这一步不能省 —— 上游挂起不返回时，请求会无限等待。
 *
 * 这条**不适用**于流式：`chatStream` 用 `idleTimeout()`，理由写在那里。
 * 以前两家 provider 各抄了一份本函数，所以「流式该用空闲超时」这个决定要改两处、
 * 还容易只改一处；收成一处之后，两种预算各自有名字。
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 流式调用的空闲超时句柄，由 `idleTimeout()` 产出。 */
export interface IdleTimeout {
  /** 已经与调用方的取消信号组合过，可直接作为 `fetch` 的 `signal`。 */
  signal: AbortSignal;
  /** 收到一段增量就续期一次。 */
  renew(): void;
  /** 摘掉定时器，**必须**放在 `finally` 里。 */
  dispose(): void;
  /** 是不是超时触发的那个出口（与「调用方主动取消」分开说不同的话）。 */
  expired(): boolean;
  /** 配置的空闲上限，只为了把数字原样说回错误里。 */
  readonly idleMs: number;
}

/**
 * 流式调用的**空闲**超时：连续 `idleMs` 没有任何一段增量才中断。
 *
 * 为什么不能沿用总预算：一次生成长度是模型的属性，不是我们的属性。以前流式也吃
 * `AbortSignal.timeout(timeoutMs)`（默认 120s，见 `store.ts` 的 `DEFAULT_TIMEOUT_MS`），
 * 于是一段超过 120s 的长回复会在流中途被掐死；而引擎是「`chatStream` 返回之后才落库
 * 助手那条」（`core/agent/engine.ts` 的 `#record` 排在它后面），结果用户那句已经持久化、
 * 模型这一整段全丢，前端只收到一个 error 帧 —— 一次成功的生成被记成一次故障。
 * 空闲判据留下「上游确实在往前推」的长回复，掐掉的只是「再也不出字」的连接。
 *
 * `dispose()` 不是收尾的礼貌：那个 `setTimeout` 句柄会吊住事件循环，
 * 而本仓的判据是「一个文件里的桩上游都要关掉，否则 node:test 不会退出」。
 */
export function idleTimeout(idleMs: number, external?: AbortSignal): IdleTimeout {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didExpire = false;

  const arm = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      didExpire = true;
      controller.abort(new Error(`上游连续 ${idleMs}ms 没有增量输出`));
    }, idleMs);
  };
  arm();

  return {
    signal: external ? AbortSignal.any([external, controller.signal]) : controller.signal,
    renew() {
      if (timer !== undefined) clearTimeout(timer);
      // 已经中断就别再续期：那会让一个已经死掉的流继续吊着事件循环。
      if (!controller.signal.aborted) arm();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    expired: () => didExpire,
    idleMs,
  };
}

/**
 * 流式路径的错误出口：空闲超时说人话，其余按原有规则归一。
 *
 * 三条分支的次序是刻意的：
 * 1. 已经是 `ProviderError` 的原样返回 —— 循环体里「200 流里带的 error」「没有响应体」
 *    那些分支已经把上游原文收进了 `detail`，再走一次 `toNetworkError` 会把它压成
 *    「无法连接上游」，用户就再也看不到上游到底说了什么。
 * 2. 空闲超时单独一句：它不是取消，也不是连不上，而是上游出字出到一半停了。
 * 3. 其余（含调用方取消、真网络失败）交给 `toNetworkError`，它已经把 `AbortError`
 *    翻成「请求已被取消」。
 */
export function wrapStreamError(err: unknown, idle: IdleTimeout, label: TimeoutLabel): unknown {
  if (err instanceof ProviderError) return err;
  if (!idle.expired()) return toNetworkError(err, label);

  const suffix = label.model ? `（模型 ${label.model}）` : "";
  return new ProviderError(
    `provider「${label.provider}」流式响应连续 ${idle.idleMs}ms 没有增量输出，已中断${suffix}。` +
      `这通常是对话过长或上游在排队；要放宽的是这一家 provider 的 timeoutMs，不是全局设置`,
    { provider: label.provider, cause: err },
  );
}
