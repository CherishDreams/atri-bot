import { API_PREFIX, WS_PATH } from "@atri/shared";
import type { ServerFrame } from "@atri/shared";
import {
  authStatus as authStatusOp,
  createProvider as createProviderOp,
  createProviderSource as createProviderSourceOp,
  createSession as createSessionOp,
  deleteProvider as deleteProviderOp,
  deleteProviderSource as deleteProviderSourceOp,
  deleteSession as deleteSessionOp,
  fetchProviderModels as fetchProviderModelsOp,
  getProfileConfig as getProfileConfigOp,
  getPluginConfig as getPluginConfigOp,
  savePluginConfig as savePluginConfigOp,
  getSession as getSessionOp,
  createProfile as createProfileOp,
  deleteProfile as deleteProfileOp,
  listPlugins as listPluginsOp,
  listAdapters as listAdaptersOp,
  listLogs as listLogsOp,
  listProfiles as listProfilesOp,
  saveProfileConfig as saveProfileConfigOp,
  listProviderSources as listProviderSourcesOp,
  listProviders as listProvidersOp,
  listSessions as listSessionsOp,
  listTools as listToolsOp,
  login as loginOp,
  logout as logoutOp,
  me as meOp,
  setDefaultProvider as setDefaultProviderOp,
  reloadPlugin as reloadPluginOp,
  setPluginEnabled as setPluginEnabledOp,
  setToolEnabled as setToolEnabledOp,
  streamMessage,
  unloadPlugin as unloadPluginOp,
  updateProvider as updateProviderOp,
  updateProviderSource as updateProviderSourceOp,
} from "./generated/index.js";
import type {
  LogEntry,
  ProviderInput,
  ProviderSourceInput,
  ProviderSourceUpdate,
  ProviderUpdate,
  ProfileConfigPatch,
  StreamChunk,
} from "./generated/index.js";
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
 *
 * 这里只管 **axios** 那条路。流式端点走全局 `fetch`，同一个 401→`UnauthorizedError` 规则
 * 在 `sseFetch` 里另写一遍 —— 一个规则两个出口是因为生成客户端用了两套传输栈，
 * 不是两份规则。改的时候两处一起改。
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

/**
 * SSE 那一侧的错误出口。
 *
 * **一条规则，两套栈**：非流式走 axios（`generated/client.gen.ts` 用的是 `_axios`，
 * 压根不碰 `fetch`），流式走全局 `fetch`。「401 → `UnauthorizedError`」这条规则因此必须
 * 在 `unwrap()` 与这里各写一遍 —— 两处注释互相指一次，别有人「顺手统一」成一份而漏掉另一份。
 *
 * 为什么必须由我们包装：生成的 SSE 循环在 `!response.ok` 时抛的是
 * `SSE failed: 409 Conflict` 这种内部话术，紧接着被同一个 try 的 catch 吞掉、
 * 因为 `sseMaxRetryAttempts: 0` 直接 break —— 用户看到的是「回复流意外中断」，
 * 而服务端明明说清了「这个会话有一次对话还没结束」。读 `{error}` 再抛是唯一能把那句话
 * 送上界面的位置。
 *
 * 它是挂在**每次请求**的 options 上，不是 `client.setConfig`：生成的
 * `Config<ClientOptions>` 里没有 `fetch` 这一根键（写进去被类型直接拒），而
 * `ServerSentEventsOptions` 有 —— 这也正说明这个口子是 SSE 专属的，axios 那条路不读它。
 */
async function sseFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await globalThis.fetch(input, init);
  if (res.ok) return res;
  let detail = "";
  try {
    detail = String(((await res.json()) as { error?: unknown }).error ?? "");
  } catch {
    // 响应体不是 JSON（前置代理吐的 502 页之类）：下面退回状态码本身。
  }
  // 用户看到一句话，永远比看到一个精确的句子重要。
  const message = detail || `请求失败: ${res.status}`;
  if (res.status === 401) throw new UnauthorizedError(message);
  throw new Error(message);
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

// --- 日志 -------------------------------------------------------------------

/** 最近的程序日志。`limit` 由服务端夹在 1–500，默认 200。 */
export async function listLogs(limit = 200) {
  return body(await listLogsOp({ query: { limit } }));
}

/**
 * 订阅实时日志。先由服务端补发 `after` 之后的缓冲区内容，再持续推送。
 *
 * 这里手写而不用生成的 SSE 客户端：生成的循环自带重连，而重连时机与 `after`
 * 续传必须由调用方掌握（见 `stores/logs.ts` 的序号对账）。用同一套 fetch 泵，
 * 401 也走 `sseFetch` 的统一出口。
 */
export async function* streamLogs(after: number, signal?: AbortSignal): AsyncGenerator<LogEntry> {
  const url = new URL(`${API_PREFIX}/logs/stream`, window.location.origin);
  url.searchParams.set("after", String(after));
  const res = await sseFetch(url, {
    credentials: "include",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.body) throw new Error("日志流没有响应体");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        // 边界收窄：服务端发的就是 LogEntry，形状由 openapi 与响应形状守卫钉着。
        yield JSON.parse(data.slice(6)) as LogEntry;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// --- 会话 -------------------------------------------------------------------

/**
 * 两个列表接口的游标分页参数。
 *
 * `before` 就是上一次响应里的 `nextCursor`（不透明串，前端不解析，只原样传回）。
 * 刻意不收 `null`：生成类型那侧也是 `string`（OpenAPI 的 query 参数没有 null 这个形状），
 * 而「翻到顶」的正确表达是**不再发这一页的请求**，不是把哨兵值传过去 ——
 * 服务端把空串当非法游标回 400，传 null 上去只会得到一个说不清的 400。
 * 那条由 store 守住（`loadEarlier()` / `loadMoreSessions()` 开头都先判 `cursor === null`）。
 */
export interface PageQuery {
  limit?: number;
  before?: string;
}

export async function listSessions(query?: PageQuery) {
  return body(await listSessionsOp({ query }));
}

export async function createSession(title?: string) {
  return body(await createSessionOp({ body: { title } }));
}

export async function getSession(id: string, query?: PageQuery) {
  return body(await getSessionOp({ path: { id }, query }));
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
  profile: string,
  sessionId: string,
  content: string,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // 生成的循环会把 `fetch` 抛出的任何东西 catch 掉（`core/serverSentEvents.gen.ts` 里
  // 那个 catch 只调 `onSseError` 再 break），所以不接这个回调，409 与 401 就变成
  // 「流安静地结束、界面留一条空回复」。捞回来存着，等迭代结束后再抛 ——
  // 在 generator 里直接抛会让消费方的 `for await` 拿到一个没有上下文的错。
  let failure: unknown = null;
  // 生成物的 `RequestOptions` 只从 `ServerSentEventsOptions` 里 pick 了
  // `onRequest` / `onSseError` / `onSseEvent` / `sseDefaultRetryDelay` /
  // `sseMaxRetryAttempts` / `sseMaxRetryDelay`，**唯独漏了 `fetch`** —— 而运行时那一行
  // 读的就是 `options.fetch`（`core/serverSentEvents.gen.ts` 的
  // `options.fetch ?? globalThis.fetch`）。写成 `fetch: sseFetch` 会被对象字面量的
  // excess-property 检查拒掉，`as any` 会把整份 options 的校验一起丢掉；用一个具名变量
  // 展开进去，是把「类型里没有、运行时认」这一件事单独说清楚，也让升级 openapi-ts 之后
  // 的下一个人在 diff 里看得见它。
  const fetchOverride = { fetch: sseFetch };
  const { stream } = await streamMessage({
    path: { id: sessionId },
    query: { profile },
    body: { content, model },
    signal,
    ...fetchOverride,
    sseMaxRetryAttempts: 0,
    onSseError: (err: unknown) => {
      // 切页面 / 关停会让 `signal.abort()` 抛 AbortError，那是**正常路径**，不是故障。
      if (err instanceof DOMException && err.name === "AbortError") return;
      failure ??= err;
    },
  });
  for await (const chunk of stream) yield chunk as StreamChunk;
  if (failure) throw failure;
}

// --- 插件 -------------------------------------------------------------------

export async function listPlugins(profile: string) {
  return body(await listPluginsOp({ query: { profile } }));
}

export async function reloadPlugin(profile: string, id: string) {
  return body(await reloadPluginOp({ path: { id }, query: { profile } }));
}

export async function unloadPlugin(profile: string, id: string) {
  return body(await unloadPluginOp({ path: { id }, query: { profile } }));
}

export async function setPluginEnabled(profile: string, id: string, enabled: boolean) {
  return body(await setPluginEnabledOp({ path: { id }, body: { enabled }, query: { profile } }));
}

/** 读一份插件的 `_conf_schema.json` 与当前生效值；schema 坏了也能打开，原因在 `schemaError`。 */
export async function getPluginConfig(profile: string, id: string) {
  return body(await getPluginConfigOp({ path: { id }, query: { profile } }));
}

/**
 * 保存插件配置。**只发改过的项**（与配置工作台同一条 diff 语义）；服务端保存后会重载插件，
 * 重载失败不影响保存本身 —— 原因在 `reloadError` 里，两件事界面要分开说。
 */
export async function savePluginConfig(
  profile: string,
  id: string,
  values: { key: string; value: string | number | boolean }[],
) {
  return body(await savePluginConfigOp({ path: { id }, body: { values }, query: { profile } }));
}

// --- 工具（function calling）-------------------------------------------------

export async function listTools(profile: string) {
  return body(await listToolsOp({ query: { profile } }));
}

/**
 * 启用 / 禁用一颗工具。`enabled` 是必填参数（不是可选补丁）：
 * 服务端刻意不接受「省略即启用」，UI 也不该有那种调用方式。
 */
export async function setToolEnabled(profile: string, id: string, enabled: boolean) {
  return body(await setToolEnabledOp({ path: { id }, body: { enabled }, query: { profile } }));
}

// --- 模型 provider -----------------------------------------------------------
//
// 这一族**都不带 `profile`**：源与实例是部署级全局的一份（服务端的 `providers.json`），
// 在这里保存一次，每一档下一次发消息用的就是它。「这一档默认用清单里的哪一个」
// 在 `setDefaultProvider` 上 —— 那才是档的属性。

export async function listProviders() {
  return body(await listProvidersOp());
}

export async function createProvider(input: ProviderInput) {
  return body(await createProviderOp({ body: input }));
}

export async function updateProvider(id: string, patch: ProviderUpdate) {
  return body(await updateProviderOp({ path: { id }, body: patch }));
}

export async function deleteProvider(id: string) {
  return body(await deleteProviderOp({ path: { id } }));
}

export async function listProviderSources() {
  return body(await listProviderSourcesOp());
}

export async function createProviderSource(input: ProviderSourceInput) {
  return body(await createProviderSourceOp({ body: input }));
}

export async function updateProviderSource(id: string, patch: ProviderSourceUpdate) {
  return body(await updateProviderSourceOp({ path: { id }, body: patch }));
}

/**
 * 删除一个源。`cascade` 为真时连同引用它的 provider 一起删。
 *
 * 不传 cascade 时，若还有 provider 引用该源，服务端回 400 并列出引用者——
 * 这里不替调用方做决定，让它把服务端的解释原样展示给用户。
 */
export async function deleteProviderSource(id: string, cascade = false) {
  return body(await deleteProviderSourceOp({ path: { id }, query: { cascade } }));
}

/**
 * 用**已保存的**源去拉上游的模型列表。
 *
 * 没有 baseUrl/apiKey 参数：凭据来自服务端已落盘的配置，否则这个端点会变成
 * 「带任意凭证访问任意地址」的转发器。因此调用方必须先保存改动再调用。
 */
export async function fetchProviderModels(id: string) {
  return body(await fetchProviderModelsOp({ path: { id } }));
}

// --- WebSocket（codegen 不覆盖，手写保留）-----------------------------------

/**
 * 订阅服务端出站事件。返回取消订阅函数。
 *
 * WebSocket 的握手与帧协议不属于 OpenAPI 能描述的范围，所以这一段仍是手写的：
 * 生成物只覆盖 HTTP 与 SSE。
 */
/** 实时连接的状态。`retrying` 与 `closed` 必须能让界面说清楚，见下面 `connect`。 */
export type LiveStatus = "open" | "retrying" | "closed";

/** 重连退避：首次 1s，之后翻倍，封顶 15s（本仓自选，理由见 `connect`）。 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * 订阅服务端出站事件。返回取消订阅函数。
 *
 * WebSocket 的握手与帧协议不属于 OpenAPI 能描述的范围，所以这一段仍是手写的：
 * 生成物只覆盖 HTTP 与 SSE。
 *
 * **断了要重连，并且要让调用方知道现在没连上。** 以前这里只接 `message`：
 * 服务端重启（一次发版就够）之后，这条连接安静地不再收任何 `message` 帧，
 * 而页面看起来一切正常 —— 用户要等到「别人都在动而我这页不动」才发现，
 * 而那已经是一次需要解释的故障了。
 *
 * 退避取 1s 起、翻倍、封顶 15s：一次重启通常在几秒内完成，所以第一档要快；
 * 封顶是为了服务端真的不在时不要每分钟敲两百次。关掉页面（`onBeforeUnmount`
 * 走那个 disposer）时**不再重连** —— 那是我们自己关的，不是断了。
 *
 * 握手被拒（登出后 401）也走 `close`，会照旧退避重试；这不影响正确性，因为路由守卫
 * 已经把人带回登录页，而那里的卸载会调用 disposer。
 */
export function connect(
  onFrame: (frame: ServerFrame) => void,
  onStatus?: (status: LiveStatus) => void,
): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const openOnce = (): void => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
    ws.addEventListener("open", () => {
      attempt = 0;
      onStatus?.("open");
    });
    ws.addEventListener("message", (ev) => {
      try {
        onFrame(JSON.parse(ev.data) as ServerFrame);
      } catch {
        /* 忽略格式错误的帧 */
      }
    });
    ws.addEventListener("close", () => {
      if (closed) return;
      attempt += 1;
      onStatus?.("retrying");
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      if (timer) clearTimeout(timer);
      timer = setTimeout(openOnce, delay);
    });
  };

  openOnce();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    ws?.close();
    ws = null;
    onStatus?.("closed");
  };
}

export type {
  AdapterInfo,
  Message,
  ProfileConfig,
  ProfileConfigPatch,
  ProviderInfo,
  ProviderSource,
  ProviderSourceInput,
  ProviderSourceUpdate,
  ProviderUpdate,
  ProviderInput,
  ToolInfo,
} from "./generated/index.js";

/**
 * 接入平台列表。**只读**：`adapters` 段今天只能改 `atri.config.json`，没有写端点。
 * `enabled` 与 `bound` 是两件事（没关掉 / 绑的档现在可用），两个都为真才真的在收流量。
 */
export async function listAdapters() {
  return body(await listAdaptersOp());
}

// --- 配置档 ---------------------------------------------------------------

/**
 * 全部配置档及其加载状态。
 *
 * `error` 只在 `status === "failed"` 时非空，且只给操作者看：那句原文带着
 * 配置文件的绝对路径（`readConfigFileAt` 拼进去的），所以它出现在这个
 * 鉴权闸门内的列表里，而绝不出现在任何 4xx/5xx 响应体里。
 */
export async function listProfiles() {
  return body(await listProfilesOp());
}

export async function createProfile(id: string, name?: string) {
  return body(await createProfileOp({ body: { id, ...(name === undefined ? {} : { name }) } }));
}

/**
 * 改这份配置档默认用的 provider 实例（全局那份清单里的 id）。
 *
 * 传 `null` 是**取消档级默认**，回到全局 `providers.default`，与「不提交这一键」是两件事
 *（服务端对后者回 400），所以这里的参数类型是 `string | null` 而不是可选。
 */
export async function setDefaultProvider(id: string, providerId: string | null) {
  return body(await setDefaultProviderOp({ path: { id }, body: { providerId } }));
}

/**
 * 一份配置档此刻的可编辑内容（默认模型、单轮步数、工具与插件的开关）。
 *
 * 四段一次读而不是让界面拼 `GET /tools` + `GET /plugins` + `GET /profiles`：
 * 那三份之间没有原子性，两次请求之间恰好有人改了档，草稿的起点就自相矛盾，
 * 而下一次保存会把这份矛盾写回磁盘。
 */
export async function getProfileConfig(id: string) {
  return body(await getProfileConfigOp({ path: { id } }));
}

/**
 * 保存这批改动。`patch` 是 **diff**：省略的键服务端不动，所以另一个标签页
 * 改过的项不会被这里悄悄写回旧值。
 *
 * 返回的 `config` 是服务端**回读**的那一份（不是把草稿原样还回来），而 `failed`
 * 是同一批里没能生效的插件项 —— 它非空时界面必须点名，不能显示成全部成功。
 */
export async function saveProfileConfig(id: string, patch: ProfileConfigPatch) {
  return body(await saveProfileConfigOp({ path: { id }, body: patch }));
}

/**
 * 删除一份配置。409 表示它还占着某个会话（那一轮对话还没结束）。
 *
 * 服务端连同 `profiles/<id>/` 整个目录（`config.json` 与插件数据）一起删掉，
 * 不可恢复；被占用时那一步根本不会发生。
 */
export async function deleteProfile(id: string) {
  return body(await deleteProfileOp({ path: { id } }));
}
