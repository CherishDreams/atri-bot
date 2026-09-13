import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionDetail, ToolCall } from "@atri/shared";
import { createApp } from "#app.ts";
import type { ProvidersFileConfig } from "#config/file.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 会话持久化的端到端测试：**stop → 用同一个数据目录再 start → 复查**。
 *
 * 这条形状在本仓此前一条测试都没有 —— 内存版做不到「重启后还在」，所以没什么可测。
 * 会话落进 `config.dataDir` 下的 sqlite 之后，「还在」变成一个可以被证伪的事实，
 * 于是它必须被钉住：只测「写进去读得出来」（进程内就能过）的套件会在退化回内存实现时
 * 依然全绿，那正是本文件存在的理由。
 *
 * 与 `stream.test.ts` 一样不 mock provider：走完整条 HTTP + 引擎 + 桩上游的链。
 */

interface Running {
  origin: string;
  stop(): Promise<void>;
}

/**
 * 在**给定的 root** 上起一个 app。
 *
 * 与 `stream.test.ts` 的 `startApp` 唯一的区别：root 由调用方持有、这里不删 ——
 * 本文件每条用例都要在同一个目录上起第二个 app，目录的生命周期必须比 app 长。
 * `stop` 带一次性守卫，所以「显式停一次、清理钩子再兜一次」不会重复关服务器。
 */
async function startAppOn(root: string, providers: ProvidersFileConfig): Promise<Running> {
  const app = await createApp(makeTestConfig({ root, providers }));
  await app.start();
  let stopped = false;
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await app.stop();
    },
  };
}

/**
 * 一座临时数据目录 + 会自己收尾的 `start()`。
 *
 * 清理钩子只注册一次、且**先停 app 再删目录**：反过来的话，测试失败时留下的就是一个
 * 还在被占着的 sqlite（Linux 上删得掉，但日志里会多一句与用例无关的关闭错误）。
 */
async function useStore(
  t: TestContext,
): Promise<(providers: ProvidersFileConfig) => Promise<Running>> {
  const root = mkdtempSync(join(tmpdir(), "atri-session-restore-"));
  const running: Running[] = [];
  t.after(async () => {
    for (const app of running) await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return async (providers) => {
    const app = await startAppOn(root, providers);
    running.push(app);
    return app;
  };
}

function listenPort(server: Server): number {
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error(`桩上游未绑定 TCP 端口（address=${String(bound)}）`);
  }
  return bound.port;
}

/**
 * 桩上游：把给定分段回成助手内容。
 *
 * 按请求里的 `stream` 旗标分派两种报文 —— 本文件的用例都走**非流式**的
 * `POST /sessions/:id/messages`（引擎调 `chat()` 而不是 `chatStream()`），
 * 而照 `stream.test.ts` 那样无条件吐 SSE 会让 provider 解析不出内容、
 * 端点回 400：那是桩写错了，不是被测行为。
 */
async function startStubUpstream(chunks: string[]) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const content = chunks.join("");
      const parsed = JSON.parse(body || "{}") as { stream?: unknown };
      const streaming = parsed.stream === true;
      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    baseUrl: `http://127.0.0.1:${listenPort(server)}/v1`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 报错路径的桩上游：401 + OpenAI 的错误体（provider 层把它归一成「密钥无效」）。 */
async function startDecliningUpstream() {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    baseUrl: `http://127.0.0.1:${listenPort(server)}/v1`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");
  return cookie;
}

/**
 * 取一个 JSON 响应。
 *
 * `as` 在这里是允许的：`Response.json()` 的返回是 `unknown`，而这里每个调用点要的
 * 那一个形状都由调用方写清（与 `api/server.ts` 的 `readJson` 返回 `Record<string, unknown>`
 * 是同一取向 —— 收窄发生在边界上，不是靠放宽类型）。
 */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createSession(origin: string, cookie: string, title: string): Promise<Session> {
  const res = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  assert.equal(res.status, 201);
  const body = await json<{ session: Session }>(res);
  return body.session;
}

async function getDetail(origin: string, cookie: string, id: string): Promise<SessionDetail> {
  const res = await fetch(`${origin}/api/v1/sessions/${id}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await json<{ session: SessionDetail }>(res);
  return body.session;
}

async function send(
  origin: string,
  cookie: string,
  id: string,
  content: string,
): Promise<Response> {
  return fetch(`${origin}/api/v1/sessions/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content, model: "m" }),
  });
}

test("会话元数据跨重启存活（不需要上游，也不需要引擎）", async (t) => {
  const start = await useStore(t);

  const first = await start({});
  const cookie = await login(first.origin);
  const created = await createSession(first.origin, cookie, "重启后还在");
  await first.stop();

  const second = await start({});
  const again = await login(second.origin);
  const res = await fetch(`${second.origin}/api/v1/sessions`, { headers: { cookie: again } });
  const body = await json<{ sessions: Session[] }>(res);

  // 「还在」必须是**这一座库**里的那一条，而不是第二次启动自己新建的。
  assert.deepEqual(
    body.sessions.map((s) => [s.id, s.title, s.messageCount]),
    [[created.id, "重启后还在", 0]],
  );
});

test("一轮完整对话跨重启存活，次序与内容就是刷新后看到的", async (t) => {
  const start = await useStore(t);
  const upstream = await startStubUpstream(["A", "B"]);
  t.after(() => upstream.stop());
  const providers = { stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] } };

  const first = await start(providers);
  const cookie = await login(first.origin);
  const session = await createSession(first.origin, cookie, "问答");
  const reply = await send(first.origin, cookie, session.id, "你好");
  assert.equal(reply.status, 200);
  await reply.body?.cancel();
  await first.stop();

  const second = await start(providers);
  const detail = await getDetail(second.origin, await login(second.origin), session.id);
  assert.equal(detail.messageCount, 2);
  // 次序是契约：上游两家都靠「助手那条排在它的工具结果之前」配对，刷新后不能变。
  assert.deepEqual(
    detail.messages.map((m) => [m.role, m.content]),
    [
      ["user", "你好"],
      ["assistant", "AB"],
    ],
  );
});

test("被上游拒绝的一轮：用户那条原样留着，重启后仍是一条", async (t) => {
  const start = await useStore(t);
  const upstream = await startDecliningUpstream();
  t.after(() => upstream.stop());
  const providers = { stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] } };

  const first = await start(providers);
  const cookie = await login(first.origin);
  const session = await createSession(first.origin, cookie, "半截");
  const failed = await send(first.origin, cookie, session.id, "问一半");
  // 非流式路径把上游报错折算成一个 4xx —— 但用户那句在问上游之前就已经落库了。
  assert.equal(failed.status, 400);
  await failed.body?.cancel();
  await first.stop();

  const second = await start(providers);
  const detail = await getDetail(second.origin, await login(second.origin), session.id);
  // 刻意**不**清理、不标记：被中断的一轮是运行期的事实，不是脏数据（方案里定的决策）。
  // 也不伪造回复 —— 这里必须恰好只有一条 user。
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ["user"],
  );
  assert.equal(detail.messageCount, 1);
});

test("删除是库里的删除，不是只在内存里抹掉一次视图", async (t) => {
  const start = await useStore(t);
  const upstream = await startStubUpstream(["嗯"]);
  t.after(() => upstream.stop());
  const providers = { stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] } };

  const first = await start(providers);
  const cookie = await login(first.origin);
  const kept = await createSession(first.origin, cookie, "留下");
  const doomed = await createSession(first.origin, cookie, "删掉");
  await (await send(first.origin, cookie, doomed.id, "说一句")).body?.cancel();

  const del = await fetch(`${first.origin}/api/v1/sessions/${doomed.id}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(del.status, 200);
  await first.stop();

  const second = await start(providers);
  const again = await login(second.origin);
  const list = await json<{ sessions: Session[] }>(
    await fetch(`${second.origin}/api/v1/sessions`, { headers: { cookie: again } }),
  );
  assert.deepEqual(
    list.sessions.map((s) => s.id),
    [kept.id],
    "删除的会话重启后仍不存在",
  );
  const gone = await fetch(`${second.origin}/api/v1/sessions/${doomed.id}`, {
    headers: { cookie: again },
  });
  assert.equal(gone.status, 404);
});

test("带工具调用的一轮跨重启后，调用与结果的配对关系仍在", async (t) => {
  const start = await useStore(t);
  // 桩上游直接给**非流式**的 tool_calls 报文（`chat()` 那条路径），一次调用一个结果。
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const asked = (JSON.parse(body) as { messages: unknown[] }).messages.some(
        (m) => (m as { role?: string }).role === "tool",
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          asked
            ? {
                choices: [
                  { message: { role: "assistant", content: "查完了" }, finish_reason: "stop" },
                ],
              }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: { name: "current_time", arguments: '{"timezone":"UTC"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const providers = {
    stub: { type: "openai", baseUrl: `http://127.0.0.1:${listenPort(server)}/v1`, models: ["m"] },
  };
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const first = await start(providers);
  const cookie = await login(first.origin);
  const session = await createSession(first.origin, cookie, "工具");
  // 工具默认关闭，所以这一步的执行会失败 —— 但「失败的工具结果」也是一条 role:"tool" 消息，
  // 正是要验的形状：它带着配对的 toolCallId 落库，重启后仍然配得上。
  await (await send(first.origin, cookie, session.id, "几点了")).body?.cancel();
  const before = await getDetail(first.origin, cookie, session.id);
  await first.stop();

  const second = await start(providers);
  const after = await getDetail(second.origin, await login(second.origin), session.id);

  assert.deepEqual(
    before.messages.map((m) => m.role),
    after.messages.map((m) => m.role),
    "重启不是重新排一遍",
  );
  const assistant = after.messages.find((m) => m.role === "assistant" && m.toolCalls?.length);
  assert.ok(assistant, "带 toolCalls 的助手消息必须还在");
  const tool = after.messages.find((m) => m.role === "tool");
  assert.ok(tool?.toolCallId, "工具结果那条必须仍带着配对的 toolCallId");
  const calls: ToolCall[] = assistant.toolCalls ?? [];
  assert.equal(calls[0]?.id, tool?.toolCallId);
  // `arguments` 是模型产出的原始串，原样往返（`registry.ts` 刻意不解析它）。
  assert.equal(calls[0]?.arguments, '{"timezone":"UTC"}');
});

/**
 * 分页参数走**真 URL** 的那一段。
 *
 * `api/server.ts` 的 `pageOptions()` 把 query 里的字符串变成 `limit: number`，而它以前
 * 一次也没被 HTTP 测过 —— 单元侧的 `#page()` 断言全绿也挡不住这里 `Number(...)` 被删掉、
 * 或者 `?before=` 的空串被当成「没传」。更关键的是游标要过一次 URL：`base64url` 的 alphabet
 * 与 query string 的转义规则（`+` 变空格、`=` 要编码）是本项目里最容易只在真机上坏的一类。
 */
test("分页游标经真 URL 逐页拼接：一条不漏、一条不重，非法值一律 400", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-page-url-"));
  const running: Running[] = [];
  t.after(async () => {
    for (const app of running) await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const app = await startAppOn(root, {});
  running.push(app);
  const cookie = await login(app.origin);
  const titles = ["甲", "乙", "丙"];
  const created = [];
  for (const title of titles) created.push(await createSession(app.origin, cookie, title));

  const get = (query: string) =>
    fetch(`${app.origin}/api/v1/sessions?${query}`, { headers: { cookie } });

  // 逐页翻完：拼接结果必须等于全量，且游标链在 URL 上不断。
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < titles.length + 1; guard += 1) {
    const res = await get(
      cursor === null ? "limit=1" : `limit=1&before=${encodeURIComponent(cursor)}`,
    );
    assert.equal(res.status, 200, `翻第 ${guard + 1} 页得到 ${res.status}`);
    const body = await json<{ sessions: Session[]; nextCursor: string | null }>(res);
    assert.equal(body.sessions.length, 1, "limit=1 就是一条");
    const [only] = body.sessions;
    if (!only) throw new Error("空页：游标链断了");
    seen.push(only.id);
    cursor = body.nextCursor;
    if (cursor === null) break;
  }
  assert.deepEqual(
    seen.toSorted(),
    created.map((s) => s.id).toSorted(),
    "逐页拼接 == 全量：少一条是漏，多一条是重",
  );
  assert.equal(cursor, null, "翻到底要给出 null，而不是继续给同一个游标");

  // 非法值：400 + 标准错误体，不夹取也不当没传。
  for (const query of ["limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=501"]) {
    const res = await get(query);
    assert.equal(res.status, 400, `${query} 应当被拒`);
    const body = await json<Record<string, unknown>>(res);
    assert.deepEqual(Object.keys(body), ["error"]);
  }
  for (const query of ["before=%21%21%21", "before=", "before=MTIz"]) {
    const res = await get(query);
    assert.equal(res.status, 400, `${query} 应当被当成非法游标`);
    assert.match(String((await json<{ error: string }>(res)).error), /游标/);
  }
});

/**
 * 数据目录的权限位：挡住对话内容的是**目录**，不是库文件的 mode。
 *
 * 这条用例盯着一个只在磁盘上成立的事实。库文件 chmod 0600 早就有了，但 WAL 模式下
 * 真正躺着最近内容的是 `sessions.sqlite-wal`，它由 SQLite 按 umask 创建、并在每次
 * checkpoint 后**重建**（实测 0644）—— 逐文件收紧是追不上它的。`synchronous = NORMAL`
 * 下 checkpoint 又是惰性的，所以「最新的、最敏感的那批消息」在一段时间里就停在
 * 一个 0644 的边上。目录 0700 之后别人连 `stat` 都做不到，文件自己的 mode 才变成次要。
 *
 * 删掉 `db.ts` 里那次 `chmodSync(dataDir, 0o700)` 会红在这里。
 */
test(
  "数据目录是 0700：WAL 边车靠目录挡住，不靠它自己的 mode",
  { skip: process.platform === "win32" && "没有 POSIX 权限位，chmodSync 被静默忽略" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atri-data-mode-"));
    const running: Running[] = [];
    t.after(async () => {
      for (const app of running) await app.stop();
      rmSync(root, { recursive: true, force: true });
    });

    // **先**把数据目录建成 0755，模拟从内存版/旧版升上来的那台机器：`mkdir` 的 `mode`
    // 对已存在的目录不起作用，只有紧随的那次 `chmodSync` 会把它收紧。不这么预置的话，
    // 新目录光靠 `mode: 0o700` 就已经合规，删掉 chmod 也照样绿 —— 那是量了个不存在的东西。
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    chmodSync(dataDir, 0o755);
    assert.equal(
      statSync(dataDir).mode & 0o777,
      0o755,
      "预置的旧目录应当是宽松的，否则这条用例没前提",
    );

    const app = await startAppOn(root, {});
    running.push(app);

    // 先证明「这里真的有一个边车」：没有它，下面那句目录断言就是在量一个不存在的东西。
    const cookie = await login(app.origin);
    await createSession(app.origin, cookie, "一条写入");
    const wal = join(dataDir, "sessions.sqlite-wal");
    assert.ok(
      existsSync(wal),
      "WAL 边车应当在写入后存在；它不在，说明这条用例的量法失效了（而不是实现是对的）",
    );

    assert.equal(statSync(dataDir).mode & 0o777, 0o700, "数据目录必须被收紧到 0700");
    // 库文件那一道还在（纵深防御，也是本仓既有的先例）。
    assert.equal(statSync(join(dataDir, "sessions.sqlite")).mode & 0o777, 0o600);
  },
);
