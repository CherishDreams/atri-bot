import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@atri/shared";
import { PluginManager } from "#plugins/manager.ts";
import type { PluginView } from "#plugins/manager.ts";
import type { Logger } from "#core/logger.ts";

/**
 * 插件 fixture 与用例之间的探针都挂在 `globalThis` 上（见各用例里写进磁盘的 `index.js`）。
 *
 * 逐个声明类型，而不是给 `globalThis` 开一个索引签名：索引签名会让「探针名拼错」静默
 * 变成 `undefined`，而这些用例的全部价值恰恰是「读到的到底是不是真值」。
 * `declare global` 是纯类型声明、不产出任何 JS，运行时写入这些键的仍然是插件代码本身；
 * 带上 `| undefined` 是因为用例结尾要 `delete` 它们（`delete` 要求操作数可为空）。
 */
declare global {
  /** p2 用它报告自己的 effect 有没有被释放。 */
  var __p2_cleaned: (() => boolean) | undefined;
  /** p3 用它报告模块被求值了几次。 */
  var __p3_loads: number | undefined;
  /** p3 用它报告 effect 被释放了几次。 */
  var __p3_disposed: number | undefined;
  /** p6a 把 `ctx.plugins` 这个访问器交给用例，好在**加载之后**再调用它。 */
  var __p6_peers: (() => PluginInfo[]) | undefined;
}

/** 建一个临时插件目录，写入给定源码的 index.js。 */
async function makePlugin(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "atri-plugin-"));
  await writeFile(join(dir, "index.js"), source, "utf8");
  return dir;
}

/**
 * 静默 logger。
 *
 * 五个方法一个都不能少：`Logger` 的 `debug / info / warn / error / child` 全是必填
 * （见 `src/core/logger.ts`），少写一个就是「不合法的 logger」而不是「没被调用的字段」。
 */
function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
}

/**
 * 只把 `list()` 的返回改成「首项必填」的一层视图。
 *
 * 为什么需要它：有一条断言写成 `assert.equal(mgr.list()[0].status, "disabled")`，
 * 而断言序列在本次迁移中逐字冻结（有快照比对），守卫插不进那一行——`mgr.list()[0]`
 * 是「调用表达式的下标」，TS 的收窄只认引用，连 `assert.ok(mgr.list()[0])` 都帮不到下一行。
 * 这里写的是真实的运行时前提：上一行刚 `load()` 成功并拿到 p4，列表里就是那一个插件。
 * 真的空列表时行为与迁移前一致（TypeError），那条断言照样红。
 */
interface PluginManagerView extends PluginManager {
  list(): [PluginView, ...PluginView[]];
}

test("加载插件并暴露元数据", async () => {
  const dir = await makePlugin(`
    export default { id: "p1", name: "插件一", version: "1.2.3", setup() {} };
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  const info = await mgr.load(dir);
  assert.equal(info.id, "p1");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.status, "active");
  assert.equal(mgr.list().length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("卸载插件会释放其 effect", async () => {
  const dir = await makePlugin(`
    let cleaned = false;
    export default {
      id: "p2",
      setup(ctx) { ctx.effect(() => { cleaned = true; }, "cleanup"); },
    };
    globalThis.__p2_cleaned = () => cleaned;
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  await mgr.load(dir);
  // 守卫：探针的类型是「可能没有」（用例结尾要 delete 它），而下面两行都要把它当函数调用。
  // 插件确实挂上了它（见上一行 load 的 fixture 源码），没挂上就是 fixture 坏了。
  assert.ok(globalThis.__p2_cleaned, "p2 的 fixture 必须挂上清理探针");
  // 卸载前副作用未释放
  assert.equal(globalThis.__p2_cleaned(), false);
  await mgr.unload("p2");
  assert.equal(globalThis.__p2_cleaned(), true, "unload 应释放 effect");
  assert.equal(mgr.list().length, 0);
  delete globalThis.__p2_cleaned;
  await rm(dir, { recursive: true, force: true });
});

test("重载插件会销毁旧实例并重新求值代码", async () => {
  const dir = await makePlugin(`
    export default {
      id: "p3",
      version: "1",
      setup(ctx) {
        globalThis.__p3_loads = (globalThis.__p3_loads ?? 0) + 1;
        ctx.effect(() => { globalThis.__p3_disposed = (globalThis.__p3_disposed ?? 0) + 1; });
      },
    };
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  await mgr.load(dir);
  assert.equal(globalThis.__p3_loads, 1);
  await mgr.reload("p3");
  assert.equal(globalThis.__p3_loads, 2, "重载应重新实例化");
  assert.equal(globalThis.__p3_disposed, 1, "重载应先释放旧实例的 effect");
  delete globalThis.__p3_loads;
  delete globalThis.__p3_disposed;
  await rm(dir, { recursive: true, force: true });
});

test("禁用后再启用可恢复运行", async () => {
  const dir = await makePlugin(`
    export default {
      id: "p4",
      setup(ctx) { ctx.effect(() => {}); },
    };
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger()) as PluginManagerView;
  await mgr.load(dir);
  const off = await mgr.setEnabled("p4", false);
  assert.equal(off.enabled, false);
  assert.equal(mgr.list()[0].status, "disabled");
  const on = await mgr.setEnabled("p4", true);
  assert.equal(on.status, "active");
  await rm(dir, { recursive: true, force: true });
});

test("操作未知插件应报错", async () => {
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  await assert.rejects(() => mgr.reload("nope"), /未知插件/);
  await assert.rejects(() => mgr.unload("nope"), /未知插件/);
});

test("工厂形式的插件也被支持", async () => {
  const dir = await makePlugin(`
    export default (shared) => ({ id: "p5", name: shared.config ? "有配置" : "无" });
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  const info = await mgr.load(dir);
  assert.equal(info.id, "p5");
  await rm(dir, { recursive: true, force: true });
});

test("ctx.plugins() 是实时投影，且不含 dir 与 error", async () => {
  const dirA = await makePlugin(`
    export default {
      id: "p6a",
      name: "会看同伴",
      version: "1.0.0",
      description: "把 ctx.plugins 交给用例",
      setup(ctx) {
        globalThis.__p6_peers = () => ctx.plugins();
      },
    };
  `);
  const dirB = await makePlugin(`
    export default { id: "p6b", name: "后到的", version: "0.1.0", setup() {} };
  `);
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
  await mgr.load(dirA);

  const peers = globalThis.__p6_peers;
  assert.ok(peers, "p6a 的 fixture 必须挂上同伴视图探针");

  // 先加载的那个能看见后加载的那个 —— 这条证的是「注入的是闭包而不是快照」：
  // 数组快照会停在 p6a 出生那一刻，永远只看得见它自己。
  assert.deepEqual(
    peers().map((p) => p.id),
    ["p6a"],
  );
  await mgr.load(dirB);
  assert.deepEqual(
    peers().map((p) => p.id),
    ["p6a", "p6b"],
    "运行期新加载的插件必须立刻可见",
  );

  const late = peers().find((p) => p.id === "p6b");
  assert.equal(late?.name, "后到的");
  assert.equal(late?.version, "0.1.0");
  assert.equal(late?.enabled, true);
  // `enabled` 投影自运行期 status（`#peers()`），所以禁用会立刻反映到同伴视图上。
  await mgr.setEnabled("p6b", false);
  assert.equal(peers().find((p) => p.id === "p6b")?.enabled, false);

  // 投影的边界。这是「新增一条可见键必须经过一次人的判断」的可执行形式：同伴的磁盘路径
  // 与加载失败原因不交给插件 —— 后者可能带着 `resolve()` 之后的绝对路径。
  for (const p of peers()) {
    assert.ok(!("dir" in p), "不该把别的插件的目录交给插件");
    assert.ok(!("error" in p), "不该把加载失败原因交给插件");
  }
  // 键是逐个拼出来的而不是 `...meta`：没声明 description 的那个连这个键都不该有。
  assert.equal(peers().find((p) => p.id === "p6a")?.description, "把 ctx.plugins 交给用例");
  assert.ok(!("description" in (peers().find((p) => p.id === "p6b") ?? {})));

  await mgr.unloadAll();
  delete globalThis.__p6_peers;
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});
