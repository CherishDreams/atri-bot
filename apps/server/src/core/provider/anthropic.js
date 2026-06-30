import { toNetworkError, toProviderError } from "./errors.js";
import { parseSseJson } from "./sse.js";

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
 * 鉴权用 `x-api-key`，并且必须带 `anthropic-version`。
 */
export class AnthropicProvider {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {string} [options.name]
   * @param {string[]} [options.models]
   * @param {string} [options.baseUrl] 例如 `https://api.anthropic.com/v1`
   * @param {string} [options.apiKey]
   * @param {string} [options.version] anthropic-version 请求头
   * @param {number} [options.maxTokens] 必填字段的取值，默认 8192
   * @param {Record<string,string>} [options.headers]
   * @param {number} [options.timeoutMs]
   */
  constructor({
    id,
    name,
    models = [],
    baseUrl,
    apiKey,
    version = "2023-06-01",
    maxTokens = 8192,
    headers = {},
    timeoutMs = 120_000,
  } = {}) {
    if (!id) throw new Error("anthropic provider 必须带有 id");
    this.id = id;
    this.name = name ?? id;
    this.models = models;
    this.type = "anthropic";
    this.baseUrl = (baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = apiKey ?? "";
    this.version = version;
    this.maxTokens = maxTokens;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  #endpoint() {
    return `${this.baseUrl}/messages`;
  }

  #request(messages, { model, stream, signal }) {
    const headers = {
      "content-type": "application/json",
      "anthropic-version": this.version,
      ...this.headers,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const { system, body } = splitMessages(messages);

    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model ?? this.models[0],
        max_tokens: this.maxTokens,
        // 只有真的存在 system 提示时才带该字段：传空串会被上游当成非空校验对象。
        ...(system ? { system } : {}),
        messages: body,
        stream,
      }),
      signal,
    };
  }

  async chat({ model, messages, signal }) {
    const response = await this.#fetch(messages, { model, stream: false, signal });
    if (!response.ok) throw await toProviderError(response, { provider: this.id, model });

    const payload = await response.json();
    const text = extractText(payload?.content);
    return { role: "assistant", content: text };
  }

  async chatStream({ model, messages, onDelta, signal }) {
    const response = await this.#fetch(messages, { model, stream: true, signal });
    if (!response.ok) throw await toProviderError(response, { provider: this.id, model });
    if (!response.body) {
      throw await toProviderError(new Response("上游未返回响应体", { status: 502 }), {
        provider: this.id,
        model,
      });
    }

    let content = "";
    for await (const frame of parseSseJson(response.body)) {
      // 事件类型在 `event:` 字段里，而不是 data 载荷内。
      switch (frame.event) {
        case "message_stop":
          return { role: "assistant", content };
        case "content_block_delta": {
          const delta = frame.payload?.delta?.text;
          if (typeof delta === "string" && delta.length > 0) {
            content += delta;
            onDelta?.(delta);
          }
          break;
        }
        case "error": {
          const detail = frame.payload?.error?.message ?? JSON.stringify(frame.payload?.error);
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
    return { role: "assistant", content };
  }

  async #fetch(messages, options) {
    try {
      return await fetch(this.#endpoint(), {
        ...this.#request(messages, options),
        signal: withTimeout(options.signal, this.timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err, { provider: this.id, model: options.model });
    }
  }
}

/**
 * 把统一消息格式拆成 Anthropic 的 `system` + `messages`。
 *
 * 注意所有 system 消息合并成一个字符串：Anthropic 的 `system` 是单个字段
 * 而不是数组，多条 system 直接覆盖会让前面几条静默消失。
 */
export function splitMessages(messages) {
  const systems = [];
  const body = [];

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

    body.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }

  return { system: systems.join("\n\n"), body: mergeAdjacent(body) };
}

/**
 * 合并相邻的同角色消息。
 *
 * Anthropic 要求 user / assistant 严格交替，而 agent 会话历史里连续两条
 * user 消息很常见（例如用户连发两条）。不合并会被上游以
 * 「messages: roles must alternate」拒绝。
 */
function mergeAdjacent(messages) {
  const merged = [];
  for (const message of messages) {
    const prev = merged.at(-1);
    if (prev && prev.role === message.role && typeof prev.content === "string") {
      if (typeof message.content === "string") {
        prev.content = `${prev.content}\n\n${message.content}`;
        continue;
      }
    }
    merged.push({ ...message });
  }
  return merged;
}

/** 从 Anthropic 的 content blocks 里取出纯文本，忽略 thinking / tool_use 等块。 */
function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
