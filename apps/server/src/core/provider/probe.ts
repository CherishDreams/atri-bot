import { errorMessage } from "#core/errors.ts";
import type { ProviderImpl } from "./types.ts";

/**
 * Provider 可用性探针的种类。
 *
 * - `api`：验证源可达、鉴权正确、模型列表接口可用；
 * - `model`：用实例绑定的模型发一次最小补全，验证模型真的能回。
 *
 * 两者都不写会话、不占会话锁、不使用用户历史。
 */
export const PROVIDER_PROBE_KINDS = ["api", "model"] as const;
export type ProviderProbeKind = (typeof PROVIDER_PROBE_KINDS)[number];

/**
 * 探针超时。API 只是一次列表请求；模型要走一次上游补全，给更长的预算。
 * 都是本仓自选值：用户配置的 `timeoutMs` 可能长达 10 分钟，不适合「点一下看是否可用」。
 */
export const PROVIDER_PROBE_TIMEOUT_MS: Record<ProviderProbeKind, number> = {
  api: 10_000,
  model: 20_000,
};

/** 探针结果。`ok: false` 是正常的业务结果，不抛异常，界面/插件据此展示原因。 */
export interface ProviderProbeResult {
  kind: ProviderProbeKind;
  ok: boolean;
  latencyMs: number;
  detail: string | null;
  error: string | null;
}

const ERROR_LIMIT_CHARS = 300;

/** 一次最小补全。用英文短句减少分词/上下文带来的额外差异，不要求模型回答内容。 */
const PROBE_MESSAGES = [{ role: "user" as const, content: "ping" }];

export async function probeProvider(
  provider: ProviderImpl,
  kind: ProviderProbeKind,
): Promise<ProviderProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS[kind]);
  try {
    if (kind === "api") {
      if (typeof provider.listModels !== "function") {
        return {
          kind,
          ok: false,
          latencyMs: Date.now() - started,
          detail: null,
          error: "该接入方式没有模型列表接口",
        };
      }
      const models = await provider.listModels({ signal });
      return {
        kind,
        ok: true,
        latencyMs: Date.now() - started,
        detail: `模型列表可用（${models.length} 个）`,
        error: null,
      };
    }

    const reply = await provider.chat({
      ...(provider.models[0] === undefined ? {} : { model: provider.models[0] }),
      messages: PROBE_MESSAGES,
      signal,
    });
    return {
      kind,
      ok: true,
      latencyMs: Date.now() - started,
      detail: `模型已响应（${reply.content.length} 字）`,
      error: null,
    };
  } catch (err) {
    return {
      kind,
      ok: false,
      latencyMs: Date.now() - started,
      detail: null,
      error: errorMessage(err).slice(0, ERROR_LIMIT_CHARS),
    };
  }
}

/** 把结果里可能出现的密钥替换掉；上游错误文本有时会回显请求 URL/头。 */
export function redactProbeResult(
  result: ProviderProbeResult,
  secrets: readonly string[],
): ProviderProbeResult {
  const nonEmpty = secrets.filter((secret) => secret !== "");
  if (nonEmpty.length === 0) return result;
  const redact = (text: string | null): string | null => {
    if (text === null) return null;
    let next = text;
    for (const secret of nonEmpty) next = next.split(secret).join("***");
    return next;
  };
  return { ...result, detail: redact(result.detail), error: redact(result.error) };
}
