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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // 一颗真插件：`plugins` 那一段的比较要有东西可比，否则两边都是空数组，
  // 「同源」那条断言就成了在空输入上证明的一句空话。
  const pluginsRoot = join(root, "plugins");
  const dir = join(pluginsRoot, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.js"),
    'export default { id: "probe", name: "探针", version: "1.0.0", description: "只为比较而存在", setup() {} };\n',
    "utf8",
  );
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
  return {
    origin,
    cookie,
    get: async (path) => {
      const res = await fetch(`${origin}/api/v1${path}`, { headers: { cookie } });
      return {
        status: res.status,
        // 边界收窄：`Response.json()` 是 unknown，这里只认领「失败也有 {error}」这一形状。
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    },
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
  assert.equal(plugins.plugins.length, 1, "插件夹具没装上，下面那条相等就是空比较");
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
  assert.match(String(missing.body.error), /没有这份配置档/);

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
