import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "#app.ts";
import { DEFAULT_AUTH_COOKIE_NAME, API_PREFIX, WS_PATH } from "@atri/shared";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * WebSocket 鉴权。浏览器无法为 WS 握手自定义请求头，令牌只能来自 Cookie，
 * 因此这里用 `ws` 客户端手工构造 Cookie 头，覆盖「被拒」与「被放行」两侧。
 */

/**
 * `tryConnect` 的选项。
 *
 * 与 `http-auth.test.ts` 的 `CallOptions` 同一个理由：`cookie` **没有默认值**
 * （它的「缺省」就是「不带 Cookie 头」，函数体靠真值判断区分），让 TS 从解构默认值
 * 推断会把 options 推成只有 `headers` 一个键，于是每个传 cookie 的调用点都成 TS2353。
 */
interface ConnectOptions {
  /** 完整的 `name=value`；不传即匿名握手。 */
  cookie?: string | null;
  headers?: Record<string, string>;
}

/**
 * 握手结果，刻意做成**以 `opened` 为判别式**的联合。
 *
 * 为什么不是 `{ opened: boolean; ws?: WebSocket }`：有断言紧接着读 `result.ws` 与
 * `first.ws`，而断言序列在本次迁移中逐字冻结（有快照比对），守卫插不进那些行。
 * 判成联合之后，上一行的 `assert.equal(result.opened, true)` 就能把类型筛到
 * `opened: true` 那一支（严格模式下 `assert.equal` 就是 `strictEqual`，带
 * `asserts actual is T` 签名），于是 `ws` 必然存在。
 * 被拒的那一支没有 `ws` —— 与迁移前 `done({ opened: false, code, error })` 的实际形状一致。
 */
type ConnectResult =
  | { opened: true; ws: WebSocket; code: null; error: null }
  | { opened: false; ws?: undefined; code: number | null; error: Error | null };

async function startServer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "atri-ws-"));
  // 共享 fixture 的默认值与迁移前这里手抄的那份逐项相同（host / port 0 / logLevel /
  // dataDir / pluginDirs / adapters / providers，`"atri_session"` 就是
  // `DEFAULT_AUTH_COOKIE_NAME`、`cookieSecure: false`），口令与 staticDir 用本文件的值。
  const config = makeTestConfig({
    root,
    staticDir: join(root, "dist"),
    adminPassword: "pw-for-test",
  });

  const app = await createApp(config);
  await app.start();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => app.stop());

  const port = app.address().port;
  return { port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}${WS_PATH}` };
}

/** 建立连接并给出结果：`opened` 表示握手是否通过。 */
function tryConnect(url: string, { cookie, headers = {} }: ConnectOptions = {}) {
  return new Promise<ConnectResult>((done) => {
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
      // `IncomingMessage.statusCode` 在 node 的类型上是 `number | undefined`
      // （还没读到状态行时就是 undefined）。这里 `?? null` 不改变判定：断言看的是
      // 「被拒时状态码必须是 401」， undefined 与 null 都会让那条断言同样地红。
      done({ opened: false, code: res.statusCode ?? null, error: null });
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      done({ opened: false, code, error: null });
    });
  });
}

async function loginCookie(http: string): Promise<string> {
  const res = await fetch(`${http}${API_PREFIX}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw-for-test" }),
  });
  assert.equal(res.status, 200);
  const header = res.headers
    .getSetCookie()
    .find((h) => h.startsWith(`${DEFAULT_AUTH_COOKIE_NAME}=`));
  // 用抛错而不是 `assert.ok` 做守卫：这两处只是将类型上的「可能没有」落到运行时，
  // 本文件的断言序列是比对基线，能少加一行就少加一行。
  if (!header) throw new Error("登录响应里没有会话 Cookie");
  const [pair] = header.split(";");
  if (!pair) throw new Error("Set-Cookie 没有 name=value 分段");
  return pair;
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
