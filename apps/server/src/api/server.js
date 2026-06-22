import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { API_PREFIX, WS_PATH, APP_NAME } from "@atri/shared";
import { Router } from "./router.js";
import { sendJson, sendError, readJson } from "./http.js";

/**
 * HTTP + WebSocket API。这一层只做「传输 <-> 核心调用」的翻译，
 * 不含任何业务逻辑。路由处理函数直接委托给各个 manager。
 */
export function createHttpServer(deps) {
  const { config, logger, sessions, providers, plugins, adapters, engine } = deps;

  const router = new Router();

  router.get(`${API_PREFIX}/health`, async (_req, res) => {
    sendJson(res, 200, { ok: true, app: APP_NAME, version: "1.0.0" });
  });

  router.get(`${API_PREFIX}/sessions`, async (_req, res) => {
    sendJson(res, 200, { sessions: sessions.list() });
  });

  router.post(`${API_PREFIX}/sessions`, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, { session: sessions.create(body) });
  });

  router.get(`${API_PREFIX}/sessions/:id`, async (req, res, params) => {
    const session = sessions.get(params.id);
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
      const hit = router.match(req.method, pathname);
      if (!hit) return sendError(res, 404, "接口不存在");
      await hit.handler(req, res, hit.params);
    } catch (err) {
      logger.error(`请求处理出错: ${err.stack ?? err.message}`);
      if (!res.headersSent) sendError(res, 500, "服务器内部错误");
    }
  });

  // --- WebSocket：把会话事件推送给 dashboard -----------------------------
  const wss = new WebSocketServer({ server, path: WS_PATH });
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
    listen: (port, host) => new Promise((resolve) => server.listen(port, host, resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const ws of clients) ws.close();
        wss.close(() => server.close(resolve));
      }),
  };
}
