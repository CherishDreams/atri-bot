import type { Role } from "@atri/shared";

/**
 * 引擎与厂商之间「一轮对话」的单元。
 *
 * 不复用 `@atri/shared` 的 `Message`：那个是**已落库的消息**，带 `id`/`sessionId`/`createdAt`，
 * 而发给上游的历史只需要其中三个字段。
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
}

/**
 * 一次补全的返回。`role` 刻意可选：注册表与引擎**从不读它**
 * （引擎自己写 `role: "assistant"` 落库），而各家上游的返回里它可有可无。
 */
export interface ChatReply {
  role?: Role;
  content: string;
}

export type ProviderType = "openai" | "anthropic";

export interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
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
 * OpenAI 兼容接口的响应里我们认领的键（非流式取 `message.content`，流式取 `delta.content`）。
 * 上游还有 `usage`/`finish_reason` 等一堆字段，刻意不列。
 */
export interface OpenAIChatPayload {
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
  /** 有的网关把错误塞进 200 的流里，所以流式帧也要认这个键。 */
  error?: { message?: string };
}

/** `GET /models` 的响应：`{data: [{id}, ...]}`，其余字段不认领。 */
export interface OpenAIModelsPayload {
  data?: unknown;
}

/** Anthropic 的响应：文本在 `content[]` 的 `type === "text"` 块里。 */
export interface AnthropicChatPayload {
  content?: { type?: string; text?: string }[];
  error?: { message?: string };
}

/** Anthropic 流式帧：增量在 `delta.text`，错误帧的说明在 `error.message`。 */
export interface AnthropicStreamPayload {
  delta?: { text?: string };
  error?: { message?: string };
}
