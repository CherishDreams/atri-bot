import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { AdapterInfo, Message, MessageImage } from "@atri/shared";
import { createApp } from "#app.ts";
import type { Logger } from "#core/logger.ts";
import type { AdapterTarget } from "#adapters/manager.ts";
import type { ConversationSessions } from "#adapters/message.ts";
import { NapCatAdapter } from "#adapters/napcat.ts";
import { parseOneBotMessage } from "#adapters/onebot11.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * NapCat 的协议层：本仓只消费 OneBot 11 的一个子集，用本地 WS 服务器把
 * 「事件 → 引擎 → 动作 → 响应」走一遍，比对着文档抄 JSON 更能证明字段名没写错。
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

/** 文件头是合法 PNG 即可；测试只验证下载、嗅探与 base64 往返。 */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("parseOneBotMessage：文本、at、图片引用与无来源图片的占位", () => {
  const parsed = parseOneBotMessage([
    { type: "text", data: { text: "你好" } },
    { type: "at", data: { qq: 123 } },
    {
      type: "image",
      data: { file: "x.png", url: "https://example.test/x.png" },
    },
    // 没有 url/file 的图片段保留占位，而不是当成正文丢掉。
    { type: "image", data: {} },
    { type: "reply", data: { id: "1" } },
    { type: "mystery", data: {} },
  ]);
  assert.equal(parsed.text, "你好@123[图片][mystery]");
  assert.deepEqual(parsed.images, [{ file: "x.png", url: "https://example.test/x.png" }]);
  assert.deepEqual(parseOneBotMessage("原样文本", "raw"), { text: "原样文本", images: [] });
  assert.deepEqual(parseOneBotMessage([], "回退文本"), { text: "回退文本", images: [] });
  assert.deepEqual(parseOneBotMessage([{ type: "text", data: { text: "  " } }]), {
    text: "",
    images: [],
  });
});

interface Action {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

test("NapCat：作为 WS 服务端接收客户端，鉴权与私聊/群聊收发", async (t) => {
  const actions: Action[] = [];
  const engineCalls: { sessionId: string; content: string; images?: MessageImage[] }[] = [];
  const conversations: { key: string; title: string }[] = [];

  const imageServer = createServer((req, res) => {
    if (req.url !== "/pic.png") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png", "content-length": ONE_PIXEL_PNG.length });
    res.end(ONE_PIXEL_PNG);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", () => resolve()));
  const imagePort = (imageServer.address() as AddressInfo).port;
  const adapter = new NapCatAdapter({
    id: "napcat",
    profileId: "default",
    host: "127.0.0.1",
    port: "0",
    path: "/ws",
    token: "secret",
    logger: silentLogger(),
    resolveTarget: () =>
      ({
        engine: {
          async handleMessage(options: {
            sessionId: string;
            content: string;
            images?: MessageImage[];
          }) {
            engineCalls.push({
              sessionId: options.sessionId,
              content: options.content,
              ...(options.images === undefined ? {} : { images: options.images }),
            });
            return reply("收到");
          },
        },
      }) as unknown as AdapterTarget,
    conversations: {
      getOrCreate(key, title): string {
        conversations.push({ key, title });
        return `session-${conversations.length}`;
      },
    } satisfies ConversationSessions,
    actionTimeoutMs: 2000,
  });

  await adapter.start();
  const address = adapter.address();
  assert.ok(address, "反向 WS 应已监听");
  const port = address.port;

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: "Bearer secret" },
  });
  const respond = (action: Action, data: unknown): void => {
    client.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: action.echo }));
  };
  const loginSeen = new Promise<void>((resolve, reject) => {
    client.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as Action;
      actions.push(parsed);
      if (parsed.action === "get_login_info") {
        respond(parsed, { user_id: 10000, nickname: "机器人" });
        resolve();
      } else if (parsed.action === "get_image") {
        // 下载失败后的刷新也没有拿到新地址：消息应退回 `[图片]` 而不是消失。
        respond(parsed, { url: "" });
      } else if (parsed.action === "send_private_msg" || parsed.action === "send_group_msg") {
        respond(parsed, { message_id: 2 });
      }
    });
    client.once("error", reject);
  });

  t.after(async () => {
    try {
      client.close();
    } catch {
      client.terminate();
    }
    await adapter.stop();
    await new Promise<void>((resolve) => imageServer.close(() => resolve()));
  });

  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  await loginSeen;

  // 错误的 token 在握手阶段就该被拒；能连上的是上面那条带正确 Bearer 的连接。
  const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: "Bearer wrong" },
  });
  const refused = await new Promise<boolean>((resolve) => {
    rejected.once("open", () => resolve(false));
    rejected.once("error", () => resolve(true));
  });
  assert.equal(refused, true, "错误 token 的客户端不应连上");
  rejected.terminate();

  const send = (event: Record<string, unknown>): void => {
    client.send(JSON.stringify({ post_type: "message", self_id: 10000, ...event }));
  };

  send({
    message_type: "private",
    user_id: 123,
    message_id: 1,
    message: [{ type: "text", data: { text: "你好" } }],
    raw_message: "你好",
    sender: { user_id: 123, nickname: "小明" },
  });
  await waitFor(
    () => engineCalls.length === 1 && actions.some((a) => a.action === "send_private_msg"),
  );
  assert.deepEqual(engineCalls[0], { sessionId: "session-1", content: "你好" });
  assert.deepEqual(conversations[0], { key: "default:private:123", title: "QQ 私聊 小明" });
  const privateAction = actions.find((a) => a.action === "send_private_msg");
  assert.deepEqual(privateAction?.params, {
    user_id: 123,
    message: [{ type: "text", data: { text: "收到" } }],
  });

  // 自己的消息不能再进引擎，否则会自问自答。
  send({
    message_type: "private",
    user_id: 10000,
    message_id: 99,
    message: [{ type: "text", data: { text: "我自己" } }],
    raw_message: "我自己",
    sender: { user_id: 10000, nickname: "机器人" },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(engineCalls.length, 1);

  send({
    message_type: "group",
    group_id: 456,
    user_id: 123,
    message_id: 2,
    message: [{ type: "text", data: { text: "大家好" } }],
    raw_message: "大家好",
    sender: { user_id: 123, nickname: "小明", card: "群名片" },
  });
  await waitFor(
    () => engineCalls.length === 2 && actions.some((a) => a.action === "send_group_msg"),
  );
  assert.deepEqual(engineCalls[1], { sessionId: "session-2", content: "[群名片] 大家好" });
  assert.deepEqual(conversations[1], { key: "default:group:456", title: "QQ 群 456" });
  const groupAction = actions.find((a) => a.action === "send_group_msg");
  assert.deepEqual(groupAction?.params, {
    group_id: 456,
    message: [{ type: "text", data: { text: "收到" } }],
  });

  // 纯图片消息：正文为空也必须进引擎，图片要按原始字节转成 base64 附件。
  send({
    message_type: "private",
    user_id: 123,
    message_id: 3,
    message: [
      {
        type: "image",
        data: { file: "pic.png", url: `http://127.0.0.1:${imagePort}/pic.png` },
      },
    ],
    raw_message: "[CQ:image,file=pic.png]",
    sender: { user_id: 123, nickname: "小明" },
  });
  await waitFor(() => engineCalls.length === 3);
  assert.deepEqual(engineCalls[2], {
    sessionId: "session-3",
    content: "",
    images: [{ data: ONE_PIXEL_PNG.toString("base64"), mediaType: "image/png" }],
  });

  // 下载失败时保留 `[图片]` 占位，不能让整条消息静默消失。
  send({
    message_type: "private",
    user_id: 123,
    message_id: 4,
    message: [
      {
        type: "image",
        data: { file: "missing.png", url: `http://127.0.0.1:${imagePort}/missing.png` },
      },
    ],
    raw_message: "[CQ:image,file=missing.png]",
    sender: { user_id: 123, nickname: "小明" },
  });
  await waitFor(() => engineCalls.length === 4);
  assert.deepEqual(engineCalls[3], { sessionId: "session-4", content: "[图片]" });
});

test("NapCat：反向监听配置不完整时启动即报中文错误", async () => {
  const adapter = new NapCatAdapter({
    id: "napcat",
    profileId: "default",
    host: "",
    port: "",
    path: "",
    token: "",
    logger: silentLogger(),
    resolveTarget: () => null,
    conversations: { getOrCreate: () => "s" },
  });
  await assert.rejects(() => adapter.start(), /配置不完整/);
});

test("组合根注册 NapCat：GET /adapters 能看见绑定状态", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-napcat-wiring-"));
  // `enabled: false`：这里只验组合根注册与列表投影，不真的去连一个 WS 服务器。
  const app = await createApp(
    makeTestConfig({
      root,
      adapters: {
        napcat: {
          enabled: false,
          profile: "default",
          host: "127.0.0.1",
          port: "6199",
          path: "/ws",
          token: "secret",
        },
      },
    }),
  );
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");

  const res = await fetch(`${origin}/api/v1/adapters`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { adapters: AdapterInfo[] };
  const row = body.adapters.find((item) => item.id === "napcat");
  assert.ok(row, "配置里出现 adapters.napcat 后应注册进列表");
  assert.equal(row.name, "NapCat");
  assert.equal(row.enabled, false);
  assert.equal(row.profile, "default");
  assert.equal(row.bound, true, "默认配置档可用");
});
