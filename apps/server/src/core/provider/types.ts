import type { Role, ToolCall } from "@atri/shared";
import type { JsonSchema } from "../tool/types.ts";

/**
 * 引擎与厂商之间「一轮对话」的单元。
 *
 * 不复用 `@atri/shared` 的 `Message`：那个是**已落库的消息**，带 `id`/`sessionId`/`createdAt`，
 * 而发给上游的历史只需要其中几个字段。
 *
 * `toolCallId` 与 `tool_call_id` 并存是既有的：OpenAI 兼容线协议用 snake_case，
 * 而仓内 `shared.Message` 用 camelCase，`anthropic.ts` 两个都会读到。
 * 把其中一个「修正」掉是行为变更，迁移不动它。
 */
export interface ChatMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  tool_call_id?: string;
  /** 助手消息要求调用工具时带上；`role === "tool"` 的那条用 `toolCallId` 配回这里。 */
  toolCalls?: ToolCall[];
}

/**
 * 一次补全的返回。`role` 刻意可选：注册表与引擎**从不读它**
 * （引擎自己写 `role: "assistant"` 落库），而各家上游的返回里它可有可无。
 *
 * `stopReason` 只用于诊断与日志，**不是循环的终止条件**：OpenAI 兼容网关在
 * `finish_reason` / `stop_reason` 上的一致性太差（本文件已经在处理「网关把 error
 * 塞进 200 流」这种情况），而「有没有 toolCalls」是我们自己能数的事实。
 */
export interface ChatReply {
  role?: Role;
  content: string;
  /** 模型要求执行的调用。非空即表示这一轮还没说完，需要回喂结果再问一次。 */
  toolCalls?: ToolCall[];
  stopReason?: string;
}

export type ProviderType = "openai" | "anthropic";

/** 交给厂商的中立工具描述；各家再映射成自己的线协议形状。 */
export interface ChatTool {
  /** 线协议里的函数名，取自 `ToolDefinition.id`。 */
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  /**
   * 本轮可用的工具。**空数组与 undefined 都等于不发这个键**：
   * 默认关闭的工具不该在报文里留下任何痕迹，这样「启用前后逐字节相同」才可被断言。
   */
  tools?: ChatTool[];
  signal?: AbortSignal;
}

export interface ChatStreamOptions extends ChatOptions {
  onDelta?: (delta: string) => void;
}

export interface ListModelsOptions {
  signal?: AbortSignal;
}

/**
 * `ProviderRegistry` 认识的最小实例表面。
 *
 * `chat` 与 `models` 是**必填**：这样注册表与 factory 内部的
 * `provider.chat(...)` / `provider.models.length` 都不需要守卫，迁移也就不必
 * 新增任何运行时分支。只用来验证选路/列表的测试桩因此要带上这两个字段，
 * 见 `test/provider.test.ts`。
 */
export interface ProviderImpl {
  id: string;
  name?: string;
  models: string[];
  type?: string;
  chat(options: ChatOptions): Promise<ChatReply>;
  chatStream?(options: ChatStreamOptions): Promise<ChatReply>;
  listModels?(options?: ListModelsOptions): Promise<string[]>;
}

/**
 * provider 实现类的构造选项。
 *
 * factory 把「源 + 实例」合并后的**整个配置段**透传进来，实现类只认领自己认识的键
 * （`headers`、Anthropic 的 `version` / `maxTokens` 就散落在各自的类里）。
 * 因此新增厂商不需要改 factory。两层结构的关键字段（`id`/`type`/`baseUrl`/
 * `timeoutMs`/`model`）已在 `ProviderConfigStore` 写入时校验过。
 */
export interface ProviderOptions {
  id?: string;
  name?: string;
  models?: string[];
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Anthropic 私有：`anthropic-version` 请求头。声明在这里是为了让构造器能认领它。 */
  version?: string;
  /** Anthropic 私有：必填的 `max_tokens` 取值。 */
  maxTokens?: number;
  [key: string]: unknown;
}

/** 实现类构造器。factory 的 `TYPES` 表按这个形状收。 */
export type ProviderConstructor = new (options?: ProviderOptions) => ProviderImpl;

/**
 * OpenAI 兼容接口的响应里我们认领的键。
 *
 * 列到 function calling 为止：`usage`、`logprobs`、`system_fingerprint` 等仍然不认领。
 * `finish_reason` 现在认领了，但只作诊断用（理由见 `ChatReply.stopReason`）。
 */
export interface OpenAIChatPayload {
  choices?: {
    delta?: { content?: string; tool_calls?: OpenAIToolCallFragment[] };
    message?: { content?: string; tool_calls?: OpenAIToolCallValue[] };
    finish_reason?: string | null;
  }[];
  /** 有的网关把错误塞进 200 的流里，所以流式帧也要认这个键。 */
  error?: { message?: string };
}

/**
 * 流式里的一次工具调用增量。
 *
 * `index` 是**归属键**：一次响应可以并行要求调多个工具，每个的 `arguments` 会被拆成
 * 任意多片，片与片靠 `index` 归位，而 `id`/`name` 只在首片出现 —— 所以累加的是
 * `arguments`，覆盖的是 `id`/`name`。
 */
export interface OpenAIToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** 非流式里的一次完整工具调用。 */
export interface OpenAIToolCallValue {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** `GET /models` 的响应：`{data: [{id}, ...]}`，其余字段不认领。 */
export interface OpenAIModelsPayload {
  data?: unknown;
}

/**
 * Anthropic 的响应：文本在 `content[]` 的 `type === "text"` 块里，
 * 工具调用在同数组的 `type === "tool_use"` 块里（`input` 已是对象，不像 OpenAI 那样是串）。
 */
export interface AnthropicChatPayload {
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  stop_reason?: string | null;
  error?: { message?: string };
}

/**
 * Anthropic 流式帧。
 *
 * 三种帧各自填不同字段：`content_block_start` 带 `index` + `content_block`（`tool_use`
 * 的 id/name 在这里给全），`content_block_delta` 带 `delta.type`（`text_delta` 给
 * `text`、`input_json_delta` 给 `partial_json`），`message_delta` 带 `stop_reason`。
 * 因此 `delta.type` **必须**先看一眼再决定怎么用 `delta.text` ——
 * 漏了这一步，工具参数的 JSON 碎片会被当成正文推给前端。
 */
export interface AnthropicStreamPayload {
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  /** `message_delta` 帧把 `stop_reason` 放在 delta 里，与文本增量共用同一个对象。 */
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  error?: { message?: string };
}
