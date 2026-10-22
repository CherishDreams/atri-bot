import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Message } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import type { AdapterTarget } from "#adapters/manager.ts";
import type { ConversationSessions } from "#adapters/message.ts";
import { SnowLumaAdapter } from "#adapters/snowluma.ts";

/**
 * SnowLuma 的传输层：它和 NapCat 说同一套 OneBot 11，但方向相反。
 * 这里用本地 WS 服务端扮演 SnowLuma，验证连接、鉴权头、事件/回复与 callAction。
 */

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function reply(content: string): Message {
  return {
    id: "m",
    sessionId: "s",
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Frame {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

test("SnowLuma：正向 WS 连接、Bearer 鉴权、消息收发与 callAction", async (t) => {
  const received: Frame[] = [];
  const authHeaders: string[] = [];
  const engineCalls: { sessionId: string; content: string }[] = [];
  let peer: WebSocket | null = null;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;

  const respond = (frame: Frame, data: unknown): void => {
    if (peer !== null) {
      peer.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: frame.echo }));
    }
  };
  const sendEvent = (event: unknown): void => {
    if (peer === null) throw new Error("SnowLuma 连接尚未建立");
    peer.send(JSON.stringify(event));
  };
  server.on("connection", (ws, req) => {
    peer = ws;
    authHeaders.push(req.headers.authorization ?? "");
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      received.push(frame);
      if (frame.action === "get_login_info") {
        respond(frame, { user_id: 10001, nickname: "SnowLuma 机器人" });
      } else if (frame.action === "send_private_msg") {
        respond(frame, { message_id: 2 });
      } else if (frame.action === "custom_action") {
        respond(frame, { answer: 42 });
      }
    });
  });

  const adapter = new SnowLumaAdapter({
    id: "snowluma",
    profileId: "default",
    url: `ws://127.0.0.1:${port}/ws`,
    token: "secret",
    logger: silentLogger(),
    resolveTarget: () =>
      ({
        engine: {
          async handleMessage(options: { sessionId: string; content: string }) {
            engineCalls.push({ sessionId: options.sessionId, content: options.content });
            return reply("收到");
          },
        },
      }) as unknown as AdapterTarget,
    conversations: { getOrCreate: (key) => `session-${key}` } satisfies ConversationSessions,
    actionTimeoutMs: 2000,
  });

  await adapter.start();
  t.after(async () => {
    await adapter.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await waitFor(() => received.some((frame) => frame.action === "get_login_info"));
  assert.deepEqual(authHeaders, ["Bearer secret"], "token 应该以 Authorization: Bearer 发送");
  assert.ok(received.some((frame) => frame.action === "get_login_info"));

  sendEvent({
    post_type: "message",
    message_type: "private",
    self_id: 10001,
    user_id: 20002,
    message_id: 3,
    sender: { nickname: "小明" },
    message: [{ type: "text", data: { text: "你好" } }],
  });
  await waitFor(() => engineCalls.length === 1);
  assert.equal(engineCalls[0]?.content, "你好");

  await waitFor(() => received.some((frame) => frame.action === "send_private_msg"));
  const sent = received.find((frame) => frame.action === "send_private_msg");
  assert.equal(sent?.params.user_id, 20002);
  assert.deepEqual(sent?.params.message, [{ type: "text", data: { text: "收到" } }]);

  const data = await adapter.callAction("custom_action", { question: "life" });
  assert.deepEqual(data, { answer: 42 });
  assert.deepEqual(received.find((frame) => frame.action === "custom_action")?.params, {
    question: "life",
  });

  await adapter.stop();
  await assert.rejects(() => adapter.callAction("custom_action", {}), /尚未连接/);
});

test("SnowLuma：非法 URL 在启动时就报错，而不是进入重连循环", async () => {
  const adapter = new SnowLumaAdapter({
    id: "snowluma-bad",
    profileId: "default",
    url: "http://127.0.0.1:3001/ws",
    token: "",
    logger: silentLogger(),
    resolveTarget: () => null,
    conversations: { getOrCreate: () => "s" },
  });
  await assert.rejects(() => adapter.start(), /必须以 ws:\/\/ 或 wss:\/\//);
  await adapter.stop();
});
