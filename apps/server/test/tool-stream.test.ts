/**
 * 工具调用的端到端链：HTTP + SSE + 真引擎 + 真 current_time + 桩上游。
 *
 * 证的是「回喂真的发生了」这件事在**线协议层**成立：
 * 桩上游按请求内容分支 —— 历史里没有 `role:"tool"` 就要求调用，有就给最终回答。
 * 于是「第二次请求里同时出现 assistant.tool_calls 与 tool_call_id」就是整条链的收据，
 * 进程内的引擎测试（`engine-tools.test.ts`）证不到这一层。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { configFilePath } from "#config/file.ts";
import { makeTestConfig } from "./helpers/config.ts";

/** 上游收到的一次请求（只留这条链要断言的字段）。 */
interface UpstreamRequest {
  body: {
    tools?: { type?: string; function?: { name?: string } }[];
    messages?: { role: string; content?: string; tool_calls?: unknown; tool_call_id?: string }[];
  };
}

/**
 * 桩上游：第一次补全要求调用 `current_time`（arguments 故意拆两片，模拟真实分片），
 * 看到历史里已经有工具结果了就回一句最终文本。
 */
async function startStubUpstream() {
  const seen: UpstreamRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as UpstreamRequest["body"];
      seen.push({ body });
      const answered = body.messages?.some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (answered) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "现在是白天" } }] })}\n\n`,
        );
      } else {
        for (const fragment of [
          { index: 0, id: "call_1", function: { name: "current_time", arguments: '{"time' } },
          { index: 0, function: { arguments: 'zone":"UTC"}' } },
        ]) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [fragment] } }] })}\n\n`,
          );
        }
      }
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("桩上游没有绑定 TCP 端口");
  return {
    baseUrl: `http://127.0.0.1:${bound.port}/v1`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startApp(t: TestContext, upstreamUrl: string, enabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), "atri-tool-stream-"));
  // 预置必须在 createApp 之前写：工具开关是每次现读文件，但 provider 源要走启动装配。
  writeFileSync(
    configFilePath(root),
    JSON.stringify({ tools: { current_time: { enabled } } }, null, 2),
  );
  const app = await createApp(
    makeTestConfig({
      root,
      providerSources: {
        stub: { type: "openai", name: "stub", baseUrl: upstreamUrl, apiKey: "sk", timeoutMs: 5000 },
      },
      providers: { stub: { source: "stub", model: "m" } },
    }),
  );
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, origin: `http://127.0.0.1:${app.address().port}` };
}

async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  const first = res.headers.getSetCookie()[0];
  if (!first) throw new Error("登录没有拿到 Cookie");
  return first.split(";")[0] as string;
}

interface SseFrame {
  delta?: string;
  done?: boolean;
  error?: string;
  message?: { role: string; content: string; toolCalls?: unknown[]; toolCallId?: string };
}

async function readSse(origin: string, cookie: string, sessionId: string): Promise<SseFrame[]> {
  const res = await fetch(
    `${origin}/api/v1/sessions/${sessionId}/messages/stream?profile=default`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "现在几点" }),
    },
  );
  assert.equal(res.status, 200);
  const frames: SseFrame[] = [];
  const buffer = await res.text();
  for (const block of buffer.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice("data: ".length);
    if (payload && payload !== "[DONE]") frames.push(JSON.parse(payload) as SseFrame);
  }
  return frames;
}

async function newSession(origin: string, cookie: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "工具" }),
  });
  const json = (await res.json()) as { session: { id: string } };
  return json.session.id;
}

test("启用工具后：一次对话真的跑完「调用 → 执行 → 回喂 → 回答」", async (t) => {
  const upstream = await startStubUpstream();
  t.after(() => upstream.stop());
  const { origin } = await startApp(t, upstream.baseUrl, true);
  const cookie = await login(origin);
  const sessionId = await newSession(origin, cookie);

  const frames = await readSse(origin, cookie, sessionId);

  // 上游确实被打了两次，且第一次带着工具声明
  assert.equal(upstream.seen.length, 2, "应当问了两次：要求调用 + 拿到结果后再答");
  const first = upstream.seen[0]?.body;
  // read_skill 是 internal 工具（技能目录契约的另一半），恒声明排在内置清单之后。
  assert.deepEqual(
    first?.tools?.map((tool) => [tool.type, tool.function?.name]),
    [
      ["function", "current_time"],
      ["function", "read_skill"],
    ],
  );
  const second = upstream.seen[1]?.body;
  const assistantTurn = second?.messages?.find((m) => m.role === "assistant");
  const toolTurn = second?.messages?.find((m) => m.role === "tool");
  assert.ok(assistantTurn?.tool_calls, "第二次请求必须带回助手那条 tool_calls");
  assert.equal(toolTurn?.tool_call_id, "call_1", "结果必须用同一个 id 配对");

  // SSE 帧：中间消息确实推了，末帧仍是最终回复
  const messages = frames.filter((f) => f.message).map((f) => f.message);
  assert.deepEqual(
    messages?.map((m) => m?.role),
    ["assistant", "tool", "assistant"],
    "界面上必须看得见「模型查了什么」，而不是只剩最后那段字",
  );
  assert.ok(frames.at(-1)?.done === true, "末帧必须还是 done:true");
  assert.equal(frames.at(-1)?.message?.content, "现在是白天");
  assert.ok(!frames.some((f) => f.error), `不该有错误帧：${JSON.stringify(frames)}`);

  // 落库历史四条，次序与因果一致
  const detail = await (
    await fetch(`${origin}/api/v1/sessions/${sessionId}`, { headers: { cookie } })
  ).json();
  const history = (detail as { session: { messages: SseFrame["message"][] } }).session.messages;
  assert.deepEqual(
    history.map((m) => m?.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.ok(history[1]?.toolCalls, "带 toolCalls 的助手消息要留在历史里");
  assert.equal(history[2]?.toolCallId, "call_1");
  // current_time 真的执行了：结果文本带着它自己的措辞
  assert.match(history[2]?.content ?? "", /时区 UTC/);

  // 开关确实是被读出来的，不是测试自己造的：GET /tools 与这轮行为必须同源
  const listed = (await (
    await fetch(`${origin}/api/v1/tools?profile=default`, { headers: { cookie } })
  ).json()) as { tools: { id: string; enabled: boolean }[] };
  assert.equal(listed.tools[0]?.enabled, true);
});

test("工具关闭时：不发 tools 键，模型硬要调用也不执行", async (t) => {
  const upstream = await startStubUpstream();
  t.after(() => upstream.stop());
  const { origin } = await startApp(t, upstream.baseUrl, false);
  const cookie = await login(origin);
  const sessionId = await newSession(origin, cookie);

  const frames = await readSse(origin, cookie, sessionId);

  // 第一次请求的 tools 里只应有 internal 工具（read_skill 恒声明），
  // 用户开关里的 current_time 必须缺席 —— 「关掉的开关被模型远程打开」就是从这里防的。
  assert.deepEqual(
    (upstream.seen[0]?.body.tools as { function?: { name: string } }[] | undefined)?.map(
      (tool) => tool.function?.name,
    ),
    ["read_skill"],
  );
  // 桩上游不管有没有声明工具都回一个 tool_calls，这正是「模型硬要调用」的那一种。
  assert.equal(upstream.seen.length, 2, "拒绝执行也要把结果回喂，所以还会再问一次");
  const toolTurn = upstream.seen[1]?.body.messages?.find((m) => m.role === "tool");
  assert.match(toolTurn?.content ?? "", /未授权执行/, "回喂给模型的那条必须说明为什么没执行");
  const detail = (await (
    await fetch(`${origin}/api/v1/sessions/${sessionId}`, { headers: { cookie } })
  ).json()) as { session: { messages: { role: string; content: string }[] } };
  const toolMessage = detail.session.messages.find((m) => m.role === "tool");
  assert.match(toolMessage?.content ?? "", /未授权执行/);
  // 关键的一条：current_time 真的**没有**被执行（执行了就会带它自己的措辞）。
  assert.doesNotMatch(toolMessage?.content ?? "", /时区/);
  assert.ok(frames.at(-1)?.done === true, "界面上仍是一条正常的末帧，不该挂成错误");
});
