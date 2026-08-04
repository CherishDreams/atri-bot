import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ServerFrame } from "@atri/shared";
import { API_PREFIX, APP_NAME, WS_PATH } from "@atri/shared";
import { createProviders } from "../core/provider/factory.ts";
import { httpStatusForError } from "../core/provider/store.ts";
import type { ProviderEntry } from "../core/provider/store.ts";
import { Router } from "./router.ts";
import { readJson, sendError, sendJson, sendSse, startSse, type HttpDeps } from "./http.ts";
import { parseCookies, clearSessionCookie, requireAuth, setSessionCookie } from "./auth.ts";
import { errorMessage, errorStack } from "../core/errors.ts";

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
 * 写操作的响应形状。
 *
 * 补一个 `default` 字段：前端拿到响应后能直接更新高亮，不必为了「刚才设的
 * 默认项生效了吗」再拉一次列表。默认项来自保留键，所以由调用方传入。
 */
function viewProvider(entry: ProviderEntry, defaultId: string | null): ProviderMutationResult {
  return { ...entry, default: entry.id === defaultId };
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
  const { config, logger, sessions, providers, plugins, adapters, engine, auth } = deps;
  const { providerConfig, reloadProviders } = deps;

  const cookieName = auth.cookieName;
  const router = new Router();

  /**
   * 进行中的 SSE 流。`server.close()` 会等所有连接自然结束，而流式响应是长连接：
   * 不主动收尾，关闭就会一直挂到上游超时（实测有客户端开着流时 `stop()` 要等 120s+）。
   */
  const openStreams = new Set<AbortController>();

  router.get(`${API_PREFIX}/health`, async (_req, res) => {
    sendJson(res, 200, { ok: true, app: APP_NAME, version: "1.0.0" });
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
  router.get(`${API_PREFIX}/sessions`, async (_req, res) => {
    sendJson(res, 200, { sessions: sessions.list() });
  });

  router.post(`${API_PREFIX}/sessions`, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { session: sessions.create(body) });
  });

  router.get(`${API_PREFIX}/sessions/:id`, async (req, res, params) => {
    const session = sessions.getDetail(params.id);
    if (!session) return sendError(res, 404, "会话不存在");
    sendJson(res, 200, { session });
  });

  router.delete(`${API_PREFIX}/sessions/:id`, async (_req, res, params) => {
    const ok = sessions.delete(params.id);
    sendJson(res, ok ? 200 : 404, { deleted: ok });
  });

  router.post(`${API_PREFIX}/sessions/:id/messages`, async (req, res, params) => {
    const body = await readJson(req);
    if (typeof body.content !== "string" || body.content.length === 0) {
      return sendError(res, 400, "必须提供 `content`（字符串）");
    }
    try {
      const reply = await engine.handleMessage({
        sessionId: params.id,
        content: body.content,
        model: readModel(body),
      });
      sendJson(res, 200, { message: reply });
    } catch (err) {
      sendError(res, 400, errorMessage(err));
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
    if (!sessions.get(params.id)) return sendError(res, 404, "会话不存在");

    startSse(res);

    // 客户端断开（关标签页、切路由）时中断上游请求，避免为已无人接收的
    // 响应继续消耗 token。abort 也会让 provider 侧抛出取消错误。
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    openStreams.add(controller);

    try {
      const reply = await engine.handleMessage({
        sessionId: params.id,
        content: body.content,
        model: readModel(body),
        signal: controller.signal,
        onDelta: (delta) => {
          if (!res.writableEnded) sendSse(res, { delta, done: false });
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

  // --- provider 与 provider source ----------------------------------------
  //
  // 这一组是「配置层」而不是「运行时层」：读的是 atri.config.json 里的
  // providerSources / providers，每次成功的写操作末尾都会重建注册表，
  // 因此改完不需要重启。

  /**
   * 配置层的 provider 列表，并标注它有没有真正加载成功。
   *
   * 与旧版的差别：这里返回配置里的**全部**条目（含被禁用、以及因缺源/类型
   * 拼错而加载失败的），而不是只返回注册表里活着的那些。配置页需要看见
   * 「我配了但它没生效」，旧语义下那种条目会凭空消失。
   */
  router.get(`${API_PREFIX}/providers`, async (_req, res) => {
    // 单独跑一遍工厂，只为拿到「谁没加载成功、为什么」——注册表里没有这个信息，
    // 而配置页恰恰最需要它。注意取的是 `errors` 不是 `providers`：后者是**成功
    // 构造出来的实例**，键名写反了会得到一个恒空的错误表，于是失败原因永远不显示。
    const { errors } = createProviders(providerConfig.providerEntries(), {
      sources: providerConfig.sourceEntries(),
    });
    const failedById = new Map(errors.map((e) => [e.id, e.message]));
    const defaultId = providerConfig.defaultId;

    const list: ProviderListItem[] = providerConfig.providers.map((entry) => {
      const loaded = providers.get(entry.id) !== null;
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
    sendJson(res, 200, { providers: list });
  });

  router.post(`${API_PREFIX}/providers`, async (req, res) => {
    const body = await readJson(req);
    try {
      const provider = providerConfig.createProvider(body);
      reloadProviders();
      sendJson(res, 201, { provider: viewProvider(provider, providerConfig.defaultId) });
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
    }
  });

  router.post(`${API_PREFIX}/providers/:id`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const provider = providerConfig.updateProvider(params.id, body);
      reloadProviders();
      sendJson(res, 200, { provider: viewProvider(provider, providerConfig.defaultId) });
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
    }
  });

  router.delete(`${API_PREFIX}/providers/:id`, async (_req, res, params) => {
    try {
      const result = providerConfig.deleteProvider(params.id);
      reloadProviders();
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
    }
  });

  /**
   * 源列表。**apiKey 明文返回**——这是有意的取舍：配置页要能把原值填回输入框，
   * 与 AstrBot 的行为一致。该接口在鉴权闸门之内，仅管理员可取。
   * 若日后要收紧，改成 `hasApiKey` + 掩码即可，不影响其它设计。
   */
  router.get(`${API_PREFIX}/provider-sources`, async (_req, res) => {
    sendJson(res, 200, { sources: providerConfig.sources });
  });

  router.post(`${API_PREFIX}/provider-sources`, async (req, res) => {
    const body = await readJson(req);
    try {
      const source = providerConfig.createSource(body);
      reloadProviders();
      sendJson(res, 201, { source });
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
    }
  });

  router.post(`${API_PREFIX}/provider-sources/:id`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const source = providerConfig.updateSource(params.id, body);
      reloadProviders();
      sendJson(res, 200, { source });
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
    }
  });

  /** 删除源。默认拒绝删除仍被引用的源，`?cascade=1` 才连带删掉引用者。 */
  router.delete(`${API_PREFIX}/provider-sources/:id`, async (req, res, params) => {
    const cascade = searchOf(req).get("cascade");
    const isCascade = cascade === "1" || cascade === "true";
    try {
      const result = providerConfig.deleteSource(params.id, { cascade: isCascade });
      reloadProviders();
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, httpStatusForError(err), errorMessage(err));
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
    const source = providerConfig.getSource(params.id);
    if (!source) return sendError(res, 404, `未找到 id 为「${params.id}」的 provider source`);

    // 借工厂造一个只用来拉列表的实例：`listModels()` 只需 baseUrl / apiKey /
    // timeoutMs / type，这四样全部来自源，所以 model 填什么都无所谓。
    const { providers: built } = createProviders(
      { [params.id]: { source: params.id, model: MODEL_LIST_PROBE } },
      { sources: providerConfig.sourceEntries() },
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

  router.get(`${API_PREFIX}/plugins`, async (_req, res) => {
    sendJson(res, 200, { plugins: plugins.list() });
  });

  router.post(`${API_PREFIX}/plugins/:id/reload`, async (_req, res, params) => {
    try {
      const plugin = await plugins.reload(params.id);
      sendJson(res, 200, { plugin });
    } catch (err) {
      sendError(res, 400, errorMessage(err));
    }
  });

  router.post(`${API_PREFIX}/plugins/:id/unload`, async (_req, res, params) => {
    try {
      const result = await plugins.unload(params.id);
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, 400, errorMessage(err));
    }
  });

  router.post(`${API_PREFIX}/plugins/:id/enable`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const result = await plugins.setEnabled(params.id, body.enabled !== false);
      sendJson(res, 200, { plugin: result });
    } catch (err) {
      sendError(res, 400, errorMessage(err));
    }
  });

  router.get(`${API_PREFIX}/adapters`, async (_req, res) => {
    sendJson(res, 200, { adapters: adapters.list() });
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
      logger.error(`请求处理出错: ${errorStack(err)}`);
      if (!res.headersSent) sendError(res, 500, "服务器内部错误");
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
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", () => clients.delete(ws));
  });

  const broadcast = (frame: ServerFrame) => {
    const data = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  engine.subscribe(broadcast);

  return {
    listen: (port: number, host: string) =>
      new Promise<void>((done) => {
        server.listen(port, host, () => done());
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

        for (const ws of clients) ws.close();
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
  createReadStream(filePath).pipe(res);
}
