import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Session, SessionDetail } from "@atri/shared";
import { createApp } from "#app.ts";
import type { ProvidersFileConfig } from "#config/file.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 流式接口的端到端测试：真的起一个「上游 LLM」HTTP 服务，让 provider 去打它，
 * 再通过 HTTP 层的 SSE 端点把增量读回来。
 *
 * 这里刻意不 mock provider：只有走完整条链路（provider 解析上游 SSE →
 * 引擎逐段透传 → 我们的 SSE 端点重新编码），才能验证「前端能拿到增量」这件事，
 * 而单元测试各自只覆盖其中一段。
 */

/**
 * 一条 SSE 帧。对应 `src/api/server.ts` 里 `sendSse` 写出的三种：
 * 增量帧（`delta`）、末帧（`done: true` + 已落库的 `message`）、错误帧（`error`）。
 */
interface SseEvent {
  delta?: string;
  done?: boolean;
  error?: string;
  message?: Message;
}

/**
 * 断言过响应头的响应形状。
 *
 * `Headers.get()` 的类型是 `string | null`，而 `assert.match` 的第一个参数只收
 * `string`。这里用交叉类型**向下收窄**（不替换掉 `Response` 的其余成员）：断言的本意就是
 * 「这个头必须存在并且匹配」，头缺失时运行时传进去的还是 null，`assert.match` 照样抛
 * ERR_ASSERTION，语义没有放宽。之所以在取到响应的那一刻收窄，而不是在断言里加 `!` 或
 * `String(...)`：断言行在本次迁移里逐字冻结（本仓没有快照机制，靠的是人工比对迁移前后的输出）。
 */
type ResponseWithContentType = Response & { headers: { get(name: "content-type"): string } };

/**
 * 桩上游绑定后取它的 TCP 端口。
 *
 * `server.address()` 的类型是 `AddressInfo | string | null`（TCP / Unix socket / 未监听
 * 共用一个方法）。用运行时判断而不是 `as AddressInfo`：真没监听上时要得到一句说得通的
 * 错误，而不是在模板串里冒出 TypeError（`src/api/server.ts` 的 `address()` 同形）。
 */
function listenPort(server: Server): number {
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error(`桩上游未绑定 TCP 端口（address=${String(bound)}）`);
  }
  return bound.port;
}

async function startStubUpstream(chunks: string[]) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  // `listen` 的回调类型是 `() => void`，直接把 Promise 的 resolve 递过去会带上一个
  // 必填参数而不匹配，所以包一层空参箭头函数。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = listenPort(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startApp(providers: ProvidersFileConfig) {
  const root = mkdtempSync(join(tmpdir(), "atri-sse-"));
  // 共享 fixture 的默认值与迁移前这里手抄的那份逐字段相同
  // （`"atri_session"` 就是 `DEFAULT_AUTH_COOKIE_NAME`），所以换成它不改变行为。
  const app = await createApp(makeTestConfig({ root, providers }));
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
async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  // `Headers.get()` 的类型是 `string | null`，第一个分段才是要回传的 `name=value`。
  // 缺头就意味着登录没成功（上一行的状态码断言先兜住），这里用抛错做类型守卫，
  // 不新增断言行：断言序列是本次迁移的比对基线。
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");
  return cookie;
}

async function createSession(origin: string, cookie: string): Promise<Session> {
  const res = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "t" }),
  });
  // 边界收窄：`Response.json()` 的返回是 `unknown`（JSON 里可以有任何东西）。
  const body = (await res.json()) as { session: Session };
  return body.session;
}

/** 读完整条 SSE 响应，返回解析后的事件对象数组。 */
async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return (
    text
      .split("\n\n")
      .filter((block) => block.startsWith("data:"))
      // 边界收窄：`JSON.parse` 的返回是 `any`，帧的形状见上面的 SseEvent。
      .map((block) => JSON.parse(block.replace(/^data:\s*/, "")) as SseEvent)
  );
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

  // 断言要读 content-type 这个头，所以在这里向下收窄一次（见 ResponseWithContentType）。
  const res = (await fetch(`${app.origin}/api/v1/sessions/${session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "嗨", model: "m" }),
  })) as ResponseWithContentType;

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("cache-control"), "no-store");

  const events = await readSse(res);
  const deltas = events.filter((e) => e.delta).map((e) => e.delta);
  assert.deepEqual(deltas, ["你", "好", "呀"], "增量应逐段到达，而不是攒成一整段");

  const final = events.at(-1);
  // 运行时守卫（不新增断言行：断言序列是本次迁移的比对基线）。`at(-1)` 与可选的
  // `message` 在类型上都带 undefined，而这两样正是本条用例要证的东西：缺了就是失败，
  // 与迁移前 `any` 下的表现一致（那时是 TypeError）。
  if (!final) throw new Error("SSE 流没有末帧");
  if (!final.message) throw new Error("末帧没有带回已落库的消息");
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

  // 边界收窄：`Response.json()` 的返回是 `unknown`，而这里读的是会话详情
  // （`{ session: SessionDetail }`，见 `src/api/server.ts` 的 GET /sessions/:id）。
  const detail = (await fetch(`${app.origin}/api/v1/sessions/${session.id}`, {
    headers: { cookie },
  }).then((r) => r.json())) as { session: SessionDetail };

  const roles = detail.session.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  // 运行时守卫（不新增断言行）：本条用例断言的就是「第二条消息是助手回复」，
  // 而 `noUncheckedIndexedAccess` 让 `[1]` 的读法带 undefined。
  if (!detail.session.messages[1]) throw new Error("会话详情里没有第二条消息");
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
  // 断言要读 content-type 这个头，所以在这里向下收窄一次（见 ResponseWithContentType）。
  const res = (await fetch(`${app.origin}/api/v1/sessions/不存在/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "q" }),
  })) as ResponseWithContentType;

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
  const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  // `listen` 的回调类型是 `() => void`，直接把 resolve 递过去会带上一个必填参数而
  // 不匹配，所以包一层空参箭头函数（端口取值见 listenPort）。
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${listenPort(upstream)}/v1`;

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
  // 运行时守卫（不新增断言行）：`at(-1)` 与可选的 `error` 在类型上都带 undefined，
  // 而这两样正是本条用例要证的东西，缺了就是失败（迁移前是 `any`，报错形式不同而已）。
  if (!final) throw new Error("SSE 流没有末帧");
  if (typeof final.error !== "string") throw new Error("错误路径的末帧没有带上 error");
  assert.equal(final.done, true);
  assert.match(final.error, /密钥无效/);
  assert.equal(final.message, undefined, "失败时不该伪造一条回复");
});

test("流式端点：客户端中途断开时中断上游，且不按服务端故障记 error", async (t) => {
  // 上游慢速推送，好让我们在流中间主动断开。
  // `notifyAborted` 由 Promise 的执行器**同步**赋值，所以到下面注册 close 回调时它
  // 一定是个函数——这一点是类型给的（声明成 `() => void`，不给初值）。
  let notifyAborted: () => void;
  const upstreamAborted = new Promise<void>((resolve) => (notifyAborted = () => resolve()));
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`);
    req.on("close", () => notifyAborted());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${listenPort(upstream)}/v1`;

  const app = await startApp({ stub: { type: "openai", baseUrl, models: ["m"] } });
  t.after(() => new Promise((r) => upstream.close(r)));
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const session = await createSession(app.origin, cookie);

  // 抓住 error 级日志：客户端断开是预期路径，不该冒出「流式回复出错」的堆栈。
  const logged: string[] = [];
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
  const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${listenPort(upstream)}/v1`;

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
  // 运行时守卫（不新增断言行）：`Response.body` 的类型带 null（无体的响才会），
  // 而 SSE 响应一定有可读流；没有流就等于这条用例的前提没成立。
  if (!res.body) throw new Error("SSE 响应没有可读 body");
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
