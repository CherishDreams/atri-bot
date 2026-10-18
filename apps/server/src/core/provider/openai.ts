import { DEFAULT_TIMEOUT_MS } from "./store.ts";
import { toNetworkError, toProviderError } from "./errors.ts";
import { idleTimeout, withTimeout, wrapStreamError, type IdleTimeout } from "./timeout.ts";
import type { ToolCall } from "@atri/shared";
import type {
  ChatMessage,
  ChatOptions,
  ChatReply,
  ChatStreamOptions,
  ChatTool,
  ListModelsOptions,
  OpenAIChatPayload,
  OpenAIModelsPayload,
  OpenAIToolCallValue,
  ProviderOptions,
} from "./types.ts";
import { parseSseJson } from "./sse.ts";

/**
 * OpenAI 兼容 provider（`POST /chat/completions`）。
 *
 * 之所以叫「兼容」而不是「OpenAI」：DeepSeek、Moonshot、通义、Ollama、vLLM、
 * One-API 等一大批服务都实现了同一套报文，改的只是 `baseUrl` 与模型名。
 * 因此这里不做厂商判断，只按这一套契约发请求。
 *
 * 报文要点（与 Anthropic 的差异都在这里）：
 * - `system` 消息留在 `messages` 数组里，不提到顶层。
 * - `max_tokens` **可选**，不传则用上游默认值。
 * - 流式响应的增量在 `choices[0].delta.content`，结束哨兵是字面量 `data: [DONE]`。
 * - 鉴权是 `Authorization: Bearer <key>`。
 * - function calling：工具声明在 `tools[]`（`{type:"function", function:{...}}`），
 *   调用回在 `delta.tool_calls[]` / `message.tool_calls[]`，结果作为
 *   `role:"tool"` + `tool_call_id` 回到 `messages` 里。
 */
export class OpenAIProvider {
  id: string;
  name: string;
  models: string[];
  type = "openai";
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs: number;

  constructor({
    id,
    name,
    models = [],
    baseUrl,
    apiKey,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: ProviderOptions = {}) {
    if (!id) throw new Error("openai provider 必须带有 id");
    this.id = id;
    this.name = name ?? id;
    this.models = models;
    this.baseUrl = normalizeBaseUrl(baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = apiKey ?? "";
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  /** 端点地址。base 末尾是否带 `/` 都在 normalizeBaseUrl 里抹平了。 */
  #endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  #request(
    messages: ChatMessage[],
    {
      model,
      stream,
      tools,
      signal,
    }: { model?: string; stream: boolean; tools?: ChatTool[]; signal?: AbortSignal },
  ): { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    // 空数组与 undefined 一样：整个 `tools` 键都不发。默认关闭的工具因此不会在报文里
    // 留下任何痕迹，「启用前后逐字节相同」才是可断言的（见 test/provider.test.ts）。
    const declared = toOpenAITools(tools);

    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model ?? this.models[0],
        messages: toOpenAIMessages(messages),
        stream,
        ...(declared ? { tools: declared } : {}),
      }),
      signal,
    };
  }

  /** 一次完整（非流式）补全。 */
  async chat({ model, messages, tools, signal }: ChatOptions): Promise<ChatReply> {
    const response = await this.#fetch(messages, { model, stream: false, tools, signal });
    if (!response.ok) throw await toProviderError(response, { provider: this.id, model });

    // `response.json()` 交出 unknown（这是 JSON 边界，类型只能在此处认领），
    // 往下每个使用点只读自己声明认领的那几个键。
    const payload = (await response.json()) as OpenAIChatPayload;
    const choice = payload?.choices?.[0];
    const reply: ChatReply = { role: "assistant", content: choice?.message?.content ?? "" };
    const toolCalls = toToolCalls(choice?.message?.tool_calls);
    // 空数组不写进返回值：引擎判的是「有没有 toolCalls」，留一个空数组会让
    // 「这一轮要不要继续」变成两种等价表示，日后读代码的人得先去查哪一支才是生效的。
    if (toolCalls) reply.toolCalls = toolCalls;
    if (choice?.finish_reason) reply.stopReason = choice.finish_reason;
    return reply;
  }

  /**
   * 流式补全。每收到一段增量就 `onDelta(delta)`，返回拼接后的完整文本。
   * 调用方拿返回值落库，因此增量与最终内容必然一致。
   *
   * 超时走**空闲**判据（`idleTimeout`），不是总预算：一次长生成还在往前推时不该被掐掉。
   */
  async chatStream({
    model,
    messages,
    tools,
    onDelta,
    signal,
  }: ChatStreamOptions): Promise<ChatReply> {
    const idle = idleTimeout(this.timeoutMs, signal);
    try {
      const response = await this.#fetch(messages, { model, stream: true, tools, idle });
      if (!response.ok) throw await toProviderError(response, { provider: this.id, model });
      if (!response.body) {
        throw await toProviderError(new Response("上游未返回响应体", { status: 502 }), {
          provider: this.id,
          model,
        });
      }

      let content = "";
      let stopReason: string | undefined;
      // 按 `index` 归位的槽位：一次响应可以并行要求调多个工具，每个的 arguments
      // 会被拆成任意多片，所以这里只能累加，覆盖会丢掉前缀。
      const slots = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const frame of parseSseJson(response.body)) {
        // 收到任何一帧就算「上游还在往前推」，包括那些只带 tool_calls 片段的帧。
        idle.renew();
        if (frame.data === "[DONE]") break;

        // JSON.parse 交出的是 unknown，这里认领 OpenAI 兼容契约里的那几个键。
        const chunk = frame.payload as OpenAIChatPayload | null;
        const choice = chunk?.choices?.[0];

        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          content += delta;
          onDelta?.(delta);
        }

        for (const frag of choice?.delta?.tool_calls ?? []) {
          // 没有 `index` 时按「这一路只有一个调用」处理（早期 function_call 就是这个形状）。
          const at = frag.index ?? 0;
          const slot = slots.get(at) ?? { id: "", name: "", arguments: "" };
          if (typeof frag.id === "string" && frag.id) slot.id = frag.id;
          if (typeof frag.function?.name === "string") slot.name += frag.function.name;
          if (typeof frag.function?.arguments === "string")
            slot.arguments += frag.function.arguments;
          slots.set(at, slot);
        }

        // 只作诊断：循环的终止条件是「有没有 toolCalls」，不看这里（理由见 ChatReply.stopReason）。
        if (typeof choice?.finish_reason === "string") stopReason = choice.finish_reason;

        // 兼容网关有时把错误塞进 200 的流里（OpenAI 本身也可能用 `error` 字段报错）。
        if (chunk?.error) {
          const detail = chunk.error.message ?? JSON.stringify(chunk.error);
          throw await toProviderError(new Response(detail, { status: 502 }), {
            provider: this.id,
            model,
          });
        }
      }

      const toolCalls = [...slots.entries()]
        .toSorted(([a], [b]) => a - b)
        .map(([index, slot]) => ({
          // id 缺失时补一个确定性的占位：回喂结果要靠 id 配对，宁可给它一个能数出来的名字，
          // 也不要让那条 tool 消息带着空 tool_call_id 去上游（上游会直接拒）。
          id: slot.id || `call_${index}`,
          name: slot.name,
          arguments: slot.arguments,
        }));

      const reply: ChatReply = { role: "assistant", content };
      if (toolCalls.length > 0) reply.toolCalls = toolCalls;
      if (stopReason) reply.stopReason = stopReason;
      return reply;
    } catch (err) {
      throw wrapStreamError(err, idle, { provider: this.id, model });
    } finally {
      // 定时器必须摘：留着一个未触发的 120s 句柄，测试进程会吊在那里不退出。
      idle.dispose();
    }
  }

  async #fetch(
    messages: ChatMessage[],
    options: {
      model?: string;
      stream: boolean;
      tools?: ChatTool[];
      signal?: AbortSignal;
      /** 流式路径的空闲超时句柄；给了它就由它决定 `signal`，不再套总预算。 */
      idle?: IdleTimeout;
    },
  ): Promise<Response> {
    const signal = options.idle ? options.idle.signal : withTimeout(options.signal, this.timeoutMs);
    try {
      return await fetch(this.#endpoint(), { ...this.#request(messages, options), signal });
    } catch (err) {
      throw toNetworkError(err, { provider: this.id, model: options.model });
    }
  }

  /**
   * 拉取上游的模型列表（`GET /models`）。
   *
   * 用于配置页的「获取模型列表」：用户填完 baseUrl 与密钥后不必手抄模型名。
   * 自建网关不一定实现这个端点，此时上游会回 404，错误经 `toProviderError`
   * 归一成一句可读提示，前端据此引导用户手填模型 ID。
   *
   * 这里**不做内置回退列表**：悄悄给一份「大概能用」的模型名，会让配置错误
   * 被推迟到发消息时才暴露，而那时更难定位。
   *
   * @returns 去重并按字典序排好的模型 id
   */
  async listModels({ signal }: ListModelsOptions = {}): Promise<string[]> {
    const payload = await this.#requestJson("/models", { signal });
    return normalizeModels(payload?.data);
  }

  /** 发一个 GET、把响应解析成 JSON，错误按 provider 层统一归一。 */
  async #requestJson(
    path: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<OpenAIModelsPayload> {
    const headers: Record<string, string> = { accept: "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: withTimeout(signal, this.timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err, { provider: this.id });
    }
    if (!response.ok) throw await toProviderError(response, { provider: this.id });
    return (await response.json()) as OpenAIModelsPayload;
  }
}

/**
 * 历史 -> OpenAI 兼容的 `messages`。
 *
 * 三种形状要分开发：普通消息、带 `tool_calls` 的助手消息、以及 `role:"tool"` 的结果。
 * 前两类**必须原样回带**：上游靠助手消息里的 `tool_calls` 与随后的 `tool_call_id`
 * 把结果和调用配起来，抹掉它们（旧实现只留 `role`/`content`）会让多轮工具对话
 * 直接说不通 —— 这也是为什么这里不能偷懒复用一句 `map`。
 */
function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        // 两个拼写都读：`shared.Message` 用 camelCase，线协议用 snake_case。
        tool_call_id: m.toolCallId ?? m.tool_call_id ?? "",
        content: m.content,
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        // 纯工具调用时正文为空，而这一族的规范值就是 null（空串在个别网关上会被判非法）。
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    // 图片只可能出现在用户消息上（适配器接收时产生）。有图时必须改成内容块数组：
    // 纯文本内容不能带图，而空正文的图片消息若仍发字符串，就会变成一条空消息。
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** 中立工具描述 -> `tools[]`。空集合返回 undefined，让调用方整个键都不发。 */
function toOpenAITools(tools: ChatTool[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** 非流式响应里的 `message.tool_calls` -> 仓内 `ToolCall[]`；空则 undefined。 */
function toToolCalls(values: OpenAIToolCallValue[] | undefined): ToolCall[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value, index) => ({
    id: value.id ?? `call_${index}`,
    name: value.function?.name ?? "",
    arguments: value.function?.arguments ?? "",
  }));
}

/** `{data: [{id}, ...]}` → 去重排序的字符串数组，非字符串项直接丢弃。 */
export function normalizeModels(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const ids = data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].toSorted();
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
