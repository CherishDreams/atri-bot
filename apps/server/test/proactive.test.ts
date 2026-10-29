/**
 * 主动消息引擎的测试：闸门链（免打扰/每日上限/冷却/仅私聊/空闲阈值）、
 * 生成与发送的成败路径。假时钟 + 手动触发扫描（捕获 setTimer 的回调直接调）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProactiveEngine,
  inQuietHours,
  type ProactiveTarget,
  type ProactiveConversationRef,
} from "#core/companion/proactive.ts";
import type { HumanizerConfig } from "@atri/shared";
import type { Logger } from "#core/logger.ts";

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info: (m) => sink.push(m),
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

const BASE = new Date("2026-11-02T15:00:00+08:00");

function proactiveConfig(
  overrides: Partial<HumanizerConfig["proactive"]> = {},
): HumanizerConfig["proactive"] {
  return {
    enabled: true,
    idleMinutes: 180,
    maxPerDay: 3,
    quietStart: "23:30",
    quietEnd: "08:00",
    ...overrides,
  };
}

/** 可手动推进的时钟 + 手动触发的扫描。 */
function harness(options: {
  targets: ProactiveTarget[];
  conversations: ProactiveConversationRef[];
  lastActivity: Record<string, string>;
  startAt?: Date;
}) {
  let now = options.startAt ?? BASE;
  const sent: { profileId: string; ref: ProactiveConversationRef; text: string }[] = [];
  const engine = new ProactiveEngine({
    logger: silentLogger(),
    now: () => now,
    intervalMs: 60_000,
    setTimer: () => 1,
    clearTimer: () => {},
    targets: () => options.targets,
    conversationsOf: () => options.conversations,
    lastActivityAt: (sessionId) => options.lastActivity[sessionId] ?? null,
    send: async (profileId, ref, text) => {
      sent.push({ profileId, ref, text });
    },
  });
  engine.start();
  return {
    engine,
    sent,
    /** 推进时钟（可选）并同步等待一次扫描跑完。 */
    async tickNow(at?: Date): Promise<void> {
      if (at !== undefined) now = at;
      await engine.scanOnce();
    },
    stop(): void {
      engine.stop();
    },
  };
}

function target(config = proactiveConfig(), text = "忙什么呢？"): ProactiveTarget {
  return {
    profileId: "default",
    config,
    generate: async () => text,
  };
}

const CONV: ProactiveConversationRef = {
  conversation: { kind: "private", id: "10001" },
  sessionId: "s1",
  adapterId: "napcat",
};

test("空闲超阈值：生成、发送、计数一条龙", async () => {
  const h = harness({
    targets: [target()],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 4 * 3600_000).toISOString() },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.text, "忙什么呢？");
  assert.equal(h.sent[0]?.profileId, "default");
  h.stop();
});

test("闸门链：未空闲、群聊、未启用、上限到、免打扰各自跳过", async () => {
  const idleAt = new Date(BASE.getTime() - 4 * 3600_000).toISOString();

  // 未空闲。
  let h = harness({
    targets: [target()],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 60_000).toISOString() },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 0, "刚聊过不该主动");
  h.stop();

  // 群聊被过滤（只发给私聊）。
  h = harness({
    targets: [target()],
    conversations: [
      { conversation: { kind: "group", id: "g" }, sessionId: "s1", adapterId: "napcat" },
    ],
    lastActivity: { s1: idleAt },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 0, "群聊主动插话不该发生");
  h.stop();

  // 未启用。
  h = harness({
    targets: [target(proactiveConfig({ enabled: false }))],
    conversations: [CONV],
    lastActivity: { s1: idleAt },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 0);
  h.stop();

  // 每日上限已到。
  h = harness({
    targets: [target(proactiveConfig({ maxPerDay: 0 }))],
    conversations: [CONV],
    lastActivity: { s1: idleAt },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 0);
  h.stop();

  // 免打扰时段（01:00 在 23:30–08:00 内）。
  h = harness({
    targets: [target()],
    conversations: [CONV],
    lastActivity: { s1: idleAt },
    startAt: new Date("2026-11-02T01:00:00+08:00"),
  });
  await h.tickNow();
  assert.equal(h.sent.length, 0, "免打扰时段不发");
  h.stop();
});

test("冷却：同一人两次问候之间至少再隔 idleMinutes", async () => {
  const h = harness({
    targets: [target()],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 4 * 3600_000).toISOString() },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 1);
  await h.tickNow();
  assert.equal(h.sent.length, 1, "冷却期内不重发");
  // 推进 4 小时后再扫：可以再发。
  await h.tickNow(new Date(BASE.getTime() + 4 * 3600_000));
  assert.equal(h.sent.length, 2, "冷却过后可以再问候");
  h.stop();
});

test("每日上限：跨天计数清零", async () => {
  const h = harness({
    targets: [target(proactiveConfig({ maxPerDay: 2 }))],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 4 * 3600_000).toISOString() },
  });
  await h.tickNow();
  await h.tickNow(new Date(BASE.getTime() + 4 * 3600_000));
  assert.equal(h.sent.length, 2, "两天各一条");
  // 同一天内第三条被上限挡住。
  await h.tickNow(new Date(BASE.getTime() + 5 * 3600_000));
  assert.equal(h.sent.length, 2, "同一天到上限就不发");
  h.stop();
});

test("生成为空不发送也不计数；生成抛错只记日志", async () => {
  const empty = harness({
    targets: [{ profileId: "default", config: proactiveConfig(), generate: async () => "   " }],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 4 * 3600_000).toISOString() },
  });
  await empty.tickNow();
  assert.equal(empty.sent.length, 0, "没有话就不发");
  empty.stop();

  let boom = true;
  const failing = harness({
    targets: [
      {
        profileId: "default",
        config: proactiveConfig(),
        generate: async () => {
          if (boom) throw new Error("模型超时");
          return "想你了";
        },
      },
    ],
    conversations: [CONV],
    lastActivity: { s1: new Date(BASE.getTime() - 4 * 3600_000).toISOString() },
  });
  await failing.tickNow();
  assert.equal(failing.sent.length, 0);
  // 修复之后再扫：失败的尝试不占额度也不进冷却。
  boom = false;
  await failing.tickNow();
  assert.equal(failing.sent.length, 1, "失败后下一次扫描还能发");
  failing.stop();
});

test("最近聊过的人优先；发送失败不计数", async () => {
  const conversations: ProactiveConversationRef[] = [
    { conversation: { kind: "private", id: "old" }, sessionId: "s-old", adapterId: "napcat" },
    { conversation: { kind: "private", id: "recent" }, sessionId: "s-recent", adapterId: "napcat" },
  ];
  const h = harness({
    targets: [target()],
    conversations,
    lastActivity: {
      "s-old": new Date(BASE.getTime() - 8 * 3600_000).toISOString(),
      "s-recent": new Date(BASE.getTime() - 3 * 3600_000).toISOString(),
    },
  });
  await h.tickNow();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.ref.conversation.id, "recent", "想念最近的人");
  h.stop();

  // 发送抛错：不计数也不进冷却，下一次扫描还能重试。
  const failingSend = new ProactiveEngine({
    logger: silentLogger(),
    now: () => BASE,
    intervalMs: 60_000,
    setTimer: () => 1,
    clearTimer: () => {},
    targets: () => [target()],
    conversationsOf: () => [CONV],
    lastActivityAt: (sessionId: string) =>
      sessionId === "s1" ? new Date(BASE.getTime() - 4 * 3600_000).toISOString() : null,
    send: async () => {
      throw new Error("适配器没在跑");
    },
  });
  await failingSend.scanOnce();
  failingSend.stop();
});

test("inQuietHours：跨午夜与不设限", async () => {
  assert.equal(inQuietHours(new Date("2026-11-02T01:00:00"), "23:30", "08:00"), true);
  assert.equal(inQuietHours(new Date("2026-11-02T12:00:00"), "23:30", "08:00"), false);
  assert.equal(inQuietHours(new Date("2026-11-02T12:00:00"), "", "08:00"), false, "缺一边就不设限");
  assert.equal(
    inQuietHours(new Date("2026-11-02T23:40:00"), "23:00", "23:30"),
    false,
    "不跨午夜的普通区间",
  );
  assert.equal(inQuietHours(new Date("2026-11-02T23:20:00"), "23:00", "23:30"), true);
});
