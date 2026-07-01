import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { API_PREFIX, WS_PATH, APP_NAME } from "@atri/shared";
import { Router } from "./router.js";
import { sendJson, sendError, readJson, startSse, sendSse } from "./http.js";
import { parseCookies, setSessionCookie, clearSessionCookie, requireAuth } from "./auth.js";

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

const CONTENT_TYPES = {
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
export function createHttpServer(deps) {
  const { config, logger, sessions, providers, plugins, adapters, engine, auth } = deps;

  const cookieName = auth.cookieName;
  const router = new Router();

  /**
   * 进行中的 SSE 流。`server.close()` 会等所有连接自然结束，而流式响应是长连接：
   * 不主动收尾，关闭就会一直挂到上游超时（实测有客户端开着流时 `stop()` 要等 120s+）。
   */
  const openStreams = new Set();

  router.get(`${API_PREFIX}/health`, async (_req, res) => {
    sendJson(res, 200, { ok: true, app: APP_NAME, version: "1.0.0" });
  });

  // --- 鉴权 ---------------------------------------------------------------
  router.post(`${API_PREFIX}/auth/login`, async (req, res) => {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendError(res, 400, err.message);
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
        model: body.model,
      });
      sendJson(res, 200, { message: reply });
    } catch (err) {
      sendError(res, 400, err.message);
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
      return sendError(res, 400, err.message);
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
        model: body.model,
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
        logger.error(`流式回复出错: ${err.stack ?? err.message}`);
        // 状态码已经是 200 了，错误只能走事件。前端据此提示，而不是静默变成空回复。
        if (!res.writableEnded) sendSse(res, { error: err.message, done: true });
      }
    } finally {
      res.off("close", onClose);
      openStreams.delete(controller);
      if (!res.writableEnded) res.end();
    }
  });

  router.get(`${API_PREFIX}/providers`, async (_req, res) => {
    sendJson(res, 200, { providers: providers.list() });
  });

  router.get(`${API_PREFIX}/plugins`, async (_req, res) => {
    sendJson(res, 200, { plugins: plugins.list() });
  });

  router.post(`${API_PREFIX}/plugins/:id/reload`, async (_req, res, params) => {
    try {
      const plugin = await plugins.reload(params.id);
      sendJson(res, 200, { plugin });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.post(`${API_PREFIX}/plugins/:id/unload`, async (_req, res, params) => {
    try {
      const result = await plugins.unload(params.id);
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.post(`${API_PREFIX}/plugins/:id/enable`, async (req, res, params) => {
    const body = await readJson(req);
    try {
      const result = await plugins.setEnabled(params.id, body.enabled !== false);
      sendJson(res, 200, { plugin: result });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.get(`${API_PREFIX}/adapters`, async (_req, res) => {
    sendJson(res, 200, { adapters: adapters.list() });
  });

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
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
      logger.error(`请求处理出错: ${err.stack ?? err.message}`);
      if (!res.headersSent) sendError(res, 500, "服务器内部错误");
    }
  });

  /** 未命中任何 API 路由的请求走这里：先试真实文件，再回退到 SPA 入口。 */
  function serveStatic(req, res, pathname) {
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
    verifyClient: ({ req }) => {
      const token = parseCookies(req)[cookieName];
      return Boolean(token && auth.getByToken(token));
    },
  });
  const clients = new Set();

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

  const broadcast = (frame) => {
    const data = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };
  engine.subscribe(broadcast);

  return {
    listen: (port, host) => new Promise((done) => server.listen(port, host, done)),
    // 暴露实际绑定端口，使 `port: 0`（随机端口）可用于测试与并行启动。
    address: () => server.address(),
    /**
     * 真实注册的 API 路由。测试拿它比对 `apps/server/openapi.json`——
     * 那份规格是手写的，需要一道「代码与规格没走散」的检查。
     */
    routes: () => router.routes,
    close: () =>
      new Promise((done) => {
        // 先掐断进行中的流式响应：它们是长连接，`server.close()` 只会干等它们自然结束。
        // 中断上游同时也会让对应响应收尾，连接随之释放。
        for (const controller of openStreams) controller.abort();
        openStreams.clear();

        for (const ws of clients) ws.close();
        wss.close(() => server.close(done));
        // WebSocket 升级过的连接不算在 http server 的普通请求里，closeAllConnections
        // 兜住剩余的空闲 keep-alive 连接，否则关停仍可能拖到超时。
        server.closeAllConnections?.();
      }),
  };
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
export function resolveStaticPath(staticDir, pathname) {
  const target = resolve(staticDir, `.${pathname}`);
  // 恰为目录本身（例如 pathname === "/"）也算命中；后续 statFile 会判定它不是文件，
  // 从而自然回退到 index.html。若这里拒绝，站点根路径会变成 403。
  if (target === staticDir) return target;

  const base = staticDir.endsWith(sep) ? staticDir : staticDir + sep;
  return target.startsWith(base) ? target : null;
}

function statFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 静态文件响应。构建产物带 hash 可长缓存，index.html 每次校验，否则发版后拿到旧壳。 */
function sendFile(req, res, filePath) {
  const stats = statSync(filePath);
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stats.size,
    "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}
