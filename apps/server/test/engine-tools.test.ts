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
import { AgentEngine } from "#core/agent/engine.ts";
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
    child() {
      return this;
    },
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
  const toolConfig = new ToolConfigStore({ root, tools: enabled, maxToolSteps });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider(replies);
  providers.register(provider);
  const engine = new AgentEngine({
    sessions,
    providers,
    tools: registry,
    toolConfig,
    logger: silentLogger(logLines),
  });
  const session = await engine.sessions.create({ title: "测试" });
  const frames: ServerFrame[] = [];
  engine.subscribe((frame) => frames.push(frame));
  // 清理收在这一处（用例里不再有 `t.after`）：句柄先关、再删目录。本仓不留「内存版存储」
  // 这条第二路径，所以这里的会话存储是真库，漏掉 close 就是把库文件一直占着。
  t.after(() => {
    sessions.close();
    return rm(root, { recursive: true, force: true });
  });
  return { engine, provider, sessions, frames, session };
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
  const toolMessage = h.sessions.getDetail(h.session.id)?.messages[2];
  assert.match(toolMessage?.content ?? "", /未授权执行/, "拒绝的理由要回喂给模型，而不是静默丢掉");
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

  const detail = h.sessions.getDetail(h.session.id);
  assert.deepEqual(
    detail?.messages.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
    "次序必须是 用户 → 助手(调用) → 工具结果 → 助手(回答)",
  );
  assert.equal(detail?.messages[1]?.toolCalls?.[0]?.id, "c1");
  assert.equal(detail?.messages[2]?.toolCallId, "c1");
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
  const toolMessage = h.sessions.getDetail(h.session.id)?.messages[2];
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
  assert.equal(h.sessions.getDetail(h.session.id)?.messages.length, 5);
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
  const toolConfig = new ToolConfigStore({ root });
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
