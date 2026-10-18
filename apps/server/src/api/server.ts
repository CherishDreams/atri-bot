import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ServerFrame, ToolInfo } from "@atri/shared";
import { API_PREFIX, APP_NAME, WS_PATH } from "@atri/shared";
import { createProviders } from "#core/provider/factory.ts";
import type { ProviderEntry } from "#core/provider/store.ts";
import type { ToolDefinition } from "#core/tool/types.ts";
import type { PageOptions } from "#core/session/manager.ts";
import { Router } from "./router.ts";
import {
  isJsonObject,
  readJson,
  sendError,
  sendJson,
  sendSse,
  startSse,
  type HttpDeps,
  type ProfileBundle,
} from "./http.ts";
import { parseCookies, clearSessionCookie, requireAuth, setSessionCookie } from "./auth.ts";
import { errorMessage, errorStack, statusForError, ApiError } from "#core/errors.ts";
import { LOG_BUFFER_CAPACITY, LOG_DEFAULT_LIMIT } from "#core/logger.ts";
import { SESSION_BUSY_MESSAGE, SESSION_BUSY_DELETE_MESSAGE } from "#core/session/lock.ts";

/**
 * provider 实例在 `GET /providers` 里的元素：磁盘条目 + 这一条路由额外补上的运行时标注。
 *
 * 导出的理由：这个形状只存在于 HTTP 层（磁盘上没有 `loaded`/`error`），但**前端与测试都得
 * 重述它一遍**。留在原地各写一份，就会漂移到「测试里的形状比接口更宽松」，那时测试不再
 * 背书响应体。写操作（POST/PATCH）的响应见 `ProviderMutationResult`，它刻意不含
 * `loaded`：那条路径刚重建过注册表，返回值里没有这个信息。
 */
export type ProviderListItem = ProviderEntry & {
  /** 是不是保留键 `providers.default` 指向的那一个。 */
  default: boolean;
  /** 是不是真的注册进了工厂（配置里写着 ≠ 跑得起来）。 */
  loaded: boolean;
  /** 加载失败的原因，只在 `loaded: false` 时出现。 */
  error?: string;
};

/** 写操作（POST /providers、POST /providers/:id）的响应形状。 */
export type ProviderMutationResult = ProviderEntry & { default: boolean };

/**
 * 磁盘条目 -> 对外条目：补 `name` 的兜底。
 *
 * 规格里 `ProviderInfo.name` 是必填，而磁盘条目可以没有它（人手工编辑
 * `atri.config.json` 时只写 model 就足够跑起来），前端 ProviderCard 又直接显示它。
 * 与 `factory.ts` 构造实例时的 `name: merged.name ?? id` 用同一个兜底，否则会出现
 * 「注册表里显示 A、配置页里显示空」这种只有界面能看见的分裂。
 */
function viewListEntry(entry: ProviderEntry): ProviderEntry {
  return entry.name ? entry : { ...entry, name: entry.id };
}

/**
 * 写操作的响应形状。
 *
 * 补一个 `default` 字段：前端拿到响应后能直接更新高亮，不必为了「刚才设的
 * 默认项生效了吗」再拉一次列表。默认项来自保留键，所以由调用方传入。
 */
function viewProvider(entry: ProviderEntry, defaultId: string | null): ProviderMutationResult {
  return { ...viewListEntry(entry), default: entry.id === defaultId };
}

/**
 * 注册表条目 -> 对外视图。
 *
 * `enabled` 必须由调用方现问 `ToolConfigStore`，不能从注册表推：注册表只管「存在」，
 * 启用与否是每次现读文件的结果（见 `core/tool/store.ts` 的类注释）。
 * `parameters` 刻意不出去 —— 它是给模型的 JSON Schema，控制台不需要，把它带上等于
 * 让响应形状跟着工具实现走，每加一颗工具都得回头改规格。
 */
function viewTool(tool: ToolDefinition, enabled: boolean): ToolInfo {
  return {
    id: tool.id,
    name: tool.name ?? tool.id,
    enabled,
    description: tool.description,
  };
}

/**
 * 一份对象图 -> `ProfileConfig` 响应体。
 *
 * 抽出来给读和写两条路由共用：保存之后必须**回读**，界面拿到的要是服务端此刻的事实，
 * 而不是它自己发出去的那份草稿 —— 而"回读"与"读"若是两份实现，保存就会开始说谎。
 * 每一段仍由各自的存储现算，这里只做搬运（与 `GET /tools` 共用 `viewTool`）。
 */
function profileConfigView(bundle: ProfileBundle) {
  return {
    id: bundle.id,
    name: bundle.name,
    defaultProviderId: bundle.defaultProviderId,
    // 夹取后的生效值，不是文件里的原值：见 `ProfileConfig.maxToolSteps` 的注释。
    maxToolSteps: bundle.toolConfig.maxSteps(),
    tools: bundle.tools.list().map((tool) => viewTool(tool, bundle.toolConfig.isEnabled(tool.id))),
    plugins: bundle.plugins.list(),
  };
}

/**
 * 探针实例的占位模型名。`listModels()` 不看模型，但工厂要求 model 非空，
 * 且这个值永远不会被发到上游——用个显眼的名字，万一出现在日志里也能一眼认出。
 */
const MODEL_LIST_PROBE = "__model_list_probe__";

/**
 * 无需登录即可访问的路径。`/auth/status` 必须公开——否则前端在渲染登录页之前
 * 无法得知「要不要登录」。
 */
const PUBLIC_PATHS = new Set([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/auth/login`,
  `${API_PREFIX}/auth/logout`,
  `${API_PREFIX}/auth/status`,
]);

/**
 * 用 `Record<string, string>` 而不是 `keyof typeof`：扩展名键集天然开放，
 * 而 `?? "application/octet-stream"` 那条 fallback **本来就是** `in` 判定，
 * 套一层 `keyof` 只会把 `??` 变成死代码。
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * HTTP + WebSocket API。这一层只做「传输 <-> 核心调用」的翻译，
 * 不含任何业务逻辑。路由处理函数直接委托给各个 manager。
 */
export function createHttpServer(deps: HttpDeps) {
  const {
    config,
    logger,
    logs,
    version,
    sessions,
    lock,
    events,
    profiles,
    providerSurface,
    adapters,
    auth,
  } = deps;

  const cookieName = auth.cookieName;
  const router = new Router();

  /**
   * 从查询串里选出**这次请求要用哪一份配置档**，并把不可用的那些直接回掉。
   *
   * 三条判据分开，是因为它们是三件不同的事，而合成一句「用不了」会让人猜：
   * - 没带 `profile` → **400**。绝不回落到 `default`：那正是「错了也看不出来」的那类默认，
   *   而控制台的界面会在一次写错档的操作上显示绿勾。
   * - 这个 id 压根不存在 → **404**（「没这东西」）。
   * - 存在但加载失败 → **503**（「你配坏了」）。两者分开是仓内一贯的选择，
   *   `GET /providers` 带着失败条目同是一条决定。
   *
   * 503 那句刻意**不带原因原文**：`readConfigFileAt` 的消息里躺着配置文件的绝对路径，
   * 而 5xx 的固定文案纪律只写在 `fail()` 里 —— 从守卫直接 `sendError` 会绕过它。
   * 原因由 `GET /profiles` 的 `error` 字段给操作者看（那是鉴权闸门内的出口）。
   *
   * @returns 可用的一份对象图；已经回完响应时返回 `null`，调用方直接 `return`
   */
  function scopedProfile(req: IncomingMessage, res: ServerResponse): ProfileBundle | null {
    const id = searchOf(req).get("profile");
    if (id === null || id === "") {
      sendError(res, 400, "缺少 profile 参数（要操作哪一份配置）");
      return null;
    }
    return profileById(res, id);
  }

  /**
   * 按**路径里的档 id** 取那一份对象图，不可用的直接回掉。
   *
   * 三条判据与 `scopedProfile` 完全同一条（400 缺参数 / 404 没这东西 / 503 你配坏了），
   * 差别只在 id 从哪来：`/profiles/{id}/…` 那一族（rename / reload / default-provider /
   * config）的档 id 本来就在路径上，再要求一份 query 参数就是同一个值写两遍 ——
   * 而两处不一致时听谁的，是一件没有答案的事。
   *
   * @returns 可用的一份对象图；已经回完响应时返回 `null`，调用方直接 `return`
   */
  function profileById(res: ServerResponse, id: string): ProfileBundle | null {
    const status = profiles.status(id);
    if (status === null) {
      sendError(res, 404, `没有这份配置: ${id}`);
      return null;
    }
    const bundle = profiles.get(id);
    if (bundle === null) {
      // 503 那句刻意不带原因原文：`readConfigFileAt` 的消息里躺着配置文件的绝对路径。
      sendError(res, 503, `配置「${id}」当前不可用，原因见 GET /profiles`);
      return null;
    }
    return bundle;
  }

  /**
   * 进行中的**一轮回复**（SSE 与非流式都往里放），值就是各自的 abort 入口。
   *
   * `server.close()` 会等所有连接自然结束，而流式响应是长连接：不主动收尾，关闭就会一直
   * 挂到上游超时（实测有客户端开着流时 `stop()` 要等 120s+）。非流式端点也要进来，
   * 否则关停时它不在任何集合里，而它占着的**会话锁**会让下一轮直接 409。
   */
  const openStreams = new Set<AbortController>();

  /**
   * handler 自带 catch 时的唯一出口：**5xx 的原文一律不回客户端**。
   *
   * 之前十个 handler 各写一遍 `sendError(res, statusForError(err), errorMessage(err))`，
   * 而 `statusForError` 对不带 status 的错误给 500 —— 于是存储故障的原始错误
   * （`core/provider/store.ts` 那句里带着**配置文件的绝对路径**）被原样发出去了，
   * 与同一个文件里顶层兜底那句「500 的文案固定，细节只在日志」正好相反。
   * 两处规则相反，说明其中一处本来就该是函数。
   *
   * 4xx 仍然原样回：那是使用方问题，消息本身就是给用户的中文说明（「必须提供 content」
   * 「未知插件」），藏起来只会让人无法自助。
   */
  function fail(res: ServerResponse, err: unknown): void {
    // 响应已经开始写了就没有第二次机会：SSE 与静态托管都在「已经发头」之后还可能抛，
    // 那时候唯一正确的动作是别再往一个正在成的响应里塞第二个状态码。
    if (res.headersSent) return;
    const status = statusForError(err);
    if (status < 500) {
      // 4xx 是使用方问题，只记一句：打堆栈会把真正的故障淹掉。
      logger.warn(`请求被拒绝 (${status}): ${errorMessage(err)}`);
      sendError(res, status, errorMessage(err));
      return;
    }
    logger.error(`请求处理出错: ${errorStack(err)}`);
    // 不把内部错误原文回出去：**5xx 一律固定文案**，细节只在日志里。这一条对
    // `ApiError(…, 500)` 也成立（存储层那句「保存 X 失败，详情见服务端日志」因此只进日志），
    // 判据不是「这条消息看起来安全」而是「凡是 5xx 都不往外说」—— 后者不需要每次都判断对。
    sendError(res, 500, "服务器内部错误，详情见服务端日志");
  }

  router.get(`${API_PREFIX}/health`, async (_req, res) => {
    // 版本由装配注入（见 `readServerVersion`）：写死这一句时它与 package.json、
    // openapi.json 各说各话，bump 之后运维拿到的是一条假凭证。
    sendJson(res, 200, { ok: true, app: APP_NAME, version });
  });

  // --- 日志 ---------------------------------------------------------------
  //
  // 日志是**进程级**的，不属于任何一份配置档，所以这一组不带 `?profile=`。
  // 它也不是「配置文件」：缓冲区在内存里，重启即清空。

  router.get(`${API_PREFIX}/logs`, async (req, res) => {
    const raw = searchOf(req).get("limit");
    const limit = raw === null ? LOG_DEFAULT_LIMIT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LOG_BUFFER_CAPACITY) {
      return sendError(res, 400, `limit 必须是 1–${LOG_BUFFER_CAPACITY} 的整数`);
    }
    sendJson(res, 200, { instance: logs.instance, logs: logs.recent(limit) });
  });

  /**
   * 实时日志流。先补发历史，再订阅新的；`id:` 行就是日志序号，客户端重连时带回来。
   *
   * 选 SSE 而不是复用聊天 WS：日志是**单向**的，SSE 天然支持断线重连与 `Last-Event-ID`，
   * 也不需要给聊天协议加一种只有日志页关心的帧。会话增量流已经证明这条传输可用。
   */
  router.get(`${API_PREFIX}/logs/stream`, async (req, res) => {
    const search = searchOf(req);
    const header = req.headers["last-event-id"];
    const rawAfter = search.get("after") ?? (Array.isArray(header) ? header[0] : header);
    let after: number | null = null;
    if (rawAfter !== undefined && rawAfter !== null && rawAfter !== "") {
      after = Number(rawAfter);
      if (!Number.isInteger(after) || after < 0) {
        return sendError(res, 400, "after 必须是 ≥ 0 的整数");
      }
    }

    startSse(res);
    const controller = new AbortController();
    openStreams.add(controller);

    let closed = false;
    let keepalive: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    const stop = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive !== null) clearInterval(keepalive);
      unsubscribe?.();
      openStreams.delete(controller);
      if (!res.writableEnded) res.end();
    };
    // `http.close()` 会 abort 这个集合里的每个 controller；日志流没有上游请求可中断，
    // 但必须在这里结束响应，否则 keepalive 定时器会让 server.close() 一直等下去。
    controller.signal.addEventListener("abort", stop, { once: true });
    res.on("close", () => controller.abort());

    unsubscribe = logs.subscribe((entry) => {
      if (closed || res.writableEnded || res.destroyed) return;
      sendSse(res, entry, "log", entry.id);
    });
    keepalive = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) {
        controller.abort();
        return;
      }
      res.write(": keepalive\n\n");
    }, 15_000);

    const history = after === null ? logs.recent(LOG_DEFAULT_LIMIT) : logs.after(after);
    for (const entry of history) {
      if (closed || res.writableEnded || res.destroyed) break;
      sendSse(res, entry, "log", entry.id);
    }
  });

  // --- 鉴权 ---------------------------------------------------------------
  router.post(`${API_PREFIX}/auth/login`, async (req, res) => {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendError(res, 400, errorMessage(err));
    }

    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string") {
      return sendError(res, 400, "必须提供 `username` 与 `password`（字符串）");
    }

    const result = auth.login(username, password);
    // 用户名错误与口令错误返回同一句话，避免枚举出账号是否存在。
    if (!result) return sendError(res, 401, "账号或密码错误");

    setSessionCookie(res, cookieName, result.token, { secure: auth.cookieSecure });
    logger.info(`登录成功: ${result.user.username}`);
    sendJson(res, 200, { user: result.user, expiresAt: result.expiresAt });
  });

  router.post(`${API_PREFIX}/auth/logout`, async (req, res) => {
    // 幂等：没有令牌、令牌已失效都算登出成功，避免前端卡在登录态。
    const token = parseCookies(req)[cookieName];
    if (token) auth.logout(token);
    clearSessionCookie(res, cookieName, { secure: auth.cookieSecure });
    sendJson(res, 200, { ok: true });
  });

  router.get(`${API_PREFIX}/auth/me`, async (req, res) => {
    const session = requireAuth(auth, req, res);
    if (!session) return;
    sendJson(res, 200, { user: session.user, expiresAt: session.expiresAt });
  });

  router.get(`${API_PREFIX}/auth/status`, async (_req, res) => {
    sendJson(res, 200, { required: auth.enabled });
  });

  // --- 会话 ---------------------------------------------------------------
  // 两个列表接口都是**游标分页**：默认给最新的一页，`nextCursor` 非 null 就还能往前翻。
  // 判据（默认值、上限、非法值 400）全在 `core/session/manager.ts`，这里只做搬运 ——
  // 范围在这里再判一次就会变成两处数字，而规格只有一处能写对。
  router.get(`${API_PREFIX}/sessions`, async (req, res) => {
    const page = sessions.list(pageOptions(searchOf(req)));
    sendJson(res, 200, page);
  });

  router.post(`${API_PREFIX}/sessions`, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { session: sessions.create(body) });
  });

  router.get(`${API_PREFIX}/sessions/:id`, async (req, res, params) => {
    const page = sessions.getDetail(params.id, pageOptions(searchOf(req)));
    if (!page) return sendError(res, 404, "会话不存在");
    sendJson(res, 200, { session: page.detail, nextCursor: page.nextCursor });
  });

  router.delete(`${API_PREFIX}/sessions/:id`, async (_req, res, params) => {
    // 判据与 `profiles.remove` 同一条，只是方向反过来：那里查「这个配置档占着任何会话」，
    // 这里查「这个会话正被占着」。不查的后果是那一轮之后的每次 `#record` 都落到
    // `appendMessage` 的 404（会话已经没了），流式端点以一个 error 帧收场，
    // 而已经生成的那半轮无处可查 —— 用户看到的是一次莫名其妙的失败，
    // 实际是他自己在它跑着的时候把地基抽掉了。
    if (lock.has(params.id)) return sendError(res, 409, SESSION_BUSY_DELETE_MESSAGE);
    const ok = sessions.delete(params.id);
    // 失败时回标准错误体而不是 `{ deleted: false }`：404 配一个成功形状的身体，
    // 客户端只能靠状态码猜，而规格里这个分支声明的是 `{ error }`。
    if (!ok) return sendError(res, 404, "会话不存在");
    sendJson(res, 200, { deleted: true });
  });

  router.post(`${API_PREFIX}/sessions/:id/messages`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    const body = await readJson(req);
    if (typeof body.content !== "string" || body.content.length === 0) {
      return sendError(res, 400, "必须提供 `content`（字符串）");
    }
    // 与流式端点一致：会话不存在是 404。以前它被下面的 catch 一并算成 400，
    // 于是「发消息给一个已经被删掉的会话」和「content 写错了」共用同一个状态码。
    if (!sessions.has(params.id)) return sendError(res, 404, "会话不存在");
    // 客户端断开要能中止这一轮 —— 与流式端点同一个理由，但这里的后果更严重：
    // 会话锁按会话持有（`SessionLock`），没人等的轮次跑完之前，用户下一条
    // 消息只会得到 409；而 `http.close()` 也拦不住它 —— `openStreams` 此前只装 SSE 控制器。
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    openStreams.add(controller);
    try {
      const reply = await bundle.engine.handleMessage({
        sessionId: params.id,
        content: body.content,
        model: readModel(body),
        signal: controller.signal,
      });
      sendJson(res, 200, { message: reply });
    } catch (err) {
      if (controller.signal.aborted) {
        // 是人走了，不是服务坏了：按服务端故障记一条 error 堆栈会把真问题淹掉。
        logger.debug(`客户端断开，已中断回复: ${params.id}`);
        return;
      }
      // 带 status 的错误自己说话 —— 409「这个会话有一次对话还没结束」就是新加的那一种。
      // 不直接套 `statusForError`：那会把「已达单轮工具调用步数上限」（引擎在步数耗尽时
      // 抛的那条普通 Error）从 400 升成 500，那是明显的行为退化。
      sendError(res, err instanceof ApiError ? err.status : 400, errorMessage(err));
    } finally {
      res.off("close", onClose);
      openStreams.delete(controller);
    }
  });

  /**
   * 流式版本：以 SSE 逐段推送助手回复。
   *
   * 与上面「等完整回复」的接口并存，而不是取代它——批量调用方（适配器、
   * 脚本）不需要流式的复杂度，而 UI 需要首字尽快可见。两者共用同一个引擎，
   * 落库内容一致。
   */
  router.post(`${API_PREFIX}/sessions/:id/messages/stream`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendError(res, 400, errorMessage(err));
    }
    if (typeof body.content !== "string" || body.content.length === 0) {
      return sendError(res, 400, "必须提供 `content`（字符串）");
    }

    // 会话不存在要在开流之前判断：一旦发出 200 响应头，就只能靠事件报错，
    // 客户端拿不到「404」这种明确语义了。
    if (!sessions.has(params.id)) return sendError(res, 404, "会话不存在");

    // 「这个会话正忙」同样要在开流之前预检，理由与上一行完全一样。
    // 这只是**预检**：权威判定在 `engine.handleMessage` 里，两者之间必然留一个窗口，
    // 真撞上时那句 409 只能以 error 帧出去（`SessionLock` 的注释记录了这件事）。
    // 问的是**共享锁**而不是某个引擎：占着这个会话的那一轮可能属于另一份配置档。
    if (lock.has(params.id)) return sendError(res, 409, SESSION_BUSY_MESSAGE);

    startSse(res);

    // 客户端断开（关标签页、切路由）时中断上游请求，避免为已无人接收的
    // 响应继续消耗 token。abort 也会让 provider 侧抛出取消错误。
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    openStreams.add(controller);

    try {
      const reply = await bundle.engine.handleMessage({
        sessionId: params.id,
        content: body.content,
        model: readModel(body),
        signal: controller.signal,
        onDelta: (delta) => {
          if (!res.writableEnded) sendSse(res, { delta, done: false });
        },
        // 中间消息（要求执行工具的助手消息、工具结果）也推给前端：不推的话，
        // 一轮里跑了三步的对话在界面上只剩最后那段字，中间「模型查了什么」全看不见。
        // 用的仍是 StreamChunk 已有的 `message` 字段，不新增帧类型、也不起 SSE 事件名。
        onMessage: (message) => {
          if (!res.writableEnded) sendSse(res, { message, done: false });
        },
      });
      if (!res.writableEnded) sendSse(res, { delta: "", done: true, message: reply });
    } catch (err) {
      // 客户端主动断开（关标签页、切走）会让上面的 controller.abort() 打断上游，
      // 抛出的取消错误属于预期路径，不该按服务端故障记一条 error 堆栈。
      if (controller.signal.aborted) {
        logger.debug(`客户端断开，已中断流式回复: ${params.id}`);
      } else {
        logger.error(`流式回复出错: ${errorStack(err)}`);
        // 状态码已经是 200 了，错误只能走事件。前端据此提示，而不是静默变成空回复。
        if (!res.writableEnded) sendSse(res, { error: errorMessage(err), done: true });
      }
    } finally {
      res.off("close", onClose);
      openStreams.delete(controller);
      if (!res.writableEnded) res.end();
    }
  });

  // --- 供应商：源与模型实例 ------------------------------------------------
  //
  // 这一组是「配置层」而不是「运行时层」：读的是 `providers.json` 里的
  // providerSources / providers，每次成功的写操作末尾都会重建注册表，
  // 因此改完不需要重启。
  //
  // 它们**不带 `?profile=`**：连接与密钥是部署级全局的一份，在这里保存一次，
  // 每一档下一次发消息用的就是它。「这一档默认用清单里的哪一个」在
  // `POST /profiles/{id}/default-provider` 上 —— 那才是档的属性。

  /**
   * 全局清单，并标注每一条有没有真正加载成功。
   *
   * 与旧版的差别：这里返回配置里的**全部**条目（含被禁用、以及因缺源/类型
   * 拼错而加载失败的），而不是只返回注册表里活着的那些。配置页需要看见
   * 「我配了但它没生效」，旧语义下那种条目会凭空消失。
   *
   * `error` 那一根是「整个文件读不出来」时的原因：那种时刻清单只能是空的，
   * 而「空」与「读不出」是两件必须分开说的事 —— 与上面每一条各自带 `error`
   * 同一条理由。它来自配置读取的原文（带绝对路径），而这一层在鉴权闸门之内，
   * 只给操作者，不进日志之外的任何地方。
   */
  router.get(`${API_PREFIX}/providers`, async (_req, res) => {
    const { registry, loadErrors, view } = providerSurface;
    const { entries, defaultId, error } = view();
    // 错误取自装配那一次（见 `ProviderSurface.loadErrors`），不在这里重跑工厂。
    const failedById = loadErrors();

    const list: ProviderListItem[] = entries.map((rawEntry) => {
      const entry = viewListEntry(rawEntry);
      const loaded = registry.get(entry.id) !== null;
      const reason = failedById.get(entry.id);
      return {
        ...entry,
        default: entry.id === defaultId,
        loaded,
        // 兜住「没在注册表里、也没有工厂错误」这一种（例如源存在但实例
        // 因别的原因没注册上）。有 `loaded: false` 就必须给个原因，
        // 否则用户看到的是一个说不通的「没加载」。
        ...(loaded
          ? {}
          : { error: reason ?? "该 provider 未加载成功，请检查它引用的 provider source 是否存在" }),
      };
    });
    sendJson(res, 200, { providers: list, error });
  });

  router.post(`${API_PREFIX}/providers`, async (req, res) => {
    const body = await readJson(req);
    try {
      const provider = providerSurface.config.createProvider(body);
      providerSurface.rebuild();
      sendJson(res, 201, {
        provider: viewProvider(provider, providerSurface.config.defaultId),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post(`${API_PREFIX}/providers/:id`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const provider = providerSurface.config.updateProvider(params.id, body);
      providerSurface.rebuild();
      sendJson(res, 200, {
        provider: viewProvider(provider, providerSurface.config.defaultId),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete(`${API_PREFIX}/providers/:id`, async (_req, res, params) => {
    try {
      const result = providerSurface.config.deleteProvider(params.id);
      providerSurface.rebuild();
      sendJson(res, 200, result);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 源列表。**apiKey 明文返回**——这是有意的取舍：配置页要能把原值填回输入框，
   * 与 AstrBot 的行为一致。该接口在鉴权闸门之内，仅管理员可取。
   * 若日后要收紧，改成 `hasApiKey` + 掩码即可，不影响其它设计。
   */
  router.get(`${API_PREFIX}/provider-sources`, async (_req, res) => {
    sendJson(res, 200, { sources: providerSurface.config.sources });
  });

  router.post(`${API_PREFIX}/provider-sources`, async (req, res) => {
    const body = await readJson(req);
    try {
      const source = providerSurface.config.createSource(body);
      providerSurface.rebuild();
      sendJson(res, 201, { source });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post(`${API_PREFIX}/provider-sources/:id`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const source = providerSurface.config.updateSource(params.id, body);
      providerSurface.rebuild();
      sendJson(res, 200, { source });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 删除源。默认拒绝删除仍被引用的源，`?cascade=1` 才连带删掉引用者。 */
  router.delete(`${API_PREFIX}/provider-sources/:id`, async (req, res, params) => {
    const cascade = searchOf(req).get("cascade");
    const isCascade = cascade === "1" || cascade === "true";
    try {
      const result = providerSurface.config.deleteSource(params.id, { cascade: isCascade });
      providerSurface.rebuild();
      sendJson(res, 200, result);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 用**已保存的**源去打上游的 `GET /models`。
   *
   * 刻意不接受请求体里的 baseUrl/apiKey：否则这个端点会变成「带任意凭证
   * 访问任意地址」的转发器。用户要先保存，再获取——与 AstrBot 的
   * 「保存并获取模型」按钮同一语义。
   */
  router.post(`${API_PREFIX}/provider-sources/:id/models`, async (_req, res, params) => {
    // 不叫 `config`：外层已经有一个 `config`（`HttpDeps.config`，那份部署级配置），
    // 同名会让「这个 handler 读的是哪一份配置」变成要靠肉眼分辨的事。
    const { config: providerStore } = providerSurface;
    const source = providerStore.getSource(params.id);
    if (!source) return sendError(res, 404, `未找到 id 为「${params.id}」的 provider source`);

    // 借工厂造一个只用来拉列表的实例：`listModels()` 只需 baseUrl / apiKey /
    // timeoutMs / type，这四样全部来自源，所以 model 填什么都无所谓。
    const { providers: built } = createProviders(
      { [params.id]: { source: params.id, model: MODEL_LIST_PROBE } },
      { sources: providerStore.sourceEntries() },
    );
    const probe = built[0];
    if (!probe) return sendError(res, 400, `provider source「${params.id}」的配置不合法`);

    try {
      // `listModels` 在 ProviderImpl 里是可选的（有的接入方式确实不需要它），
      // 而 `TYPES` 表里的两家实现都提供了它，所以这里实际不会走到 undefined 那一支。
      const models = await probe.listModels?.();
      // 拿到列表后顺手把它记下来：配置页在源还没绑定任何模型时也能显示
      // 「上次拿到过什么」，省一次往返。
      sendJson(res, 200, { models });
    } catch (err) {
      // 这里刻意回 400 而不是 502：绝大多数情况是 baseUrl 打错、密钥不对、
      // 或该网关根本没有 /models，都是**用户可修**的配置问题。
      sendError(res, 400, errorMessage(err));
    }
  });

  router.get(`${API_PREFIX}/plugins`, async (req, res) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    sendJson(res, 200, { plugins: bundle.plugins.list() });
  });

  router.post(`${API_PREFIX}/plugins/:id/reload`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    try {
      const plugin = await bundle.plugins.reload(params.id);
      sendJson(res, 200, { plugin });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post(`${API_PREFIX}/plugins/:id/unload`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    try {
      const result = await bundle.plugins.unload(params.id);
      sendJson(res, 200, result);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 启用/禁用**这份配置档**里的某个插件。
   *
   * 插件是全局安装的（部署级 `pluginDirs`），所以这个开关不是「装不装」而是
   * 「这份档开不开它」—— 界面上要说清，否则操作者会以为在卸载。
   * 它现在也是第一次真正落盘的启用状态（以前只在管理器内存里，重启即忘）。
   */
  router.post(`${API_PREFIX}/plugins/:id/enable`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    const body = await readJson(req);
    try {
      const result = await bundle.plugins.setEnabled(params.id, body.enabled !== false);
      sendJson(res, 200, { plugin: result });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get(`${API_PREFIX}/plugins/:id/config`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    try {
      sendJson(res, 200, { config: bundle.plugins.getConfig(params.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 写一份插件配置。值由 `PluginManager.saveConfig` 校验并落盘；插件的重载失败
   * **不是**保存失败 —— 文件已经写进去了，`reloadError` 单独说，界面把两件事分开显示。
   */
  router.post(`${API_PREFIX}/plugins/:id/config`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    const body = await readJson(req);
    try {
      const result = await bundle.plugins.saveConfig(params.id, body.values);
      sendJson(res, 200, result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get(`${API_PREFIX}/adapters`, async (_req, res) => {
    sendJson(res, 200, { adapters: adapters.list() });
  });

  // --- 工具 ---------------------------------------------------------------
  //
  // 与 provider 那组不同：这里**不需要重建任何东西**。注册表只回答「这颗工具存在吗」，
  // 启用与否每次现读文件，所以写完开关下一条消息看到的就已是新状态（`GET /tools` 同理）。

  router.get(`${API_PREFIX}/tools`, async (req, res) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    sendJson(res, 200, {
      tools: bundle.tools
        .list()
        .map((tool) => viewTool(tool, bundle.toolConfig.isEnabled(tool.id))),
    });
  });

  router.post(`${API_PREFIX}/tools/:id/enable`, async (req, res, params) => {
    const bundle = scopedProfile(req, res);
    if (!bundle) return;
    // readJson 在 try 之外：畸形 JSON 由顶层分派成 400，与其余写操作一致
    //（`test/openapi-request.test.ts` 的畸形体用例就是打这条路径的）。
    const body = await readJson(req);
    try {
      const tool = bundle.tools.get(params.id);
      if (!tool) return sendError(res, 404, `未知工具: ${params.id}`);
      const { enabled } = bundle.toolConfig.setEnabled(params.id, body.enabled);
      sendJson(res, 200, { tool: viewTool(tool, enabled) });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- 配置档 -------------------------------------------------------------
  //
  // 这一组**不带 `profile` 参数**：它们操作的是「有哪些档」以及「档与全局清单之间的
  // 引用」，而不是「某档里的插件与工具」。唯一带 `?profile=` 语义的是「这份档现在
  // 能不能用」，而那由 `records()` 的 status 说。

  router.get(`${API_PREFIX}/profiles`, async (_req, res) => {
    sendJson(res, 200, { profiles: profiles.records() });
  });

  router.post(`${API_PREFIX}/profiles`, async (req, res) => {
    const body = await readJson(req);
    try {
      const record = await profiles.create(
        typeof body.id === "string" ? body.id : "",
        typeof body.name === "string" ? body.name : undefined,
      );
      sendJson(res, 201, { profile: record });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 一份配置档「此刻是什么」的完整读回，配置工作台的草稿起点。
   *
   * 为什么要一个端点而不是让界面拼 `GET /tools` + `GET /plugins` + `GET /profiles`：
   * 那三份之间没有原子性 —— 两次请求之间恰好有人改了或新建了一份档，草稿的起点就成了
   * 自相矛盾的，而下一次保存会把这份矛盾整个写回磁盘。一次读，四段同源。
   */
  router.get(`${API_PREFIX}/profiles/:id/config`, async (_req, res, params) => {
    const bundle = profileById(res, params.id);
    if (!bundle) return;
    sendJson(res, 200, profileConfigView(bundle));
  });

  /**
   * 保存这份档的多段配置。校验、落盘、运行态对账全在组合根（`ProfileDirectory.updateConfig`），
   * 这里只搬请求与响应。
   *
   * `failed` 那一段不是错误码而是**部分生效的清单**：插件那颗 `setup()` 抛错时，
   * 同一批里前面的开关已经真的生效了。那种时刻回一个 200 而让界面回到原样，
   * 或者回一个 4xx 而把已生效的悄悄留着，都是本仓最恨的形状 —— 所以两样都给。
   */
  router.post(`${API_PREFIX}/profiles/:id/config`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const { failed } = await profiles.updateConfig(params.id, body);
      // 回读。走 `profileById` 而不是 `profiles.get`：并发的一次 `DELETE /profiles/:id`
      // 之后这份档可能已经不在了，那时要说的是「这份档当前不可用」，不是一个 null 字段。
      const bundle = profileById(res, params.id);
      if (!bundle) return;
      sendJson(res, 200, { config: profileConfigView(bundle), failed });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 改这一档默认用的 provider 实例（`{"providerId": null}` 是取消档级默认）。
   *
   * 这是「供应商全局、跑法按档」这条分界上唯一一条**写在档里**的供应商引用：
   * 清单本身在 `providers.json`，而「这一档默认打哪一个模型」属于这一档。
   * 存在的理由是删掉浏览器本地那份选择（`localStorage`）—— 换台机器就换一个默认
   * 不是「偏好」，是配置，而配置必须落在文件里、能被备份、也不该看不见。
   */
  router.post(`${API_PREFIX}/profiles/:id/default-provider`, async (req, res, params) => {
    const body = await readJson(req);
    // 必须**显式**给出这一键：`{}` 不等于「取消默认」。省略与清空是两件事，
    // 让它们都表示清空，就会有一次误发的空请求悄悄改掉某一档的默认模型。
    if (body.providerId === undefined) {
      return sendError(res, 400, "必须提供 `providerId`（字符串，或显式的 null 表示取消）");
    }
    if (typeof body.providerId !== "string" && body.providerId !== null) {
      return sendError(res, 400, "`providerId` 必须是字符串或 null");
    }
    try {
      const profile = await profiles.setDefaultProvider(params.id, body.providerId);
      sendJson(res, 200, { profile });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * 删除一份配置档：先从服务里摘掉，再删掉它的整个目录（`config.json` 与插件数据）。
   *
   * 顺序不可反：摘除可能失败（还被一次对话占着、插件卸载抛错），那时磁盘必须原封不动；
   * 反过来会得到「文件没了，而运行中的对象图还在」—— 比删不掉更糟。
   */
  router.delete(`${API_PREFIX}/profiles/:id`, async (_req, res, params) => {
    try {
      if (profiles.status(params.id) === null) {
        return sendError(res, 404, `没有这份配置: ${params.id}`);
      }
      const removed = await profiles.remove(params.id);
      if (!removed) {
        return sendError(res, 409, "这个配置正被某个会话使用，等那轮对话结束后再删除");
      }
      sendJson(res, 200, { id: params.id, removed: true });
    } catch (err) {
      fail(res, err);
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(requestUrl(req), baseUrlOf(req));
      // 判据是「路径是否在 API 前缀下」，而不是「有没有命中路由」。
      // 否则未知 API 路径会先回 404，匿名调用者就能靠 401/404 的差异
      // 枚举出哪些端点是存在的。放在路由匹配之前，新增路由也默认受保护（fail closed）。
      // 静态资源（登录页本身）必须匿名可取，所以闸门只覆盖 API 前缀。
      const isApiPath = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
      if (isApiPath && !PUBLIC_PATHS.has(pathname)) {
        const session = requireAuth(auth, req, res);
        if (!session) return;
      }

      const hit = router.match(req.method, pathname);
      if (!hit) return serveStatic(req, res, pathname);
      await hit.handler(req, res, hit.params);
    } catch (err) {
      // 与 handler 自带 catch 走的是同一个出口（见 `fail`）：状态码由错误自己带，
      // 这样「客户端把 JSON 写坏了」不会被当成服务端故障回 500，而 5xx 的原文也不会出去。
      fail(res, err);
    }
  });

  /** 未命中任何 API 路由的请求走这里：先试真实文件，再回退到 SPA 入口。 */
  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, 404, "接口不存在");
    }
    // 非 GET/HEAD 已在上面挡掉；API/WS 路径也绝不做 SPA 回退，保持「接口不存在」原样。
    if (pathname.startsWith(`${API_PREFIX}/`) || pathname === API_PREFIX || pathname === WS_PATH) {
      return sendError(res, 404, "接口不存在");
    }

    const staticDir = config.auth.staticDir;
    const filePath = resolveStaticPath(staticDir, pathname);
    if (filePath === null) return sendError(res, 403, "非法路径");

    const file = statFile(filePath) ? filePath : null;
    if (file) return sendFile(req, res, file);

    // SPA 回退：前端 history 路由的深链接在刷新时也要能打开。
    const indexPath = resolveStaticPath(staticDir, "/index.html");
    if (indexPath !== null && statFile(indexPath)) return sendFile(req, res, indexPath);

    return sendError(res, 404, "控制台尚未构建，请先运行 `pnpm build`");
  }

  // --- WebSocket：把会话事件推送给 dashboard -----------------------------
  // 浏览器无法为 WS 握手自定义请求头，所以令牌只能从 Cookie 里取。
  // 好在 Cookie 本来就是会话载体，前端因此不需要为鉴权改动。
  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const token = parseCookies(req)[cookieName];
      return Boolean(token && auth.getByToken(token));
    },
  });
  /**
   * `ws` 会把 **http server 的 `error` 事件转发成它自己的一次 `emit("error")`**
   *（构造时它往 server 上挂 `error: (err) => this.emit('error', err)`）。
   * 而 EventEmitter 对「没人听的 error 事件」的规矩是**抛出去**。
   *
   * 后果不是难看而是致命：那个转发监听器排在监听器队列**前面**，所以一次传输层错误
   *（端口被占、绑定失败）会先在这里变成未捕获异常把进程打死，下面 `listen()` 里那条
   * 中文错误根本没机会生成 —— 实测不加这条时，`app.start()` 既不 reject 也不 resolve，
   * 进程只留下一条 `UNCAUGHT EADDRINUSE`。
   * 所以这条必须挂在构造处，而不是等失败之后再补。
   */
  wss.on("error", (err) => {
    logger.error(`WebSocket 服务出错: ${errorMessage(err)}`);
  });

  /**
   * 在线连接 -> **它握手时用的令牌**。
   *
   * 存令牌不是为了再鉴权一次，而是为了「一个浏览器登出」只影响它自己那批连接：
   * 没有这个对应关系，`unauthorized` 就只能广播给所有人，那等于让任何一个窗口
   * 都能把别人的控制台踢回登录页。握手时 `verifyClient` 已经验过，所以这里存的
   * 必然是当时有效的令牌。
   */
  const clients = new Map<WebSocket, string>();

  wss.on("connection", (ws, req) => {
    const token = parseCookies(req)[cookieName] ?? "";
    clients.set(ws, token);
    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // 形状必须在读 `frame.type` 之前判掉，理由与 HTTP body 那条完全相同（见 `isJsonObject`）：
      // `JSON.parse("null")` 得到 `null`，而这里的监听器是 `ws` 在 socket 的 data 回调里**同步**
      // `emit` 出来的 —— 一句 `null.type` 会以未捕获异常终止整个进程，`app.stop()` 一步都不跑
      // （在途对话、会话锁、WAL 边车全随进程没掉）。畸形帧的正确响应是「忽略」，不是「打死自己」。
      if (!isJsonObject(frame)) return;
      // `ClientFrame` 今天只有 `ping` 一种；`subscribe` / `unsubscribe` 已从协议里删掉
      // （服务端从不消费它们，而留着会让客户端写出永远走不到的分支）。
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", () => clients.delete(ws));
  });

  const broadcast = (frame: ServerFrame) => {
    const data = JSON.stringify(frame);
    for (const ws of clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  // 订阅的是**共享总线**而不是某个引擎：N 份配置档各接一次的话，同一个 WebSocket
  // 会把每条消息收到 N 遍；而删掉一份配置档时那个订阅会泄在已卸载的对象图上。
  // 一次订阅、一次退订，代价是「引擎不知道谁在听」——正是我们要的性质。
  const unsubscribeEvents = events.subscribe(broadcast);

  /**
   * 登录会话被显式作废时，只通知**用它握手的那批连接**，然后关掉它们。
   *
   * 关掉才是这条通知的全部内容：以前 `verifyClient` 只在握手时鉴权，握手之后的连接
   * **无条件继续收全量 `message` 帧** —— 令牌死了也照收，也就是「登出之后那个 socket
   * 还在读全部对话内容」。`ws-auth.test.ts` 里以前那句「旧连接不会被动断开」把这个
   * 行为当成了预期，现在它被当成漏洞修掉了。
   *
   * 先 `send` 再 `close`：`ws` 会把已排队的 data 帧在关闭握手之前冲刷出去，
   * 对端因此先收到这一帧、再收到 close。
   */
  const unsubscribeAuth = auth.onSessionLost((token, reason) => {
    const text = reason === "logout" ? "已在别处登出" : "登录态已被服务端撤销";
    for (const [ws, wsToken] of clients) {
      if (wsToken !== token) continue;
      if (ws.readyState === ws.OPEN) {
        // 帧**就地构造在 `ws.send(...)` 的实参里**，不是先存进变量再传：
        // `test/protocol-frames.test.ts` 那道守卫的锚点就是
        // `.send(JSON.stringify({ type: "…`，先落成变量会让它看不见这处产生点（它会假绿）。
        ws.send(JSON.stringify({ type: "unauthorized", reason: text } satisfies ServerFrame));
      }
      ws.close();
      clients.delete(ws);
    }
  });

  return {
    /**
     * 绑定端口。失败**必须**是一条能被抓到的错误，而不是一次静默挂起。
     *
     * `server.listen()` 的失败（端口被占 —— 本服务最常见的启动故障）走的是**事件**而不是
     * 返回值：实测 EADDRINUSE 在一个 tick 之后才到来，所以 `try/catch` 挡不住它（第一版这么
     * 写过，catch 一次也没进）。只包 `listening` 回调的话这个 promise 永不 settle，
     * `main().catch` 抓不到东西，最后由 Node 的默认出口把进程打死，留下一条英文裸栈
     * （`EADDRINUSE` 加一堆内部帧）—— 既违反「用户可见字符串一律中文」，
     * 也让测试里的端口冲突死得无法解释。
     *
     * 与上面那条 `wss.on("error")` 是一对：那条负责「事件有人接、不会被抛出去」，
     * 这条负责「接到之后说成一句能读的中文」。缺了前者，这里的 `onError` 根本轮不到执行。
     */
    listen: (port: number, host: string) =>
      // 形参刻意不叫 `resolve`/`reject`：`resolve` 与文件顶部从 `node:path` import 的那个
      // 同名（`no-shadow` 告警，而本仓 `pnpm lint` 带 `--deny-warnings`，告警即失败）。
      new Promise<void>((resolveListen, rejectListen) => {
        const wrap = (err: unknown): Error =>
          new Error(`无法监听 ${host}:${port}：${listenHint(err)}`, { cause: err });
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolveListen();
        };
        const onError = (err: Error): void => {
          server.removeListener("listening", onListening);
          rejectListen(wrap(err));
        };
        // 两条都挂上之后再发起绑定：反过来（先 listen 再挂）在两次调用之间就失败的场合
        // 会两条都错过，于是又回到「永不 settle」。
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(port, host);
      }),
    // 暴露实际绑定端口，使 `port: 0`（随机端口）可用于测试与并行启动。
    // `server.address()` 的类型是 `AddressInfo | string | null`，而这里只需要 TCP 那一支：
    // 真在 listen 之前被调用属于调用方用法错误，给一句中文错而不是留一个 TypeError。
    address: () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("服务尚未监听");
      return bound;
    },
    /**
     * 真实注册的 API 路由。测试拿它比对 `apps/server/openapi.json`——
     * 那份规格是手写的，需要一道「代码与规格没走散」的检查。
     */
    routes: () => router.routes,
    close: () =>
      new Promise<void>((done) => {
        // 先掐断进行中的流式响应：它们是长连接，`server.close()` 只会干等它们自然结束。
        // 中断上游同时也会让对应响应收尾，连接随之释放。
        for (const controller of openStreams) controller.abort();
        openStreams.clear();

        // 两个订阅都要退掉。`engine.subscribe` 以前把退订函数丢了，于是关停之后
        // 引擎上一直挂着这个闭包；`auth.onSessionLost` 同一条规矩。
        // 现在接的是共享总线，`events.listenerCount` 归零是这条退订可被断言的证据
        //（见 `test/stream.test.ts` 的关停用例）。
        unsubscribeEvents();
        unsubscribeAuth();

        // **关停不发 `unauthorized`**：一次例行发版会让每个开着控制台的浏览器跳回登录页，
        // 而操作者会把它读成「我被踢了」—— 那是把非鉴权事件伪装成鉴权事件。
        // 连接随进程一起死，客户端下一次请求自然拿到 401 并走同一条登出路径。
        // 这句留在原地，否则将来一定有人把它「改进」成先广播再关。
        for (const ws of clients.keys()) ws.close();
        clients.clear();
        wss.close(() => server.close(() => done()));
        // WebSocket 升级过的连接不算在 http server 的普通请求里，closeAllConnections
        // 兜住剩余的空闲 keep-alive 连接，否则关停仍可能拖到超时。
        server.closeAllConnections?.();
      }),
  };
}

/**
 * `req.url` 在 node 的类型里可选，但进入 request 事件的完整请求恒有值；
 * 这里的 `??` 只为了让类型过，同时保留「异常 URL 一律走 catch → 500」的既有语义。
 */
function requestUrl(req: IncomingMessage): string {
  return req.url ?? "/";
}

function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? ""}`;
}

/** 从查询串里取 `cascade` 之类的开关。 */
function searchOf(req: IncomingMessage): URLSearchParams {
  return new URL(requestUrl(req), baseUrlOf(req)).searchParams;
}

/**
 * query 里的 `limit` / `before` → 存储层的分页入参。
 *
 * 这里只做**无损**的字符串转换：`Number("abc")` 得到 NaN，而 NaN 不是整数，
 * 于是「非法」与「没传」在 `SessionManager.#page()` 那里分得开（前者 400、后者走默认页）。
 * 范围与游标形状都留给存储层判 —— 这里再判一遍就会有两份数字，而规格只写得对一处。
 */
function pageOptions(search: URLSearchParams): PageOptions {
  const rawLimit = search.get("limit");
  return {
    limit: rawLimit === null ? undefined : Number(rawLimit),
    before: search.get("before"),
  };
}

/**
 * 请求体里的 `model`。
 *
 * 非字符串一律当「没传」：今天非字符串会一路传到注册表的选路里、匹配不上任何
 * provider 而回退到默认项，收窄成 undefined 得到的是同一个回退，
 * 但不让垃圾值进到类型里。
 */
function readModel(body: Record<string, unknown>): string | undefined {
  return typeof body.model === "string" ? body.model : undefined;
}

/**
 * 把 URL 路径映射到静态目录下的绝对路径。返回 null 表示越界——
 * 这是目录穿越的唯一防线，因此必须在 resolve 之后按前缀比对，而不是靠字符串过滤。
 *
 * 注意：`new URL()` 会把 `/../` 这类点段（包括 `%2e%2e` 形式）先行规范化，
 * 所以走到这里时 pathname 通常已经不含逃逸段。保留这道检查是为了防住
 * 「调用方改成传原始 URL」或「有人先在前面 decode 一次」这类改动——
 * 因此它由单元测试直接覆盖，而不是靠 HTTP 层间接证明。
 */
export function resolveStaticPath(staticDir: string, pathname: string): string | null {
  const target = resolve(staticDir, `.${pathname}`);
  // 恰为目录本身（例如 pathname === "/"）也算命中；后续 statFile 会判定它不是文件，
  // 从而自然回退到 index.html。若这里拒绝，站点根路径会变成 403。
  if (target === staticDir) return target;

  const base = staticDir.endsWith(sep) ? staticDir : staticDir + sep;
  return target.startsWith(base) ? target : null;
}

/**
 * `listen` 失败的中文说法（拼在 `无法监听 …` 后面）。
 *
 * 只翻两种真会遇到的码，且各自给出下一步；其余原样带出 `err.message`。
 * 写一张全量表只会诱人来加「理论上的错误」，而那时我们并没有对应的修法可给。
 */
function listenHint(err: unknown): string {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "EADDRINUSE") return "地址已被占用，用 ATRI_PORT 换一个端口，或先停掉占用它的进程";
  if (code === "EACCES") return "没有权限监听该端口（低于 1024 需要特权）";
  return errorMessage(err);
}

function statFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 静态文件响应。构建产物带 hash 可长缓存，index.html 每次校验，否则发版后拿到旧壳。 */
function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stats = statSync(filePath);
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stats.size,
    "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // `pipe()` **不转发源流的 error**，而 `fs` ReadStream 的 error 无人监听就是未捕获异常 ——
  // 与刚修掉的 WS 那一处是同一类故障：进程当场没了，`app.stop()` 一步都不跑。
  // 触发它的是常规运维动作而不是坏运气：单进程托管时静态目录就是构建产物，`pnpm build`
  // 期间替换或删除正被请求的那个带 hash 的资源，`statFile` 与实际 `open` 之间就有窗口
  // （实测 stat 之后删文件 → `UNCAUGHT: ENOENT`，退出码 8）。
  // 响应头与半截 body 已经发出去了，这里只能把连接拆掉：客户端看到的是网络错误，
  // 而不是服务端消失。不重试、不降级成 404 —— 那两者都要求头还没发。
  const stream = createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
