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
  /** 出错 provider 的 id，便于分辨是哪一个后端。 */
  provider?: string;
  /** 上游 HTTP 状态码；网络层失败时为 undefined。 */
  status?: number;
  /** 上游返回的原始错误文本（已截断），只用于排查，不直接展示给终端用户。 */
  detail?: string;

  constructor(message: string, { provider, status, detail, cause }: ProviderErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

interface ProviderErrorOptions {
  provider?: string;
  status?: number;
  detail?: string;
  /** 上游/网络层的原始失败。`Error` 的 cause 是 `unknown`，这里不替它收窄。 */
  cause?: unknown;
}

interface ProviderLabel {
  provider?: string;
  model?: string;
}

const STATUS_HINTS: Record<string, string> = {
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
export function describeStatus(status: number): string {
  const hint = STATUS_HINTS[status];
  if (hint) return hint;
  if (status >= 500) return "上游服务出错";
  return `上游返回 ${status}`;
}

/** JSON 之外还可能是纯文本/HTML，所以任何对象形状都在这里收窄一次。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从上游响应体里尽量抠出一句可读的错误说明。 */
export function extractUpstreamMessage(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";

  // OpenAI / Anthropic 都把说明放在 error.message；部分兼容网关只给 message 或 detail。
  const nested = payload.error;
  if (typeof nested === "string") return nested;
  if (isRecord(nested) && typeof nested.message === "string") return nested.message;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.detail === "string") return payload.detail;
  return "";
}

/**
 * 读取失败响应的正文并拼装成 ProviderError。
 * 上游正文可能是 JSON、纯文本甚至 HTML，所以解析失败一律退回原文。
 */
export async function toProviderError(
  response: Response,
  { provider, model }: ProviderLabel = {},
): Promise<ProviderError> {
  let payload: unknown;
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
export function toNetworkError(
  err: unknown,
  { provider, model }: ProviderLabel = {},
): ProviderError {
  // 不做 `err instanceof Error` 的整体收窄：被 abort 的值可能来自不同实现，
  // 而我们真正需要的只是 name/message/cause.code 这几个字段在不在。
  const bag = isRecord(err) ? err : {};
  const name = typeof bag.name === "string" ? bag.name : undefined;
  const message = typeof bag.message === "string" ? bag.message : "";
  const cause = isRecord(bag.cause) ? bag.cause : undefined;
  const causeCode = cause && typeof cause.code === "string" ? cause.code : "";
  const ownCode = typeof bag.code === "string" ? bag.code : "";

  if (name === "AbortError") {
    return new ProviderError(`provider「${provider}」的请求已被取消`, {
      provider,
      detail: message,
      cause: err,
    });
  }

  const detail = [name, message, causeCode || ownCode].filter(Boolean).join(" / ");
  const label = model
    ? `provider「${provider}」调用模型 ${model} 失败`
    : `provider「${provider}」调用失败`;

  return new ProviderError(`${label}：无法连接上游（${detail}）`, {
    provider,
    detail,
    cause: err,
  });
}
