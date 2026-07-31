import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../src/plugins/manager.ts";

/** 建一个临时插件目录，写入给定源码的 index.js。 */
async function makePlugin(source) {
  const dir = await mkdtemp(join(tmpdir(), "atri-plugin-"));
  await writeFile(join(dir, "index.js"), source, "utf8");
  return dir;
}

function silentLogger() {
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
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger());
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
