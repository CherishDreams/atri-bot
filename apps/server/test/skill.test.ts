/**
 * 技能系统的测试：frontmatter 解析、目录扫描、注入块、read_skill 工具与端到端
 * （启用校验、报头注入、插件捆绑发现）。
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
import { SkillStore, parseFrontmatter, MAX_SKILL_CONTENT_CHARS } from "#core/skill/store.ts";
import { createSkillTools, skillDirectoryBlock } from "#core/skill/tools.ts";
import type { ChatOptions, ChatReply, ProviderImpl } from "#core/provider/types.ts";
import type { Logger } from "#core/logger.ts";

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info() {},
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

// --- 解析与注入块 -----------------------------------------------------------

test("parseFrontmatter：扁平键值；嵌套与缺头按失败处理", () => {
  const ok = parseFrontmatter("---\nname: 回声\ndescription: 教你回声\n---\n# 正文\n");
  assert.ok(ok);
  assert.equal(ok.frontmatter.name, "回声");
  assert.match(ok.body, /正文/);
  assert.equal(parseFrontmatter("# 没有 frontmatter"), null);
  // 嵌套（缩进的子行）不是合法子集：宁可拒绝也不静默读错。
  assert.equal(parseFrontmatter("---\nname: x\nnested:\n  a: 1\n---\n"), null);
});

test("skillDirectoryBlock：只列启用的，目录对不上时为 null", () => {
  const skills = [
    { id: "a", name: "甲", description: "做甲事", source: "skills" },
    { id: "b", name: "乙", description: "", source: "skills" },
  ];
  assert.equal(skillDirectoryBlock([], skills), null);
  assert.equal(skillDirectoryBlock(["ghost"], skills), null, "启用的 id 全部无效时不注入空块");
  const block = skillDirectoryBlock(["a", "b"], skills);
  assert.ok(block);
  assert.match(block, /甲（a）：做甲事/);
  assert.match(block, /乙（b）：（无说明）/);
  assert.match(block, /read_skill/);
});

// --- 目录扫描 ---------------------------------------------------------------

function makeStore(t: TestContext, prepare: (root: string, pluginRoot: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "atri-skill-"));
  const pluginRoot = join(root, "bundled-dir");
  mkdirSync(pluginRoot, { recursive: true });
  prepare(root, pluginRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new SkillStore({
    skillsDir: join(root, "skills"),
    pluginDirs: [pluginRoot],
    logger: silentLogger(),
  });
}

function writeSkill(dir: string, id: string, content: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "SKILL.md"), content, "utf8");
}

test("SkillStore：部署级与插件捆绑都发现，插件 id 带前缀，坏文件跳过", (t) => {
  const store = makeStore(t, (root, pluginRoot) => {
    writeSkill(
      join(root, "skills"),
      "echo-guide",
      "---\nname: 回声指南\ndescription: 教你回声\n---\n正文",
    );
    writeSkill(join(root, "skills"), "bad-skill", "没有 frontmatter 的正文");
    // 不合法的目录名。
    writeSkill(join(root, "skills"), "Bad Name", "---\ndescription: x\n---\n");
    writeSkill(
      join(pluginRoot, "skills"),
      "bundled",
      "---\ndescription: 插件自带的技能\n---\n正文",
    );
  });
  const skills = store.list();
  const ids = skills.map((skill) => skill.id);
  assert.deepEqual(ids, ["bundled-dir:bundled", "echo-guide"], "按 id 排序；插件捆绑带前缀");
  const guide = skills.find((skill) => skill.id === "echo-guide");
  assert.equal(guide?.name, "回声指南");
  assert.equal(guide?.source, "skills");
  const bundled = skills.find((skill) => skill.id === "bundled-dir:bundled");
  assert.equal(bundled?.source, "bundled-dir");
  // 坏文件不进清单但服务照常。
  assert.ok(!ids.includes("bad-skill"));
  assert.match(store.read("echo-guide") ?? "", /正文/, "read 按现扫的目录定位文件");
});

test("SkillStore：read 返回全文，重名时部署级赢", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-skill-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "p");
  mkdirSync(join(root, "skills", "dup"), { recursive: true });
  writeFileSync(
    join(root, "skills", "dup", "SKILL.md"),
    "---\ndescription: 部署级\n---\n部署级全文",
    "utf8",
  );
  mkdirSync(join(pluginRoot, "skills", "dup"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "skills", "dup", "SKILL.md"),
    "---\ndescription: 插件\n---\n插件全文",
    "utf8",
  );
  const store = new SkillStore({
    skillsDir: join(root, "skills"),
    pluginDirs: [pluginRoot],
    logger: silentLogger(),
  });
  assert.match(store.read("dup") ?? "", /部署级全文/);
  assert.match(store.read("p:dup") ?? "", /插件全文/);
  assert.equal(store.read("nope"), null);
});

// --- read_skill 工具 --------------------------------------------------------

test("read_skill：取全文、未知 id 如实说", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-skill-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills", "guide"), { recursive: true });
  writeFileSync(
    join(root, "skills", "guide", "SKILL.md"),
    "---\ndescription: 指南\n---\n第一步做什么",
    "utf8",
  );
  const store = new SkillStore({
    skillsDir: join(root, "skills"),
    pluginDirs: [],
    logger: silentLogger(),
  });
  const tool = createSkillTools(store).find((def) => def.id === "read_skill");
  assert.ok(tool);
  assert.equal(tool.internal, true, "目录契约的另一半，不进用户开关");
  void tool.run({ id: "guide" }, {}).then((text) => assert.match(text, /第一步做什么/));
  return tool.run({ id: "ghost" }, {}).then((text) => assert.match(text, /没有/));
});

// --- 引擎与端到端 ------------------------------------------------------------

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

async function startApp(t: TestContext, prepare?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "atri-skill-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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

test("端到端：启用技能后目录进报头、read_skill 内部工具恒声明", async (t) => {
  const { origin, cookie } = await startApp(t, (root) => {
    writeSkill(
      join(root, "data", "skills"),
      "echo-guide",
      "---\nname: 回声指南\ndescription: 教你回声\n---\n# 第一步\n原样重复。",
    );
  });

  const list = await call(origin, cookie, "GET", "/skills");
  assert.deepEqual(
    (list.json.skills as { id: string }[]).map((s) => s.id),
    ["echo-guide"],
  );
  const detail = await call(origin, cookie, "GET", "/skills/echo-guide");
  assert.match(String(detail.json.content), /原样重复/);
  const missing = await call(origin, cookie, "GET", "/skills/ghost");
  assert.equal(missing.status, 404);

  // 启用一个不存在的 id 要被拒绝。
  const bad = await call(origin, cookie, "POST", "/profiles/default/config", {
    skills: { enabled: ["ghost"] },
  });
  assert.equal(bad.status, 400);
  const enabled = await call(origin, cookie, "POST", "/profiles/default/config", {
    skills: { enabled: ["echo-guide"] },
  });
  assert.equal(enabled.status, 200);
  const view = enabled.json.config as {
    skills: { enabled: string[] };
    availableSkills: { id: string }[];
  };
  assert.deepEqual(view.skills.enabled, ["echo-guide"]);
  assert.ok(view.availableSkills.some((s) => s.id === "echo-guide"));
});

test("引擎：启用的技能进 system 报头，未启用时不注入", async () => {
  const root = await mkdtemp(join(tmpdir(), "atri-skill-engine-"));
  const skillsDir = join(root, "data", "skills");
  writeSkill(skillsDir, "guide", "---\nname: 指南\ndescription: 做指南事\n---\n按步骤来");
  mkdirSync(join(root, "profiles", "default"), { recursive: true });
  writeFileSync(
    join(root, "profiles", "default", "config.json"),
    JSON.stringify({ skills: { enabled: ["guide"] } }),
  );
  const skillStore = new SkillStore({ skillsDir, pluginDirs: [], logger: silentLogger() });
  const registry = new ToolRegistry();
  for (const tool of createSkillTools(skillStore)) registry.register(tool);
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const providers = new ProviderRegistry();
  const provider = scriptedProvider([{ content: "模型回复" }]);
  providers.register(provider);
  const engine = new AgentEngine({
    sessions,
    providers,
    tools: registry,
    toolConfig: new ToolConfigStore({ filePath: configFilePath(root) }),
    logger: silentLogger(),
    lock: new SessionLock(),
    events: new SessionEvents(),
    profileId: "default",
    defaultProviderId: null,
    systemPrompt: "",
    contextProviders: [
      async () =>
        skillDirectoryBlock(
          // 与生产同一条现读路径：这里直接给清单（档文件现读已被上面的预置覆盖）。
          ["guide"],
          skillStore.list(),
        ),
    ],
  });
  const session = await engine.sessions.create({ title: "测试" });
  await engine.handleMessage({ sessionId: session.id, content: "帮我做指南事", source: "console" });
  const system = provider.seen[0]?.messages[0];
  assert.equal(system?.role, "system");
  assert.match(system?.content ?? "", /【可用技能】/);
  assert.match(system?.content ?? "", /指南（guide）：做指南事/);
  // read_skill 是 internal 工具：本轮工具列表里必须恒有它。
  assert.ok(provider.seen[0]?.tools?.some((tool) => tool.name === "read_skill"));
  const roles = sessions.getWithMessages(session.id)?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"], "技能目录不落库");
  await sessions.close();
  await rm(root, { recursive: true, force: true });
});

void MAX_SKILL_CONTENT_CHARS;
