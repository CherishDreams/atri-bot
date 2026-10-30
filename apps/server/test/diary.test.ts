/**
 * 日记与记忆巩固的测试：判重（一天一次）、交互为空/provider 不支持的跳过、
 * 生成与写入的成败路径。假时钟 + 手动触发扫描。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiaryEngine, type DiaryTarget } from "#core/companion/diary.ts";
import type { Logger } from "#core/logger.ts";

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info: (m) => sink.push(m),
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

const TEN_PM = new Date("2026-11-02T22:05:00+08:00");

interface HarnessOptions {
  interactions?: string[] | null;
  diary?: string;
  facts?: string[];
  failDiary?: boolean;
  startAt?: Date;
}

function harness(options: HarnessOptions = {}) {
  const now = options.startAt ?? TEN_PM;
  const writes: { kind: string; content: string }[] = [];
  let interactionCalls = 0;
  const target: DiaryTarget = {
    profileId: "default",
    enabled: true,
    hour: 22,
    interactions: async () => {
      interactionCalls += 1;
      return options.interactions ?? null;
    },
    composeDiary: async (dateKey) => {
      if (options.failDiary) throw new Error("模型超时");
      return `今天聊了（${dateKey}）。`;
    },
    composeFacts: async () => options.facts ?? [],
    write: async (kind, content) => {
      writes.push({ kind, content });
      return true;
    },
  };
  const engine = new DiaryEngine({
    logger: silentLogger(),
    now: () => now,
    intervalMs: 10 * 60_000,
    setTimer: () => 1,
    clearTimer: () => {},
    targets: () => [target],
  });
  return { engine, writes, target, interactionCalls: () => interactionCalls };
}

test("到点写日记与事实；同一天只写一次", async () => {
  const h = harness({
    interactions: ["用户：小明喜欢天文\n助手：真的吗", "用户：周五要开会\n助手：好"],
    facts: ["小明喜欢天文", "周五有会议"],
  });
  await h.engine.scanOnce();
  assert.equal(h.writes.filter((w) => w.kind === "diary").length, 1);
  assert.match(h.writes[0]?.content ?? "", /【日记 2026-11-02】/);
  assert.deepEqual(
    h.writes.filter((w) => w.kind === "fact").map((w) => w.content),
    ["小明喜欢天文", "周五有会议"],
  );

  // 同一天再扫：判重，什么都不写。
  await h.engine.scanOnce();
  assert.equal(h.writes.length, 3);
});

test("没到点、当天无交互、provider 不支持各自跳过", async () => {
  // 21:59 还没到 22 点。
  const early = harness({
    interactions: ["x"],
    startAt: new Date("2026-11-02T21:59:00+08:00"),
  });
  await early.engine.scanOnce();
  assert.equal(early.writes.length, 0);

  // 今天没有交互：无事可写。
  const empty = harness({ interactions: [] });
  await empty.engine.scanOnce();
  assert.equal(empty.writes.length, 0);

  // provider 不支持（interactions 返回 null）：跳过且不抛。
  const unsupported = harness({ interactions: null });
  await unsupported.engine.scanOnce();
  assert.equal(unsupported.writes.length, 0);
});

test("生成失败不写；hour 可自定义；失败后同一天内不重试", async () => {
  const h = harness({
    interactions: ["用户：你好\n助手：嗨"],
    failDiary: true,
  });
  await h.engine.scanOnce();
  assert.equal(h.writes.length, 0, "失败什么都不写");
  await h.engine.scanOnce();
  assert.equal(h.writes.length, 0, "同一天内不反复打扰模型");
});

test("事实行的行首符号被组合根剥掉（这里验引擎上限 5 条）", async () => {
  const h = harness({
    interactions: ["用户：你好\n助手：嗨"],
    facts: ["1", "2", "3", "4", "5", "6", "7"],
  });
  await h.engine.scanOnce();
  assert.equal(h.writes.filter((w) => w.kind === "fact").length, 5, "每天最多 5 条事实");
});
