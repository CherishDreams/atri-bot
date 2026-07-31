import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../src/app.ts";
import { DEFAULT_AUTH_COOKIE_NAME, API_PREFIX, WS_PATH } from "@atri/shared";

/**
 * WebSocket 鉴权。浏览器无法为 WS 握手自定义请求头，令牌只能来自 Cookie，
 * 因此这里用 `ws` 客户端手工构造 Cookie 头，覆盖「被拒」与「被放行」两侧。
 */
async function startServer(t) {
  const root = mkdtempSync(join(tmpdir(), "atri-ws-"));
  const config = {
    root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    dataDir: join(root, "data"),
    pluginDirs: [],
    adapters: {},
    providers: {},
    auth: {
      adminUser: "admin",
      adminPassword: "pw-for-test",
      cookieName: DEFAULT_AUTH_COOKIE_NAME,
      cookieSecure: false,
      staticDir: join(root, "dist"),
    },
  };

  const app = await createApp(config);
  await app.start();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => app.stop());

  const port = app.address().port;
  return { port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}${WS_PATH}` };
}

/** 建立连接并给出结果：`opened` 表示握手是否通过。 */
function tryConnect(url, { cookie, headers = {} } = {}) {
  return new Promise((done) => {
    const ws = new WebSocket(url, {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      done({ opened: false, code: null, error: new Error("连接既未打开也未关闭（超时）") });
    }, 5000);

    ws.on("open", () => {
      clearTimeout(timer);
      done({ opened: true, ws, code: null, error: null });
    });
    ws.on("error", (error) => {
      // 握手被拒时 ws 会同时抛 error 与 close，这里只关心「没连上」。
      if (ws.readyState === WebSocket.CLOSED) return;
      clearTimeout(timer);
      done({ opened: false, code: null, error });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      done({ opened: false, code: res.statusCode, error: null });
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      done({ opened: false, code, error: null });
    });
  });
}

async function loginCookie(http) {
  const res = await fetch(`${http}${API_PREFIX}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw-for-test" }),
  });
  assert.equal(res.status, 200);
  return res.headers
    .getSetCookie()
    .find((h) => h.startsWith(`${DEFAULT_AUTH_COOKIE_NAME}=`))
    .split(";")[0];
}

test("无 Cookie 的 WS 握手被拒（401），不会进入连接", async (t) => {
  const { ws } = await startServer(t);
  const result = await tryConnect(ws);

  assert.equal(result.opened, false, "未登录不应建立连接");
  assert.equal(result.code, 401, `应当以 401 拒绝握手，实际 ${result.code}`);
});

test("伪造令牌的 WS 握手被拒", async (t) => {
  const { ws } = await startServer(t);
  const result = await tryConnect(ws, {
    cookie: `${DEFAULT_AUTH_COOKIE_NAME}=00000000-0000-0000-0000-000000000000`,
  });
  assert.equal(result.opened, false);
  assert.equal(result.code, 401);
});

test("已登录的 WS 握手通过，ping 能收到 pong", async (t) => {
  const { http, ws } = await startServer(t);
  const cookie = await loginCookie(http);

  const result = await tryConnect(ws, { cookie });
  assert.equal(result.opened, true, "登录后应当能建立连接");

  const client = result.ws;
  t.after(() => client.terminate());

  const frame = await new Promise((done) => {
    client.once("message", (raw) => done(JSON.parse(raw.toString())));
    client.send(JSON.stringify({ type: "ping" }));
  });
  assert.deepEqual(frame, { type: "pong" });
});

test("登出后既有 WS 连接仍在线，但新握手被拒", async (t) => {
  const { http, ws } = await startServer(t);
  const cookie = await loginCookie(http);

  const first = await tryConnect(ws, { cookie });
  assert.equal(first.opened, true);
  t.after(() => first.ws.terminate());

  await fetch(`${http}${API_PREFIX}/auth/logout`, { method: "POST", headers: { cookie } });

  // 旧连接不会被动断开（本例未做心跳踢出），但复用同一 Cookie 已无法再握手。
  const second = await tryConnect(ws, { cookie });
  assert.equal(second.opened, false, "登出后旧令牌不得再建立连接");
  assert.equal(second.code, 401);
});
