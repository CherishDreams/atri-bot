/**
 * 工具注册表与开关存储的单元测试。
 *
 * 这里要证的是两件在 HTTP 层测不到的事：
 *   1. 「执行一次工具调用永远不会抛」—— 模型幻觉出工具名、给出坏 JSON 参数都是常态，
 *      它们必须是回喂给模型的一条 `isError`，而不是把整轮打成 400/500；
 *   2. 开关的默认语义是**关闭**（`=== true`），而且写盘时不碰配置文件里的其它段落。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@atri/shared";
import { ToolRegistry } from "#core/tool/registry.ts";
import { ToolConfigStore } from "#core/tool/store.ts";
import { createBuiltinTools } from "#core/tool/builtins.ts";
import type { PluginSummary } from "#core/tool/builtins/listPlugins.ts";
import type { ToolDefinition } from "#core/tool/types.ts";
import { ApiError } from "#core/errors.ts";
import { configFilePath } from "#config/file.ts";
import type { FileConfig } from "#config/file.ts";

/** 一次调用的最小构造；`arguments` 故意收 string，因为那就是模型产出的形状。 */
function call(name: string, args: string): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

function probeTool(run: ToolDefinition["run"]): ToolDefinition {
  return {
    id: "probe",
    name: "探针",
    description: "只为验证注册表行为而存在",
    parameters: { type: "object", properties: {} },
    run,
  };
}

test("注册表按注册顺序暴露工具，未注册的 id 被忽略", () => {
  const reg = new ToolRegistry();
  reg.register(probeTool(async () => "一"));
  reg.register({ ...probeTool(async () => "二"), id: "second", name: "第二颗" });

  assert.deepEqual(
    reg.list().map((t) => t.id),
    ["probe", "second"],
  );
  // 传入顺序不影响结果顺序：交给模型的工具列表必须稳定，否则缓存与调试都在漂。
  assert.deepEqual(
    reg.pick(["second", "probe", "不存在的工具"]).map((t) => t.id),
    ["probe", "second"],
  );
});

test("注册时就要挡住坏定义，而不是等模型调用那一刻", () => {
  const reg = new ToolRegistry();
  assert.throws(() => reg.register({ ...probeTool(async () => ""), id: "" }), /工具必须带有 id/);
  assert.throws(
    // 运行时守卫：内置工具由 TS 保证有 run，但注册表是公开 API，将来插件也会往里塞东西。
    () =>
      reg.register({ ...probeTool(async () => ""), run: undefined } as unknown as ToolDefinition),
    /缺少 run\(\)/,
  );
});

test("四条失败路径都变成回喂给模型的 isError", async () => {
  const reg = new ToolRegistry();
  reg.register(
    probeTool(async () => {
      throw new Error("内部炸了：堆栈不该出现在这里");
    }),
  );

  const unknown = await reg.run(call("没有这颗工具", "{}"));
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /没有名为「没有这颗工具」的工具/);

  const badJson = await reg.run(call("probe", "{这不是 JSON"));
  assert.equal(badJson.isError, true);
  assert.match(badJson.content, /参数不是合法的 JSON 对象/);

  const notObject = await reg.run(call("probe", "[1,2]"));
  assert.equal(notObject.isError, true);
  assert.match(notObject.content, /期望对象，实际是 array/);

  const thrown = await reg.run(call("probe", "{}"));
  assert.equal(thrown.isError, true);
  // 只带 errorMessage，不带堆栈：工具内部的错误文本可能夹着路径或上游响应体。
  assert.match(thrown.content, /工具「probe」执行失败：内部炸了/);
  assert.ok(!thrown.content.includes("    at "));

  // 每条结果都要挂回它对应的那次调用，否则多工具并行时模型分不清结果。
  assert.equal(thrown.toolCallId, "call-probe");
});

test("空参数串按无参数处理，结果超长会截断并注明原长", async () => {
  let seenArgs: Record<string, unknown> | null = null;
  const reg = new ToolRegistry();
  reg.register(
    probeTool(async (args) => {
      seenArgs = args;
      return "x".repeat(500);
    }),
  );

  const empty = await reg.run(call("probe", ""));
  assert.deepEqual(seenArgs, {}, "空 arguments 应当收成 {}（不少网关在无参数时就这么发）");
  assert.equal(empty.isError, undefined);

  const long = await reg.run(call("probe", "{}"), 100);
  assert.ok(long.content.startsWith("x".repeat(100)));
  assert.match(long.content, /结果已截断，原长 500 字符/);
});

/** 插件的清单项：形状与 `plugins.list()` 的 `PluginView` 兼容（core 不 import plugins，靠结构赋值）。 */
function plugin(id: string, enabled: boolean, error: string | null = null): PluginSummary {
  return { id, name: `${id} 插件`, enabled, error };
}

test("内置 current_time 能跑，非法时区兜成 isError 而不是抛出", async () => {
  const reg = new ToolRegistry();
  for (const tool of createBuiltinTools({ listPlugins: () => [] })) reg.register(tool);

  assert.deepEqual(
    reg.list().map((t) => t.id),
    ["current_time", "list_plugins"],
  );

  const ok = await reg.run(call("current_time", '{"timezone":"Asia/Shanghai"}'));
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /时区 Asia\/Shanghai/);
  assert.match(ok.content, /ISO UTC 为 /);

  // Intl 对非法 IANA 名抛 RangeError —— 兜成 isError 正是设计意图：模型下一次改填 UTC 就能自愈。
  const bad = await reg.run(call("current_time", '{"timezone":"不存在的/时区"}'));
  assert.equal(bad.isError, true);

  const scalar = await reg.run(call("current_time", '"北京时间"'));
  assert.equal(scalar.isError, true);
});

test("list_plugins 逐个报告启用状态，且不把失败原因原文外传给模型", async () => {
  const reg = new ToolRegistry();
  for (const tool of createBuiltinTools({
    listPlugins: () => [
      plugin("ok", true),
      plugin("off", false),
      plugin("bad", false, "插件缺少 id: /home/atri/plugins/x"),
    ],
  })) {
    reg.register(tool);
  }

  const out = await reg.run(call("list_plugins", "{}"));
  assert.equal(out.isError, undefined);
  assert.match(out.content, /ok 插件（id: ok）：运行中/);
  assert.match(out.content, /off 插件（id: off）：已禁用/);
  // `error` 先判，所以失败的那条说「上次加载失败」而不是「已禁用」——
  // 后者会把「它坏了」说成「操作者关掉了它」，模型据此会建议用户去开一个根本起不来的插件。
  assert.match(out.content, /bad 插件（id: bad）：上次加载失败/);
  // 失败原因原文里带着绝对路径，而工具结果会整段发给第三方 provider。模型只需要
  // 「别声称这个插件的能力可用」，原因是给操作者看的（`GET /plugins` 那侧）。
  assert.doesNotMatch(out.content, /\/home\/atri/);
});

test("list_plugins 每次调用现读：注册时还没有插件，装完之后照样报得出", async () => {
  const reg = new ToolRegistry();
  const installed: PluginSummary[] = [];
  for (const tool of createBuiltinTools({ listPlugins: () => installed })) reg.register(tool);

  const empty = await reg.run(call("list_plugins", "{}"));
  assert.match(empty.content, /当前没有安装任何插件/);

  // `app.ts` 恰恰是在 `plugins.loadAll()` 之前注册工具的：这条断言证的就是
  // 「传 getter 而不是快照」不是多余的形式主义 —— 快照在这里会永远报「没有插件」。
  installed.push(plugin("late", true));
  const after = await reg.run(call("list_plugins", "{}"));
  assert.match(after.content, /late 插件（id: late）：运行中/);
});

// --- 开关存储 ---------------------------------------------------------------

test("开关只认 === true：没写、写 false、写字符串都算禁用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-tool-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 走文件而不是注入的 baseline：`{enabled:"true"}` 在 `ToolToggle` 的类型上根本非法，
  // 而它恰恰是「用户手改配置文件」会写出来的东西 —— 这条语义只能在运行时边界上证。
  await writeFile(
    configFilePath(root),
    JSON.stringify({
      tools: {
        on: { enabled: true },
        off: { enabled: false },
        missing: {},
        truthy: { enabled: "true" },
        numeric: { enabled: 1 },
      },
    }),
    "utf8",
  );

  const store = new ToolConfigStore({ root });
  assert.equal(store.isEnabled("on"), true);
  assert.equal(store.isEnabled("off"), false);
  assert.equal(store.isEnabled("missing"), false);
  assert.equal(store.isEnabled("truthy"), false);
  assert.equal(store.isEnabled("numeric"), false);
  assert.equal(store.isEnabled("不在配置里"), false);
  assert.deepEqual(store.enabledIds(), ["on"]);
});

test("没有 tools 键时以注入的 baseline 为准", () => {
  const store = new ToolConfigStore({ tools: { injected: { enabled: true } } });
  assert.equal(store.isEnabled("injected"), true);
  assert.equal(store.writable, false);
  assert.equal(store.filePath, null);
});

test("写开关只动 tools 段，且保留工具自己的其它键", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-tool-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preset: FileConfig = {
    port: 6185,
    pluginDirs: ["./plugins"],
    adapters: { http: { enabled: true } },
    auth: { adminUser: "admin", adminPassword: "pw" },
    tools: { current_time: { timezone: "Asia/Shanghai" } },
  };
  await writeFile(configFilePath(root), JSON.stringify(preset, null, 2), "utf8");

  const store = new ToolConfigStore({ root });
  assert.deepEqual(store.setEnabled("current_time", true), { id: "current_time", enabled: true });

  const saved = JSON.parse(readFileSync(configFilePath(root), "utf8")) as FileConfig & {
    tools: Record<string, { enabled?: unknown; timezone?: unknown }>;
  };
  assert.equal(saved.port, 6185);
  assert.deepEqual(saved.pluginDirs, ["./plugins"]);
  assert.deepEqual(saved.adapters, { http: { enabled: true } });
  assert.equal(saved.auth?.adminPassword, "pw");
  // 工具段落里我们不认识的键必须活着回来（读-改-写，见 config/file.ts 的 FileConfig 注释）。
  assert.equal(saved.tools.current_time?.timezone, "Asia/Shanghai");
  assert.equal(saved.tools.current_time?.enabled, true);
});

test("非法开关值与没有落盘位置都明确报错，而不是静默", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-tool-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new ToolConfigStore({ root });
  for (const bad of [undefined, "yes", 1, {}]) {
    assert.throws(
      () => store.setEnabled("current_time", bad),
      (err) => err instanceof ApiError && err.status === 400,
      `${String(bad)} 不该被当成布尔值`,
    );
  }
  // 文件完全没被写过：校验发生在落盘之前，mutate 抛错时 updateConfigFile 根本不碰文件。
  assert.equal(existsSync(configFilePath(root)), false, "失败的写入不该创建配置文件");

  const readonly = new ToolConfigStore({ tools: {} });
  assert.throws(
    () => readonly.setEnabled("current_time", true),
    (err) => err instanceof ApiError && err.status === 400 && /没有落盘位置/.test(err.message),
  );
});

test("开关落盘失败：包成 500 并带上原始错误作为 cause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-tool-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(configFilePath(root), "{ 这不是 JSON", "utf8");

  const store = new ToolConfigStore({ root });
  assert.throws(
    () => store.setEnabled("current_time", true),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, `应是 ApiError，实际是 ${String(err)}`);
      assert.equal(err.status, 500);
      // 对外只有这一句：`readConfigFile` 的原文带着配置文件绝对路径，不能顺原路发出去。
      assert.equal(err.message, "保存工具开关失败，详情见服务端日志");
      assert.doesNotMatch(err.message, /atri-tool-fail|atri\.config\.json/);
      // AGENTS.md 要求包装错误必须带 cause。这句以前是缺的（全仓仅此一处），
      // 缺了它，堆栈里只剩包装那一句，「为什么写不进去」重新变成猜。
      assert.ok(err.cause instanceof Error, "必须带上原始错误");
      assert.match(err.cause.message, /不是合法 JSON/);
      return true;
    },
  );
});
