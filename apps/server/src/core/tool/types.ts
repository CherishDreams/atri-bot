/**
 * 工具的对外形状。这一层只有类型，零依赖 ——
 * 注册表据此存取，provider 层据此搬运，具体实现据此写自己。
 */

/**
 * 交给上游的 JSON Schema（工具参数）。
 *
 * **本仓不校验它**：没有 ajv，也不该为了把一个对象原样搬给模型而引入运行时依赖。
 * 模型给的参数只在 `ToolRegistry.run()` 里做 `JSON.parse`，逐键检查写在
 * 每个工具自己的 `run()` 里 —— 与 `api/http.ts` 的 `readJson()` 返回
 * `Record<string, unknown>`（让 per-field `typeof` 成为编译期要求）是同一取向。
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** 工具执行时框架交给它的取消信号。插件工具应当把它继续传给自己的网络请求。 */
export interface ToolRunOptions {
  signal?: AbortSignal;
}

/**
 * 一颗工具。契约是「模型请求、本地执行、结果回喂」的**每调用一次性**：
 * 既不是 adapter 的长驻 `start()`/`stop()`，也不是 provider 的每请求 `chat()`，
 * 所以这三个词不要混用。
 */
export interface ToolDefinition {
  /** 线协议里的 name 就是它（OpenAI 的 `function.name`、Anthropic 的 `name`），必须稳定、可拼写。 */
  id: string;
  /** 只给控制台看的中文名；缺省时用 id。给模型看的名字始终是 `id`。 */
  name?: string;
  /** 给模型看的说明。这句话决定模型会不会调它，是工具最重要的对外文本。 */
  description: string;
  parameters: JsonSchema;
  /**
   * 内部工具：始终交给模型，但**不进入用户的工具开关列表**。
   *
   * 系统内省（插件列表等）由内置插件提供，用户不需要理解也不该关掉它；
   * 它仍然是一颗正常的工具调用，只是 `GET /tools` 与配置页不展示。
   */
  internal?: boolean;
  /**
   * 单次执行上限（毫秒）。缺省由 `ToolRegistry` 给一个保守值；插件可以在自己的
   * `index.js` 里声明。超时后框架会放弃等待并把结果作为 `isError` 回喂模型，
   * 但**无法强行终止**不遵守 signal 的代码，所以工具实现仍应使用传入的 signal。
   */
  timeoutMs?: number;
  /**
   * 返回**回喂给模型的文本**，不是对象：两家上游都把工具结果当字符串内容处理。
   * 抛错由注册表兜成 `isError` 结果（那是模型的一次可纠正回合），不会把整轮变成 500。
   *
   * `options.signal` 在客户端断开或整轮超时/取消时会触发；不遵守它也不会让会话锁
   * 永远占住（注册表会竞速并放弃等待），但工具自己的网络请求会继续跑到自然结束。
   */
  run(args: Record<string, unknown>, options?: ToolRunOptions): Promise<string>;
}
