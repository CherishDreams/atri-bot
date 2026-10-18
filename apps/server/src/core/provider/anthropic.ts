import { DEFAULT_TIMEOUT_MS } from "./store.ts";
import { toNetworkError, toProviderError } from "./errors.ts";
import { idleTimeout, withTimeout, wrapStreamError, type IdleTimeout } from "./timeout.ts";
import { normalizeModels } from "./openai.ts";
import type { ToolCall } from "@atri/shared";
import type {
  AnthropicChatPayload,
  AnthropicStreamPayload,
  ChatMessage,
  ChatOptions,
  ChatReply,
  ChatStreamOptions,
  ChatTool,
  ListModelsOptions,
  OpenAIModelsPayload,
  ProviderOptions,
} from "./types.ts";
import { parseSseJson } from "./sse.ts";

/**
 * Anthropic provider（`POST /v1/messages`）。
 *
 * 报文与 OpenAI 兼容接口有四处硬差异，所以无法靠换 baseUrl 复用同一份实现：
 *
 * 1. **`system` 不能留在 messages 里**，必须提到顶层 `system` 字段。
 *    Anthropic 的 messages 只接受 `user` / `assistant` 两种角色。
 * 2. **`max_tokens` 必填**（OpenAI 那边是可选的），缺失会被直接拒绝。
 * 3. **`tool` 角色不存在**，工具结果要以 `user` 消息 + `tool_result` 内容块表达。
 * 4. **流式事件带 `event:` 名**，增量在 `content_block_delta` 的 `delta.text`，
 *    没有 `[DONE]` 哨兵，靠 `message_stop` 结束。
 *
 * function calling 的形状也因此完全不同：声明在顶层 `tools[]`（`input_schema`），
 * 调用是 `content[]` 里的 `tool_use` 块（`input` **已是对象**，不是串），
 * 流式时 id/name 在 `content_block_start`、参数按 `input_json_delta` 分片给出。
 *
 * 鉴权用 `x-api-key`，并且必须带 `anthropic-version`。
 */
export class AnthropicProvider {
  id: string;
  name: string;
  models: string[];
  type = "anthropic";
  baseUrl: string;
  apiKey: string;
  version: string;
  maxTokens: number;
  headers: Record<string, string>;
  timeoutMs: number;

  constructor({
    id,
    name,
    models = [],
    baseUrl,
    apiKey,
    version = "2023-06-01",
    maxTokens = 8192,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: ProviderOptions = {}) {
    if (!id) throw new Error("anthropic provider 必须带有 id");
    this.id = id;
    this.name = name ?? id;
    this.models = models;
    this.baseUrl = (baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = apiKey ?? "";
    this.version = version;
    this.maxTokens = maxTokens;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  #endpoint(): string {
    return `${this.baseUrl}/messages`;
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
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.version,
      ...this.headers,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const { system, body } = splitMessages(messages);
    const declared = toAnthropicTools(tools);

    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model ?? this.models[0],
        max_tokens: this.maxTokens,
        // 只有真的存在 system 提示时才带该字段：传空串会被上游当成非空校验对象。
        ...(system ? { system } : {}),
        // 同理，工具集为空时整个键都不发 —— 默认关闭的工具不该在报文里留下痕迹。
        ...(declared ? { tools: declared } : {}),
        messages: body,
        stream,
      }),
      signal,
    };
  }

  async chat({ model, messages, tools, signal }: ChatOptions): Promise<ChatReply> {
    const response = await this.#fetch(messages, { model, stream: false, tools, signal });
    if (!response.ok) throw await toProviderError(response, { provider: this.id, model });

    // `response.json()` 交出 unknown（JSON 边界），只在此处认领要用的那几个键。
    const payload = (await response.json()) as AnthropicChatPayload;
    const reply: ChatReply = { role: "assistant", content: extractText(payload?.content) };
    const toolCalls = extractToolUses(payload?.content);
    if (toolCalls) reply.toolCalls = toolCalls;
    if (payload?.stop_reason) reply.stopReason = payload.stop_reason;
    return reply;
  }

  /**
   * 流式补全。超时走**空闲**判据（`idleTimeout`）而不是总预算，理由与 openai 那一侧相同。
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
      // 按内容块 `index` 归位：`content_block_start` 给 id/name，参数随后以
      // `input_json_delta` 分片到达，所以只能累加。
      const slots = new Map<number, { id: string; name: string; arguments: string }>();
      const finish = (): ChatReply => {
        const reply: ChatReply = { role: "assistant", content };
        const toolCalls = [...slots.entries()]
          .toSorted(([a], [b]) => a - b)
          .map(([index, slot]) => ({
            id: slot.id || `call_${index}`,
            name: slot.name,
            arguments: slot.arguments,
          }));
        if (toolCalls.length > 0) reply.toolCalls = toolCalls;
        if (stopReason) reply.stopReason = stopReason;
        return reply;
      };

      for await (const frame of parseSseJson(response.body)) {
        // 任何一帧都算「还在往前推」，包括只带工具参数碎片的那些。
        idle.renew();
        // JSON.parse 交出的是 unknown，这里认领 Anthropic 流式帧里的那几个键。
        const chunk = frame.payload as AnthropicStreamPayload | null;
        // 事件类型在 `event:` 字段里，而不是 data 载荷内。
        switch (frame.event) {
          case "message_stop":
            return finish();
          case "content_block_start": {
            const block = chunk?.content_block;
            if (block?.type === "tool_use") {
              slots.set(chunk?.index ?? 0, {
                id: block.id ?? "",
                name: block.name ?? "",
                arguments: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            // 必须先分 `delta.type`：工具参数的 JSON 碎片也在 `content_block_delta` 里，
            // 不看类型就当成文本推给前端，用户会看到一堆 `{\"timez` 这样的半截 JSON。
            const delta = chunk?.delta;
            if (delta?.type === "input_json_delta") {
              const slot = slots.get(chunk?.index ?? 0);
              if (slot && typeof delta.partial_json === "string")
                slot.arguments += delta.partial_json;
              break;
            }
            const text = delta?.text;
            if (typeof text === "string" && text.length > 0) {
              content += text;
              onDelta?.(text);
            }
            break;
          }
          case "message_delta": {
            if (typeof chunk?.delta?.stop_reason === "string") stopReason = chunk.delta.stop_reason;
            break;
          }
          case "error": {
            const detail = chunk?.error?.message ?? JSON.stringify(chunk?.error);
            throw await toProviderError(new Response(detail, { status: 502 }), {
              provider: this.id,
              model,
            });
          }
          default:
            break;
        }
      }
      // 上游没发 message_stop 就断流时，已收到的内容仍然有效。
      return finish();
    } catch (err) {
      throw wrapStreamError(err, idle, { provider: this.id, model });
    } finally {
      // 定时器必须摘：留着一个未触发的句柄，测试进程会吊在那里不退出。
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
   * Anthropic 的响应体形状与 OpenAI 一致（`{data:[{id,display_name,...}]}`），
   * 所以复用同一个 `normalizeModels`。差异只在鉴权头：这里用 `x-api-key`
   * 与 `anthropic-version`，而不是 `Authorization: Bearer`。
   *
   * @returns 去重并按字典序排好的模型 id
   */
  async listModels({ signal }: ListModelsOptions = {}): Promise<string[]> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "anthropic-version": this.version,
      ...this.headers,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers,
        signal: withTimeout(signal, this.timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err, { provider: this.id });
    }
    if (!response.ok) throw await toProviderError(response, { provider: this.id });

    const payload = (await response.json()) as OpenAIModelsPayload;
    return normalizeModels(payload?.data);
  }
}

/** `tool` 角色在 Anthropic 里的表达：一条 user 消息 + 一个 `tool_result` 内容块。 */
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** 助手消息里的一次工具调用。`input` 必须是对象，不能是模型原样吐出的串。 */
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 用户消息里的一张图片。Anthropic 的 base64 源不接受 `data:` 前缀。 */
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

/** 内容块联合。文本既可以是裸 string 也可以是 text 块，取决于消息里有没有别的块。 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

/** Anthropic 的 messages 项：纯文本消息用 string，带工具的用内容块数组。 */
interface AnthropicBodyMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * 把统一消息格式拆成 Anthropic 的 `system` + `messages`。
 *
 * 注意所有 system 消息合并成一个字符串：Anthropic 的 `system` 是单个字段
 * 而不是数组，多条 system 直接覆盖会让前面几条静默消失。
 */
export function splitMessages(messages: ChatMessage[]): {
  system: string;
  body: AnthropicBodyMessage[];
} {
  const systems: string[] = [];
  const body: AnthropicBodyMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
      continue;
    }

    // `tool` 在 Anthropic 里不存在：工具结果要以 user 消息承载。
    if (message.role === "tool") {
      body.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? message.tool_call_id ?? "",
            content: message.content,
          },
        ],
      });
      continue;
    }

    // 助手要求调用工具时，正文与 tool_use 块同消息发回去：上游要靠这条历史把
    // 后面的 tool_result 配对上。缺了它，第二轮请求就是「有结果没有调用」。
    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseInput(call) });
      }
      body.push({ role: "assistant", content: blocks });
      continue;
    }

    // 图片只可能出现在用户消息上。Anthropic 要求图片走内容块（base64 源），
    // 与 OpenAI 的 `image_url` 不是同一种结构，所以两家的换算各自留在自己的文件里。
    if (message.role === "user" && message.images?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const image of message.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        });
      }
      body.push({ role: "user", content: blocks });
      continue;
    }

    body.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }

  return { system: systems.join("\n\n"), body: mergeAdjacent(body) };
}

/**
 * 把 `ToolCall.arguments`（模型产出的 JSON 串）转成上游要的 `input` 对象。
 *
 * 坏 JSON 退化成 `{}` 而**不抛错**：抛出去会把整轮变成 500，而此刻唯一确定的事实是
 * 「模型上一轮给了一个我们没法复现的参数串」。空参数调用继续跑下去，比一次硬失败更可用。
 */
function parseInput(call: ToolCall): Record<string, unknown> {
  if (!call.arguments) return {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  return {};
}

/**
 * 合并相邻的同角色消息。
 *
 * Anthropic 要求 user / assistant 严格交替，而 agent 会话历史里连续两条
 * user 消息很常见（例如用户连发两条）。不合并会被上游以
 * 「messages: roles must alternate」拒绝。
 *
 * **内容块数组也要合并**：模型一次并行要求调两个工具时，回喂的两条 `role:"tool"`
 * 消息会变成两条相邻的 user 消息，各自带一个 tool_result 块 —— 正是这里曾经会漏掉的
 * 情况（旧实现只合并两侧都是 string 的情形，块数组原样推出去，于是又被上游拒掉）。
 */
function mergeAdjacent(messages: AnthropicBodyMessage[]): AnthropicBodyMessage[] {
  const merged: AnthropicBodyMessage[] = [];
  for (const message of messages) {
    const prev = merged.at(-1);
    if (prev && prev.role === message.role) {
      prev.content = concatContent(prev.content, message.content);
      continue;
    }
    merged.push({ ...message });
  }
  return merged;
}

/**
 * 两侧都是纯文本时拼成一个串（保持既有形状：历史里的普通消息不该突然变成块数组），
 * 只要有一侧是内容块就统一成块数组，并把 string 侧转成 text 块。
 */
function concatContent(
  prev: AnthropicBodyMessage["content"],
  next: AnthropicBodyMessage["content"],
): AnthropicBodyMessage["content"] {
  if (typeof prev === "string" && typeof next === "string") return `${prev}\n\n${next}`;
  return [...toBlocks(prev), ...toBlocks(next)];
}

function toBlocks(content: AnthropicBodyMessage["content"]): AnthropicContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** 从 Anthropic 的 content blocks 里取出文本块并拼成串；`tool_use` 由 `extractToolUses` 负责。 */
function extractText(content: AnthropicChatPayload["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 非流式响应里的 `tool_use` 块 -> 仓内 `ToolCall[]`；没有则 undefined。
 *
 * `input` 在这里已经是对象，而 `ToolCall.arguments` 统一是串（OpenAI 那边给的就是串），
 * 所以序列化一次：往回喂给上游时由 `parseInput` 再解回来，两边形状由此对齐。
 */
function extractToolUses(content: AnthropicChatPayload["content"]): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = content
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      id: block.id ?? "",
      name: block.name ?? "",
      arguments: JSON.stringify(block.input ?? {}),
    }));
  return calls.length > 0 ? calls : undefined;
}

/** 中立工具描述 -> `tools[]`。`input_schema` 是必填键，所以工具必须自带一个（哪怕空）schema。 */
function toAnthropicTools(tools: ChatTool[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}
