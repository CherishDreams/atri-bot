/**
 * 适配器通用常量。
 *
 * 这些值同时约束 HTTP 入口与插件入口；散落在两处会让「界面能发、插件不能发」
 * 或者反过来。action 名本身不在这里枚举 —— 它由平台决定，OneBot 11 的扩展动作
 * 随实现版本变化，框架不维护一份永远追不上的白名单。
 */
export const ADAPTER_ACTION_LIMITS = {
  /** OneBot action 名上限；正常实现远小于这个值，限制只用于挡住畸形输入。 */
  maxNameLength: 128,
  /** 参数 JSON 的字符上限。Media / 群列表之外的普通动作够用，也避免一次请求拖垮日志或内存。 */
  maxParamsChars: 64 * 1024,
  /** 回给界面/插件的错误文本上限；上游可能返回很长的 HTML 或堆栈。 */
  maxErrorChars: 500,
} as const;
