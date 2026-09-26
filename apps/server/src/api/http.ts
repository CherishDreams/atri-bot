/** JSON HTTP 处理的辅助函数。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProfileRecord, ProfileStatus } from "@atri/shared";
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
import type { SessionLock } from "#core/session/lock.ts";
import type { SessionEvents } from "#core/agent/events.ts";
import type { AdapterManager } from "#adapters/manager.ts";
import type { PluginManager } from "#plugins/manager.ts";

/**
 * **一份配置档的运行期对象图**。
 *
 * 这个形状只存在于 HTTP 层：它是「一次请求要用的那一套东西」的打包，
 * 而打包这件事本身由 `app.ts` 做（用对象字面量 + 闭包，不起类）。
 * 与 `ProviderListItem` / `ProviderMutationResult` 同一个先例 —— 它们也声明在这里，
 * 因为「这个类型只服务于传输层的响应形状」，放进 `core/` 反而会让 core 认识 HTTP。
 */
export interface ProfileBundle {
  id: string;
  /** 给人看的名字（配置档文件里的 `name`，缺省为 id）。 */
  name: string;
  /** 这份档的配置文件路径，只用于日志与 `GET /profiles` 的 `path`。 */
  path: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfigStore;
  /** 配置写成功后重建整张注册表，由组合根提供（见 `app.ts` 的 rebuildProviders）。 */
  reloadProviders: () => ProviderRegistry;
  /**
   * 最近一次装配里没加载成功的 provider（`id -> 中文原因`），由 `rebuildProviders()` 写。
   *
   * 存在的理由是不给 HTTP 层第二次装配的机会：它以前在这里自己调一次
   * `createProviders()` 来「诊断」，于是那条路径不传 logger（工厂里的 info 每次
   * `GET /providers` 都被丢掉）、重读一遍 `process.env` 的密钥，而且与真正的装配
   * 迟早对同一个字段给出不同答案 —— architecture.md 说 `rebuildProviders()` 是唯一
   * 装配路径，那么错误也只能有这一个来源。
   */
  providerLoadErrors: () => Map<string, string>;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  plugins: PluginManager;
  engine: AgentEngine;
}

/**
 * 配置档的注册表：`id -> 那份对象图`，加上「读不出一份档」的那半边状态。
 *
 * 为什么它是**接口 + 组合根里的对象字面量**而不是一个类：这份 bundle 必须持有
 * `PluginManager`，而 `scripts/check-layering.mjs` 的 `ALLOWED.core = {core, config}`
 * —— `core/` 里放不下一个 import 得到 `plugins/` 的类。可以选的出路有
 * 「把接口留在 api/、对象留在 app.ts」（这里选的，与仓内既有先例一致）、
 * 「起一个 service locator」、「建一个模块级 Map」。后两条正是 AGENTS.md
 * 「依赖一律走构造参数」一路在拒的形态。
 *
 * `get()` 只对 `ready` 返回对象：`failed` 的那一份**没有对象图**（构造它时就抛了），
 * 所以「拿到 bundle」与「这份档可用」必须是同一个动作，而不是两个可以各自成立的查询。
 */
export interface ProfileDirectory {
  /** 全部配置档 id（含 `failed` 的），按名字排序。 */
  ids(): string[];
  /** 此刻可用的一份对象图；不存在或加载失败时为 `null`。 */
  get(id: string): ProfileBundle | null;
  /** 这份档此刻的状态；id 完全不存在时为 `null`。 */
  status(id: string): ProfileStatus | null;
  /** 全部配置档的状态，含失败的（`GET /profiles` 的数据源）。 */
  records(): ProfileRecord[];
  /**
   * 新建并打开一份配置档。id 不合法或已存在时抛。
   * 顺序是「先落盘、再建对象图」，见 `app.ts` 的实现注释。
   */
  create(id: string, name?: string): Promise<ProfileRecord>;
  /** 只改给人看的名字（写回文件的 `name`），**不改目录名** —— 目录一动，插件数据就跟丢。 */
  rename(id: string, name: string): Promise<ProfileRecord>;
  /** 重读文件并换上新的对象图，然后卸载旧的。失败时保留正在服务的那一份并抛。 */
  reload(id: string): Promise<ProfileRecord>;
  /**
   * 摘掉并卸载一份配置档。
   *
   * 返回 `false` 表示**这个请求什么都没做**：它此刻还占着某个会话
   *（`lock.isInUse`），要等那轮对话结束。占用检查与摘除之间不能有 `await`，
   * 所以这条判据放在目录内部而不是让 handler 先查再删。
   *
   * **永不删文件、永不删 `profiles/<id>/plugins/`**：框架从不删它，清理是操作者的
   * `rm -rf`（`test/plugins.test.ts` 有断言拦着这条）。
   */
  remove(id: string): Promise<boolean>;
}

/**
 * `createHttpServer` 的依赖，由组合根 `app.ts` 注入。
 *
 * 字段类型用各 manager 的**具体类**而不是 `Pick<>`：传输层本来就该知道 manager 的
 * 真实 API（`providerConfig.providers` / `auth.cookieName` / `plugins.reload`…），
 * 它不知道的是业务规则。`Pick` 在这里只会变成一坨比类本身更长的清单。
 *
 * 注意这里**没有** `providers` / `tools` / `plugins` / `engine` 了：那些都属于某一份
 * 配置档，要从 `profiles` 里按请求带来的 `?profile=` 取。留下它们就等于留一条
 * 「handler 忘了选档就用了一份不知道谁的对象图」的活路。
 * 跨配置档共享的只有三样：会话存储、会话锁、事件总线。
 */
export interface HttpDeps {
  config: AppConfig;
  logger: Logger;
  auth: AuthManager;
  sessions: SessionManager;
  lock: SessionLock;
  events: SessionEvents;
  profiles: ProfileDirectory;
  adapters: AdapterManager;
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
 * JSON 解析结果的**形状**判据：非 `null`、`typeof === "object"`、非数组。
 *
 * HTTP 请求体与 WS 帧共用这一个谓词，不是顺手复用 —— 是这两条入站路径必须严格度一致。
 * `JSON.parse` 什么都能给：`null`、`[]`、`5`、`"北京时间"`，而调用方拿到之后读的是
 * `frame.type` / `body.content`。少这一道，一个客户端写错的报文就变成 TypeError：
 * 在 HTTP 那边是「500 + 服务器内部错误」（用户看不出是自己发错了，日志里多一条无关堆栈），
 * 在 WS 那边更糟 —— 异常发生在 `ws` 的 `message` 监听器里，同步冒到 socket 的 data 回调，
 * 成为**未捕获异常直接终止进程**，`app.stop()` 一步都不跑。
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  // **形状**也要在边界上判，不只语法（判据与 WS 帧共用，见 `isJsonObject`）。
  // 空 body 走上面的 `return {}`，所以这里拒的是「有内容但不是对象」。
  if (!isJsonObject(parsed)) {
    throw new ApiError("请求体必须是一个 JSON 对象");
  }
  return parsed;
}
