import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@atri/shared";
import { createApp } from "#app.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 同会话串行的 **HTTP 层**测试。
 *
 * 引擎侧那三条（`engine-tools.test.ts`）证的是锁的语义；这里证的是两件只在HTTP 上成立的事：
 *
 * 1. 规格里声明的 409 真的以 409 的状态码出去 —— 尤其流式端点必须在**写响应头之前**判，
 *    否则「409」只会变成 SSE 里的一个 error 帧，客户端拿不到状态码语义（与「未知会话
 *    要在开流前 404」是同一条约束）。
 * 2. 一轮结束后同一个会话还能再发 —— 锁漏在某个抛错分支上时，症状是「这个会话从此
 *    每次发消息都 409」，那是最难受的一类 bug，所以它值得在真链路上钉一次。
 */

/** 一个进入即挂住的上游：让「一轮还在进行中」撑到可以被第二次请求撞上。 */
async function startHoldingUpstream() {
  let mark!: () => void;
  const entered = new Promise<void>((resolve) => (mark = resolve));
  let go!: () => void;
  const hold = new Promise<void>((resolve) => (go = resolve));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // 只要把请求体读干（不读干的话连接上的下一步会排队），内容用不上。
    req.resume();
    req.on("end", async () => {
      mark();
      await hold;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "答完了" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("桩上游未绑定 TCP 端口");

  return {
    baseUrl: `http://127.0.0.1:${bound.port}/v1`,
    entered,
    release: () => go(),
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

test("同会话并发：非流式与流式都在开流前拿到 409，结束后会话仍可继续使用", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-session-busy-"));
  const upstream = await startHoldingUpstream();
  const app = await createApp(
    makeTestConfig({
      root,
      providers: { stub: { type: "openai", baseUrl: upstream.baseUrl, models: ["m"] } },
    }),
  );
  await app.start();
  const origin = `http://127.0.0.1:${app.address().port}`;

  t.after(async () => {
    await app.stop();
    await upstream.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const cookie = await login(origin);
  const created = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "并发" }),
  });
  assert.equal(created.status, 201);
  const { session } = (await created.json()) as { session: Session };
  const messagesUrl = `${origin}/api/v1/sessions/${session.id}/messages`;

  const send = (content: string, path = messagesUrl) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content, model: "m" }),
    });

  // 第一轮：发出去、不 await，等它真的进了上游。
  const first = send("第一条");
  await upstream.entered;

  const conflict = await send("第二条");
  assert.equal(conflict.status, 409, "同一会话的第二次请求必须被拒");
  const conflictBody = (await conflict.json()) as Record<string, unknown>;
  // 标准错误体：只有 `error` 一个键，与其它 4xx 同形（前端只需要一条通路就能读理由）。
  assert.deepEqual(Object.keys(conflictBody).toSorted(), ["error"]);
  assert.match(String(conflictBody.error), /还没结束/);

  // 这一条是本文件存在的理由：流式端点必须在**写 SSE 响应头之前**判，
  // 否则状态码就定死在 200，409 这个语义客户端再也拿不到。
  const streamConflict = await send("走流式", `${messagesUrl}/stream`);
  assert.equal(streamConflict.status, 409);
  const contentType = streamConflict.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/);
  assert.doesNotMatch(contentType, /text\/event-stream/);
  await streamConflict.body?.cancel();

  upstream.release();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  await firstResponse.body?.cancel();

  // 锁释放了：同一个会话还能再发（忘记在 finally 里释放的症状就在这一步）。
  const after = await send("第三条");
  assert.equal(after.status, 200);
  await after.body?.cancel();

  const detail = await fetch(`${origin}/api/v1/sessions/${session.id}`, { headers: { cookie } });
  const { session: full } = (await detail.json()) as {
    session: { messages: { role: string; content: string }[] };
  };
  // 被拒的两次**一条消息都没留下**：历史里只有两个完整的往返。
  assert.deepEqual(
    full.messages.map((m) => [m.role, m.content]),
    [
      ["user", "第一条"],
      ["assistant", "答完了"],
      ["user", "第三条"],
      ["assistant", "答完了"],
    ],
  );
});
