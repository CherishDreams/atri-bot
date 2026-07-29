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

/** 需要堆栈的场景（顶层请求兜底按 `stack ?? message` 记录）。 */
export function errorStack(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
