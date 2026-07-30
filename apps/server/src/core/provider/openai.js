import { toNetworkError, toProviderError } from "./errors.ts";
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
 */
export class OpenAIProvider {
  /**
   * @param {object} options
   * @param {string} options.id 配置里的键名，也是日志里显示的 provider id
   * @param {string} [options.name]
   * @param {string[]} [options.models]
   * @param {string} [options.baseUrl] 例如 `https://api.openai.com/v1`
   * @param {string} [options.apiKey]
   * @param {Record<string,string>} [options.headers] 额外请求头（自建网关常用）
   * @param {number} [options.timeoutMs]
   */
  constructor({ id, name, models = [], baseUrl, apiKey, headers = {}, timeoutMs = 120_000 } = {}) {
    if (!id) throw new Error("openai provider 必须带有 id");
    this.id = id;
    this.name = name ?? id;
    this.models = models;
    this.type = "openai";
    this.baseUrl = normalizeBaseUrl(baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = apiKey ?? "";
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  /** 端点地址。base 末尾是否带 `/` 都在 normalizeBaseUrl 里抹平了。 */
  #endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  #request(messages, { model, stream, signal }) {
    const headers = { "content-type": "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    return {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model ?? this.models[0],
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream,
      }),
      signal,
    };
  }

  /** 一次完整（非流式）补全。 */
  async chat({ model, messages, signal }) {
    const response = await this.#fetch(messages, { model, stream: false, signal });
    if (!response.ok) throw await toProviderError(response, { provider: this.id, model });

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? "";
    return { role: "assistant", content: text };
  }

  /**
   * 流式补全。每收到一段增量就 `onDelta(delta)`，返回拼接后的完整文本。
   * 调用方拿返回值落库，因此增量与最终内容必然一致。
   */
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
      if (frame.data === "[DONE]") break;

      const delta = frame.payload?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        onDelta?.(delta);
      }

      // 兼容网关有时把错误塞进 200 的流里（OpenAI 本身也可能用 `error` 字段报错）。
      if (frame.payload?.error) {
        const detail = frame.payload.error.message ?? JSON.stringify(frame.payload.error);
        throw await toProviderError(new Response(detail, { status: 502 }), {
          provider: this.id,
          model,
        });
      }
    }
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
   * @returns {Promise<string[]>} 去重并按字典序排好的模型 id
   */
  async listModels({ signal } = {}) {
    const payload = await this.#requestJson("/models", { signal });
    return normalizeModels(payload?.data);
  }

  /** 发一个 GET、把响应解析成 JSON，错误按 provider 层统一归一。 */
  async #requestJson(path, { signal } = {}) {
    const headers = { accept: "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response;
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
    return response.json();
  }
}

/** `{data: [{id}, ...]}` → 去重排序的字符串数组，非字符串项直接丢弃。 */
export function normalizeModels(data) {
  if (!Array.isArray(data)) return [];
  const ids = data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].toSorted();
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

/**
 * 给请求挂一个超时。
 *
 * 用 `AbortSignal.any` 组合调用方的取消信号与超时信号：任何一方触发都能中断请求。
 * 不能省掉这一步——上游挂起不返回时，流式响应会让连接和前端一起无限等待。
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
