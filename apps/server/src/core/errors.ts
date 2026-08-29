/**
 * 把 `catch` 到的值转成人可读的消息。
 *
 * 写成函数而不是在每个模板串里各写一遍 `err instanceof Error ? err.message : String(err)`：
 * 那种三元迟早有一处漏掉 fallback，于是日志里出现 `[object Object]`，而原始错误彻底丢失。
 *
 * 参数刻意是 `unknown` 而不是 `Error` —— 第三方插件与上游厂商可能抛出任意值，
 * 标注成 `Error` 是一个运行时谎言（编译期不再强制处理，运行时照样炸）。
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 需要回给客户端一个明确 HTTP 状态码的错误。
 *
 * `options` 直通 `Error` 的 `ErrorOptions`，为的是让**包装**捕获到的错误时能带上 `cause`
 * （AGENTS.md：不带 cause 的话堆栈里就丢了原始错误，排查变成猜）。`Error` 的构造函数本身
 * 就读 `options.cause`，所以这里不需要自己做任何事。
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 错误 -> HTTP 状态码，全仓只有这一处规则。
 *
 * 存在的理由：状态码规则原先散在「provider 路由调 httpStatusForError、其余 handler 硬编码
 * 400、顶层兜底一律 500」三种写法上，后果是「客户端把 JSON 写坏了」这种明显的 400
 * 也回 500 并打一条带堆栈的 error 日志（7 个有请求体的端点各自漏包了 try/catch）。
 * 现在带 status 的错误自己说话，其余才落到 500。
 */
export function statusForError(err: unknown): number {
  return err instanceof ApiError ? err.status : 500;
}

/** 需要堆栈的场景（顶层请求兜底按 `stack ?? message` 记录）。 */
export function errorStack(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
