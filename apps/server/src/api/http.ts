/** JSON HTTP 处理的辅助函数。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "#core/errors.ts";
import type { AppConfig } from "#config/index.ts";
import type { AgentEngine } from "#core/agent/engine.ts";
import type { AuthManager } from "#core/auth/manager.ts";
import type { Logger } from "#core/logger.ts";
import type { ProviderConfigStore } from "#core/provider/store.ts";
import type { ProviderRegistry } from "#core/provider/registry.ts";
import type { ToolConfigStore } from "#core/tool/store.ts";
import type { ToolRegistry } from "#core/tool/registry.ts";
import type { SessionManager } from "#core/session/manager.ts";
import type { AdapterManager } from "#adapters/manager.ts";
import type { PluginManager } from "#plugins/manager.ts";

/**
 * `createHttpServer` 的依赖，由组合根 `app.ts` 注入。
 *
 * 字段类型用各 manager 的**具体类**而不是 `Pick<>`：传输层本来就该知道 manager 的
 * 真实 API（`providerConfig.providers` / `auth.cookieName` / `plugins.reload`…），
 * 它不知道的是业务规则。`Pick` 在这里只会变成一坨比类本身更长的清单。
 */
export interface HttpDeps {
  config: AppConfig;
  logger: Logger;
  auth: AuthManager;
  sessions: SessionManager;
  providers: ProviderRegistry;
  providerConfig: ProviderConfigStore;
  /** 配置写成功后重建整张注册表，由组合根提供（见 `app.ts` 的 rebuildProviders）。 */
  reloadProviders: () => ProviderRegistry;
  plugins: PluginManager;
  adapters: AdapterManager;
  /** 工具注册表与它的开关存储；两者都是只读用途，所以没有 `reloadTools`。 */
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  engine: AgentEngine;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 统一的错误体形状：`{ error: "<中文说明>" }`，全仓所有失败响应都是它。 */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * 开启一个 SSE 响应。
 *
 * `x-accel-buffering: no` 是给 Nginx 用的：不加这一行，反代会把整个响应缓冲到
 * 结束才吐出，流式就白做了。`cache-control: no-store` 同理——中间层缓存增量流
 * 毫无意义，还可能把上一个请求的内容喂给下一个。
 */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // 立刻发一个注释帧：让客户端（以及任何中间层）马上认为连接已建立，
  // 避免在等待上游首个 token 期间被判定为超时。
  res.write(": connected\n\n");
}

/** 发一个 SSE 事件。默认事件名即 `message`，前端 SDK 会解析 data 里的 JSON。 */
export function sendSse(res: ServerResponse, data: unknown, event?: string): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 读取并解析 JSON 请求体，带大小上限。
 *
 * 返回 `Record<string, unknown>` 而不是 `any`：调用方（`api/server.ts`）确实
 * 逐个字段做 `typeof` 校验，而 `unknown` 让那些校验成为**编译期要求**——
 * 返回 `any` 的话，忘记校验某个字段就不再是错误，只是没人看得见。
 */
export async function readJson(
  req: IncomingMessage,
  limitBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new ApiError("请求体过大", 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("JSON 请求体格式错误");
  }
  // **形状**也要在边界上判，不只语法。`JSON.parse` 什么都能给：`null`、`[]`、`5`、`"北京时间"`，
  // 而返回类型声明的是 `Record<string, unknown>` —— 不挡的话调用方第一处 `body.content` 就是
  // TypeError，一个客户端写错的请求体于是变成 500 加一条「服务器内部错误」，
  // 用户看不出是自己发错了，日志里还多一条与故障无关的堆栈。
  // 空 body 走上面的 `return {}`，所以这里拒的是「有内容但不是对象」。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("请求体必须是一个 JSON 对象");
  }
  // 这一处 `as` 就是 JSON 边界本身：上面那道判据已经把它压成「非 null 的非数组对象」，
  // 而 TS 不知道「对象」在 JSON 里就等于「键值映射」。
  return parsed as Record<string, unknown>;
}
