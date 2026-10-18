import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterAccessControl, Message, MessageImage } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import type { AdapterTarget } from "#adapters/manager.ts";
import {
  MessageAdapter,
  chunkText,
  formatInbound,
  type ConversationSessions,
  type InboundConversation,
  type InboundMessage,
} from "#adapters/message.ts";
import {
  JsonConversationSessions,
  type ConversationStateIo,
  type SessionDirectory,
} from "#adapters/conversations.ts";

/**
 * 适配器抽象的公共策略：消息格式化、切块、按会话排队、会话映射。
 *
 * 这些策略与平台无关，平台适配器（NapCat 等）只负责传输；因此这里用假引擎、
 * 假会话表就能把「一条消息进来之后发生什么」验完，不需要真 QQ 或真 sqlite。
 */

function logger(warnings: string[], errors: string[], infos: string[] = []): Logger {
  return {
    debug() {},
    info: (msg: string) => infos.push(msg),
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
  };
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

function target(
  handle: (options: { sessionId: string; content: string }) => Promise<Message>,
): AdapterTarget {
  return { engine: { handleMessage: handle } } as unknown as AdapterTarget;
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const conversation: InboundConversation = overrides.conversation ?? {
    kind: "private",
    id: "123",
    label: "小明",
  };
  return {
    sender: { id: "123", name: "小明" },
    conversation,
    text: "你好",
    sessionTitle: conversation.kind === "group" ? `QQ 群 ${conversation.id}` : "QQ 私聊 小明",
    ...overrides,
  };
}

class TestAdapter extends MessageAdapter {
  readonly name = "test";
  sent: { conversation: InboundConversation; text: string }[] = [];

  start(): void {}
  stop(): void {}

  protected async sendText(conversation: InboundConversation, text: string): Promise<void> {
    this.sent.push({ conversation, text });
  }
}

test("formatInbound：群聊带发送人前缀，私聊保持原文", () => {
  assert.equal(
    formatInbound(
      inbound({
        conversation: { kind: "group", id: "456" },
        sender: { id: "1", name: "小\n明" },
        text: " 大家好 ",
      }),
    ),
    "[小 明] 大家好",
  );
  assert.equal(formatInbound(inbound({ text: " 你好 " })), "你好");
  // 纯图片消息没有正文，但群聊仍要告诉模型「谁发的」。
  assert.equal(
    formatInbound(
      inbound({
        conversation: { kind: "group", id: "456" },
        sender: { id: "1", name: "小明" },
        text: "",
      }),
    ),
    "[小明]",
  );
});

test("MessageAdapter：纯图片消息进引擎，日志保留图片标记", async () => {
  const image: MessageImage = { data: "aGVsbG8=", mediaType: "image/png" };
  const calls: { sessionId: string; content: string; images?: MessageImage[] }[] = [];
  const infos: string[] = [];
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger([], [], infos),
    resolveTarget: () =>
      ({
        engine: {
          async handleMessage(options: {
            sessionId: string;
            content: string;
            images?: MessageImage[];
          }) {
            calls.push({
              sessionId: options.sessionId,
              content: options.content,
              ...(options.images === undefined ? {} : { images: options.images }),
            });
            return reply("看到了");
          },
        },
      }) as unknown as AdapterTarget,
    conversations: { getOrCreate: () => "s" },
  });

  await adapter.receive(inbound({ text: "", images: [image] }));
  assert.deepEqual(calls, [{ sessionId: "s", content: "", images: [image] }]);
  assert.ok(
    infos.some((line) => line.includes("[test:privateMessage:123]: [图片]")),
    "结构化图片也必须留下可读的日志标记",
  );
});

test("chunkText：不超长、不丢非空白字符，空串返回空", () => {
  assert.deepEqual(chunkText("", 10), []);
  const long = "a".repeat(25);
  const chunks = chunkText(long, 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
  assert.equal(chunks.join(""), long);

  const prose = "hello world ".repeat(10);
  const pieces = chunkText(prose, 20);
  assert.ok(pieces.every((chunk) => chunk.length <= 20));
  assert.equal(
    pieces.join("").replace(/\s/g, ""),
    prose.replace(/\s/g, ""),
    "切块可以吃掉边界空白，但不能吃掉正文",
  );
});

test("MessageAdapter：群聊前缀、会话映射与长回复切块", async () => {
  const calls: { sessionId: string; content: string }[] = [];
  const titles: { key: string; title: string }[] = [];
  const infos: string[] = [];
  const conversations: ConversationSessions = {
    getOrCreate(key, title) {
      titles.push({ key, title });
      return "session-1";
    },
  };
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger([], [], infos),
    resolveTarget: () =>
      target(async (options) => {
        calls.push(options);
        return reply("a".repeat(25));
      }),
    conversations,
    maxMessageLength: 10,
  });

  await adapter.receive(
    inbound({
      conversation: { kind: "group", id: "456" },
      sender: { id: "1", name: "小\n明" },
      text: " 大家好 ",
      sessionTitle: "QQ 群 456",
    }),
  );

  assert.deepEqual(calls, [{ sessionId: "session-1", content: "[小 明] 大家好" }]);
  assert.deepEqual(titles, [{ key: "default:group:456", title: "QQ 群 456" }]);
  assert.equal(adapter.sent.length, 3, "25 个字按 10 切成 10/10/5");
  assert.ok(adapter.sent.every((item) => item.text.length <= 10));
  assert.equal(adapter.sent.map((item) => item.text).join(""), "a".repeat(25));
  assert.ok(
    infos.some((line) => line.includes("[test:groupMessage:456]: [小 明] 大家好")),
    "收到的群消息日志要带事件键与带发送人前缀的内容",
  );
  assert.equal(
    infos.filter((line) => line.startsWith("发送[test:groupMessage:456]:")).length,
    3,
    "长回复切成几块就应记录几条发送日志",
  );
});

test("MessageAdapter：私聊事件日志带 privateMessage 与 QQ 号", async () => {
  const infos: string[] = [];
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger([], [], infos),
    resolveTarget: () => target(async () => reply("好")),
    conversations: { getOrCreate: () => "s" },
  });
  await adapter.receive(inbound({ text: "你好" }));
  assert.ok(infos.some((line) => line.includes("[test:privateMessage:123]: 你好")));
});

test("MessageAdapter：白名单按会话过滤，管理员始终放行，规则可热更新", async () => {
  const calls: string[] = [];
  const infos: string[] = [];
  let access: AdapterAccessControl = {
    whitelistEnabled: true,
    allowedIds: ["456"],
    adminIds: ["999"],
  };
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger([], [], infos),
    resolveTarget: () =>
      target(async (options) => {
        calls.push(options.content);
        return reply("ok");
      }),
    conversations: { getOrCreate: () => "s" },
    // 每收到一条消息现读；这里用一个可替换的闭包模拟「配置档里的名单保存了」。
    resolveAccess: () => access,
  });

  await adapter.receive(inbound({ sender: { id: "123", name: "路人" }, text: "非白名单私聊" }));
  await adapter.receive(inbound({ sender: { id: "999", name: "管理员" }, text: "管理员私聊" }));
  await adapter.receive(
    inbound({
      conversation: { kind: "group", id: "456" },
      sender: { id: "123", name: "路人" },
      text: "白名单群",
    }),
  );
  await adapter.receive(
    inbound({
      conversation: { kind: "group", id: "789" },
      sender: { id: "123", name: "路人" },
      text: "非白名单群",
    }),
  );
  assert.deepEqual(calls, ["管理员私聊", "[路人] 白名单群"]);
  assert.equal(
    infos.filter((line) => line.includes("不在白名单")).length,
    2,
    "被挡下的两条要各留一条日志，且日志里不该带正文",
  );

  access = { whitelistEnabled: false, allowedIds: [], adminIds: [] };
  await adapter.receive(
    inbound({
      conversation: { kind: "group", id: "789" },
      sender: { id: "123", name: "路人" },
      text: "关闭白名单后",
    }),
  );
  assert.equal(calls.at(-1), "[路人] 关闭白名单后");
});

test("MessageAdapter：同一会话串行，后一条等前一条回完", async () => {
  let started = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger([], []),
    resolveTarget: () =>
      target(async () => {
        started += 1;
        if (started === 1) await gate;
        return reply("ok");
      }),
    conversations: { getOrCreate: () => "s" },
  });

  const first = adapter.receive(inbound({ text: "第一条" }));
  const second = adapter.receive(inbound({ text: "第二条" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 1, "第二条不能在前一条回完之前进引擎");
  release?.();
  await Promise.all([first, second]);
  assert.equal(started, 2);
  assert.equal(adapter.sent.length, 2);
});

test("MessageAdapter：引擎失败回一句固定中文，不把内部错误发给用户", async () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: logger(warnings, errors),
    resolveTarget: () =>
      target(async () => {
        throw new Error("provider 密钥无效: /绝对/路径");
      }),
    conversations: { getOrCreate: () => "s" },
  });

  await adapter.receive(inbound());
  assert.deepEqual(
    adapter.sent.map((item) => item.text),
    ["处理消息时出错了，请稍后再试。"],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /provider 密钥无效/);
  assert.equal(warnings.length, 0);
});

test("MessageAdapter：配置档不可用时不进引擎，只记一条 warn", async () => {
  const warnings: string[] = [];
  const adapter = new TestAdapter({
    id: "test",
    profileId: "gone",
    logger: logger(warnings, []),
    resolveTarget: () => null,
    conversations: { getOrCreate: () => "s" },
  });
  await adapter.receive(inbound());
  assert.equal(adapter.sent.length, 0);
  assert.match(warnings[0] ?? "", /配置档「gone」当前不可用/);
});

function fakeSessions(): SessionDirectory & { ids: Set<string>; created: string[] } {
  let n = 0;
  const ids = new Set<string>();
  const created: string[] = [];
  return {
    ids,
    created,
    has(id) {
      return ids.has(id);
    },
    create(input = {}) {
      n += 1;
      const id = `s${n}`;
      ids.add(id);
      created.push(input.title ?? "");
      return {
        id,
        title: input.title ?? "新会话",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
      };
    },
  };
}

test("JsonConversationSessions：复用、会话被删后重建、坏文件从空表开始", () => {
  let stored: Record<string, unknown> = {};
  const io: ConversationStateIo = {
    ensureDir() {},
    read() {
      return stored;
    },
    write(_file, value) {
      stored = value;
    },
  };
  const sessions = fakeSessions();
  const warnings: string[] = [];
  const map = new JsonConversationSessions({
    filePath: "/tmp/ignored.json",
    sessions,
    logger: logger(warnings, []),
    io,
  });

  assert.equal(map.getOrCreate("default:private:1", "私聊"), "s1");
  assert.equal(map.getOrCreate("default:private:1", "私聊"), "s1", "同一会话复用");
  assert.equal(map.size, 1);
  assert.deepEqual(stored, { "default:private:1": "s1" });

  sessions.ids.delete("s1");
  assert.equal(map.getOrCreate("default:private:1", "私聊"), "s2", "会话被删后必须重建");
  assert.deepEqual(stored, { "default:private:1": "s2" });

  const brokenWarnings: string[] = [];
  const broken = new JsonConversationSessions({
    filePath: "/tmp/broken.json",
    sessions,
    logger: logger(brokenWarnings, []),
    io: {
      ensureDir() {},
      read() {
        throw new Error("不是合法 JSON");
      },
      write(_file, value) {
        stored = value;
      },
    },
  });
  assert.equal(broken.size, 0);
  assert.match(brokenWarnings[0] ?? "", /读取适配器会话映射失败/);
  assert.equal(broken.getOrCreate("default:group:2", "群聊"), "s3");
});
