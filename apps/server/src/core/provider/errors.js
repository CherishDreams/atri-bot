/**
 * provider 调用失败时的统一错误类型。
 *
 * 为什么需要这一层：各家的错误响应体形状不同（OpenAI 是 `{ error: { message } }`，
 * Anthropic 是 `{ error: { type, message } }`，有的网关直接回纯文本或 HTML），
 * 而调用方（引擎 → API 层 → 前端）只关心「发生了什么、能不能读给用户听」。
 * 这里把状态码映射成可读中文，同时用 `detail` 保留上游原文，便于排查。
 *
 * 设计取向是「透传真实错误」而不是回退到假回复：密钥配错、限流、模型名打错
 * 都必须让使用者看见。否则故障会被伪装成一条正常回复，问题永远暴露不出来。
 */
export class ProviderError extends Error {
  constructor(message, { provider, status, detail, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProviderError";
    /** 出错 provider 的 id，便于分辨是哪一个后端。 */
    this.provider = provider;
    /** 上游 HTTP 状态码；网络层失败时为 undefined。 */
    this.status = status;
    /** 上游返回的原始错误文本（已截断），只用于排查，不直接展示给终端用户。 */
    this.detail = detail;
  }
}

const STATUS_HINTS = {
  400: "请求被上游拒绝",
  401: "密钥无效或未提供",
  403: "无权访问该模型或接口",
  404: "模型或接口不存在",
  408: "上游请求超时",
  413: "请求体过大",
  422: "请求参数不被上游接受",
  429: "触发限流，请稍后重试",
};

/** 把上游状态码翻成一句人话。5xx 统一按上游故障处理。 */
export function describeStatus(status) {
  if (STATUS_HINTS[status]) return STATUS_HINTS[status];
  if (status >= 500) return "上游服务出错";
  return `上游返回 ${status}`;
}

/** 从上游响应体里尽量抠出一句可读的错误说明。 */
export function extractUpstreamMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;

  // OpenAI / Anthropic 都把说明放在 error.message；部分兼容网关只给 message 或 detail。
  const nested = payload.error;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested.message === "string") return nested.message;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.detail === "string") return payload.detail;
  return "";
}

/**
 * 读取失败响应的正文并拼装成 ProviderError。
 * 上游正文可能是 JSON、纯文本甚至 HTML，所以解析失败一律退回原文。
 */
export async function toProviderError(response, { provider, model } = {}) {
  let payload;
  let text = "";
  try {
    text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  const upstream = extractUpstreamMessage(payload) || text;
  // 截断：上游偶尔回整页 HTML，不截断会把日志和前端气泡撑爆。
  const detail = upstream ? upstream.slice(0, 500) : "";

  const hint = describeStatus(response.status);
  const label = model
    ? `provider「${provider}」调用模型 ${model} 失败`
    : `provider「${provider}」调用失败`;
  const message = detail ? `${label}：${hint}（${detail}）` : `${label}：${hint}`;

  return new ProviderError(message, {
    provider,
    status: response.status,
    detail,
  });
}

/** 网络层失败（DNS、连接被拒、超时、被 abort）也统一成 ProviderError。 */
export function toNetworkError(err, { provider, model } = {}) {
  if (err?.name === "AbortError") {
    return new ProviderError(`provider「${provider}」的请求已被取消`, {
      provider,
      detail: String(err?.message ?? ""),
      cause: err,
    });
  }

  const cause = err?.cause?.code ?? err?.code ?? "";
  const detail = [err?.name, err?.message, cause].filter(Boolean).join(" / ");
  const label = model
    ? `provider「${provider}」调用模型 ${model} 失败`
    : `provider「${provider}」调用失败`;

  return new ProviderError(`${label}：无法连接上游（${detail}）`, {
    provider,
    detail,
    cause: err,
  });
}
