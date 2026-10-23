/**
 * 指令系统的测试：解析器、注册表、内置指令、引擎短路路径与 HTTP 端点。
 *
 * 分四段，各测各的那一层：
 * - 解析器与注册表是纯单元（不碰任何存储）；
 * - 引擎短路用真引擎 + 假 provider（照搬 `engine-tools.test.ts` 的形状）；
 * - 端到端（`GET /commands`、控制台 `/help`、插件指令与冲突）起真 app。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandInfo, Message, ServerFrame } from "@atri/shared";
import { createApp } from "#app.ts";
import { configFilePath } from "#config/file.ts";
import { DEFAULT_PROFILE_ID, profileConfigPath, profilesRoot } from "#config/profiles.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { AgentEngine } from "#core/agent/engine.ts";
import { SessionEvents } from "#core/agent/events.ts";
import { SessionLock } from "#core/session/lock.ts";
import { ProviderRegistry } from "#core/provider/registry.ts";
import { SessionManager } from "#core/session/manager.ts";
import { CommandRegistry } from "#core/command/registry.ts";
import { parseCommand, splitCommandArgs } from "#core/command/parser.ts";
import { createBuiltinCommands } from "#core/command/builtins.ts";
import type { CommandDefinition } from "#core/command/types.ts";
import { ToolRegistry } from "#core/tool/registry.ts";
import { ToolConfigStore } from "#core/tool/store.ts";
import type { ChatOptions, ChatReply, ProviderImpl } from "#core/provider/types.ts";
import type { Logger } from "#core/logger.ts";

// --- 解析器 ---------------------------------------------------------------

test("parseCommand：前缀、指令名与剩余参数", () => {
  assert.deepEqual(parseCommand("/help", "/"), { name: "help", raw: "" });
  assert.deepEqual(parseCommand("/remind 12:00 开会", "/"), {
    name: "remind",
    raw: "12:00 开会",
  });
  // 大小写不归一在这里做（注册表管），解析只切。
  assert.deepEqual(parseCommand("/HELP", "/"), { name: "HELP", raw: "" });
  // 自定义前缀。
  assert.deepEqual(parseCommand("!帮助 x", "!"), { name: "帮助", raw: "x" });
  // 没带前缀、前缀之后只有空白，都不是指令。
  assert.equal(parseCommand("你好", "/"), null);
  assert.equal(parseCommand("/", "/"), null);
  assert.equal(parseCommand("/   ", "/"), null);
});

test("parseCommand：空串前缀退回缺省 /（关闭门槛不关指令）", () => {
  assert.deepEqual(parseCommand("/help", ""), { name: "help", raw: "" });
  assert.equal(parseCommand("你好", ""), null);
});

test("splitCommandArgs：空白拆分、成对引号合并、未闭合引号吃到结尾", () => {
  assert.deepEqual(splitCommandArgs(""), []);
  assert.deepEqual(splitCommandArgs("a b  c"), ["a", "b", "c"]);
  assert.deepEqual(splitCommandArgs(`say "hello world" x`), ["say", "hello world", "x"]);
  assert.deepEqual(splitCommandArgs(`say '单引号 也可以'`), ["say", "单引号 也可以"]);
  // 引号没闭合就吃到结尾（整段当一个参数），而不是悄悄拆开变成两句谁也看不懂的话。
  assert.deepEqual(splitCommandArgs(`remind "未闭合的 会`), ["remind", "未闭合的 会"]);
  // 空引号参数也要保留：它是用户明确给的一个空参数。
  assert.deepEqual(splitCommandArgs(`a "" b`), ["a", "", "b"]);
});

// --- 注册表 ---------------------------------------------------------------

const echo: CommandDefinition = {
  name: "echo",
  description: "回声",
  run: (_args, ctx) => `${ctx.prefix}${ctx.senderId ?? "anon"}`,
};

function silentLogger(sink: string[] = []): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

test("CommandRegistry：注册、别名查询、大小写归一", () => {
  const registry = new CommandRegistry(silentLogger());
  registry.register({ ...echo, aliases: ["说"] });
  assert.equal(registry.find("echo")?.def.description, "回声");
  assert.equal(registry.find("ECHO")?.def.description, "回声");
  assert.equal(registry.find("说")?.def.description, "回声");
  assert.equal(registry.find("nope"), null);
  assert.ok(registry.takenNames().has("echo"));
  assert.ok(registry.takenNames().has("说"));
});

test("CommandRegistry：内置重名直接抛，动态撞内置让路并留 warn", () => {
  const lines: string[] = [];
  const registry = new CommandRegistry(silentLogger(lines));
  registry.register({ ...echo, aliases: ["说"] });
  assert.throws(() => registry.register({ ...echo, name: "说" }), /冲突/);

  let dynamic: CommandDefinition[] = [{ name: "echo", description: "插件版", run: () => "x" }];
  registry.registerSource(() => dynamic.map((def) => ({ def, source: "p" })));
  assert.equal(registry.find("echo")?.def.description, "回声", "内置赢，插件让路");
  assert.equal(
    registry.list().filter((entry) => entry.source === "p").length,
    0,
    "清单里也不该出现让路的指令",
  );
  assert.ok(lines.some((line) => line.includes("与内置指令重名")));

  // 插件换代码（重载）后不再撞：动态来源是每次现读的。
  dynamic = [{ name: "other", description: "插件版", run: () => "x" }];
  assert.equal(registry.find("other")?.def.description, "插件版");
});

// --- 内置指令 --------------------------------------------------------------

test("内置指令：/help 列出全部、详情按名字与别名都能查到", () => {
  const registry = new CommandRegistry(silentLogger());
  const builtins = createBuiltinCommands({ registry });
  for (const def of builtins) registry.register(def);
  registry.register({ ...echo, aliases: ["说"] });

  const help = builtins.find((def) => def.name === "help");
  assert.ok(help);
  const ctx = {
    profileId: "default",
    sessionId: "s",
    prefix: "/",
    source: "console",
    senderId: null,
    senderName: null,
    isAdmin: true,
  } as const;
  const list = String(help.run({ raw: "", args: [] }, ctx));
  assert.match(list, /\/help/);
  assert.match(list, /\/插件/);
  assert.match(list, /\[builtin\]/);

  const detail = String(help.run({ raw: "说", args: ["说"] }, ctx));
  assert.match(detail, /\/echo（别名：\/说）/);
  assert.match(detail, /所有人/);

  const missing = String(help.run({ raw: "nope", args: ["nope"] }, ctx));
  assert.match(missing, /没有/);
});

test("内置指令：/plugins 读访问器，没有访问器时说清楚", () => {
  const registry = new CommandRegistry(silentLogger());
  const without = createBuiltinCommands({ registry }).find((def) => def.name === "plugins");
  assert.ok(without);
  assert.match(String(without.run({ raw: "", args: [] }, {} as never)), /没有已安装的插件/);

  const withPeers = createBuiltinCommands({
    registry,
    listPlugins: () => [
      { id: "a", name: "甲", version: "1", enabled: true },
      { id: "b", name: "乙", version: "1", enabled: false },
    ],
  }).find((def) => def.name === "plugins");
  assert.ok(withPeers);
  const text = String(withPeers.run({ raw: "", args: [] }, {} as never));
  assert.match(text, /甲（id: a）：运行中/);
  assert.match(text, /乙（id: b）：已禁用/);
});

// --- 引擎短路路径 ----------------------------------------------------------

interface EngineHarness {
  engine: AgentEngine;
  provider: ProviderImpl & { seen: ChatOptions[] };
  sessions: SessionManager;
  frames: ServerFrame[];
  session: { id: string };
}

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
      throw new Error(`脚本没有第 ${seen.length} 次回复（指令命中时根本不该调到模型）`);
    },
  };
}

async function engineHarness(
  t: TestContext,
  {
    commands = [],
    adminIds = ["999"],
    wakePrefix = "/",
  }: {
    commands?: CommandDefinition[];
    adminIds?: string[];
    wakePrefix?: string;
  } = {},
): Promise<EngineHarness> {
  const root = await mkdtemp(join(tmpdir(), "atri-command-"));
  const tools = new ToolRegistry();
  const toolConfig = new ToolConfigStore({ filePath: configFilePath(root) });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider([{ content: "模型回复" }]);
  providers.register(provider);
  const lock = new SessionLock();
  const events = new SessionEvents();
  const registry = new CommandRegistry(silentLogger());
  for (const def of createBuiltinCommands({ registry })) registry.register(def);
  for (const def of commands) registry.register(def);
  const engine = new AgentEngine({
    sessions,
    providers,
    tools,
    toolConfig,
    logger: silentLogger(),
    lock,
    events,
    profileId: "default",
    defaultProviderId: null,
    systemPrompt: "",
    commands: registry,
    resolveAccess: () => ({
      whitelistEnabled: false,
      allowedIds: [],
      adminIds,
    }),
    wakePrefix,
  });
  const session = await engine.sessions.create({ title: "测试" });
  const frames: ServerFrame[] = [];
  events.subscribe((frame) => frames.push(frame));
  t.after(() => {
    sessions.close();
    return rm(root, { recursive: true, force: true });
  });
  return { engine, provider, sessions, frames, session };
}

test("引擎：/help 短路模型，用户与回复消息都落库", async (t) => {
  const h = await engineHarness(t);
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "/help",
    source: "console",
  });
  assert.match(reply.content, /可用指令/);
  assert.equal(h.provider.seen.length, 0, "指令命中时一次模型调用都不该发生");
  const roles = h.sessions.getWithMessages(h.session.id)?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

test("引擎：带前缀但不是指令的消息落回正常路径", async (t) => {
  const h = await engineHarness(t);
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "/不存在的指令",
    source: "console",
  });
  assert.equal(reply.content, "模型回复");
  assert.equal(h.provider.seen.length, 1);
});

test("引擎：cron 来源不做指令匹配", async (t) => {
  const h = await engineHarness(t);
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "/help",
    source: "cron",
  });
  assert.equal(reply.content, "模型回复");
  assert.equal(h.provider.seen.length, 1);
});

test("引擎：群聊指令按去掉发送人前缀的 commandText 匹配，权限与身份进入上下文", async (t) => {
  const seen: { raw: string; args: string[]; ctx: unknown }[] = [];
  const h = await engineHarness(t, {
    commands: [
      {
        name: "who",
        description: "看看我是谁",
        permission: "admin",
        run: (args, ctx) => {
          seen.push({ raw: args.raw, args: args.args, ctx });
          return `你好 ${ctx.senderName ?? "?"}`;
        },
      },
    ],
  });
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "[张三] /who a b",
    commandText: "/who a b",
    sender: { id: "999", name: "张三" },
    source: "platform",
  });
  assert.equal(reply.content, "你好 张三");
  assert.equal(h.provider.seen.length, 0);
  assert.deepEqual(seen[0]?.args, ["a", "b"]);
  const ctx = seen[0]?.ctx as { isAdmin: boolean; source: string; senderId: string | null };
  assert.equal(ctx.isAdmin, true);
  assert.equal(ctx.source, "platform");
  assert.equal(ctx.senderId, "999");
});

test("引擎：admin 指令对非管理员拒绝，拒绝也落库", async (t) => {
  const executed: string[] = [];
  const h = await engineHarness(t, {
    commands: [
      {
        name: "who",
        description: "管理员专属",
        permission: "admin",
        run: () => {
          executed.push("跑到了");
          return "秘密";
        },
      },
    ],
  });
  const reply = await h.engine.handleMessage({
    sessionId: h.session.id,
    content: "/who",
    sender: { id: "123", name: "路人" },
    source: "platform",
  });
  assert.match(reply.content, /仅管理员可用/);
  assert.deepEqual(executed, []);
  const roles = h.sessions.getWithMessages(h.session.id)?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

test("引擎：指令抛错回固定中文，原文只进日志", async (t) => {
  const errors: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "atri-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider([{ content: "模型回复" }]);
  providers.register(provider);
  const registry = new CommandRegistry(silentLogger());
  for (const def of createBuiltinCommands({ registry })) registry.register(def);
  registry.register({
    name: "boom",
    description: "会炸的指令",
    run: () => {
      throw new Error("插件内部错误 /绝对/路径");
    },
  });
  const engine = new AgentEngine({
    sessions,
    providers,
    tools: new ToolRegistry(),
    toolConfig: new ToolConfigStore({ filePath: configFilePath(root) }),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (m) => errors.push(m),
    },
    lock: new SessionLock(),
    events: new SessionEvents(),
    profileId: "default",
    defaultProviderId: null,
    systemPrompt: "",
    commands: registry,
  });
  const session = await engine.sessions.create({ title: "测试" });
  const reply = await engine.handleMessage({
    sessionId: session.id,
    content: "/boom",
    source: "console",
  });
  assert.equal(reply.content, "指令执行失败，详情见服务端日志。");
  assert.ok(
    errors.some((line) => line.includes("插件内部错误")),
    "原文必须留在服务端日志里",
  );
  assert.ok(!reply.content.includes("/绝对/路径"), "回复体里不能有内部原文");
});

// --- 端到端 ---------------------------------------------------------------

async function startApp(
  t: TestContext,
  prepare?: (root: string) => void,
): Promise<{ root: string; origin: string; cookie: string; dataDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "atri-command-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 插件在启动时扫描，所以先让用例把插件写进盘，再创建 app。
  prepare?.(root);
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
  return { root, origin, cookie, dataDir: join(root, "data") };
}

async function call(
  origin: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  // 档级请求必须带 `?profile=`（缺参一律 400）；部署级端点（建会话等）多一个
  // 查询参数无害，统一拼省得逐个调用点记忆哪条要哪条不要。
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${origin}/api/v1${path}${sep}profile=default`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("GET /commands：内置指令在列，带来源与权限", async (t) => {
  const { origin, cookie } = await startApp(t);
  const { status, json } = await call(origin, cookie, "GET", "/commands?profile=default");
  assert.equal(status, 200);
  const commands = json.commands as CommandInfo[];
  const help = commands.find((c) => c.name === "help");
  assert.ok(help);
  assert.equal(help.source, "builtin");
  assert.deepEqual(help.aliases, ["帮助"]);
  assert.equal(help.permission, "all");
  assert.ok(commands.some((c) => c.name === "plugins" && c.source === "builtin"));
});

test("控制台发 /help：回复是指令清单，且写进了会话历史", async (t) => {
  const { origin, cookie } = await startApp(t);
  const created = await call(origin, cookie, "POST", "/sessions", { title: "指令" });
  const sessionId = (created.json.session as { id: string }).id;
  const sent = await call(origin, cookie, "POST", `/sessions/${sessionId}/messages`, {
    content: "/help",
  });
  assert.equal(sent.status, 200);
  const reply = sent.json.message as Message;
  assert.match(reply.content, /可用指令/);
  const detail = await call(origin, cookie, "GET", `/sessions/${sessionId}`);
  const messages = (detail.json.session as { messages: Message[] }).messages;
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "/help"],
      ["assistant", reply.content],
    ],
  );
});

async function writeCommandPlugin(root: string, id: string, commandsSource: string): Promise<void> {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.js"),
    `module.exports = { id: "${id}", name: "${id}", commands: ${commandsSource} };`,
    "utf8",
  );
}

test("插件指令：声明后在 GET /commands 出现并可执行", async (t) => {
  const { origin, cookie } = await startApp(t, (root) => {
    writeCommandPlugin(
      root,
      "greeter",
      `[{ name: "hello", aliases: ["你好"], description: "打招呼", run: (args, ctx) => "嗨 " + (ctx.senderName ?? ctx.senderId ?? "陌生人") + (args.args[0] ? " " + args.args[0] : "") }]`,
    );
  });

  const list = await call(origin, cookie, "GET", "/commands?profile=default");
  const commands = list.json.commands as CommandInfo[];
  const hello = commands.find((c) => c.name === "hello");
  assert.ok(hello, "插件指令应出现在清单里");
  assert.equal(hello.source, "greeter");
  assert.deepEqual(hello.aliases, ["你好"]);

  const created = await call(origin, cookie, "POST", "/sessions", {});
  const sessionId = (created.json.session as { id: string }).id;
  const sent = await call(origin, cookie, "POST", `/sessions/${sessionId}/messages`, {
    content: "/你好 控制台",
  });
  assert.equal((sent.json.message as Message).content, "嗨 admin 控制台", "控制台来源是管理员");
});

test("插件指令：撞内置指令时该插件加载失败，错误说清撞了谁", async (t) => {
  const { origin, cookie } = await startApp(t, (root) => {
    writeCommandPlugin(
      root,
      "clash",
      `[{ name: "help", description: "想抢内置的名字", run: () => "x" }]`,
    );
  });
  const plugins = await call(origin, cookie, "GET", "/plugins?profile=default");
  const clash = (
    plugins.json.plugins as { id: string; status: string; error: string | null }[]
  ).find((p) => p.id === "clash");
  assert.equal(clash?.status, "failed");
  assert.match(clash?.error ?? "", /重名/);
  const list = await call(origin, cookie, "GET", "/commands?profile=default");
  const commands = list.json.commands as CommandInfo[];
  assert.equal(
    commands.filter((c) => c.source === "clash").length,
    0,
    "加载失败的插件不应留下指令",
  );
});

test("wakePrefix 配置：写接口校验、落盘并热更新生效", async (t) => {
  const { origin, cookie, dataDir } = await startApp(t);
  const bad = await call(origin, cookie, "POST", "/profiles/default/config", {
    wakePrefix: "a b",
  });
  assert.equal(bad.status, 400, "含空白的前缀要被拒");

  const saved = await call(origin, cookie, "POST", "/profiles/default/config", { wakePrefix: "!" });
  assert.equal(saved.status, 200);
  assert.equal((saved.json.config as { wakePrefix: string }).wakePrefix, "!");

  // 写进文件（读-改-写要落到真正的档文件上）。
  const profilePath = profileConfigPath(profilesRoot(dataDir), DEFAULT_PROFILE_ID);
  assert.equal(
    (JSON.parse(readFileSync(profilePath, "utf8")) as { wakePrefix?: string }).wakePrefix,
    "!",
  );

  // 指令匹配跟着前缀走：`!help` 命中、`/help` 不再是指令（落回模型路径；
  // 回声兜底会原样回复，足以区分「命中」与「没命中」）。
  const created = await call(origin, cookie, "POST", "/sessions", {});
  const sessionId = (created.json.session as { id: string }).id;
  const viaBang = await call(origin, cookie, "POST", `/sessions/${sessionId}/messages`, {
    content: "!help",
  });
  assert.match((viaBang.json.message as Message).content, /可用指令/);
  const viaSlash = await call(origin, cookie, "POST", `/sessions/${sessionId}/messages`, {
    content: "/help",
  });
  assert.match((viaSlash.json.message as Message).content, /\/help/, "回声兜底会原样回复");
});

test("wakePrefix 配空串：指令按缺省 / 识别", async (t) => {
  const { origin, cookie } = await startApp(t);
  const saved = await call(origin, cookie, "POST", "/profiles/default/config", { wakePrefix: "" });
  assert.equal(saved.status, 200);
  assert.equal((saved.json.config as { wakePrefix: string }).wakePrefix, "");
  const created = await call(origin, cookie, "POST", "/sessions", {});
  const sessionId = (created.json.session as { id: string }).id;
  const sent = await call(origin, cookie, "POST", `/sessions/${sessionId}/messages`, {
    content: "/help",
  });
  assert.match((sent.json.message as Message).content, /可用指令/);
});
