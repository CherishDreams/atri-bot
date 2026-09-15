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
 * `first.ws`，而断言行在本次迁移中保持原样（本仓没有快照机制，靠的是人工比对 diff），
 * 守卫插不进那些行。判成联合之后，上一行的 `assert.equal(result.opened, true)` 就能把
 * 类型筛到 `opened: true` 那一支（严格模式下 `assert.equal` 就是 `strictEqual`，带
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
  // `app` 一并暴露：有一条用例要**主动关停**去看连接收到什么（其余用例靠 `t.after` 收尾）。
  return { port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}${WS_PATH}`, app };
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

/**
 * 登出要把**这条登录会话**的连接以 `unauthorized` 收尾并关掉。
 *
 * 这条以前写的是反面的预期（「旧连接不会被动断开，本例未做心跳踢出」），而那正是漏洞本身：
 * `verifyClient` 只在握手时鉴权，握手之后的连接**无条件继续收全量 `message` 帧**，
 * 令牌死了也照收 —— 也就是「在另一个窗口登出之后，这个窗口还读得到全部对话内容」。
 * 现在帧只发给用同一个令牌握手的那批连接，发完即关。
 */
test("登出：该令牌的连接收到 unauthorized 并被关闭，新握手被拒", async (t) => {
  const { http, ws } = await startServer(t);
  const cookie = await loginCookie(http);

  const first = await tryConnect(ws, { cookie });
  assert.equal(first.opened, true);
  t.after(() => first.ws.terminate());

  const frames: { type?: string }[] = [];
  first.ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as { type?: string }));
  const closed = new Promise<void>((resolve) => {
    first.ws.once("close", () => resolve());
  });

  await fetch(`${http}${API_PREFIX}/auth/logout`, { method: "POST", headers: { cookie } });
  await closed;

  assert.deepEqual(
    frames.map((f) => f.type),
    ["unauthorized"],
    "关闭之前必须先给一帧 unauthorized（只 close 不说是「页面自己跳的」还是「被登出的」，客户端分不出来）",
  );
  assert.equal(first.ws.readyState, WebSocket.CLOSED);

  // 复用同一 Cookie 已经建不起新连接（这条是既有语义，没变）。
  const second = await tryConnect(ws, { cookie });
  assert.equal(second.opened, false, "登出后旧令牌不得再建立连接");
  assert.equal(second.code, 401);
});

/**
 * 登出只影响**它自己那条会话**。
 *
 * 通知是按 token 匹配的，而判据是「这条会话原本还活着、被我们主动弄死了」：
 * 用一个不存在的令牌去登出（重复点了一次退出按钮、或一个假 Cookie）如果也触发广播，
 * 症状就是任何人都能把别人的控制台踢下线。
 */
test("用别人的（或不存在的）令牌登出，不得动到在线连接", async (t) => {
  const { http, ws } = await startServer(t);
  const cookie = await loginCookie(http);

  const live = await tryConnect(ws, { cookie });
  assert.equal(live.opened, true);
  t.after(() => live.ws.terminate());

  const frames: { type?: string }[] = [];
  live.ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as { type?: string }));

  await fetch(`${http}${API_PREFIX}/auth/logout`, {
    method: "POST",
    headers: { cookie: `${DEFAULT_AUTH_COOKIE_NAME}=does-not-exist` },
  });
  // 登出是幂等的：这条请求不会报错，也不该有副作用。给它一点时间走到监听器。
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(live.ws.readyState, WebSocket.OPEN, "不相干的登出不得关掉别人的连接");
  // 用 `length` 而不是 `deepEqual(frames, [])`：严格模式的 `deepEqual` 带断言签名，
  // 拿空数组去比会把 `frames` 收窄成 `never[]`，于是下面那句 `frames.map((f) => f.type)`
  // 直接 TS2339 —— 类型检查在告「你的量法把变量说死了」，不是告实现坏了。
  assert.equal(frames.length, 0, "也不该收到任何帧");

  // 而真令牌登出时，同一条连接会立刻被收尾 —— 证明上面那个「没动」是判据在生效，不是时序巧合。
  await fetch(`${http}${API_PREFIX}/auth/logout`, { method: "POST", headers: { cookie } });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    frames.map((f) => f.type),
    ["unauthorized"],
  );
});

/**
 * 服务关停只断连接，**不发** `unauthorized`。
 *
 * 这条与上面那条成对：`unauthorized` 的含义是「你的登录会话没了」，而不是一次发版。
 * 把它挂在 `close()` 上看起来像是「顺手补全通知」，后果是每个开着控制台的浏览器在每次
 * 重启后被弹回登录页，而操作者读成「我被踢了」—— 那是把非鉴权事件伪装成鉴权事件。
 * 客户端在这条路径上靠的是「连接断了 + 下一次请求 401」，走的仍是同一条路。
 */
test("服务关停不发 unauthorized，只关连接", async (t) => {
  const { http, ws, app } = await startServer(t);
  const cookie = await loginCookie(http);

  const live = await tryConnect(ws, { cookie });
  assert.equal(live.opened, true);
  t.after(() => live.ws.terminate());

  const frames: { type?: string }[] = [];
  const closed = new Promise<void>((resolve) => {
    live.ws.once("close", () => resolve());
  });
  live.ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as { type?: string }));

  // 主动关停（`t.after` 里那一次是幂等的兜底，见 `sessions.close()` 的同类处理）。
  await app.stop();
  await closed;

  assert.deepEqual(
    frames.map((f) => f.type),
    [],
    "关停不该发出任何帧，尤其不该是 unauthorized",
  );
  assert.equal(live.ws.readyState, WebSocket.CLOSED);
});

/**
 * 畸形帧必须被**忽略**，不能把进程带走。
 *
 * 量法是「发一串坏帧，再发一次 ping，pong 还要收得到」。这条没有替代品：`ws` 在 socket 的
 * data 回调里**同步** `emit` `message`，监听器里抛出的 TypeError 因此是未捕获异常，在本仓
 * 就是跑测试的这个进程当场终止 —— 少一道形状判据时，这个文件不会留下一条红用例，
 * 而是整份挂掉。反过来说，它能跑完并给出 pong，就是「忽略」这个语义真的生效了。
 */
test("畸形 WS 帧被忽略，连接仍然可用", async (t) => {
  const { http, ws } = await startServer(t);
  const cookie = await loginCookie(http);

  const connected = await tryConnect(ws, { cookie });
  assert.equal(connected.opened, true);
  t.after(() => connected.ws.terminate());

  // 其中 `null` 是唯一致命的那一个：`JSON.parse` 会成功，而 `null.type` 抛 TypeError。
  // 其余几条要么语法不过（走 `catch` 直接 return），要么取属性只得到 `undefined`。
  for (const raw of ["null", "[]", "5", '"ping"', "true", "{"]) {
    connected.ws.send(raw);
  }

  const frame = await new Promise((done) => {
    connected.ws.once("message", (raw) => done(JSON.parse(raw.toString())));
    connected.ws.send(JSON.stringify({ type: "ping" }));
  });
  assert.deepEqual(frame, { type: "pong" }, "坏帧之后连接必须还活着，并仍能正常应答");
});
