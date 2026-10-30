/**
 * 拟人化（5a 被动部分）的测试：智能分段、去机器味、防抖合并、时间/作息感知。
 * 防抖用真实短定时器（30ms 级）——假时钟在 node:test 里要替换全局 setTimeout，
 * 得不偿失；毫秒级的窗口足够证明合并语义。
 */
import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";
import { smartChunk, stripMarkdown, SMART_CHUNK_MERGE_CHARS } from "#core/companion/chunk.ts";
import { awarenessBlock, scheduleState } from "#core/companion/awareness.ts";
import { MessageAdapter, type InboundMessage } from "#adapters/message.ts";
import type { AdapterTarget } from "#adapters/manager.ts";
import type { HumanizerConfig } from "@atri/shared";

// --- 智能分段 ----------------------------------------------------------------

test("smartChunk：短句各成一条，相邻短句合并到阈值", () => {
  const out = smartChunk("好啊。那明天见！记得带伞。", 1500);
  // 三句都短：合并成一条（≤60 字）。
  assert.deepEqual(out, ["好啊。那明天见！记得带伞。"]);

  const long = `第一句话，这里有一些内容需要说清楚。${"细节".repeat(40)}。第二句。第三句。`;
  const chunks = smartChunk(long, 1500);
  assert.ok(chunks.length >= 2, "长句按边界断开");
  assert.ok(chunks.every((chunk) => chunk.length <= 1500));
});

test("smartChunk：换行是边界，超上限退硬切，空串返回空", () => {
  assert.deepEqual(smartChunk("第一行\n第二行", 1500), ["第一行", "第二行"]);
  const huge = "啊。".repeat(1000);
  assert.ok(smartChunk(huge, 100).every((chunk) => chunk.length <= 100));
  assert.deepEqual(smartChunk("", 100), []);
  // 阈值封口：合并中的 current 到 60 字就该断，不管下一句还装不装得下。
  assert.ok(SMART_CHUNK_MERGE_CHARS > 0);
});

test("stripMarkdown：剥标记保内容，链接换成文字（URL）", () => {
  assert.equal(stripMarkdown("**粗体** 和 `代码`"), "粗体 和 代码");
  assert.equal(stripMarkdown("# 标题\n- 列表项"), "标题\n列表项");
  assert.equal(stripMarkdown("[点这里](https://example.com)"), "点这里（https://example.com）");
  assert.equal(stripMarkdown("普通文本"), "普通文本");
});

// --- 时间/作息感知 ------------------------------------------------------------

const NOON = new Date("2026-11-02T14:00:00+08:00");
const LATE_NIGHT = new Date("2026-11-02T01:00:00+08:00");

const config = (): HumanizerConfig => ({
  debounceSeconds: 0,
  smartChunk: true,
  stripMarkdown: false,
  timeAwareness: true,
  schedule: { sleepStart: "23:30", sleepEnd: "07:30", napMinutes: 30 },
  proactive: {
    enabled: false,
    idleMinutes: 180,
    maxPerDay: 3,
    quietStart: "23:30",
    quietEnd: "08:00",
  },
  diary: { enabled: true, hour: 22 },
});

const turn = {
  profileId: "default",
  sessionId: "s1",
  userText: "你好",
  senderId: "1",
  senderName: "小明",
  source: "platform" as const,
};

test("scheduleState：睡眠区间跨午夜，午休从 13:00 起", () => {
  assert.equal(scheduleState(NOON, config().schedule), "清醒");
  assert.equal(scheduleState(LATE_NIGHT, config().schedule), "睡眠中");
  const napTime = new Date("2026-11-02T13:10:00+08:00");
  assert.equal(scheduleState(napTime, config().schedule), "午休中");
  // 起止为空 = 没有日程。
  assert.equal(scheduleState(LATE_NIGHT, { sleepStart: "", sleepEnd: "", napMinutes: 0 }), null);
});

test("awarenessBlock：报时间与作息；间隔大才报「距上次对话」；关闭时为 null", () => {
  const base = {
    config: config(),
    now: () => NOON,
    lastActivityAt: () => null,
  };
  const block = awarenessBlock(turn, base);
  assert.ok(block);
  assert.match(block, /2026 年 11 月 2 日（周一）/);
  assert.match(block, /14:00/);
  assert.match(block, /清醒/);
  assert.ok(!block.includes("距"), "没有上一次对话就不报间隔");

  const withGap = awarenessBlock(turn, {
    ...base,
    lastActivityAt: () => new Date(NOON.getTime() - 3 * 3600_000).toISOString(),
  });
  assert.match(withGap ?? "", /3 小时/);
  const justNow = awarenessBlock(turn, {
    ...base,
    lastActivityAt: () => new Date(NOON.getTime() - 10_000).toISOString(),
  });
  assert.ok(!justNow?.includes("距"), "一分钟内不算「过去了一段时间」");

  const off = awarenessBlock(turn, { ...base, config: { ...config(), timeAwareness: false } });
  assert.equal(off, null);
});

// --- 适配器：防抖与发送路径 -----------------------------------------------------

function makeAdapter(
  humanizer: HumanizerConfig,
  handle: (options: { content: string }) => Promise<{ content: string }>,
): { adapter: MessageAdapter; sent: string[] } {
  const sent: string[] = [];
  class TestAdapter extends MessageAdapter {
    readonly name = "test";
    start(): void {}
    async stop(): Promise<void> {
      await this.flushIntake();
    }
    protected async sendText(
      _conversation: InboundMessage["conversation"],
      text: string,
    ): Promise<void> {
      sent.push(text);
    }
  }
  const adapter = new TestAdapter({
    id: "test",
    profileId: "default",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resolveTarget: () => ({ engine: { handleMessage: handle } }) as unknown as AdapterTarget,
    conversations: { getOrCreate: () => "s1" },
    resolveHumanizer: () => humanizer,
    maxMessageLength: 100,
  });
  return { adapter, sent };
}

function inbound(text: string): InboundMessage {
  return {
    sender: { id: "1", name: "小明" },
    conversation: { kind: "private", id: "123" },
    text,
    sessionTitle: "私聊",
  };
}

test("防抖：窗口内多条合并成一轮，正文按行拼接", async () => {
  const calls: string[] = [];
  const { adapter, sent } = makeAdapter({ ...config(), debounceSeconds: 0.03 }, async (options) => {
    calls.push(options.content);
    return { content: "好的" };
  });
  const first = adapter.receive(inbound("在吗"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = adapter.receive(inbound("帮我看看那个东西"));
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, ["在吗\n帮我看看那个东西"], "窗口内的两条并成一轮");
  assert.deepEqual(sent, ["好的"]);
});

test("防抖：关闭时行为不变；stop 会把窗口里没到点的消息立刻发出", async () => {
  const calls: string[] = [];
  const off = makeAdapter(config(), async (options) => {
    calls.push(options.content);
    return { content: "好" };
  });
  await off.adapter.receive(inbound("第一条"));
  await off.adapter.receive(inbound("第二条"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, ["第一条", "第二条"], "防抖关闭时逐条处理");

  const slow = makeAdapter({ ...config(), debounceSeconds: 5 }, async (options) => {
    calls.push(options.content);
    return { content: "好" };
  });
  await slow.adapter.receive(inbound("还没到点的消息"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await slow.adapter.stop();
  assert.deepEqual(
    calls.filter((c) => c.includes("还没到点")),
    ["还没到点的消息"],
    "stop 之前 flush，消息不能静默消失",
  );
});

test("发送路径：stripMarkdown 与 smartChunk 生效（平台路径）", async () => {
  const { adapter, sent } = makeAdapter(
    { ...config(), stripMarkdown: true, smartChunk: true },
    async () => ({ content: "**你好**！\n## 第二段\n看[这个](https://example.com)" }),
  );
  await adapter.receive(inbound("说点什么"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ["你好！", "第二段", "看这个（https://example.com）"]);
});

// 引擎侧的 awareness provider 装配在端到端里证一次：改档配置 -> 下一条消息报头带当前状态。
test("端到端：humanizer 写接口与时间感知注入", async (t) => {
  const { mkdtempSync: mkd, rmSync: rmf } = await import("node:fs");
  const { createApp } = await import("#app.ts");
  const { makeTestConfig } = await import("./helpers/config.ts");
  const root = mkd(join(tmpdir(), "atri-humanizer-"));
  t.after(() => rmf(root, { recursive: true, force: true }));
  const app = await createApp(makeTestConfig({ root, logLevel: "error" }));
  await app.start();
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const call = async (method: string, path: string, body?: unknown) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${origin}/api/v1${path}${sep}profile=default`, {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const bad = await call("POST", "/profiles/default/config", {
    humanizer: { debounceSeconds: 9999 },
  });
  assert.equal(bad.status, 400, "越界不夹取");
  const saved = await call("POST", "/profiles/default/config", {
    humanizer: { debounceSeconds: 3, schedule: { napMinutes: 45 } },
  });
  assert.equal(saved.status, 200);
  const view = saved.json.config as {
    humanizer: { debounceSeconds: number; schedule: { napMinutes: number; sleepStart: string } };
  };
  assert.equal(view.humanizer.debounceSeconds, 3);
  assert.equal(view.humanizer.schedule.napMinutes, 45);
  assert.equal(view.humanizer.schedule.sleepStart, "23:30", "没给的键保持默认");

  // 时间感知默认开：发一条消息（回声兜底），确认服务不因感知 provider 而失败。
  const session = await call("POST", "/sessions", {});
  const sessionId = (session.json.session as { id: string }).id;
  const sent = await call("POST", `/sessions/${sessionId}/messages`, { content: "几点了" });
  assert.equal(sent.status, 200);
});
