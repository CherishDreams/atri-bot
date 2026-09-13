/**
 * 工具路由的端到端测试。
 *
 * 要证的还是「不重启就生效」这条链，但机制与 provider 那组**不同**：
 * provider 靠的是写完重建注册表，工具靠的是**每次现读文件**（`core/tool/store.ts`），
 * 所以这里必须证明「写完立刻 GET 就是新值」，而不只是「写完最终会一致」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@atri/shared";
import { createApp } from "#app.ts";
import { configFilePath } from "#config/file.ts";
import type { FileConfig } from "#config/file.ts";
import { DEFAULT_PROFILE_ID, profileConfigPath, profilesRoot } from "#config/profiles.ts";
import { makeTestConfig } from "./helpers/config.ts";

async function startApp(t: TestContext, preset?: FileConfig) {
  const root = mkdtempSync(join(tmpdir(), "atri-tool-routes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (preset) writeFileSync(configFilePath(root), `${JSON.stringify(preset, null, 2)}\n`);
  // `dataDir` 写出来：下面要按它算配置档文件的路径，不能吃 helper 的默认值。
  const dataDir = join(root, "data");
  const app = await createApp(makeTestConfig({ root, dataDir }));
  await app.start();
  t.after(() => app.stop());
  return {
    root,
    origin: `http://127.0.0.1:${app.address().port}`,
    /** 工具开关现在真正落在这个文件上（运行期配置归配置档，不再是 `atri.config.json`）。 */
    profilePath: profileConfigPath(profilesRoot(dataDir), DEFAULT_PROFILE_ID),
  };
}

async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200, "登录不成功的话，后面全是在测 401");
  const first = res.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Set-Cookie");
  return first.split(";")[0] as string;
}

async function call(
  origin: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  // `?profile=default`：工具开关属于配置档。缺参数必须 400 这件事由
  // `test/openapi-request.test.ts` 的规格派生守卫专门证，不在每个调用点重复钉。
  const res = await fetch(`${origin}/api/v1${path}?profile=default`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** 从 `{ tools: [...] }` / `{ tool: {...} }` 里取出工具视图。 */
function toolsOf(json: Record<string, unknown>): ToolInfo[] {
  return json.tools as ToolInfo[];
}
function toolOf(json: Record<string, unknown>): ToolInfo {
  return json.tool as ToolInfo;
}

test("GET /tools 列出内置工具，且默认全部关闭", async (t) => {
  const { origin } = await startApp(t);
  const cookie = await login(origin);

  const res = await call(origin, cookie, "GET", "/tools");
  assert.equal(res.status, 200);
  const list = toolsOf(res.json);
  // 加一颗工具就必须同步这条断言 —— 它存在的理由正是「清单变了，而端点视图没人复查」。
  // 注册顺序就是 `createBuiltinTools()` 的数组顺序，所以下面两条 map 是成对的。
  assert.deepEqual(
    list.map((tool) => tool.id),
    ["current_time", "list_plugins"],
  );
  assert.deepEqual(
    list.map((tool) => tool.enabled),
    [false, false],
    "工具是能力授予，默认必须关闭",
  );
  const tool = list[0] as ToolInfo;
  assert.equal(tool.name, "当前时间");
  assert.equal(typeof tool.description, "string");
  // 视图不能漏出参数 schema：那是给模型的，不是给控制台的。
  assert.deepEqual(Object.keys(tool).toSorted(), ["description", "enabled", "id", "name"]);
});

test("启用后不重启就生效，且只往文件里写 tools 段", async (t) => {
  const preset: FileConfig = {
    logLevel: "error",
    pluginDirs: ["./plugins"],
    adapters: { http: { enabled: false } },
    auth: { adminUser: "admin", adminPassword: "pw" },
  };
  const { origin, root, profilePath } = await startApp(t, preset);
  const cookie = await login(origin);

  const off = await call(origin, cookie, "GET", "/tools");
  assert.equal(toolsOf(off.json)[0]?.enabled, false);

  const on = await call(origin, cookie, "POST", "/tools/current_time/enable", { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(toolOf(on.json).enabled, true, "写操作必须把新状态回给调用方，否则界面要再拉一次");

  // 这一条是本文件存在的理由：没有重启、没有重建注册表，读侧就得跟着文件走。
  const after = await call(origin, cookie, "GET", "/tools");
  assert.equal(toolsOf(after.json)[0]?.enabled, true);

  // 开关落在**配置档文件**上，而 `preset` 那些部署级段落留在 `atri.config.json` 里 ——
  // 一次读-改-写现在跨两个文件，所以两侧都要钉住。
  const saved = JSON.parse(readFileSync(profilePath, "utf8")) as FileConfig & {
    tools?: Record<string, { enabled?: boolean }>;
  };
  assert.equal(saved.tools?.current_time?.enabled, true);

  const bootstrap = JSON.parse(readFileSync(configFilePath(root), "utf8")) as FileConfig;
  // 其余段落原样保留：开关写入是一次读-改-写，不是整份覆盖。
  assert.equal(bootstrap.logLevel, "error");
  assert.deepEqual(bootstrap.pluginDirs, ["./plugins"]);
  assert.deepEqual(bootstrap.adapters, { http: { enabled: false } });
  assert.equal(bootstrap.auth?.adminPassword, "pw");
  // 反向：工具开关不得回流到部署级文件（否则「改了配置档没生效」会有第二个隐藏真源）。
  assert.equal(bootstrap.tools, undefined);

  const back = await call(origin, cookie, "POST", "/tools/current_time/enable", { enabled: false });
  assert.equal(toolOf(back.json).enabled, false);
});

test("坏请求各有明确的拒绝理由", async (t) => {
  const { origin } = await startApp(t);
  const cookie = await login(origin);

  const unknown = await call(origin, cookie, "POST", "/tools/没有这颗工具/enable", {
    enabled: true,
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(unknown.json), ["error"]);

  // 与 POST /plugins/:id/enable 的刻意差别：那里省略 enabled 等于启用，这里不行。
  const missing = await call(origin, cookie, "POST", "/tools/current_time/enable", {});
  assert.equal(missing.status, 400, "省略 enabled 不该被当成「启用这颗工具」");

  const wrongType = await call(origin, cookie, "POST", "/tools/current_time/enable", {
    enabled: "yes",
  });
  assert.equal(wrongType.status, 400);

  // 带上 `?profile=`：这一条要证的 400 是**畸形 JSON**给的。不带参数的话它同样回 400，
  // 但那是因为缺配置档 —— 断言会绿，而它已经不在测它想测的那件事了。
  const malformed = await fetch(`${origin}/api/v1/tools/current_time/enable?profile=default`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{这不是 JSON",
  });
  assert.equal(malformed.status, 400, "畸形 JSON 不能被冒成 500");
});

test("工具端点默认受保护", async (t) => {
  const { origin } = await startApp(t);
  // 匿名访问必须 401 而不是 404：闸门在路由匹配之前，否则端点存在性会泄露。
  //
  // 这里**刻意不带 `?profile=`**，与上面那些用例相反：缺配置档参数是 400（路由级判据），
  // 而 401 必须在它之前发生。带着参数测反而证不到这一条 —— 那条 400 才是被挡住的东西。
  for (const [method, path, body] of [
    ["GET", "/tools", undefined],
    ["POST", "/tools/current_time/enable", { enabled: true }],
  ] as const) {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, 401, `${method} ${path} 匿名可访问`);
  }
});
