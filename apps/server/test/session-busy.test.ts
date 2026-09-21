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
  const messagesUrl = `${origin}/api/v1/sessions/${session.id}/messages?profile=default`;

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
  const streamConflict = await send(
    "走流式",
    // 完整写出来而不是 `messagesUrl + "/stream"`：查询串必须落在路径之后，
    // 拼成 `…/messages?profile=default/stream` 只会得到 404，这条用例就变成在测路由表。
    `${origin}/api/v1/sessions/${session.id}/messages/stream?profile=default`,
  );
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

/**
 * 客户端在**非流式**那一轮中途走掉时，锁必须跟着释放。
 *
 * 这条用例盯的是一个只有两条请求才能现形的故障：非流式端点以前不传 `signal`，
 * 于是关掉标签页之后那一轮照跑到底，而 `AgentEngine.#running` 是按会话持有的 ——
 * 症状是「这个会话从此每次发消息都 409」，用户怎么刷新都发不出去，`http.close()` 也救不了
 * （`openStreams` 以前只装 SSE 控制器）。
 *
 * 桩上游按「第一次请求挂住、第二次正常回」设计，收尾时无论成败都放行第一条 ——
 * 否则实现坏了的时候那条请求还挂着，`app.stop()` 会干等到测试运行器把整条用例掐掉，
 * 症状就从「红成一句能读的话」变成「莫名其妙超时」。
 */
test("非流式端点：客户端中途断开时中断上游并释放会话锁", async (t) => {
  let markEntered!: () => void;
  let markAborted!: () => void;
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const upstreamAborted = new Promise<void>((resolve) => (markAborted = resolve));
  let seen = 0;
  // 第一条请求的 response 被扣住不放。收尾时必须放它走：实现**没坏**的时候它会被 abort 掉，
  // 而实现坏了的时候它还在跑 —— 那时 `app.stop()` 会等一个永远不会回的 upstream。
  let firstPending: ServerResponse | null = null;

  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      seen += 1;
      if (seen === 1) {
        // 第一条：挂住不回，等对端把连接关掉。这一刻就是「客户端已经走了，服务端还不知道」。
        markEntered();
        req.on("close", () => markAborted());
        firstPending = res;
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "答完了" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const bound = upstream.address();
  if (bound === null || typeof bound === "string") throw new Error("桩上游未绑定 TCP 端口");

  const root = mkdtempSync(join(tmpdir(), "atri-session-abort-"));
  const app = await createApp(
    makeTestConfig({
      root,
      providers: {
        stub: { type: "openai", baseUrl: `http://127.0.0.1:${bound.port}/v1`, models: ["m"] },
      },
    }),
  );
  await app.start();
  t.after(async () => {
    // 顺序就是这条用例的意义所在：先放行可能被扣住的那一条，再停服。
    if (firstPending && !firstPending.writableEnded && !firstPending.destroyed) {
      firstPending.writeHead(200, { "content-type": "application/json" });
      firstPending.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "迟到的一答" }, finish_reason: "stop" },
          ],
        }),
      );
    }
    await app.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const cookie = await login(origin);
  const created = await fetch(`${origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "断开" }),
  });
  const { session } = (await created.json()) as { session: Session };
  const messagesUrl = `${origin}/api/v1/sessions/${session.id}/messages?profile=default`;
  const send = (content: string, signal?: AbortSignal) =>
    fetch(messagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content, model: "m" }),
      ...(signal ? { signal } : {}),
    });

  const controller = new AbortController();
  const abandoned = send("第一条", controller.signal).catch(() => null);
  await entered;
  controller.abort();
  await abandoned;

  // 有界等待：等不到就明说「这一步没发生」，而不是让整条用例挂到测试运行器的超时。
  //
  // **这条不是判据**：实测把 `signal` 接回去拿掉，它照样绿 —— 客户端断开时我们这侧的
  // socket 会被销毁，那一跳连带把上游的请求也关掉了，所以「上游收到 close」在两种实现下
  // 都成立。真正的判据是下面那句「第二条得到 200」：只有 handler 把 abort 传进
  // `handleMessage`，引擎才会提前结束、才会把 `#running` 里的这一格还回去。
  // 留在这里是因为它把故障现场说清楚了（锁没释放时，先看到这条还是先看到那条）。
  const gotClose = await Promise.race([
    upstreamAborted.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000).unref()),
  ]);
  assert.ok(gotClose, "客户端的断开没有传到上游那一跳");

  // 锁还回来了：同会话的第二条得到 200，而不是「这个会话从此每次 409」。
  //
  // 这里**必须等**：断开 → provider 那一跳被 abort → 引擎的 `finally` 把这一格还回
  // `#running`，中间隔着一次 socket 关闭与几个微任务。单独跑本文件时这个窗口从来没被撞上，
  // 整仓并发跑第一次就撞上了 —— 那是用例的时序假设，不是产品缺陷。409 在这里是「再试一次」
  // 的信号，失败的定义是「重试到截止仍然是 409」。
  // 被拒的那几次不会写进历史（引擎在追加用户消息**之前**就返回 409），所以重试不留痕迹。
  const settled = await retryWhileBusy("第二条");
  assert.equal(settled.status, 200, "客户端断开不得把会话永久锁死");
  await settled.body?.cancel();

  /** 撞上 409 就重试，最多 2 秒；返回最后一个响应（200 或截止时的 409）。 */
  async function retryWhileBusy(content: string) {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const res = await send(content);
      if (res.status !== 409 || Date.now() >= deadline) return res;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 20).unref());
    }
  }
});

/**
 * 删除与「一轮正在进行」的冲突。
 *
 * 这条查的是**判据漏了半边**：`profiles.remove` 一直查锁（「这个档占着任何会话」），
 * 而 `DELETE /sessions/:id` 以前不查（「这个会话正被占着」）—— 于是删掉一个正在跑的会话，
 * 那一轮之后的每次落库都会落到「会话不存在」，流式端点以一个 error 帧收场，
 * 已经生成的半轮无处可查。症状与「同会话并发」那两条不同：不是排队，是**内容凭空消失**。
 */
test("删除正在进行中的会话：409 且会话仍在，这一轮结束后才删得掉", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-session-delete-busy-"));
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
    body: JSON.stringify({ title: "删除与占用" }),
  });
  assert.equal(created.status, 201);
  const { session } = (await created.json()) as { session: Session };
  const url = `${origin}/api/v1/sessions/${session.id}`;

  const round = fetch(`${url}/messages?profile=default`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "第一条", model: "m" }),
  });
  await upstream.entered;

  const busy = await fetch(url, { method: "DELETE", headers: { cookie } });
  assert.equal(busy.status, 409, "会话正被占着时必须拒绝删除");
  const busyBody = (await busy.json()) as Record<string, unknown>;
  assert.match(String(busyBody.error), /还没结束/);

  // 反面守卫：409 这一支不许顺手把会话删掉。「已被拒」与「删了但报错」在状态码上分不出来，
  // 只能回头看那个会话还在不在 —— 而那正是用户下一步会做的事。
  const still = await fetch(url, { headers: { cookie } });
  assert.equal(still.status, 200, "被拒的删除不许动到会话本身");
  await still.body?.cancel();

  upstream.release();
  const done = await round;
  assert.equal(done.status, 200);
  await done.body?.cancel();

  const deleted = await fetch(url, { method: "DELETE", headers: { cookie } });
  assert.equal(deleted.status, 200, "锁释放之后同一个会话就该删得掉");
  const gone = await fetch(url, { headers: { cookie } });
  assert.equal(gone.status, 404, "删除必须真的生效，否则这条 200 是在说谎");
});
