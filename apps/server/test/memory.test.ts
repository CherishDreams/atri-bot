/**
 * 记忆模块的测试：内置供应商（写入/召回/时间衰减/淘汰）、服务层的供应商选择协议、
 * 引擎接缝（报头注入 + 轮末自动记录 + 工具上下文）、以及端到端的配置与插件替换。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { AgentEngine } from "#core/agent/engine.ts";
import { SessionEvents } from "#core/agent/events.ts";
import { SessionLock } from "#core/session/lock.ts";
import { ProviderRegistry } from "#core/provider/registry.ts";
import { SessionManager } from "#core/session/manager.ts";
import { ToolRegistry } from "#core/tool/registry.ts";
import { ToolConfigStore } from "#core/tool/store.ts";
import { configFilePath } from "#config/file.ts";
import { BuiltinMemoryProvider, extractKeywords } from "#core/memory/builtin.ts";
import { MemoryService } from "#core/memory/service.ts";
import { createMemoryTools } from "#core/memory/tools.ts";
import type { MemoryProvider } from "#core/memory/types.ts";
import type { ChatOptions, ChatReply, ProviderImpl } from "#core/provider/types.ts";
import type { Logger } from "#core/logger.ts";

// --- 内置供应商 ---------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-01T12:00:00+08:00");

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info() {},
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

interface ProviderOptions {
  now?: Date;
  maxPerProfile?: number;
}

function makeProvider(t: TestContext, opts: ProviderOptions = {}): BuiltinMemoryProvider {
  const dir = mkdtempSync(join(tmpdir(), "atri-memory-"));
  t.after(() => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const provider = new BuiltinMemoryProvider({
    dataDir: dir,
    logger: silentLogger(),
    now: () => opts.now ?? FIXED_NOW,
    ...(opts.maxPerProfile === undefined ? {} : { maxPerProfile: opts.maxPerProfile }),
  });
  return provider;
}

test("extractKeywords：CJK bigram 与 ASCII 整词，标点丢弃", () => {
  const kws = extractKeywords("小明的生日 是 2026-01-01!");
  assert.ok(kws.includes("小明"));
  assert.ok(kws.includes("生日"));
  assert.ok(kws.includes("2026"));
  assert.ok(!kws.includes("!"));
});

test("内置记忆：写入后按关键词召回，按配置档隔离", async (t) => {
  const p = makeProvider(t);
  await p.write({
    profileId: "default",
    sessionId: "s1",
    kind: "fact",
    content: "用户叫小明，喜欢天文。",
    source: "tool",
  });
  await p.write({
    profileId: "work",
    sessionId: "s2",
    kind: "fact",
    content: "项目上线时间是周五。",
    source: "tool",
  });

  const hits = await p.recall({
    profileId: "default",
    sessionId: "s1",
    query: "用户喜欢什么",
    limit: 3,
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? "", /天文/);
  const none = await p.recall({
    profileId: "default",
    sessionId: "s1",
    query: "项目上线",
    limit: 3,
  });
  assert.equal(none.length, 0, "别的档的记忆不能漏过来");
});

test("内置记忆：写不进（空内容/抽不出关键词）如实返回 false", async (t) => {
  const p = makeProvider(t);
  assert.equal(
    await p.write({ profileId: "d", sessionId: "s", kind: "fact", content: "   ", source: "x" }),
    false,
  );
  assert.equal(
    await p.write({ profileId: "d", sessionId: "s", kind: "fact", content: "!!!", source: "x" }),
    false,
  );
});

test("内置记忆：时间衰减让新记忆排前", async (t) => {
  // 两个 provider 指向**同一个 dataDir**（同一份库），分别用「90 天前」和「现在」
  // 的时钟写入，证排序确实按 created_at 衰减，而不是按插入序。
  const dir = mkdtempSync(join(tmpdir(), "atri-memory-age-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logger = silentLogger();
  const old = new BuiltinMemoryProvider({
    dataDir: dir,
    logger,
    now: () => new Date(FIXED_NOW.getTime() - 90 * 86_400_000),
  });
  await old.write({
    profileId: "d",
    sessionId: "s",
    kind: "fact",
    content: "旧事：旧密码 4477",
    source: "tool",
  });
  old.close();

  const fresh = new BuiltinMemoryProvider({ dataDir: dir, logger, now: () => FIXED_NOW });
  t.after(() => fresh.close());
  await fresh.write({
    profileId: "d",
    sessionId: "s",
    kind: "fact",
    content: "新事：新密码 4477",
    source: "tool",
  });

  const hits = await fresh.recall({ profileId: "d", sessionId: "s", query: "密码", limit: 5 });
  assert.equal(hits.length, 2);
  assert.match(hits[0]?.content ?? "", /新事/, "新记忆排前");
  assert.match(hits[1]?.content ?? "", /旧事/);
});

test("内置记忆：保留上限 FIFO 淘汰", async (t) => {
  const p = makeProvider(t, { maxPerProfile: 5 });
  for (let i = 0; i < 8; i++) {
    const ok = await p.write({
      profileId: "d",
      sessionId: "s",
      kind: "interaction",
      content: `词条 abc${i} 记录`,
      source: "interaction",
    });
    assert.equal(ok, true);
  }
  const gone = await p.recall({ profileId: "d", sessionId: "s", query: "abc0", limit: 5 });
  assert.equal(gone.length, 0, "最早的被淘汰");
  const kept = await p.recall({ profileId: "d", sessionId: "s", query: "abc7", limit: 5 });
  assert.equal(kept.length, 1, "最新的还在");
});

// --- 服务层 -----------------------------------------------------------------

/** 可调字段的假配置 + 两个假 provider，覆盖选择协议的每个分支。 */
function serviceHarness() {
  const lines: string[] = [];
  const config = { enabled: true, provider: "builtin", topK: 3, autoRecord: true };
  const calls: string[] = [];
  const builtin: MemoryProvider = {
    id: "builtin",
    async recall() {
      calls.push("recall:builtin");
      return [{ content: "内置记忆", occurredAt: "2026-01-01T00:00:00.000Z" }];
    },
    async write() {
      calls.push("write:builtin");
      return true;
    },
  };
  const plugin: MemoryProvider = {
    id: "myplugin",
    async recall() {
      calls.push("recall:myplugin");
      return [{ content: "来自 myplugin 的记忆", kind: "diary" }];
    },
    async write() {
      calls.push("write:myplugin");
      return true;
    },
  };
  const svc = new MemoryService({
    logger: silentLogger(lines),
    resolveConfig: () => config,
    builtin,
    pluginProviders: () => [plugin],
  });
  return { svc, config, lines, calls };
}

const turn = { profileId: "default", sessionId: "s", userText: "你好" };

test("MemoryService：默认选内置，召回结果格式化成带标题的块", async () => {
  const { svc, calls } = serviceHarness();
  const block = await svc.contextFor(turn);
  assert.ok(block !== null);
  assert.match(block, /【长期记忆】/);
  assert.match(block, /内置记忆/);
  assert.match(block, /（2026-01-01）/);
  assert.deepEqual(calls, ["recall:builtin"]);
});

test("MemoryService：enabled=false 或空输入不召回", async () => {
  const { svc, config, calls } = serviceHarness();
  config.enabled = false;
  assert.equal(await svc.contextFor(turn), null);
  config.enabled = true;
  assert.equal(await svc.contextFor({ ...turn, userText: "  " }), null);
  assert.deepEqual(calls, [], "两种情况下都不该真的去查");
});

test("MemoryService：provider 指到缺失的插件时不降级，只 warn 一次", async () => {
  const { svc, config, lines, calls } = serviceHarness();
  config.provider = "ghost";
  assert.equal(await svc.contextFor(turn), null, "缺失的供应商不回退内置");
  assert.equal(await svc.contextFor(turn), null);
  assert.equal(lines.filter((l) => l.includes("ghost")).length, 1, "同一个缺失 id 只 warn 一次");
  assert.deepEqual(calls, [], "内置一次都不该被调用");
});

test("MemoryService：指到插件 provider 时召回与写入都走插件", async () => {
  const { svc, config, calls } = serviceHarness();
  config.provider = "myplugin";
  const block = await svc.contextFor(turn);
  assert.match(block ?? "", /来自 myplugin 的记忆/);
  await svc.recordInteraction(turn, "回复内容");
  assert.deepEqual(calls, ["recall:myplugin", "write:myplugin"]);
});

test("MemoryService：autoRecord=false 或空交互不写", async () => {
  const { svc, config, calls } = serviceHarness();
  config.provider = "myplugin";
  config.autoRecord = false;
  await svc.recordInteraction(turn, "回复");
  assert.deepEqual(calls, []);
  config.autoRecord = true;
  await svc.recordInteraction({ ...turn, userText: "" }, "");
  assert.deepEqual(calls, [], "空交互不触发任何 provider 调用");
});

test("MemoryService：remember/search 是模型的写读入口，未启用时如实说明", async () => {
  const { svc, config } = serviceHarness();
  assert.match(await svc.remember(turn, "小明喜欢天文"), /已记住/);
  assert.match(await svc.remember(turn, "  "), /content/);
  config.enabled = false;
  assert.match(await svc.remember(turn, "x"), /未启用/);
  assert.match(await svc.search(turn, "天文"), /未启用/);
});

// --- 引擎接缝 ----------------------------------------------------------------

function scriptedProvider(replies: ChatReply[]): ProviderImpl & { seen: ChatOptions[] } {
  const seen: ChatOptions[] = [];
  return {
    id: "scripted",
    models: ["m"],
    seen,
    async chat(options) {
      seen.push({ ...options, messages: [...options.messages] });
      const next = replies[seen.length - 1];
      if (next) return next;
      throw new Error(`脚本没有第 ${seen.length} 次回复`);
    },
  };
}

async function engineHarness(
  t: TestContext,
  { memory, withTools = false }: { memory: MemoryService; withTools?: boolean },
): Promise<{
  engine: AgentEngine;
  provider: ProviderImpl & { seen: ChatOptions[] };
  sessions: SessionManager;
  session: { id: string };
}> {
  const root = await mkdtemp(join(tmpdir(), "atri-mem-engine-"));
  const registry = new ToolRegistry();
  if (withTools) for (const tool of createMemoryTools(memory)) registry.register(tool);
  const toolConfig = new ToolConfigStore({ filePath: configFilePath(root) });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider([{ content: "模型回复" }]);
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
    contextProviders: [(current) => memory.contextFor(current)],
    onTurnEnd: (finished, reply) => memory.recordInteraction(finished, reply.content),
  });
  const session = await engine.sessions.create({ title: "测试" });
  t.after(() => {
    sessions.close();
    return rm(root, { recursive: true, force: true });
  });
  return { engine, provider, sessions, session };
}

test("引擎：记忆块进 system 报头且不落历史，轮末自动记录 interaction", async (t) => {
  const { svc, config, calls } = serviceHarness();
  config.provider = "myplugin";
  const h = await engineHarness(t, { memory: svc });
  await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "还记得我吗",
    source: "console",
  });
  const system = h.provider.seen[0]?.messages[0];
  assert.equal(system?.role, "system");
  assert.match(system?.content ?? "", /【长期记忆】/);
  assert.match(system?.content ?? "", /来自 myplugin 的记忆/);
  const roles = h.sessions.getWithMessages(h.session.id)?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"], "注入块不落库");
  assert.deepEqual(calls, ["recall:myplugin", "write:myplugin"], "召回一次 + 自动记录一次");
});

test("记忆工具：写入带本轮坐标，检索能读回来", async (t) => {
  // 用**真**内置供应商：工具测试要证的是「坐标对、能写能查」这一整圈，
  // 假 provider 的 recall/write 只是打点，证不了检索结果。
  const dir = mkdtempSync(join(tmpdir(), "atri-memory-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const builtin = new BuiltinMemoryProvider({
    dataDir: dir,
    logger: silentLogger(),
    now: () => FIXED_NOW,
  });
  const svc = new MemoryService({
    logger: silentLogger(),
    resolveConfig: () => ({ enabled: true, provider: "builtin", topK: 3, autoRecord: true }),
    builtin,
    pluginProviders: () => [],
  });
  const tool = createMemoryTools(svc).find((def) => def.id === "memory_write");
  assert.ok(tool);
  const text = await tool.run(
    { content: "小明喜欢天文" },
    { context: { profileId: "default", sessionId: "s1", senderId: null, senderName: null } },
  );
  assert.match(text, /已记住/);
  const search = createMemoryTools(svc).find((def) => def.id === "memory_search");
  assert.ok(search);
  const hits = await search.run(
    { query: "天文" },
    { context: { profileId: "default", sessionId: "s1", senderId: null, senderName: null } },
  );
  assert.match(hits, /小明喜欢天文/);
  // 没有坐标的调用（嵌入式/测试）要如实说明，而不是悄悄写到不知道哪儿。
  const noCtx = await tool.run({ content: "x" }, {});
  assert.match(noCtx, /缺少本轮会话上下文/);
});

// --- 端到端：配置读写与插件替换 ----------------------------------------------

async function startApp(t: TestContext, prepare?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "atri-memory-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  prepare?.(root);
  // 插件目录就是 root：用例在 prepare 里写插件，启动时被扫描。
  const app = await createApp(makeTestConfig({ root, pluginDirs: [root] }));
  await app.start();
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.address().port}`;
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("登录响应没有 Set-Cookie");
  return { root, origin, cookie };
}

async function call(
  origin: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${origin}/api/v1${path}${sep}profile=default`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("ProfileConfig 读回 memory 段，写接口校验后生效", async (t) => {
  const { origin, cookie } = await startApp(t);
  const read = await call(origin, cookie, "GET", "/profiles/default/config");
  // GET 回的是裸视图；POST 才包 `{config, failed}`（两处形状由 openapi 规格钉住）。
  const config = read.json as unknown as { memory: { enabled: boolean; topK: number } };
  assert.equal(config.memory.enabled, true, "默认配置开箱即用");
  assert.equal(config.memory.topK, 3);
  assert.deepEqual(read.json.memoryProviders, ["builtin"]);

  const bad = await call(origin, cookie, "POST", "/profiles/default/config", {
    memory: { topK: 99 },
  });
  assert.equal(bad.status, 400, "越界不夹取");
  const saved = await call(origin, cookie, "POST", "/profiles/default/config", {
    memory: { topK: 5 },
  });
  assert.equal(saved.status, 200);
  const savedConfig = saved.json.config as { memory: { topK: number; autoRecord: boolean } };
  assert.equal(savedConfig.memory.topK, 5);
  assert.equal(savedConfig.memory.autoRecord, true, "没给的键保持默认");
});

test("插件记忆供应商：声明后出现在可选清单里，配置可以切换", async (t) => {
  const { origin, cookie } = await startApp(t, (root) => {
    const dir = join(root, "diary");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.js"),
      `const store = [];
module.exports = {
  id: "diary",
  name: "日记记忆",
  memoryProviders: [{
    id: "diary",
    description: "内存版日记",
    async recall(q) {
      return store.filter((entry) => entry.includes(q.query.slice(0, 2)))
        .slice(0, q.limit)
        .map((content) => ({ content, kind: "diary" }));
    },
    async write(record) { store.push(record.content); return true; },
  }],
};`,
      "utf8",
    );
  });
  const read = await call(origin, cookie, "GET", "/profiles/default/config");
  assert.deepEqual(read.json.memoryProviders, ["builtin", "diary"]);

  const switched = await call(origin, cookie, "POST", "/profiles/default/config", {
    memory: { provider: "diary" },
  });
  assert.equal(switched.status, 200);
  assert.equal((switched.json.config as { memory: { provider: string } }).memory.provider, "diary");
  // 指到不存在的 id：写入口只验形状（插件可能稍后才装上），运行期按「缺失」处理。
  const ghost = await call(origin, cookie, "POST", "/profiles/default/config", {
    memory: { provider: "nope" },
  });
  assert.equal(ghost.status, 200);
});

test("MemoryService：供应商抛错只记 warn，不挡回复", async (t) => {
  const lines: string[] = [];
  const svc = new MemoryService({
    logger: silentLogger(lines),
    resolveConfig: () => ({ enabled: true, provider: "boom", topK: 3, autoRecord: true }),
    builtin: {
      id: "builtin",
      async recall() {
        return [];
      },
      async write() {
        return true;
      },
    },
    pluginProviders: () => [
      {
        id: "boom",
        async recall(): Promise<never> {
          throw new Error("供应商炸了");
        },
        async write(): Promise<boolean> {
          throw new Error("供应商炸了");
        },
      },
    ],
  });
  const h = await engineHarness(t, { memory: svc });
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "你好",
    source: "console",
  });
  assert.equal(reply.content, "模型回复", "召回失败不挡回复");
  assert.ok(lines.some((line) => line.includes("供应商炸了")));
});
