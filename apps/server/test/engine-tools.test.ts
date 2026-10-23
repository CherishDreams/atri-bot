/**
 * 引擎多步循环的测试。
 *
 * 全部在进程内跑：假 provider + 真 `ToolRegistry` + 真 `ToolConfigStore`。
 * 端到端那条链（HTTP + SSE + 桩上游）由 `tool-stream.test.ts` 负责，
 * 这里只证「循环本身的次序与终止」。
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ServerFrame } from "@atri/shared";
import { AgentEngine, MAX_CONTEXT_CHARS, MAX_CONTEXT_IMAGE_BYTES } from "#core/agent/engine.ts";
import { SessionEvents } from "#core/agent/events.ts";
import { SessionLock } from "#core/session/lock.ts";
import { ApiError } from "#core/errors.ts";
import { ProviderRegistry } from "#core/provider/registry.ts";
import { SessionManager } from "#core/session/manager.ts";
import { ToolRegistry } from "#core/tool/registry.ts";
import { ToolConfigStore } from "#core/tool/store.ts";
import type { ChatOptions, ChatReply, ProviderImpl } from "#core/provider/types.ts";
import type { ToolDefinition } from "#core/tool/types.ts";
import type { Logger } from "#core/logger.ts";
import { configFilePath } from "#config/file.ts";

/** 记下每次收到的 options，并**按次序**吐出预置的回复。 */
function scriptedProvider(replies: ChatReply[]): ProviderImpl & { seen: ChatOptions[] } {
  const seen: ChatOptions[] = [];
  return {
    id: "scripted",
    models: ["m"],
    seen,
    async chat(options) {
      // 必须**快照**：引擎传进来的是它一路 push 的那同一个数组，直接记引用会让
      // 第二次请求看起来带着第三、四条消息（ recorder 说谎，测试也就不是在证「发出去时」的形状）。
      seen.push({ ...options, messages: [...options.messages] });
      const next = replies[seen.length - 1];
      if (!next) throw new Error(`脚本没有第 ${seen.length} 次回复`);
      return next;
    },
  };
}

function silentLogger(sink?: string[]): Logger {
  const push = (line: string) => sink?.push(line);
  return {
    debug: (m) => push(m),
    info: (m) => push(m),
    warn: (m) => push(m),
    error: (m) => push(m),
  };
}

const timeTool = {
  id: "probe",
  name: "探针",
  description: "测试用",
  parameters: { type: "object", properties: {} },
  run: async () => "结果文本",
};

async function harness(
  t: TestContext,
  {
    replies,
    tools = [timeTool],
    enabled = {},
    maxToolSteps,
    logLines,
  }: {
    replies: ChatReply[];
    tools?: ToolDefinition[];
    enabled?: Record<string, { enabled: boolean }>;
    maxToolSteps?: number;
    logLines?: string[];
  },
) {
  const root = await mkdtemp(join(tmpdir(), "atri-engine-"));
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  // 开关与步数**写进文件**，不再靠注入 baseline：存储现在的规则是「给了 filePath，
  // 那个文件就是唯一真相」。这也让这个 helper 走的正是生产那条路径（`app.ts` 同样传 filePath）。
  const filePath = configFilePath(root);
  const preset: Record<string, unknown> = {};
  if (enabled !== undefined) preset.tools = enabled;
  if (maxToolSteps !== undefined) preset.maxToolSteps = maxToolSteps;
  if (Object.keys(preset).length > 0) writeFileSync(filePath, JSON.stringify(preset), "utf8");
  const toolConfig = new ToolConfigStore({ filePath });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider(replies);
  providers.register(provider);
  // 锁与总线由「组合根」这里构造并注入 —— 引擎不再自己持有它们，
  // 因为多配置档之下「同一个会话不能同时跑两轮」不是单个引擎的内部事务。
  const lock = new SessionLock();
  const events = new SessionEvents();
  const engine = new AgentEngine({
    sessions,
    providers,
    tools: registry,
    toolConfig,
    logger: silentLogger(logLines),
    lock,
    events,
    profileId: "default",
    defaultProviderId: null,
    systemPrompt: "",
  });
  const session = await engine.sessions.create({ title: "测试" });
  const frames: ServerFrame[] = [];
  events.subscribe((frame) => frames.push(frame));
  // 清理收在这一处（用例里不再有 `t.after`）：句柄先关、再删目录。本仓不留「内存版存储」
  // 这条第二路径，所以这里的会话存储是真库，漏掉 close 就是把库文件一直占着。
  t.after(() => {
    sessions.close();
    return rm(root, { recursive: true, force: true });
  });
  return { engine, provider, sessions, frames, session, lock, events };
}

/**
 * 取会话的**全部**历史。
 *
 * `getDetail` 现在是分页视图（HTTP 的形状，默认最新 100 条），而引擎测试要问的是
 *「库里到底存了什么」，所以走引擎那条全量读。取不到就是 fixture 坏了 —— 直接抛，
 * 不让它退化成空数组把断言喂绿。
 */
function historyOf(sessions: SessionManager, sessionId: string): Message[] {
  const detail = sessions.getWithMessages(sessionId);
  if (!detail) throw new Error(`会话不见了: ${sessionId}`);
  return detail.messages;
}

test("已注册但本轮未授权的工具，模型硬要调用也不会被执行", async (t) => {
  let executed = 0;
  const h = await harness(t, {
    tools: [
      {
        ...timeTool,
        run: async () => {
          executed += 1;
          return "不该被跑到";
        },
      },
    ],
    // enabled 留空 = 这颗工具注册了但没开：正是「远程打开开关」那条攻击路径的形状。
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "那我直接回答" },
    ],
  });
  const reply = await h.engine.handleMessage({ sessionId: h.session.id, content: "查" });

  assert.equal(executed, 0, "未授权的工具一次都不该被执行");
  assert.equal(reply.content, "那我直接回答");
  const toolMessage = historyOf(h.sessions, h.session.id)[2];
  assert.match(toolMessage?.content ?? "", /未授权执行/, "拒绝的理由要回喂给模型，而不是静默丢掉");
});

test("人格提示作为 system 注入每次请求，但不写进会话历史", async (t) => {
  const h = await harness(t, { replies: [{ content: "好" }] });
  h.engine.systemPrompt = "你是测试人格。";
  await h.engine.handleMessage({ sessionId: h.session.id, content: "你好" });

  const sent = h.provider.seen[0]?.messages ?? [];
  assert.deepEqual(sent[0], { role: "system", content: "你是测试人格。" });
  assert.equal(sent[1]?.role, "user");
  assert.deepEqual(
    historyOf(h.sessions, h.session.id).map((m) => m.role),
    ["user", "assistant"],
    "人格不应被落成一条消息，否则历史详情会多出一条假消息",
  );
});

test("用户图片随消息落库，并出现在发给上游的历史里", async (t) => {
  const h = await harness(t, { replies: [{ content: "看到了" }] });
  const image = { data: "aGVsbG8=", mediaType: "image/png" };
  await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "",
    images: [image],
  });

  const [user] = historyOf(h.sessions, h.session.id);
  assert.deepEqual(user?.images, [image]);
  const sent = h.provider.seen[0]?.messages[0];
  assert.deepEqual(sent?.images, [image]);
  assert.equal(sent?.content, "", "纯图片消息的正文保持为空，占位不该被回填进历史");
});

test("两步收敛：落库次序、广播帧与 onMessage 各自只覆盖中间消息", async (t) => {
  const h = await harness(t, {
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "最终回答" },
    ],
    enabled: { probe: { enabled: true } },
  });

  const seen: Message[] = [];
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "几点了",
    onMessage: (m) => seen.push(m),
  });

  const messages = historyOf(h.sessions, h.session.id);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
    "次序必须是 用户 → 助手(调用) → 工具结果 → 助手(回答)",
  );
  assert.equal(messages[1]?.toolCalls?.[0]?.id, "c1");
  assert.equal(messages[2]?.toolCallId, "c1");
  assert.equal(reply.content, "最终回答");

  // 广播：4 条消息都推（WS 侧要看到全过程）；onMessage 只给中间那两条（SSE 不重复发）。
  assert.deepEqual(
    h.frames.map((f) => (f.type === "message" ? f.message.role : f.type)),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(
    seen.map((m) => m.role),
    ["assistant", "tool"],
  );
});

test("回喂的那一次请求里，必须同时有 assistant.tool_calls 与工具结果", async (t) => {
  const h = await harness(t, {
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "好" },
    ],
    enabled: { probe: { enabled: true } },
  });

  await h.engine.handleMessage({ sessionId: h.session.id, content: "查一下" });

  const second = h.provider.seen[1];
  const roles = second?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool"]);
  // 这一条证的是「两处有损映射」都修好了：引擎侧与 provider 侧任何一处只留
  // role/content，第二轮就会变成「有结果没有调用」。
  assert.deepEqual(second?.messages[1]?.toolCalls, [{ id: "c1", name: "probe", arguments: "{}" }]);
  assert.equal(second?.messages[2]?.toolCallId, "c1");
  assert.equal(second?.messages[2]?.content, "结果文本");
});

test("没有启用任何工具时，发给上游的 options 里不带 tools 键", async (t) => {
  const h = await harness(t, { replies: [{ content: "嗨" }], enabled: {} });

  await h.engine.handleMessage({ sessionId: h.session.id, content: "你好" });

  // 空数组 = 「本轮没有可用工具」。provider 层已证「空集合时整个 tools 键都不发」，
  // 引擎这一层只管把集合交下去，不必再复制一遍那个条件。
  assert.deepEqual(h.provider.seen[0]?.tools, []);
  assert.equal(h.provider.seen.length, 1, "没有工具调用时不该再问第二次");
});

test("配置里启用了一颗没注册的工具：warn 一条，且不会因为「有 enabled」就发空 tools", async (t) => {
  const lines: string[] = [];
  const h = await harness(t, {
    replies: [{ content: "嗨" }],
    enabled: { 不存在的工具: { enabled: true } },
    logLines: lines,
  });

  await h.engine.handleMessage({ sessionId: h.session.id, content: "你好" });

  assert.ok(
    lines.some((l) => l.includes("未注册的工具")),
    `应留下可读的告警，实际日志：${JSON.stringify(lines)}`,
  );
  assert.deepEqual(h.provider.seen[0]?.tools, [], "未注册的工具不该被算进本轮工具集");
});

test("工具执行失败是回喂的一条结果，而不是把整轮打成错误", async (t) => {
  const h = await harness(t, {
    tools: [
      {
        ...timeTool,
        run: async () => {
          throw new Error("内部炸了");
        },
      },
    ],
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "那我用别的方式回答" },
    ],
    enabled: { probe: { enabled: true } },
  });
  const reply = await h.engine.handleMessage({ sessionId: h.session.id, content: "查" });

  assert.equal(reply.content, "那我用别的方式回答");
  const toolMessage = historyOf(h.sessions, h.session.id)[2];
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /执行失败：内部炸了/);
});

test("撞上限时抛错，但已经跑过的步骤都已落库", async (t) => {
  const loop = { content: "", toolCalls: [{ id: "c", name: "probe", arguments: "{}" }] };
  const h = await harness(t, {
    replies: [loop, loop, loop, { content: "终于" }],
    enabled: { probe: { enabled: true } },
    maxToolSteps: 2,
  });

  await assert.rejects(
    () => h.engine.handleMessage({ sessionId: h.session.id, content: "无限查" }),
    /步数上限（2）/,
  );
  // user + (assistant + tool) × 2：抛错不该把已经发生的那两步抹掉，
  // 否则用户看到的是「我发了一句然后什么都没发生」。
  assert.equal(historyOf(h.sessions, h.session.id).length, 5);
});

test("工具不返回时，客户端取消会释放会话锁而不是把它永远占住", async (t) => {
  const h = await harness(t, {
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "不应到达" },
    ],
    tools: [
      {
        ...timeTool,
        run: () => new Promise<string>(() => {}),
      },
    ],
    enabled: { probe: { enabled: true } },
  });
  const controller = new AbortController();
  const pending = h.engine.handleMessage({
    sessionId: h.session.id,
    content: "查一个不会返回的工具",
    signal: controller.signal,
  });
  // 给循环一点时间真的进入 tool.run，再模拟客户端关页。
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, /请求已取消/);
  assert.equal(h.lock.has(h.session.id), false, "取消后锁必须已经释放");
});

test("客户端断开后不再发起下一步", async (t) => {
  const controller = new AbortController();
  const h = await harness(t, {
    replies: [
      { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
      { content: "不该被走到" },
    ],
    enabled: { probe: { enabled: true } },
  });

  await assert.rejects(async () => {
    // 第一次回复之后、循环进入第二步之前把信号掐掉。
    const original = h.provider.chat.bind(h.provider);
    h.provider.chat = async (options) => {
      controller.abort();
      return original(options);
    };
    return h.engine.handleMessage({
      sessionId: h.session.id,
      content: "查",
      signal: controller.signal,
    });
  });
  assert.equal(h.provider.seen.length, 1, "第二步不该再问上游");
});

test("发给上游的历史受文本预算约束，且不会从 tool 结果中间截断", async (t) => {
  const h = await harness(t, { replies: [{ content: "答" }], enabled: {} });
  const now = new Date().toISOString();
  const append = (role: Message["role"], content: string, extra: Partial<Message> = {}) => {
    const id = crypto.randomUUID();
    h.sessions.appendMessage(h.session.id, {
      id,
      sessionId: h.session.id,
      role,
      content,
      createdAt: now,
      ...extra,
    });
    return id;
  };
  // 先造一段早已超出预算的历史：最老那条有自己的标记，不能出现在请求里。
  append("user", "OLDEST-" + "x".repeat(10_000));
  for (let i = 0; i < 20; i += 1) {
    append("user", `older-${i}-` + "x".repeat(10_000));
  }
  await h.engine.handleMessage({ sessionId: h.session.id, content: "最新问题" });

  const sent = h.provider.seen[0]?.messages ?? [];
  assert.ok(sent.length > 0);
  assert.ok(
    sent.every((message) => !message.content.startsWith("OLDEST-")),
    "超出预算的最老消息不能还在上下文里",
  );
  const chars = sent.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(
    chars <= MAX_CONTEXT_CHARS + "最新问题".length,
    `上下文正文应受预算约束，实际 ${chars} 字符`,
  );
  assert.equal(sent.at(-1)?.content, "最新问题", "最后一条必须是本轮用户消息");

  // 手工把一条带工具调用的半截历史放在窗口边界附近：窗口从中间截断时，
  // 开头的 tool 结果必须被丢掉，否则上游会看到没有对应调用的结果。
  const h2 = await harness(t, { replies: [{ content: "答" }], enabled: {} });
  const toolId = crypto.randomUUID();
  h2.sessions.appendMessage(h2.session.id, {
    id: crypto.randomUUID(),
    sessionId: h2.session.id,
    role: "assistant",
    content: "",
    toolCalls: [{ id: toolId, name: "probe", arguments: "{}" }],
    createdAt: now,
  });
  h2.sessions.appendMessage(h2.session.id, {
    id: crypto.randomUUID(),
    sessionId: h2.session.id,
    role: "tool",
    content: "OLD-TOOL",
    toolCallId: toolId,
    createdAt: now,
  });
  for (let i = 0; i < 20; i += 1) {
    h2.sessions.appendMessage(h2.session.id, {
      id: crypto.randomUUID(),
      sessionId: h2.session.id,
      role: "user",
      content: `newer-${i}-` + "y".repeat(10_000),
      createdAt: now,
    });
  }
  await h2.engine.handleMessage({ sessionId: h2.session.id, content: "后来" });
  assert.notEqual(h2.provider.seen[0]?.messages[0]?.role, "tool", "窗口不能以孤立 tool 结果开头");
});

test("发给上游的图片受总字节预算约束", async (t) => {
  const h = await harness(t, { replies: [{ content: "看完了" }], enabled: {} });
  const images = Array.from({ length: 12 }, () => ({
    data: "A".repeat(1_000_000),
    mediaType: "image/png",
  }));
  h.sessions.appendMessage(h.session.id, {
    id: crypto.randomUUID(),
    sessionId: h.session.id,
    role: "user",
    content: "这些图片",
    images,
    createdAt: new Date().toISOString(),
  });

  await h.engine.handleMessage({ sessionId: h.session.id, content: "看看" });
  const imageMessage = h.provider.seen[0]?.messages.find((message) => message.role === "user");
  const kept = imageMessage?.images ?? [];
  const bytes = kept.reduce((sum, image) => sum + Math.ceil((image.data.length * 3) / 4), 0);
  assert.ok(bytes <= MAX_CONTEXT_IMAGE_BYTES, `图片总字节应受预算约束，实际 ${bytes}`);
  assert.ok(kept.length < images.length, "超出预算的图片应被省略");
});

test("上一轮留下的半截工具调用，发往上游前会被修掉", async (t) => {
  const h = await harness(t, { replies: [{ content: "接着答" }], enabled: {} });

  // 手工造一条「要求调用但没有结果」的助手消息（真实成因：上一轮被断开或撞上限）。
  h.sessions.appendMessage(h.session.id, {
    id: "orphan",
    sessionId: h.session.id,
    role: "assistant",
    content: "我查一下",
    toolCalls: [{ id: "never-answered", name: "probe", arguments: "{}" }],
    createdAt: new Date().toISOString(),
  });

  await h.engine.handleMessage({ sessionId: h.session.id, content: "继续" });

  const sent = h.provider.seen[0]?.messages ?? [];
  const orphan = sent.find((m) => m.role === "assistant");
  assert.equal(orphan?.content, "我查一下", "正文要保留");
  assert.equal(orphan?.toolCalls, undefined, "没配到结果的调用必须退化成纯文本，否则上游会拒");
});

test("工具集在一次运行内固定：中途改配置文件不影响在途那条消息", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-engine-pin-"));
  writeFileSync(
    configFilePath(root),
    JSON.stringify({ tools: { probe: { enabled: true } } }),
    "utf8",
  );

  const registry = new ToolRegistry();
  registry.register(timeTool);
  const toolConfig = new ToolConfigStore({ filePath: configFilePath(root) });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  // 清理与 `harness()` 同一处置：句柄先关，再删临时目录。
  t.after(() => {
    sessions.close();
    return rm(root, { recursive: true, force: true });
  });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }] },
    { content: "好" },
  ]);
  providers.register(provider);
  const engine = new AgentEngine({
    sessions,
    providers,
    tools: registry,
    toolConfig,
    logger: silentLogger(),
    lock: new SessionLock(),
    events: new SessionEvents(),
    profileId: "default",
    defaultProviderId: null,
    systemPrompt: "",
  });
  const session = await engine.sessions.create({ title: "测试" });

  // 第一步之后把工具关掉：本轮第二步仍应带着 tools（模型已经见过它）。
  const original = provider.chat.bind(provider);
  let flipped = false;
  provider.chat = async (options) => {
    const reply = await original(options);
    if (!flipped) {
      flipped = true;
      writeFileSync(configFilePath(root), JSON.stringify({ tools: { probe: { enabled: false } } }));
    }
    return reply;
  };

  await engine.handleMessage({ sessionId: session.id, content: "查" });

  assert.ok(provider.seen[0]?.tools?.length, "第一步应带工具");
  assert.ok(provider.seen[1]?.tools?.length, "第二步仍应带同一份工具集");
});

/**
 * 一个手动放行的一轮：`mark()` 由被包装的 `chat()` 在进入时调用，`entered` 让测试知道
 * 「锁确实已经被第一轮占住了」，`go()` 才让它继续走完。
 *
 * 少了 `await entered` 这一步，第二次请求可能跑在拿锁之前，那条 409 断言就成了假绿。
 */
function heldGate() {
  let mark!: () => void;
  const entered = new Promise<void>((resolve) => (mark = resolve));
  let go!: () => void;
  const hold = new Promise<void>((resolve) => (go = resolve));
  return { entered, mark, hold, go };
}

test("同一会话的一次对话没结束时第二次被拒（409），且库里不留半轮", async (t) => {
  const gate = heldGate();
  const h = await harness(t, {
    replies: [{ content: "第一响应" }, { content: "第二响应" }],
  });
  const original = h.provider.chat.bind(h.provider);
  h.provider.chat = async (options) => {
    gate.mark();
    await gate.hold;
    return original(options);
  };

  const first = h.engine.handleMessage({ sessionId: h.session.id, content: "一" });
  await gate.entered;

  await assert.rejects(
    () => h.engine.handleMessage({ sessionId: h.session.id, content: "二" }),
    (err: unknown) => err instanceof ApiError && err.status === 409,
    "冲突必须是带 409 的 ApiError，端点才有东西可说话",
  );

  gate.go();
  await first;
  h.provider.chat = original;

  // 被拒的那一次**什么都不该留下**：锁在 append 之前，所以「二」这条用户消息没进库。
  // 反过来的话，用户会看到一条自己发过、而模型从没读到的消息。
  assert.deepEqual(
    historyOf(h.sessions, h.session.id).map((m) => m.content),
    ["一", "第一响应"],
  );

  // 一轮结束后必须能再发 —— 忘记在 finally 里释放是最容易犯的错。
  const third = await h.engine.handleMessage({ sessionId: h.session.id, content: "三" });
  assert.equal(third.content, "第二响应");
  assert.equal(h.lock.has(h.session.id), false);
});

test("上游报错也释放锁：一次失败不会把会话永久锁死", async (t) => {
  const h = await harness(t, { replies: [{ content: "好了" }] });
  h.provider.chat = async () => {
    throw new Error("上游炸了");
  };

  await assert.rejects(
    () => h.engine.handleMessage({ sessionId: h.session.id, content: "一" }),
    /上游炸了/,
  );
  assert.equal(h.lock.has(h.session.id), false, "抛错路径也必须走 finally");

  // 换一个必定成功的上游再发一次：能过，就说明会话没被锁住。
  h.provider.chat = async () => ({ content: "补上的回复" });
  const reply = await h.engine.handleMessage({ sessionId: h.session.id, content: "二" });
  assert.equal(reply.content, "补上的回复");
  // 失败那一轮的半成品语义不变：用户那条留下了，伪造的回复没有。
  assert.deepEqual(
    historyOf(h.sessions, h.session.id).map((m) => m.role),
    ["user", "user", "assistant"],
  );
});

test("锁的粒度是会话，不是整个引擎", async (t) => {
  const gate = heldGate();
  const h = await harness(t, { replies: [{ content: "甲答" }, { content: "乙答" }] });
  const other = h.sessions.create({ title: "另一个会话" });
  const original = h.provider.chat.bind(h.provider);
  h.provider.chat = async (options) => {
    gate.mark();
    await gate.hold;
    return original(options);
  };

  const first = h.engine.handleMessage({ sessionId: h.session.id, content: "甲" });
  await gate.entered;
  // 别的会话不该因为有人正在问另一个会话而吃 409。
  const second = h.engine.handleMessage({ sessionId: other.id, content: "乙" });
  gate.go();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.content, "甲答");
  assert.equal(b.content, "乙答");
});
