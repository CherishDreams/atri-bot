/**
 * `GET /profiles/{id}/config` —— 配置工作台的草稿起点。
 *
 * 这一族断言只在这条端点上成立，别处测不到：
 *
 * - **四段与各自的老端点逐元素相等**。这条不是「顺手多比一次」，而是防一个具体的漂移：
 *   新端点自己算一遍工具/插件视图，某天老端点改了口径（比如 `enabled` 的默认语义），
 *   两边就各说各话，而工作台显示的是新那份 —— 用户看到的开关与发消息时生效的开关不是
 *   同一个数。同源断言让「只改一处」当场变红。
 * - **`maxToolSteps` 给的是夹取后的生效值**。文件里写 999 而界面显示 999、实际跑 50，
 *   这两个数在各自的角度都"没错"，只有断言能挑出界面上那句谎。
 * - **failed 的档回 503，而且那句不带绝对路径**（原因只在 `GET /profiles` 的 `error` 里）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { profileConfigPath, profilesRoot } from "#config/profiles.ts";
import type { ProfileConfig, ToolInfo, PluginInfo } from "@atri/shared";
import { makeTestConfig } from "./helpers/config.ts";

interface Harness {
  origin: string;
  cookie: string;
  get: (path: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** 那份档文件的**原始文本**：断言「落盘了什么」不能靠端点自己说。 */
  raw: () => string;
}

async function start(t: TestContext, presetProfile?: Record<string, unknown>): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "atri-profile-config-"));
  const dataDir = join(root, "data");
  if (presetProfile) {
    // 预置一份**已经存在**的档文件：`makeTestConfig` 只写 bootstrap，seed 之后才有 default；
    // 想在启动前就把内容写死（测夹取、测坏文件），必须自己落这一份。
    const path = profileConfigPath(profilesRoot(dataDir), "default");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(presetProfile), "utf8");
  }
  // 两颗真插件：`plugins` 那一段的比较要有东西可比（两边都是空数组的话，「同源」那条
  // 断言就成了在空输入上证明的一句空话），而「一颗起不来」那一支必须有对象才测得出来。
  const pluginsRoot = join(root, "plugins");
  const fixtures: [string, string][] = [
    [
      "probe",
      'setup() {}, tools: [{ id: "probe_tool", description: "测试工具", ' +
        'parameters: { type: "object", properties: {} }, run: async () => "ok" }]',
    ],
    ["broken", 'setup() { throw new Error("按设计起不来"); }'],
  ];
  for (const [id, setup] of fixtures) {
    const dir = join(pluginsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.js"),
      `export default { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, ` +
        `version: "1.0.0", description: "只为比较而存在", ${setup} };\n`,
      "utf8",
    );
  }
  const app = await createApp(makeTestConfig({ root, dataDir, pluginDirs: [pluginsRoot] }));
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
  assert.equal(login.status, 200, "登录不成功的话，后面全是在测 401");
  const first = login.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Set-Cookie");
  const cookie = first.split(";")[0] as string;
  const ask = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      // 边界收窄：`Response.json()` 是 unknown，这里只认领「失败也有 {error}」这一形状。
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  return {
    origin,
    cookie,
    get: (path) => ask("GET", path),
    post: (path, body) => ask("POST", path, body),
    raw: () => readFileSync(profileConfigPath(profilesRoot(dataDir), "default"), "utf8"),
  };
}

test("四段与各自的老端点逐元素相等（新端点不许自己算一份）", async (t) => {
  // 预置里显式开一颗工具：两边都是「全 false」的比较是**空比较**，
  // 把 handler 改成 `viewTool(tool, false)` 也照样绿（第一次红因检查就是这么暴露的）。
  const h = await start(t, { tools: { current_time: { enabled: true } } });
  const config = (await h.get("/profiles/default/config")).body as unknown as ProfileConfig;

  const tools = (await h.get("/tools?profile=default")).body as { tools: ToolInfo[] };
  assert.ok(
    config.tools.some((x) => x.enabled) && config.tools.some((x) => !x.enabled),
    "工具开关必须两种取值都出现，否则下面的相等断言挡不住『统一算成一种』",
  );
  assert.deepEqual(
    config.tools,
    tools.tools,
    "工作台的工具与 GET /tools 不是同一份计算 —— 界面上的开关会与发消息时生效的那套漂移",
  );

  const plugins = (await h.get("/plugins?profile=default")).body as { plugins: PluginInfo[] };
  assert.equal(plugins.plugins.length, 2, "两颗插件夹具没装上，下面那条相等就是空比较");
  assert.deepEqual(config.plugins, plugins.plugins);

  const profiles = (await h.get("/profiles")).body as {
    profiles: { id: string; name: string; defaultProviderId: string | null }[];
  };
  const row = profiles.profiles.find((p) => p.id === "default");
  assert.ok(row);
  assert.equal(config.name, row.name);
  assert.equal(config.defaultProviderId, row.defaultProviderId);
});

test("maxToolSteps 给的是夹取后的生效值，不是文件里那一个", async (t) => {
  // 999 越界（上限 50）：引擎跑的是 50，界面也必须说 50。
  const h = await start(t, { maxToolSteps: 999 });
  const config = (await h.get("/profiles/default/config")).body as unknown as ProfileConfig;
  assert.equal(config.maxToolSteps, 50, "界面写着 999、实际只跑 50 —— 界面上那句是谎话");
});

test("未知 id 回 404；failed 的档回 503 且不带配置文件路径", async (t) => {
  const h = await start(t);
  const missing = await h.get("/profiles/nope/config");
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /没有这份配置/);

  // 坏文件要**在启动前**就位：装配读过一次之后，运行期改坏只会让下一次重载失败。
  const brokenRoot = mkdtempSync(join(tmpdir(), "atri-profile-config-bad-"));
  const dataDir = join(brokenRoot, "data");
  const dir = join(profilesRoot(dataDir), "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{ 这不是 JSON", "utf8");
  const app = await createApp(makeTestConfig({ root: brokenRoot, dataDir }));
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(brokenRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
  const res = await fetch(`${origin}/api/v1/profiles/broken/config`, { headers: { cookie } });
  assert.equal(res.status, 503);
  const text = await res.text();
  // 那句原文里有绝对路径（`readConfigFileAt` 拼进去的），5xx 一律不回。
  assert.doesNotMatch(text, /atri-profile-config|config\.json/);
  assert.match(text, /原因见 GET \/profiles/);
});

// --- 写端点：POST /profiles/{id}/config --------------------------------------

/**
 * 「保存」这一路的断言都围绕同一件事：**响应说的是服务端的事实，不是界面发出去的草稿**。
 * 所以每条都比两样：档文件的**原始文本**（端点自己说没用，它可能就是那个说谎的环节），
 * 以及回读的 `config`。
 */
test("一次保存多段：落盘、回读、`failed` 为空", async (t) => {
  const h = await start(t, { tools: { current_time: { enabled: false } } });
  const res = await h.post("/profiles/default/config", {
    maxToolSteps: 9,
    tools: { current_time: { enabled: true } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.failed, [], "没有插件改动时 failed 必须是空数组（不是缺键）");

  const config = res.body.config as unknown as ProfileConfig;
  assert.equal(config.maxToolSteps, 9);
  assert.equal(config.tools.find((x) => x.id === "current_time")?.enabled, true);

  const file = JSON.parse(h.raw()) as { maxToolSteps: number; tools: Record<string, unknown> };
  assert.equal(file.maxToolSteps, 9, "响应说存了而文件里没有");
  assert.deepEqual(file.tools.current_time, { enabled: true });
});

test("省略即不动（diff 语义），未知顶层键整批拒且一个字节都不写", async (t) => {
  const h = await start(t);
  assert.equal((await h.post("/profiles/default/config", { maxToolSteps: 7 })).status, 200);

  // 只发 tools：上一步的 maxToolSteps 必须留着。整档替换的实现会在这里把它抹成默认值。
  const second = await h.post("/profiles/default/config", {
    tools: { current_time: { enabled: true } },
  });
  assert.equal(second.status, 200);
  assert.equal((second.body.config as unknown as ProfileConfig).maxToolSteps, 7);

  // 未知键：放它进来等于把这份档文件开成一台远程编辑器（能改写残留的 `providers` 段）。
  const before = h.raw();
  const bad = await h.post("/profiles/default/config", { maxToolSteps: 3, providers: { x: {} } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /不认识的配置段「providers」/);
  assert.equal(h.raw(), before, "被拒的写入还是动了档文件");
});

test("越界与非整数都回 400，而不是夹取后悄悄存下", async (t) => {
  const h = await start(t);
  for (const [value, why] of [
    [0, "下限之下"],
    [51, "上限之上"],
    [2.5, "非整数"],
    ["7", "字符串"],
  ] as const) {
    const res = await h.post("/profiles/default/config", { maxToolSteps: value });
    assert.equal(res.status, 400, `${why}（${String(value)}）竟然被接受了`);
    assert.match(String(res.body.error), /maxToolSteps/);
  }
  // 夹取的版本会在这里露出来：文件里根本不该出现这些值。
  assert.equal(JSON.parse(h.raw()).maxToolSteps, undefined);
});

test("引用不存在的工具 / 插件 / provider 实例都回 400，且说得出是哪一段", async (t) => {
  const h = await start(t);
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["不存在的工具", { tools: { nope: { enabled: true } } }, /工具「nope」不存在/],
    ["不存在的插件", { plugins: { nope: { enabled: true } } }, /插件「nope」不存在/],
    [
      "清单里没有的 provider",
      { defaultProvider: "ghost" },
      /全局供应商清单里没有 provider「ghost」/,
    ],
    ["形状不对的 enabled", { tools: { current_time: { enabled: "yes" } } }, /必须是布尔值/],
    ["不是对象的 tools", { tools: [1, 2] }, /`tools` 必须是一个对象/],
  ];
  const before = h.raw();
  const failures: string[] = [];
  for (const [label, body, pattern] of cases) {
    const res = await h.post("/profiles/default/config", body);
    if (res.status !== 400) failures.push(`${label}：期望 400，实际 ${res.status}`);
    else if (!pattern.test(String(res.body.error)))
      failures.push(`${label}：原因不对（${String(res.body.error)}）`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(h.raw(), before, "被拒的写入动了档文件");
});

test("访问控制按配置档落盘：默认全部放行，保存后规范化并回读", async (t) => {
  const h = await start(t);
  const initial = (await h.get("/profiles/default/config")).body as unknown as ProfileConfig;
  assert.deepEqual(initial.access, {
    whitelistEnabled: false,
    allowedIds: [],
    adminIds: [],
  });

  const res = await h.post("/profiles/default/config", {
    access: {
      whitelistEnabled: true,
      allowedIds: ["123", "123", " 456 "],
      adminIds: ["999"],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = (res.body.config as unknown as ProfileConfig).access;
  assert.deepEqual(saved, {
    whitelistEnabled: true,
    allowedIds: ["123", "456"],
    adminIds: ["999"],
  });
  assert.deepEqual(JSON.parse(h.raw()).access, saved, "响应说存了而文件里没有");

  // 省略 access 不影响它：保存是 diff，不是整档替换。
  assert.equal((await h.post("/profiles/default/config", { maxToolSteps: 6 })).status, 200);
  assert.deepEqual(
    ((await h.get("/profiles/default/config")).body as unknown as ProfileConfig).access,
    saved,
  );
});

test("访问控制的坏形状回 400，且一个字节都不写", async (t) => {
  const h = await start(t);
  const before = h.raw();
  const cases: [string, unknown, RegExp][] = [
    ["不是对象", [], /access 必须是对象/],
    ["开关不是布尔", { whitelistEnabled: "yes", allowedIds: [], adminIds: [] }, /whitelistEnabled/],
    ["白名单不是数组", { whitelistEnabled: true, allowedIds: "1", adminIds: [] }, /allowedIds/],
    [
      "id 带空白",
      { whitelistEnabled: true, allowedIds: ["a b"], adminIds: [] },
      /不能为空或包含空白/,
    ],
    ["id 太长", { whitelistEnabled: true, allowedIds: [], adminIds: ["x".repeat(129)] }, /太长/],
  ];
  const failures: string[] = [];
  for (const [label, access, pattern] of cases) {
    const res = await h.post("/profiles/default/config", { access });
    if (res.status !== 400) failures.push(`${label}：期望 400，实际 ${res.status}`);
    else if (!pattern.test(String(res.body.error)))
      failures.push(`${label}：原因不对（${String(res.body.error)}）`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(h.raw(), before, "被拒的写入动了档文件");
});

test("档文件里用户自己写的键，在保存之后仍然在原处", async (t) => {
  // 读-改-写要原样保留我们不认识的键（`FileConfig` 那条同判据）：这一条测的是
  // 「工作台保存会不会顺手把用户手写的东西抹了」，那是最贵的一种数据丢失。
  const h = await start(t, { myOwnKey: { keep: true }, name: "自定义名" });
  assert.equal((await h.post("/profiles/default/config", { maxToolSteps: 4 })).status, 200);
  const file = JSON.parse(h.raw()) as Record<string, unknown>;
  assert.deepEqual(file.myOwnKey, { keep: true }, "保存把用户手写的段落抹掉了");
  assert.equal(file.name, "自定义名");
});

test("档级默认与全局默认之间那一档：保存 defaultProvider 会同时改文件与目录里的回读", async (t) => {
  const h = await start(t);
  // 先经全局端点建一个真实例（档默认必须引用全局清单里存在的那一个）。
  assert.equal(
    (
      await h.post("/provider-sources", {
        id: "s",
        type: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
      })
    ).status,
    201,
  );
  assert.equal((await h.post("/providers", { id: "p", source: "s", model: "m" })).status, 201);

  const res = await h.post("/profiles/default/config", { defaultProvider: "p" });
  assert.equal(res.status, 200);
  assert.equal((res.body.config as unknown as ProfileConfig).defaultProviderId, "p");
  assert.equal(JSON.parse(h.raw()).defaultProvider, "p");
  const profiles = (await h.get("/profiles")).body as {
    profiles: { id: string; defaultProviderId: string | null }[];
  };
  assert.equal(
    profiles.profiles.find((x) => x.id === "default")?.defaultProviderId,
    "p",
    "GET /profiles 还在说没有档默认 —— 那份状态没被同步，界面上会是两个答案",
  );

  // 取消：删键，而不是留一个空串。
  assert.equal((await h.post("/profiles/default/config", { defaultProvider: null })).status, 200);
  assert.equal("defaultProvider" in JSON.parse(h.raw()), false);
});

test("一颗起不来的插件：同一批里其他改动照常生效，失败点名在 `failed` 里", async (t) => {
  const h = await start(t, { tools: {} });
  const res = await h.post("/profiles/default/config", {
    maxToolSteps: 6,
    plugins: { probe: { enabled: false }, broken: { enabled: true } },
  });
  assert.equal(res.status, 200);
  const failed = res.body.failed as { id: string; error: string }[];
  assert.deepEqual(
    failed.map((x) => x.id),
    ["broken"],
    "失败项必须点名；而 `probe` 那颗正常的不该被连坐",
  );
  assert.ok(failed[0]?.error.length, "点名了却没给原因");
  assert.equal((res.body.config as unknown as ProfileConfig).maxToolSteps, 6);
  // 管理器是「先落盘、后动内存」：文件里写着要开这颗坏插件，而运行态是 failed。
  // 这不是 bug 而是既有语义，界面上必须靠 `failed` + 那颗的状态一起说清。
  assert.equal(JSON.parse(h.raw()).plugins.broken.enabled, true);
});

/**
 * 这一条测的是**引擎里那一根线**：保存档默认之后，`AgentEngine` 用的就是新值，
 * 而不是等一次重载。它便宜但很准 —— 把那个 provider 实例从全局清单里删掉，注册表就空了，
 * 于是回复走回声兜底，而回声那句会**把它当时以为的模型名打出来**：
 * 写着 `[回声:p]` 说明引擎确实拿到了档默认 `p`，写着 `[回声:默认]` 就说明
 * `bundle.engine.defaultProviderId` 那行赋值被漏掉了（那是一句「界面上改了、
 * 下一条消息还是老样子」的 bug，别处测不到）。
 */
test("保存档默认之后，下一条不带 model 的消息用的就是它（不靠重载）", async (t) => {
  const h = await start(t);
  assert.equal(
    (
      await h.post("/provider-sources", {
        id: "s",
        type: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
      })
    ).status,
    201,
  );
  assert.equal((await h.post("/providers", { id: "p", source: "s", model: "m" })).status, 201);
  assert.equal((await h.post("/profiles/default/config", { defaultProvider: "p" })).status, 200);
  // 删掉那个实例：注册表空了，回声兜底会把「引擎以为的模型」打在回复里。
  assert.equal((await h.post("/providers/p", { name: "改名" })).status, 200);
  const del = await fetch(`${h.origin}/api/v1/providers/p`, {
    method: "DELETE",
    headers: { cookie: h.cookie },
  });
  assert.equal(del.status, 200);

  const created = await h.post("/sessions", { title: "档默认" });
  const sessionId = (created.body as { session: { id: string } }).session.id;
  const reply = await h.post(`/sessions/${sessionId}/messages?profile=default`, {
    content: "你好",
  });
  const content = (reply.body as { message: { content: string } }).message.content;
  assert.equal(reply.status, 200, content);
  assert.match(content, /\[回声:p\]/, `引擎没用上档默认，实际回复是「${content}」`);
});
