import { WS_PATH } from "@atri/shared";
import type { ServerFrame } from "@atri/shared";
import {
  authStatus as authStatusOp,
  createSession as createSessionOp,
  deleteSession as deleteSessionOp,
  getSession as getSessionOp,
  listPlugins as listPluginsOp,
  listSessions as listSessionsOp,
  login as loginOp,
  logout as logoutOp,
  me as meOp,
  reloadPlugin as reloadPluginOp,
  setPluginEnabled as setPluginEnabledOp,
  streamMessage,
  unloadPlugin as unloadPluginOp,
} from "./generated/index.js";
import type { Message, StreamChunk } from "./generated/index.js";
// `client` 这个单例只从 client.gen.ts 导出，没有经 index.ts 再导出；
// jsonBodySerializer 则只从 client/index.ts 导出。
import { client } from "./generated/client.gen.js";
import { jsonBodySerializer } from "./generated/client/index.js";

/** 会话失效（HTTP 401）时抛出，调用方据此清空登录态。 */
export class UnauthorizedError extends Error {}

/** 生成客户端失败时的返回形状（AxiosError 上挂了 `error`）。 */
type Failure = {
  isAxiosError?: boolean;
  error?: { error?: string } | undefined;
  response?: { status?: number };
};

/**
 * 把生成客户端的两种返回形态归一成「成功返回值 / 抛出异常」。
 *
 * 生成的 axios 客户端**默认不抛错**：`throwOnError` 为 false 时它把 AxiosError
 * 当普通返回值交出来，只在上面挂一个 `error` 字段。对业务代码来说「失败即异常」
 * 更好用，所以这里统一转成 throw。
 *
 * 判别标志用 `isAxiosError` 而非 `status`：成功的 AxiosResponse 同样带
 * `status: 200`，拿 status 判存在性会把成功当失败。
 */
function unwrap<T>(result: T): T {
  const failure = result as Failure;
  if (failure.isAxiosError !== true) return result;

  const status = failure.response?.status;
  const message = failure.error?.error ?? `请求失败: ${status ?? "网络错误"}`;
  if (status === 401) throw new UnauthorizedError(message);
  throw new Error(message);
}

/** 取成功响应体。 */
function body<T extends { data?: unknown }>(result: T): NonNullable<T["data"]> {
  unwrap(result);
  return result.data as NonNullable<T["data"]>;
}

// 同源访问时 Cookie 默认就会带上；显式声明是为了让「令牌只在 HttpOnly Cookie 里」
// 这件事在代码里可见，而不是靠调用方记得。
//
// bodySerializer 必须显式给：生成的 SDK 不会自动挂上它。
// - axios 路径靠自身序列化对象，所以少了它也能跑；
// - SSE 路径走的是全局 fetch，`getValidRequestBody()` 在没配 bodySerializer 时
//   会把原始对象直接塞进 `new Request(...)`，请求体变成字符串 "[object Object]"，
//   服务端解析 JSON 失败返回 400 —— 这个错只在流式端点上出现，很容易被漏掉。
client.setConfig({ withCredentials: true, ...jsonBodySerializer });

// --- 鉴权 -------------------------------------------------------------------

export async function login(username: string, password: string) {
  return body(await loginOp({ body: { username, password } }));
}

export async function logout(): Promise<void> {
  unwrap(await logoutOp());
}

export async function me() {
  return body(await meOp());
}

export async function authStatus() {
  return body(await authStatusOp());
}

// --- 会话 -------------------------------------------------------------------

export async function listSessions() {
  return body(await listSessionsOp());
}

export async function createSession(title?: string) {
  return body(await createSessionOp({ body: { title } }));
}

export async function getSession(id: string) {
  return body(await getSessionOp({ path: { id } }));
}

export async function deleteSession(id: string) {
  return body(await deleteSessionOp({ path: { id } }));
}

/**
 * 发消息并流式接收回复增量。
 *
 * `sseMaxRetryAttempts: 0` 是必须的：生成的 SSE 客户端跑在一个 `while (true)` 里，
 * 连接异常时会指数退避重连，不传这个参数就等于无限重试——对着一个已经失败的
 * 上游反复发请求。是否重发应该由调用方决定。
 *
 * 另外要注意：SSE 走的是全局 `fetch` 而不是 axios，所以上面的
 * `withCredentials` 对这里不起作用。同源请求本就带 Cookie，跨源部署时需要
 * 自行改用带凭证的 fetch。
 */
export async function* sendMessageStream(
  sessionId: string,
  content: string,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const { stream } = await streamMessage({
    path: { id: sessionId },
    body: { content, model },
    signal,
    sseMaxRetryAttempts: 0,
  });
  for await (const chunk of stream) yield chunk as StreamChunk;
}

// --- 插件 -------------------------------------------------------------------

export async function listPlugins() {
  return body(await listPluginsOp());
}

export async function reloadPlugin(id: string) {
  return body(await reloadPluginOp({ path: { id } }));
}

export async function unloadPlugin(id: string) {
  return body(await unloadPluginOp({ path: { id } }));
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  return body(await setPluginEnabledOp({ path: { id }, body: { enabled } }));
}

// --- WebSocket（codegen 不覆盖，手写保留）-----------------------------------

/**
 * 订阅服务端出站事件。返回取消订阅函数。
 *
 * WebSocket 的握手与帧协议不属于 OpenAPI 能描述的范围，所以这一段仍是手写的：
 * 生成物只覆盖 HTTP 与 SSE。
 */
export function connect(onFrame: (frame: ServerFrame) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
  ws.addEventListener("message", (ev) => {
    try {
      onFrame(JSON.parse(ev.data) as ServerFrame);
    } catch {
      /* 忽略格式错误的帧 */
    }
  });
  return () => ws.close();
}

export type { Message };
