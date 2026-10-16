import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "#plugins/manager.ts";
import type { Logger } from "#core/logger.ts";
import { ApiError } from "#core/errors.ts";
import { ensurePrivateDir, readConfigFileAt, writeConfigFileAt } from "#config/file.ts";
import {
  PLUGIN_CONFIG_FILE,
  PLUGIN_SCHEMA_FILE,
  effectiveValues,
  parseSchema,
  readSchema,
  validatePatch,
} from "#plugins/settings.ts";

/**
 * 插件配置：schema 解析 / 值校验 / 落盘 / 保存后重载。
 *
 * 这一层刻意**不**经过 HTTP：保存的语义（先验后写、坏文件重建、重载失败保留文件）
 * 都在 `PluginManager.saveConfig` 里，用真插件目录 + 真文件系统才看得见。
 * 端点的形状由 openapi 那三道守卫负责。
 */

declare global {
  /** 插件 `setup()` 里看到的 `ctx.pluginConfig`。 */
  var __settings_seen: Record<string, unknown> | undefined;
  /** `setup()` 被跑过几次（证明保存真的重载了）。 */
  var __settings_setups: number | undefined;
}

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function tmpDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 六种类型各一个：表单的每个分支都要有真实声明可验。 */
const FULL_SCHEMA = {
  greeting: { type: "string", description: "问候语", default: "你好" },
  retries: { type: "int", description: "重试次数", default: 2, min: 0, max: 10 },
  ratio: { type: "float", description: "阈值", default: 0.5, min: 0, max: 1 },
  verbose: { type: "bool", description: "详细日志", default: false },
  style: { type: "select", description: "风格", options: ["简洁", "详细"], default: "简洁" },
  prompt: { type: "text", description: "提示词", default: "" },
};

/**
 * 建一个可配置插件。`setup()` 把看到的 `ctx.pluginConfig` 交给用例，
 * 并让 `greeting === "boom"` 时抛错 —— 那条用来证「保存成功、重载失败」。
 */
async function makePlugin(
  t: TestContext,
  root: string,
  id: string,
  options: { schema?: object | null; setup?: string } = {},
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const setup =
    options.setup ??
    `
    globalThis.__settings_setups = (globalThis.__settings_setups ?? 0) + 1;
    globalThis.__settings_seen = { ...ctx.pluginConfig };
    if (ctx.pluginConfig.greeting === "boom") throw new Error("这条值按设计起不来");
  `;
  await writeFile(
    join(dir, "index.js"),
    `export default { id: ${JSON.stringify(id)}, setup(ctx) { ${setup} } };\n`,
    "utf8",
  );
  if (options.schema !== null) {
    await writeFile(
      join(dir, PLUGIN_SCHEMA_FILE),
      JSON.stringify(options.schema ?? FULL_SCHEMA),
      "utf8",
    );
  }
  return dir;
}

function managerFor(root: string, dataRoot: string, disabledIds?: string[]): PluginManager {
  return new PluginManager({ pluginDirs: [root] }, silentLogger(), {
    dataRoot,
    ...(disabledIds === undefined ? {} : { disabledIds }),
    ensurePrivateDir,
    readConfigFileAt,
    writeConfigFileAt,
  });
}

function resetProbes(): void {
  globalThis.__settings_seen = undefined;
  globalThis.__settings_setups = undefined;
}

test("parseSchema：六种类型都接受；任何一项不合规就整份作废", () => {
  const ok = parseSchema(FULL_SCHEMA);
  assert.equal(ok.error, null);
  assert.deepEqual(
    ok.fields.map((f) => [f.key, f.type, f.default]),
    [
      ["greeting", "string", "你好"],
      ["retries", "int", 2],
      ["ratio", "float", 0.5],
      ["verbose", "bool", false],
      ["style", "select", "简洁"],
      ["prompt", "text", ""],
    ],
  );

  const bad = [
    [null, /顶层必须是一个对象/],
    [{ x: { type: "list", description: "列表", default: [] } }, /type 不支持/],
    [{ x: { type: "string" } }, /缺少 description/],
    [{ x: { type: "string", description: "a", default: 1 } }, /default 必须是字符串/],
    [{ x: { type: "select", description: "a", options: ["甲"], default: "乙" } }, /default 只能取/],
    [{ x: { type: "int", description: "a", min: 9, max: 1, default: 2 } }, /min 大于 max/],
    // 用 JSON.parse 造出**自有**的 `__proto__` 键：对象字面量里的 `__proto__` 是设原型，
    // 根本不会出现在 Object.entries 里，那样测的就不是这条守卫。
    [JSON.parse('{"__proto__": {"type": "string", "description": "a", "default": ""}}'), /不合法/],
    [{ "1bad": { type: "string", description: "a", default: "" } }, /不合法/],
  ] as const;
  for (const [raw, pattern] of bad) {
    const result = parseSchema(raw);
    assert.deepEqual(result.fields, [], `不该给出半个表单：${String(pattern)}`);
    assert.match(result.error ?? "", pattern);
  }
});

test("readSchema：没有声明文件是 present:false；坏 JSON 是 present:true + error", async (t) => {
  const dir = await tmpDir(t, "atri-settings-schema-");
  assert.deepEqual(readSchema(dir), { present: false, fields: [], error: null });

  writeFileSync(join(dir, PLUGIN_SCHEMA_FILE), "{ 不是 JSON", "utf8");
  const broken = readSchema(dir);
  assert.equal(broken.present, true);
  assert.match(broken.error ?? "", /不是合法 JSON/);

  writeFileSync(join(dir, PLUGIN_SCHEMA_FILE), JSON.stringify(FULL_SCHEMA), "utf8");
  assert.equal(readSchema(dir).error, null);
});

test("effectiveValues：默认值被文件覆盖，非法值退回默认并点名", () => {
  const fields = parseSchema(FULL_SCHEMA).fields;
  const defaults = effectiveValues(fields, {});
  assert.equal(defaults.configError, null);
  assert.equal(defaults.values.greeting, "你好");
  assert.equal(defaults.values.retries, 2);

  const overridden = effectiveValues(fields, { greeting: "早上好", retries: 7 });
  assert.equal(overridden.values.greeting, "早上好");
  assert.equal(overridden.values.retries, 7);

  const invalid = effectiveValues(fields, { retries: 99, style: "不存在", extra: 1 });
  assert.equal(invalid.values.retries, 2, "越界值必须退回默认");
  assert.equal(invalid.values.style, "简洁");
  assert.match(invalid.configError ?? "", /「retries」「style」/);
  assert.equal("extra" in invalid.values, false, "未声明的键不该出现在生效值里");
});

test("validatePatch：未知/重复/缺值/类型/范围/选项都在写之前拒掉", () => {
  const fields = parseSchema(FULL_SCHEMA).fields;
  const cases: [unknown, RegExp][] = [
    [{}, /必须是数组/],
    [[{ key: "nope", value: 1 }], /不存在/],
    [
      [
        { key: "greeting", value: "a" },
        { key: "greeting", value: "b" },
      ],
      /重复提交/,
    ],
    [[{ key: "greeting" }], /缺少 value/],
    [[{ key: "retries", value: 1.5 }], /必须是整数/],
    [[{ key: "retries", value: 11 }], /不能大于 10/],
    [[{ key: "ratio", value: "0.5" }], /必须是数字/],
    [[{ key: "verbose", value: "true" }], /必须是布尔值/],
    [[{ key: "style", value: "花哨" }], /只能取/],
  ];
  for (const [patch, pattern] of cases) {
    assert.throws(
      () => validatePatch(fields, patch),
      (err: unknown) => err instanceof ApiError && err.status === 400 && pattern.test(err.message),
      `应当拒绝：${String(pattern)}`,
    );
  }
});

test("加载时把默认值交给 setup；保存后写盘、重载，setup 看到新值", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-e2e-");
  const dataRoot = await tmpDir(t, "atri-settings-data-");
  await makePlugin(t, root, "p1");
  const mgr = managerFor(root, dataRoot);

  await mgr.loadAll();
  assert.deepEqual(globalThis.__settings_seen, {
    greeting: "你好",
    retries: 2,
    ratio: 0.5,
    verbose: false,
    style: "简洁",
    prompt: "",
  });
  assert.equal(mgr.list()[0]?.configurable, true);

  const configPath = join(dataRoot, "p1", PLUGIN_CONFIG_FILE);
  // 手写的未知键必须原样保留：读-改-写不是整份替换。
  mkdirSync(join(dataRoot, "p1"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ hand_written: 42 }), "utf8");
  const result = await mgr.saveConfig("p1", [
    { key: "greeting", value: "早上好" },
    { key: "retries", value: 5 },
  ]);
  assert.equal(result.reloadError, null);
  assert.equal(globalThis.__settings_setups, 2, "保存之后插件必须重载一次");
  assert.equal(globalThis.__settings_seen?.greeting, "早上好");
  assert.equal(globalThis.__settings_seen?.retries, 5);

  const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(onDisk, { hand_written: 42, greeting: "早上好", retries: 5 });
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "配置文件必须是 0600");
  assert.equal(statSync(join(dataRoot, "p1")).mode & 0o777, 0o700, "数据目录必须是 0700");

  // 回读：GET 的那一份就是刚写进去的。
  const view = mgr.getConfig("p1");
  assert.equal(view.configError, null);
  assert.deepEqual(
    view.fields.filter((f) => f.key === "greeting" || f.key === "retries").map((f) => f.value),
    ["早上好", 5],
  );
});

test("禁用态保存只落盘、不加载；再启用时读到新值", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-disabled-");
  const dataRoot = await tmpDir(t, "atri-settings-disabled-data-");
  await makePlugin(t, root, "p2");
  const mgr = managerFor(root, dataRoot, ["p2"]);

  await mgr.loadAll();
  assert.equal(globalThis.__settings_setups, undefined, "禁用的插件不该跑 setup");

  const saved = await mgr.saveConfig("p2", [{ key: "greeting", value: "关着也能存" }]);
  assert.equal(saved.reloadError, null);
  assert.equal(saved.plugin.status, "disabled");
  assert.equal(globalThis.__settings_setups, undefined, "保存配置不该偷偷加载禁用插件");
  assert.equal(
    JSON.parse(readFileSync(join(dataRoot, "p2", PLUGIN_CONFIG_FILE), "utf8")).greeting,
    "关着也能存",
  );

  await mgr.setEnabled("p2", true);
  assert.equal(globalThis.__settings_seen?.greeting, "关着也能存");
});

test("坏配置文件：插件 failed，读取给默认值 + configError，保存可重建并恢复", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-broken-");
  const dataRoot = await tmpDir(t, "atri-settings-broken-data-");
  await makePlugin(t, root, "p3");
  const dir = join(dataRoot, "p3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{ 坏掉了", "utf8");

  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();
  const failed = mgr.list().find((p) => p.id === "p3");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /配置文件读不出来/);

  const view = mgr.getConfig("p3");
  assert.match(view.configError ?? "", /配置文件读不出来/);
  assert.equal(view.fields.find((f) => f.key === "greeting")?.value, "你好");

  const repaired = await mgr.saveConfig("p3", [{ key: "greeting", value: "修好了" }]);
  assert.equal(repaired.reloadError, null);
  assert.equal(repaired.plugin.status, "active");
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).greeting, "修好了");
});

test("重载失败：保存成功但插件 failed，文件保留；改回来能恢复", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-reload-");
  const dataRoot = await tmpDir(t, "atri-settings-reload-data-");
  await makePlugin(t, root, "p4");
  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();

  const failed = await mgr.saveConfig("p4", [{ key: "greeting", value: "boom" }]);
  assert.match(failed.reloadError ?? "", /按设计起不来/);
  assert.equal(failed.plugin.status, "failed");
  assert.equal(
    JSON.parse(readFileSync(join(dataRoot, "p4", PLUGIN_CONFIG_FILE), "utf8")).greeting,
    "boom",
    "重载失败不该把刚保存的值回滚",
  );

  const fixed = await mgr.saveConfig("p4", [{ key: "greeting", value: "没事了" }]);
  assert.equal(fixed.reloadError, null);
  assert.equal(fixed.plugin.status, "active");
  assert.equal(globalThis.__settings_seen?.greeting, "没事了");
});

test("保存先验后写：非法补丁一个字节都不落盘，重复保存幂等", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-atomic-");
  const dataRoot = await tmpDir(t, "atri-settings-atomic-data-");
  await makePlugin(t, root, "p8");
  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();

  const dir = join(dataRoot, "p8");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PLUGIN_CONFIG_FILE);
  // 一份合法的、带手写键的文件：任何一次被拒的保存都必须让它原样不动。
  const original = JSON.stringify({ hand_written: 1 }) + "\n";
  writeFileSync(path, original, "utf8");

  const badPatches: unknown[] = [
    [{ key: "nope", value: 1 }],
    [{ key: "retries", value: 1.5 }],
    [{ key: "retries", value: 99 }],
    [{ key: "style", value: "不存在" }],
    [
      { key: "greeting", value: "a" },
      { key: "greeting", value: "b" },
    ],
  ];
  for (const patch of badPatches) {
    await assert.rejects(
      () => mgr.saveConfig("p8", patch),
      (err: unknown) => err instanceof ApiError && err.status === 400,
      `应当拒绝：${JSON.stringify(patch)}`,
    );
    assert.equal(readFileSync(path, "utf8"), original, "被拒的保存不能在磁盘上留下半笔");
  }

  await mgr.saveConfig("p8", [{ key: "greeting", value: "甲" }]);
  const settled = readFileSync(path, "utf8");
  // 同一个值再存一次：文件字节与第一次完全一致（读-改-写没有制造额外漂移）。
  const again = await mgr.saveConfig("p8", [{ key: "greeting", value: "甲" }]);
  assert.equal(again.reloadError, null);
  assert.equal(readFileSync(path, "utf8"), settled);
});

test("禁用与卸载都不删插件自己的 config.json", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-keep-");
  const dataRoot = await tmpDir(t, "atri-settings-keep-data-");
  await makePlugin(t, root, "p9");
  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();

  const path = join(dataRoot, "p9", PLUGIN_CONFIG_FILE);
  await mgr.saveConfig("p9", [{ key: "greeting", value: "留着" }]);
  assert.equal(existsSync(path), true);

  await mgr.setEnabled("p9", false);
  assert.equal(existsSync(path), true, "禁用只改运行态，不碰数据目录");

  await mgr.unload("p9");
  assert.equal(existsSync(path), true, "卸载同样不删数据目录");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).greeting, "留着");
});

test("没有 schema 的插件：configurable:false，读取与保存都回 400", async (t) => {
  const root = await tmpDir(t, "atri-settings-noschema-");
  const dataRoot = await tmpDir(t, "atri-settings-noschema-data-");
  await makePlugin(t, root, "p5", { schema: null });
  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();

  assert.equal(mgr.list()[0]?.configurable, false);
  assert.throws(() => mgr.getConfig("p5"), /没有声明配置项/);
  await assert.rejects(() => mgr.saveConfig("p5", []), /没有声明配置项/);
});

test("配置按配置档隔离：一份档保存的值不会出现在另一份", async (t) => {
  const root = await tmpDir(t, "atri-settings-iso-");
  const dataA = await tmpDir(t, "atri-settings-iso-a-");
  const dataB = await tmpDir(t, "atri-settings-iso-b-");
  await makePlugin(t, root, "p6");
  const a = managerFor(root, dataA);
  const b = managerFor(root, dataB);
  await a.loadAll();
  await b.loadAll();

  await a.saveConfig("p6", [{ key: "greeting", value: "A 的值" }]);
  assert.equal(a.getConfig("p6").fields.find((f) => f.key === "greeting")?.value, "A 的值");
  assert.equal(b.getConfig("p6").fields.find((f) => f.key === "greeting")?.value, "你好");
});

test("ctx.pluginConfig 与 ctx.config 是两份：用户值不混进白名单那一边", async (t) => {
  resetProbes();
  t.after(resetProbes);
  const root = await tmpDir(t, "atri-settings-ctx-");
  const dataRoot = await tmpDir(t, "atri-settings-ctx-data-");
  // 单独记一份 ctx.config：它只该有 pluginDirs 一条。
  (globalThis as { __settings_config?: unknown }).__settings_config = undefined;
  await makePlugin(t, root, "p7", {
    setup: `
      globalThis.__settings_setups = (globalThis.__settings_setups ?? 0) + 1;
      globalThis.__settings_seen = { ...ctx.pluginConfig };
      globalThis.__settings_config = { ...ctx.config };
    `,
  });
  const mgr = managerFor(root, dataRoot);
  await mgr.loadAll();
  mkdirSync(join(dataRoot, "p7"), { recursive: true });
  writeFileSync(
    join(dataRoot, "p7", PLUGIN_CONFIG_FILE),
    JSON.stringify({ greeting: "用户值" }),
    "utf8",
  );
  await mgr.reload("p7");

  assert.equal(globalThis.__settings_seen?.greeting, "用户值");
  assert.deepEqual(
    Object.keys((globalThis as { __settings_config?: object }).__settings_config ?? {}),
    ["pluginDirs"],
    "用户配置不能出现在 ctx.config 里",
  );
});
