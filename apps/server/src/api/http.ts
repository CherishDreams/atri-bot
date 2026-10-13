/** JSON HTTP 处理的辅助函数。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProfileRecord, ProfileStatus } from "@atri/shared";
import { ApiError } from "#core/errors.ts";
import type { AppConfig } from "#config/index.ts";
import type { AgentEngine } from "#core/agent/engine.ts";
import type { AuthManager } from "#core/auth/manager.ts";
import type { Logger } from "#core/logger.ts";
import type { ProviderConfigStore, ProviderEntry } from "#core/provider/store.ts";
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
 *
 * 这里**没有** provider 相关的字段了：供应商（连接与模型清单）是部署级全局的一份，
 * 见 `ProviderSurface`。档里只剩「这一档默认用其中哪一个」，也就是 `defaultProviderId`。
 * 曾经这里是 `providerConfig` / `providers` / `reloadProviders` / `providerLoadErrors`
 * 四根字段，每档一套 —— 那套的理由（"换一档换一套后端"）被否掉了：安装插件、配密钥
 * 都是文件系统与部署级动作，按档复制只会让同一个密钥躺在 N 份文件里。
 */
export interface ProfileBundle {
  id: string;
  /** 给人看的名字（配置档文件里的 `name`，缺省为 id）。 */
  name: string;
  /** 这份档的配置文件路径，只用于日志与 `GET /profiles` 的 `path`。 */
  path: string;
  /**
   * 这一档默认用的 provider 实例 id（`null` = 用全局 `providers.default`）。
   *
   * 与 `name` 一样是**可变**的：`POST /profiles/{id}/default-provider` 先落盘再改这里
   * 和 `bundle.engine`，那样下一次发消息立刻生效，而不必等一次重载。
   */
  defaultProviderId: string | null;
  tools: ToolRegistry;
  toolConfig: ToolConfigStore;
  plugins: PluginManager;
  engine: AgentEngine;
}

/**
 * 全局供应商配置的**读视图**：清单 + 默认项 + 「文件读不出来时的那句原因」。
 *
 * 为什么要有这一层，而不是让 handler 直接读 `ProviderConfigStore.providers`：
 * 那个 getter 在文件是半截 JSON 时**抛**，而抛出去的消息里带着绝对路径，且它的后果是
 * 「整个配置页打不开」。装配那一次已经把它 catch 进错误表了，读路径必须同源 ——
 * 于是这里把「读不出来」表达成一个字段，而不是表达成一次异常。
 */
export interface ProvidersView {
  entries: ProviderEntry[];
  defaultId: string | null;
  /** 整个文件读不出来时的原因；`null` 表示读得出来（此时 `entries` 就是真实清单）。 */
  error: string | null;
}

/**
 * 供应商这一层的装配面，由组合根注入。跨配置档**只有一份**。
 *
 * 存在的理由是「写配置的那条路」与「读配置的那条路」必须共用同一个注册表和同一份
 * 失败表：`api/` 以前在 `GET /providers` 里自己调一次 `createProviders()` 来「诊断」，
 * 于是那条路径不传 logger、重读一遍 `process.env` 的密钥，并且迟早与真正的装配
 * 对同一个字段给出不同答案。
 */
export interface ProviderSurface {
  /** 全局那份读写存储（写操作直接落在它上面，然后调 `rebuild()`）。 */
  config: ProviderConfigStore;
  /** 由 `rebuild()` 填的那一份注册表；每一档的引擎共用它。 */
  registry: ProviderRegistry;
  /** 一次成功的写之后重建整张注册表 —— **唯一**装配路径。 */
  rebuild(): ProviderRegistry;
  /** 此刻的配置视图，永不抛（见 `ProvidersView`）。 */
  view(): ProvidersView;
  /**
   * 最近一次装配里没加载成功的 provider（`id -> 中文原因`）。
   * 由 `rebuild()` 整份重写（不是累加），所以它永远与注册表同源。
   */
  loadErrors(): Map<string, string>;
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
  /**
   * 改这一档默认用的 provider 实例；传 `null` 是「取消档级默认，回到全局那一个」。
   *
   * `providerId` 必须在全局清单里存在，否则抛（400）：让它指着一个不存在的实例，
   * 后果是每条消息静默落到注册表的回退上 —— 界面显示的是你选的模型，回的却是另一个。
   */
  setDefaultProvider(id: string, providerId: string | null): Promise<ProfileRecord>;
  /**
   * 一次写入这份档的多段配置 —— 配置工作台那个「保存」按钮背后的东西。
   *
   * 收的是**请求体原样**（`Record<string, unknown>`）而不是一个收窄好的类型：
   * 「拒掉不认识的键」本身就是这条端点的行为之一，把它做成编译期形状就等于
   * 让运行时校验无处可测。校验规则见 `app.ts` 的实现注释。
   *
   * 返回的 `failed` 只可能来自插件那一段（`setEnabled` 会真的加载它，`setup()` 抛错
   * 就是失败），它不是错误码而是**部分生效的清单**：那种时刻必须点名，
   * 而不是回一个 200 让界面回到原样。
   */
  updateConfig(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{
    failed: { id: string; error: string }[];
  }>;
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
 * 真实 API（`auth.cookieName` / `plugins.reload`…），它不知道的是业务规则。`Pick`
 * 在这里只会变成一坨比类本身更长的清单。
 *
 * 属于某一份配置档的东西（`tools` / `plugins` / `engine`）不在这里：那些要从
 * `profiles` 按请求带来的 `?profile=` 取，留下它们就等于留一条
 * 「handler 忘了选档就用了一份不知道谁的对象图」的活路。
 * 跨配置档共享的是四样：会话存储、会话锁、事件总线，以及 `providerSurface` ——
 * 供应商是部署级的，配置页改一次全局生效。
 */
export interface HttpDeps {
  config: AppConfig;
  logger: Logger;
  /**
   * 服务端版本号，`GET /health` 用。由组合根从 `apps/server/package.json` 读一次注入 ——
   * 以前这里写死 `"1.0.0"`，而同一个字符串在本仓有四份（根与三个包的 `package.json`、
   * `openapi.json` 的 `info.version`），bump 之后 `/health` 继续报 1.0.0，
   * 而运维把那句当部署凭证读。判据是「**这个进程**跑的是哪一版」，所以读服务端那一份。
   */
  version: string;
  auth: AuthManager;
  sessions: SessionManager;
  lock: SessionLock;
  events: SessionEvents;
  profiles: ProfileDirectory;
  providerSurface: ProviderSurface;
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
