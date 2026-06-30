import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

/**
 * 流式接口的端到端测试：真的起一个「上游 LLM」HTTP 服务，让 provider 去打它，
 * 再通过 HTTP 层的 SSE 端点把增量读回来。
 *
 * 这里刻意不 mock provider：只有走完整条链路（provider 解析上游 SSE →
 * 引擎逐段透传 → 我们的 SSE 端点重新编码），才能验证「前端能拿到增量」这件事，
 * 而单元测试各自只覆盖其中一段。
 */
async function startStubUpstream(chunks) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startApp(providers) {
  const root = mkdtempSync(join(tmpdir(), "atri-sse-"));
  const app = await createApp({
    root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    dataDir: join(root, "data"),
    pluginDirs: [],
    adapters: {},
    providers,
    auth: {
      adminUser: "admin",
      adminPassword: "pw",
      cookieName: "atri_session",
      cookieSecure: false,
      staticDir: join(root, "nonexistent"),
    },
  });
  await app.start();
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    stop: async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 登录拿 Cookie，后续请求都带上它。 */
async function login(origin) {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

async function createSession(origin, cookie) {
  const res = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "t" }),
  });
  return (await res.json()).session;
}

/** 读完整条 SSE 响应，返回解析后的事件对象数组。 */
async function readSse(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.replace(/^data:\s*/, "")));
}

test("流式端点：逐段推送增量，末帧带回已落库的消息", async (t) => {
  const upstream = await startStubUpstream(["你", "好", "呀"]);
  const app = await startApp({
    stub: { type: "openai", baseUrl: upstream.baseUrl, apiKey: "k", models: ["m"] },
  });
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "嗨", model: "m" }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("cache-control"), "no-store");

  const events = await readSse(res);
  const deltas = events.filter((e) => e.delta).map((e) => e.delta);
  assert.deepEqual(deltas, ["你", "好", "呀"], "增量应逐段到达，而不是攒成一整段");

  const final = events.at(-1);
  assert.equal(final.done, true);
  assert.equal(final.message.content, "你好呀", "末帧应带上拼接后的完整内容");
  assert.equal(final.message.role, "assistant");
  assert.ok(final.message.id, "末帧消息必须有 id，前端才好去重");
});

test("流式端点：落库内容与流式推送一致，刷新后历史就是它", async (t) => {
  const upstream = await startStubUpstream(["A", "B"]);
  const app = await startApp({
    stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] },
  });
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  // 必须把响应体读完：助手消息是在流结束的那一刻才落库的，
  // 只等响应头就回来查详情，会读到还没写入的历史。
  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q", model: "m" }),
  });
  await res.text();

  const detail = await fetch(`${app.origin}/api/v1/sessions/${session.id}`, {
    headers: { cookie },
  }).then((r) => r.json());

  const roles = detail.session.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  assert.equal(detail.session.messages[1].content, "AB");
});

test("流式端点：未知会话在开流前就 404，而不是用事件报错", async (t) => {
  const upstream = await startStubUpstream(["x"]);
  const app = await startApp({
    stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] },
  });
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const res = await fetch(`${app.origin}/api/v1/sessions/不存在/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q" }),
  });

  // 一旦发出 200 响应头就只能靠事件报错，客户端拿不到明确的 404 语义。
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);
});

test("流式端点：空 content 在开流前 400", async (t) => {
  const upstream = await startStubUpstream(["x"]);
  const app = await startApp({
    stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] },
  });
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);
  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "" }),
  });
  assert.equal(res.status, 400);
});

test("流式端点：上游报错时错误走事件（状态码已是 200），且不伪装成空回复", async (t) => {
  const upstream = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = await startApp({ stub: { type: "openai", baseUrl, models: ["m"] } });
  t.after(() => new Promise((r) => upstream.close(r)));
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q", model: "m" }),
  });

  assert.equal(res.status, 200, "响应头已发出，无法再改状态码");
  const events = await readSse(res);
  const final = events.at(-1);
  assert.equal(final.done, true);
  assert.match(final.error, /密钥无效/);
  assert.equal(final.message, undefined, "失败时不该伪造一条回复");
});

test("流式端点：客户端中途断开时中断上游，且不按服务端故障记 error", async (t) => {
  // 上游慢速推送，好让我们在流中间主动断开。
  let notifyAborted;
  const upstreamAborted = new Promise((resolve) => (notifyAborted = resolve));
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`);
    req.on("close", () => notifyAborted());
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = await startApp({ stub: { type: "openai", baseUrl, models: ["m"] } });
  t.after(() => new Promise((r) => upstream.close(r)));
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  // 抓住 error 级日志：客户端断开是预期路径，不该冒出「流式回复出错」的堆栈。
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => (console.error = originalError));

  const controller = new AbortController();
  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q", model: "m" }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);

  // 读到第一个增量后断开，模拟关标签页。
  const abortedAt = Date.now();
  controller.abort();
  await res.text().catch(() => undefined);

  // 上游必须**很快**看到断开：慢一拍就等于为已无人接收的响应继续烧 token。
  const aborted = await Promise.race([
    upstreamAborted.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 1500)),
  ]);
  assert.equal(aborted, true, `应在 1.5s 内中断上游请求（等了 ${Date.now() - abortedAt}ms）`);
  const complaints = logged.filter((line) => line.includes("流式回复出错"));
  assert.deepEqual(
    complaints,
    [],
    `客户端断开不该记成服务端故障，实际日志: ${complaints.join(" | ")}`,
  );
});

test("关停时不会因为还开着的流而被拖住", async (t) => {
  // 上游永不主动结束，模拟一个正在长时间生成回复的模型。
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = await startApp({ stub: { type: "openai", baseUrl, models: ["m"] } });
  t.after(() => new Promise((r) => upstream.close(r)));

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  // 客户端保持连接、不主动断开——这正是「关服务时有人在用」的场景。
  // server.close() 会等所有连接自然结束，流式响应是长连接，没有主动收尾就会一直挂住。
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q", model: "m" }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  // 读到第一个增量，确认流真的已经建立。
  const reader = res.body.getReader();
  await reader.read();

  const started = Date.now();
  await app.stop();
  const elapsed = Date.now() - started;

  // 阈值放宽到 3s：这里要证明的是「不会挂到上游超时（原本 120s+）」，不是精确计时。
  assert.ok(elapsed < 3000, `关停应在 3s 内完成，实际 ${elapsed}ms`);
});

test("流式端点：匿名访问被鉴权闸门拦下", async (t) => {
  const upstream = await startStubUpstream(["x"]);
  const app = await startApp({
    stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] },
  });
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const session = { id: "任意" };
  const res = await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "q" }),
  });
  assert.equal(res.status, 401);
});
