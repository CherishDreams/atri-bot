import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@atri/shared";
import { PluginManager } from "#plugins/manager.ts";
import type { PluginView } from "#plugins/manager.ts";
import type { Logger } from "#core/logger.ts";
import { ApiError } from "#core/errors.ts";
import { createApp } from "#app.ts";
import { ensurePrivateDir } from "#config/file.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 插件 fixture 与用例之间的探针都挂在 `globalThis` 上（见各用例里写进磁盘的 `index.js`）。
 *
 * 逐个声明类型，而不是给 `globalThis` 开一个索引签名：索引签名会让「探针名拼错」静默
 * 变成 `undefined`，而这些用例的全部价值恰恰是「读到的到底是不是真值」。
 * `declare global` 是纯类型声明、不产出任何 JS，运行时写入这些键的仍然是插件代码本身；
 * 带上 `| undefined` 是因为 `t.after` 要 `delete` 它们（`delete` 要求操作数可为空）。
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
  /** p7 换目录重载时读回来的那份数据（证明数据目录的键是 id，不是插件目录名）。 */
  var __p7_note: string | undefined;
  /** 坏插件报告 `setup()` / `teardown()` 各被跑过几次。 */
  var __p9_setup: number | undefined;
  var __p9_teardown: number | undefined;
  /** 跨配置档那条用例：插件**模块顶层**被求值的次数（两个管理器各一次才算隔离）。 */
  var __iso_evals: number | undefined;
  /** 启用清单那条用例：`setup()` 被跑过的次数（被禁用的那颗必须是 0 次）。 */
  var __p10_setups: number | undefined;
}

/**
 * 建一个临时插件目录，写入给定源码，并把删除挂到 `t.after` 上。
 *
 * 清理**必须**挂在钩子上而不是写在用例体末尾：写在末尾时任何一条先红的断言都会把
 * 临时目录和 `globalThis` 上的探针留给后面的用例，于是「第二条用例失败」的原因
 * 其实是第一条的残留。
 */
async function makePlugin(t: TestContext, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atri-plugin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.js"), source, "utf8");
  return dir;
}

/**
 * 在同一个插件根下按**目录名**建一个插件。
 *
 * 失败记录的对外 id 就是这个名字（插件没来得及自报 id），所以这些用例要的是可预测的
 * 目录名，`mkdtemp` 那种随机名证不了这件事。
 */
async function makeNamedPlugin(
  t: TestContext,
  root: string,
  name: string,
  source: string,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), source, "utf8");
  return dir;
}

/**
 * 静默 logger。
 *
 * 四个方法一个都不能少：`Logger` 的 `debug / info / warn / error` 全是必填
 *（见 `src/core/logger.ts`），少写一个就是「不合法的 logger」而不是「没被调用的字段」。
 * 这里以前还得写第五个 `child()` —— 它在全仓没有任何调用点，只为了满足类型。
 */
function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/** 起一个只有管理器的管理器；`pluginDirs` 由调用方决定（`shared.config` 那条用例要读它）。 */
function makeManager(t: TestContext, pluginDirs: string[] = []) {
  return new PluginManager({ pluginDirs }, silentLogger(), {
    dataRoot: useDataRoot(t),
    ensurePrivateDir,
  });
}

/**
 * 一座临时的插件数据根，用例结束删掉。
 *
 * `dataRoot` 是 `PluginManager` 的必填参数（本仓不留「没有数据根」这条第二路径），
 * 但目录**惰性**创建：只有插件真的访问 `ctx.dataDir` 才会落盘，所以下面那些不碰它的用例
 * 一句 `mkdir` 也不会发生 —— 这正是「启动不多碰盘」那条例外在测试里的样子。
 */
function useDataRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "atri-plugin-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "plugins");
}

/**
 * 只把 `list()` 的返回改成「首项必填」的一层视图。
 *
 * 为什么需要它：有一条断言写成 `assert.equal(mgr.list()[0].status, "disabled")`，而
 * `mgr.list()[0]` 是「调用表达式的下标」，TS 的收窄只认引用，连 `assert.ok(mgr.list()[0])`
 * 都帮不到下一行。这里写的是真实的运行时前提：上一行刚 `load()` 成功并拿到 p4，
 * 列表里就是那一个插件。真的空列表时行为与迁移前一致（TypeError），那条断言照样红。
 */
interface PluginManagerView extends PluginManager {
  list(): [PluginView, ...PluginView[]];
}

/** 取同伴视图里的某一条；找不到就报出「谁不见了」，而不是把 `undefined` 传进后面的断言。 */
function peerOf(peers: PluginInfo[], id: string): PluginInfo {
  const found = peers.find((p) => p.id === id);
  assert.ok(found, `同伴视图里应该有 ${id}`);
  return found;
}

test("加载插件并暴露元数据", async (t) => {
  const dir = await makePlugin(
    t,
    `
    export default { id: "p1", name: "插件一", version: "1.2.3", setup() {} };
  `,
  );
  const mgr = makeManager(t);
  const info = await mgr.load(dir);
  assert.equal(info.id, "p1");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.status, "active");
  assert.equal(mgr.list().length, 1);
});

test("卸载插件会释放其 effect", async (t) => {
  t.after(() => {
    delete globalThis.__p2_cleaned;
  });
  const dir = await makePlugin(
    t,
    `
    let cleaned = false;
    export default {
      id: "p2",
      setup(ctx) { ctx.effect(() => { cleaned = true; }, "cleanup"); },
    };
    globalThis.__p2_cleaned = () => cleaned;
  `,
  );
  const mgr = makeManager(t);
  await mgr.load(dir);
  // 守卫：探针的类型是「可能没有」（它由插件代码挂上），而下面两行都要把它当函数调用。
  // 没挂上就是 fixture 坏了。
  assert.ok(globalThis.__p2_cleaned, "p2 的 fixture 必须挂上清理探针");
  // 卸载前副作用未释放
  assert.equal(globalThis.__p2_cleaned(), false);
  await mgr.unload("p2");
  assert.equal(globalThis.__p2_cleaned(), true, "unload 应释放 effect");
  assert.equal(mgr.list().length, 0);
});

test("重载插件会销毁旧实例并重新求值代码", async (t) => {
  t.after(() => {
    delete globalThis.__p3_loads;
    delete globalThis.__p3_disposed;
  });
  const dir = await makePlugin(
    t,
    `
    export default {
      id: "p3",
      version: "1",
      setup(ctx) {
        globalThis.__p3_loads = (globalThis.__p3_loads ?? 0) + 1;
        ctx.effect(() => { globalThis.__p3_disposed = (globalThis.__p3_disposed ?? 0) + 1; });
      },
    };
  `,
  );
  const mgr = makeManager(t);
  await mgr.load(dir);
  assert.equal(globalThis.__p3_loads, 1);
  await mgr.reload("p3");
  assert.equal(globalThis.__p3_loads, 2, "重载应重新实例化");
  assert.equal(globalThis.__p3_disposed, 1, "重载应先释放旧实例的 effect");
});

test("禁用后再启用可恢复运行", async (t) => {
  const dir = await makePlugin(
    t,
    `
    export default {
      id: "p4",
      setup(ctx) { ctx.effect(() => {}); },
    };
  `,
  );
  const mgr = makeManager(t) as PluginManagerView;
  await mgr.load(dir);
  const off = await mgr.setEnabled("p4", false);
  assert.equal(off.enabled, false);
  assert.equal(mgr.list()[0].status, "disabled");
  const on = await mgr.setEnabled("p4", true);
  assert.equal(on.status, "active");
});

test("操作未知插件应报错", async (t) => {
  const mgr = makeManager(t);
  await assert.rejects(() => mgr.reload("nope"), /未知插件/);
  await assert.rejects(() => mgr.unload("nope"), /未知插件/);
  await assert.rejects(() => mgr.setEnabled("nope", true), /未知插件/);
  await assert.rejects(() => mgr.setEnabled("nope", false), /未知插件/);
});

test("工厂形式的插件也被支持", async (t) => {
  const dir = await makePlugin(
    t,
    `
    export default (shared) => ({ id: "p5", name: shared.config ? "有配置" : "无" });
  `,
  );
  const mgr = makeManager(t);
  const info = await mgr.load(dir);
  assert.equal(info.id, "p5");
});

/**
 * `shared.config` 与 `ctx.config` 都必须是**每次新拷**的一份。
 *
 * 这条用例盯的是「拷过的形状又被共享回去」：`pluginRuntimeConfig()` 在装配处已经拷过一次，
 * 但 `PluginManager` 若把 `this.config` 原样递出去（旧写法），或者 `ctx.config` 用浅层展开
 * （`{ ...this.config }` 之后 `pluginDirs` 还是同一个数组），插件一次 `push` 就能改到
 * 管理器自己在 `loadAll()` 循环里读的那一份 —— 而那个循环正是被这个数组驱动的。
 * AGENTS.md「窄的类型标注不等于窄的现实」说的就是这种形状。
 */
test("shared.config 与 ctx.config 都是副本，插件改不到管理器的配置", async (t) => {
  const sharedDir = await makePlugin(
    t,
    `
    export default (shared) => {
      shared.config.pluginDirs.push("/偷来的目录");
      return { id: "p10", name: "改了共享配置", version: "1", setup() {} };
    };
  `,
  );
  const ctxDir = await makePlugin(
    t,
    `
    export default {
      id: "p11",
      name: "改了上下文配置",
      version: "1",
      setup(ctx) { ctx.config.pluginDirs.push("/另一个偷来的目录"); },
    };
  `,
  );
  const mgr = new PluginManager({ pluginDirs: ["/原样"] }, silentLogger(), {
    dataRoot: useDataRoot(t),
    ensurePrivateDir,
  });
  await mgr.load(sharedDir);
  await mgr.load(ctxDir);

  assert.deepEqual(mgr.config.pluginDirs, ["/原样"], "插件改 shared.config 不得改到管理器那一份");
  // `shared` 每次读都该是新的一份：第二次拿到的数组里没有上一个插件 push 进去的东西。
  assert.deepEqual(mgr.shared.config.pluginDirs, ["/原样"]);
  assert.notEqual(mgr.shared.config, mgr.config, "shared.config 不能就是管理器那一个对象");
});

test("ctx.plugins() 是实时投影，键集合由白名单钉住", async (t) => {
  t.after(() => {
    delete globalThis.__p6_peers;
  });
  const dirA = await makePlugin(
    t,
    `
    export default {
      id: "p6a",
      name: "会看同伴",
      version: "1.0.0",
      description: "把 ctx.plugins 交给用例",
      setup(ctx) {
        globalThis.__p6_peers = () => ctx.plugins();
      },
    };
  `,
  );
  const dirB = await makePlugin(
    t,
    `
    export default { id: "p6b", name: "后到的", version: "0.1.0", setup() {} };
  `,
  );
  const mgr = makeManager(t);
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

  const late = peerOf(peers(), "p6b");
  assert.equal(late.name, "后到的");
  assert.equal(late.version, "0.1.0");
  assert.equal(late.enabled, true);
  // `enabled` 投影自运行期 status（`#peers()`），所以禁用会立刻反映到同伴视图上。
  await mgr.setEnabled("p6b", false);
  assert.equal(peerOf(peers(), "p6b").enabled, false);

  // 投影的边界。这是「新增一条可见键必须经过一次人的判断」的可执行形式。
  // **键集合相等**而不是「不含 dir / error / dataDir」那种缺席式断言：后者对**新增**的键
  // 完全不红（把 `dir` 改名成 `path`、或多给一条 `dataRoot` 都照样绿），而 AGENTS.md 明令
  // 禁止用黑名单去列「不该看到的键」—— 秘密会换名字、会新增，黑名单每一次都迟到。
  const KEYS = ["enabled", "id", "name", "version"];
  const KEYS_WITH_DESCRIPTION = [...KEYS, "description"].toSorted();
  assert.deepEqual(Object.keys(peerOf(peers(), "p6a")).toSorted(), KEYS_WITH_DESCRIPTION);
  assert.deepEqual(Object.keys(peerOf(peers(), "p6b")).toSorted(), KEYS);
  // 没声明 description 的那个连这个键都不该有（键是逐个拼出来的，不是 `...meta`）。
  assert.ok(!("description" in peerOf(peers(), "p6b")));

  await mgr.unloadAll();
});

test("加载失败的插件也在同伴视图里，且 enabled 为 false", async (t) => {
  t.after(() => {
    delete globalThis.__p6_peers;
  });
  const dirA = await makePlugin(
    t,
    `
    export default {
      id: "p6a",
      name: "会看同伴",
      version: "1.0.0",
      setup(ctx) { globalThis.__p6_peers = () => ctx.plugins(); },
    };
  `,
  );
  const broken = await makePlugin(
    t,
    `
    export default { id: "p6c", name: "起不来", version: "1", setup() { throw new Error("坏了"); } };
  `,
  );
  const mgr = makeManager(t);
  await mgr.load(dirA);
  await assert.rejects(() => mgr.load(broken));

  const peers = globalThis.__p6_peers;
  assert.ok(peers, "p6a 的 fixture 必须挂上同伴视图探针");
  // 同伴需要知道的正是「别声称它的能力可用」，而那一个布尔就够了 —— 为什么失败留给操作者，
  // 所以这一条在 `#peers()` 里也**不带** error 键（键集合与健康的同伴一致）。
  const bad = peerOf(peers(), "p6c");
  assert.equal(bad.enabled, false);
  assert.deepEqual(Object.keys(bad).toSorted(), ["enabled", "id", "name", "version"]);
});

test("ctx.dataDir 惰性创建，路径由 id 决定", async (t) => {
  const dataRoot = useDataRoot(t);
  const writer = await makePlugin(
    t,
    `
    import { writeFileSync } from "node:fs";
    export default {
      id: "p7",
      setup(ctx) {
        writeFileSync(ctx.dataDir + "/note.json", "第一份");
      },
    };
  `,
  );
  const idle = await makePlugin(
    t,
    `
    export default { id: "p8", setup() {} };
  `,
  );

  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger(), { dataRoot, ensurePrivateDir });
  await mgr.load(writer);

  // 键是 `id`，不是磁盘目录名 —— 目录名可以被用户改，而数据不该跟着一起丢。
  const dataDir = join(dataRoot, "p7");
  assert.equal(readFileSync(join(dataDir, "note.json"), "utf8"), "第一份");
  // 数据根之外不该有任何东西（`<dataDir>/plugins` 是框架建的唯一一个目录）。
  assert.ok(existsSync(dataRoot), "数据根由第一次访问创建");

  // 惰性的另一半：不调 `ctx.dataDir` 的插件，一次 mkdir 都不该发生。
  await mgr.load(idle);
  assert.equal(existsSync(join(dataRoot, "p8")), false, "没访问就不该建目录");

  await mgr.unloadAll();
});

test("卸载与换目录都不丢数据：目录的键是 id，不是插件所在的目录名", async (t) => {
  t.after(() => {
    delete globalThis.__p7_note;
  });
  const dataRoot = useDataRoot(t);
  const note = join(dataRoot, "p7", "note.json");
  const first = await makePlugin(
    t,
    `
    import { writeFileSync } from "node:fs";
    export default { id: "p7", setup(ctx) { writeFileSync(ctx.dataDir + "/note.json", "第一份"); } };
  `,
  );
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger(), { dataRoot, ensurePrivateDir });
  await mgr.load(first);
  assert.equal(readFileSync(note, "utf8"), "第一份");

  // 这条断言把「卸载只销毁实例」从**巧合**变成契约：今天 `apps/server/src` 里没有任何
  // 删除文件的调用，将来有人加删除时，这里会先红。
  await mgr.unload("p7");
  assert.ok(existsSync(note), "卸载不得删插件数据");

  // 用户把插件挪进别的目录 / 改了目录名，id 不变 → 数据还在原地等着它。
  const moved = await makePlugin(
    t,
    `
    import { readFileSync } from "node:fs";
    export default {
      id: "p7",
      setup(ctx) { globalThis.__p7_note = readFileSync(ctx.dataDir + "/note.json", "utf8"); },
    };
  `,
  );
  await mgr.load(moved);
  assert.equal(globalThis.__p7_note, "第一份", "数据跟着 id 走，与插件目录名无关");

  // 禁用/启用是同一条语义的另一个面：都不该碰数据。
  await mgr.setEnabled("p7", false);
  assert.ok(existsSync(note), "禁用不得删插件数据");
  await mgr.setEnabled("p7", true);
  assert.equal(globalThis.__p7_note, "第一份", "重新启用后读到的还是同一份数据");

  await mgr.unloadAll();
});

test("id 不能当路径用时拒绝加载，且不创建任何东西", async (t) => {
  t.after(() => {
    delete globalThis.__p9_setup;
  });
  const dataRoot = useDataRoot(t);
  // `../escape` 是路径穿越，`with/slash` 会多出层级，`Uppercase` 在大小写不敏感的文件系统上
  // 会与 `uppercase` 撞同一个目录、在 Linux 上却不撞 —— 三者都不能直接做目录名。
  for (const bad of ["../escape", "with/slash", "Uppercase"]) {
    const dir = await makePlugin(
      t,
      `
      export default { id: ${JSON.stringify(bad)}, setup(ctx) { globalThis.__p9_setup = 1; } };
    `,
    );
    const mgr = new PluginManager({ pluginDirs: [] }, silentLogger(), {
      dataRoot,
      ensurePrivateDir,
    });
    // id 会**直接成为** `<dataDir>/plugins/<id>` 的路径组件，所以它在登记那一刻就被拒，
    // 而不是等插件自己去碰 `ctx.dataDir` 才发现：后者意味着一份 id 不合规的插件已经进了
    // 登记表、进了日志、进了 `list_plugins` 给模型看的文本（含 `\n` 的 id 还能伪造日志行）。
    await assert.rejects(() => mgr.load(dir), /不能用作数据目录名/, `id=${bad}`);

    // 被拒的那一颗记为 failed，`setup()` 一次都没跑，而且列表里就只有它。
    assert.equal(globalThis.__p9_setup, undefined, "id 被拒时不得跑 setup()");
    const [failed] = mgr.list();
    assert.equal(mgr.list().length, 1);
    assert.equal(failed?.status, "failed");

    await mgr.unloadAll();
  }

  // 三次尝试一个目录都没建出来 —— 「不创建任何东西」是这条用例的正题，
  // 否则非法 id 就会在数据根外面留下目录（穿越成功的实证）。
  assert.equal(existsSync(dataRoot), false, "非法 id 不得创建任何目录");
});

test("setup() 抛错：记为 failed、load() 仍抛，而失败的实例不会被调 teardown", async (t) => {
  t.after(() => {
    delete globalThis.__p9_setup;
    delete globalThis.__p9_teardown;
  });
  const dir = await makePlugin(
    t,
    `
    export default {
      id: "p9",
      name: "起不来",
      version: "2.0.0",
      setup() {
        globalThis.__p9_setup = (globalThis.__p9_setup ?? 0) + 1;
        throw new Error("缺少一个环境变量");
      },
      teardown() {
        globalThis.__p9_teardown = (globalThis.__p9_teardown ?? 0) + 1;
      },
    };
  `,
  );
  const mgr = makeManager(t);
  await assert.rejects(
    () => mgr.load(dir),
    // 400 而不是 500：磁盘上的一颗插件坏了是「这次没加载成功，原因是…」，
    // 而 `POST /plugins/{id}/reload` 的规格里声明的是 400/401/404，没有 500 这一档。
    (err: unknown) => {
      assert.ok(err instanceof ApiError, `应是 ApiError，实际是 ${String(err)}`);
      assert.equal(err.status, 400);
      assert.match(err.message, /插件 p9 初始化失败/);
      // 包装必须带 cause：不带的话堆栈里就丢了插件原始那一句，排查变成猜。
      assert.ok(err.cause instanceof Error, "必须带上插件抛出的原始错误");
      assert.match(err.cause.message, /缺少一个环境变量/);
      return true;
    },
  );
  assert.equal(globalThis.__p9_setup, 1);
  // 从没构造完的实例不该被宣布存在过：插件作者有理由假设 `teardown()` 至多跑一次、
  // 且只在成功 `setup()` 之后跑。
  assert.equal(globalThis.__p9_teardown, undefined, "失败的实例不该被调 teardown()");

  const [failed] = mgr.list();
  assert.equal(mgr.list().length, 1, "失败记录也要在登记表里，否则操作者看不见");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.enabled, false);
  assert.equal(failed?.id, "p9", "拿到过 id，对外的 id 就该是它（reload 找得回来）");
  assert.match(failed?.error ?? "", /缺少一个环境变量/, "失败原因给操作者");
});

test("模块求值就坏的插件记为 failed，对外的 id 退回目录名", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-plugin-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boom = await makeNamedPlugin(
    t,
    root,
    "boom",
    `
    throw new Error("模块求值就炸");
    export default { id: "boom" };
  `,
  );
  const noid = await makeNamedPlugin(
    t,
    root,
    "noid",
    `
    export default { name: "没有 id 的插件" };
  `,
  );
  const mgr = makeManager(t);

  await assert.rejects(() => mgr.load(boom));
  const [bad1] = mgr.list();
  assert.equal(bad1?.status, "failed");
  assert.equal(bad1?.id, "boom", "没拿到过 id → 用目录名顶上，线协议里没有「没有 id」这个表达");
  assert.equal(bad1?.dir, "boom");

  await assert.rejects(() => mgr.load(noid), /插件缺少 id：目录「noid」/);
  const noidView = mgr.list().find((p) => p.id === "noid");
  assert.equal(noidView?.status, "failed");
  // 消息里是目录名而不是 `resolve()` 之后的绝对路径：操作者按目录名辨认插件，
  // 而这一句还会流经 `list()` → 控制台。
  assert.doesNotMatch(noidView?.error ?? "", /tmp/, "失败原因里不该有绝对路径");
});

test("坏插件不拖垮启动：同一根下 good 是 active、broken 是 failed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-plugin-mixed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginsRoot = join(root, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  await makeNamedPlugin(
    t,
    pluginsRoot,
    "good",
    `export default { id: "good", name: "好的", version: "1", setup() {} };`,
  );
  await makeNamedPlugin(
    t,
    pluginsRoot,
    "broken",
    `export default { id: "broken", name: "坏的", version: "1", setup() { throw new Error("坏了"); } };`,
  );

  // 走 `createApp` 而不是直接 `mgr.load()`：这条用例的真问题是「一颗坏插件会不会让进程
  // 退出 1」，而那只发生在装配链上（`app.ts` → `plugins.loadAll()` → `#scanDir`）。
  const app = await createApp(makeTestConfig({ root, pluginDirs: [pluginsRoot] }));
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const loginRes = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(loginRes.status, 200);
  const [cookie] = (loginRes.headers.get("set-cookie") ?? "").split(";");

  // `?profile=default`：`/plugins` 属于某一份配置档（插件是全局安装的，这份档决定开不开）。
  const res = await fetch(`${origin}/api/v1/plugins?profile=default`, {
    headers: { cookie: cookie ?? "" },
  });
  assert.equal(res.status, 200);
  const { plugins } = (await res.json()) as { plugins: PluginView[] };
  const byId = new Map(plugins.map((p) => [p.id, p]));
  assert.equal(byId.get("good")?.status, "active");
  assert.equal(byId.get("broken")?.status, "failed");
  assert.equal(byId.get("broken")?.enabled, false);
  assert.match(byId.get("broken")?.error ?? "", /坏了/);
});

test("重载失败不再谎报 active：槽位仍是那一个，状态退成 failed", async (t) => {
  // 中途改写 index.js 之所以安全，是因为 `#importFresh` 带 `?v=${++revision}` 绕开 ESM 的
  // 模块缓存；否则读者会怀疑是模块缓存导致的 flake。
  const dir = await makePlugin(
    t,
    `
    export default { id: "pr", name: "会被改坏", version: "1", setup() {} };
  `,
  );
  const mgr = makeManager(t);
  await mgr.load(dir);
  assert.equal(mgr.list()[0]?.status, "active");

  await writeFile(
    join(dir, "index.js"),
    `
    export default { id: "pr", name: "会被改坏", version: "1", setup() { throw new Error("新代码坏了"); } };
  `,
  );
  await assert.rejects(() => mgr.reload("pr"), /新代码坏了/);
  assert.equal(mgr.list().length, 1, "重载不得留下第二个槽位（键是目录）");
  const broken = mgr.list()[0];
  assert.equal(broken?.status, "failed", "旧实例已销毁，记录不能再声称 active");
  assert.equal(broken?.enabled, false);

  await writeFile(
    join(dir, "index.js"),
    `
    export default { id: "pr", name: "会被改坏", version: "1", setup() {} };
  `,
  );
  const back = await mgr.reload("pr");
  assert.equal(back.status, "active");
  assert.equal(back.error, null, "加载成功后失败原因要清掉");
  assert.equal(mgr.list().length, 1);
});

test("failed 记录可卸载、可停用（不隐藏诊断），且不影响 unloadAll 与关停", async (t) => {
  const dir = await makePlugin(
    t,
    `
    export default { id: "pf", name: "起不来", version: "1", setup() { throw new Error("坏了"); } };
  `,
  );
  const mgr = makeManager(t);
  await assert.rejects(() => mgr.load(dir));
  assert.equal(mgr.list()[0]?.status, "failed");

  // 停用一条失败记录：它没有运行期资源可释放，标成 disabled 只会把诊断藏起来。
  const off = await mgr.setEnabled("pf", false);
  assert.equal(off.status, "failed", "failed 不该被改成 disabled");
  assert.match(off.error ?? "", /坏了/, "原因要留着");

  // 卸载它不该 TypeError（`#teardown` 对没构造出来的实例要跳过）。
  await mgr.unload("pf");
  assert.equal(mgr.list().length, 0);

  await assert.rejects(() => mgr.reload("pf"), /未知插件/, "卸载后按 id 找不回来");
  await mgr.unloadAll();
});

test("两个目录声明同一个 id 时，后来那个被拒绝 —— 数据目录不共享", async (t) => {
  const dataRoot = useDataRoot(t);
  const victim = await makePlugin(
    t,
    `
    import { writeFileSync } from "node:fs";
    export default {
      id: "shared",
      name: "受害者",
      version: "1",
      setup(ctx) { writeFileSync(ctx.dataDir + "/secret.json", "受害者的第三方 token"); },
    };
  `,
  );
  const hijacker = await makePlugin(
    t,
    `
    export default { id: "shared", name: "劫持者", version: "1", setup() {} };
  `,
  );
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger(), { dataRoot, ensurePrivateDir });
  await mgr.load(victim);

  // `ctx.dataDir` 的路径就是 `<dataRoot>/<id>`，id 又是插件**自报**的：不拒绝第二次声明，
  // 框架就会把 A 存的 token、缓存与用户数据所在的目录**主动递给** B —— 那正是
  // AGENTS.md「信任边界只有一条：插件」要挡住的那条默认路径（不是插件自己去发现的）。
  await assert.rejects(() => mgr.load(hijacker), /插件 id "shared" 与已加载的插件冲突/);

  assert.equal(mgr.list().length, 2, "被拒的那一颗也要留一条 failed 记录，让操作者看得见");
  assert.equal(mgr.list().filter((p) => p.status === "active").length, 1);
  assert.equal(mgr.list().find((p) => p.name === "劫持者")?.status, "failed");
  // 受害者还活着，没被顶掉。
  assert.equal(mgr.list().find((p) => p.name === "受害者")?.status, "active");
  assert.equal(
    readFileSync(join(dataRoot, "shared", "secret.json"), "utf8"),
    "受害者的第三方 token",
  );

  // 同一个目录重载不受这条拒绝影响（`reload()` 走的就是同目录替换）。
  const again = await mgr.reload("shared");
  assert.equal(again.name, "受害者", "按 id 找到的应该是先登记的那一个");
  assert.equal(again.status, "active");
});

/**
 * R1：跨配置档的**模块身份**隔离。
 *
 * `PluginManager.#revision` 是每个实例各自从 0 开始数的，所以两个管理器扫**同一个安装目录**时
 * 会造出**完全相同**的 `?v=1`。Node 的 ESM 缓存按 URL 键：命中就意味着第二个管理器拿到的
 * 是第一个管理器**已经求值过的那个模块对象**，于是插件的**模块级状态**（`let captured`、
 * 连接池、缓存）由两份配置档共享，而最后一次 `setup(ctx)` 赢者通吃。
 * 症状不是报错，是**写错目录**：A 那份配置档的插件把 token 存进 B 的数据根里。
 *
 * 所以这里的探针要看的不是「两个 `ctx.dataDir` 不同名」（那必然不同名，`dataRoot` 是
 * 各传各的，抓不到这个 bug），而是**A 释放时读到的那份模块级状态属于谁**。
 */
test("两份配置档各求值一次插件模块：模块级状态不跨实例共享", async (t) => {
  delete globalThis.__iso_evals;
  t.after(() => {
    delete globalThis.__iso_evals;
  });
  const install = await mkdtemp(join(tmpdir(), "atri-plugin-install-"));
  await makeNamedPlugin(
    t,
    install,
    "iso",
    `
    import { writeFileSync } from "node:fs";
    // **模块顶层**的计数：只有真的重新求值才会再加一次。
    globalThis.__iso_evals = (globalThis.__iso_evals ?? 0) + 1;
    let captured = null;
    export default {
      id: "iso",
      version: "1",
      setup(ctx) {
        captured = ctx.dataDir;
        // effect 在释放时跑：此刻读到的 captured 是**这个模块实例**的最后一次赋值。
        // 两份配置档共享模块时，A 释放读到的是 B 的目录 —— 那正是「A 的数据写进 B」的形状。
        ctx.effect(() => {
          writeFileSync(captured + "/marker", captured);
        });
      },
    };
  `,
  );
  const dataA = useDataRoot(t);
  const dataB = useDataRoot(t);
  // 两个管理器、同一份安装目录、各自的数据根 —— 这就是多配置档下的常态形状。
  const mgrA = new PluginManager({ pluginDirs: [install] }, silentLogger(), {
    dataRoot: dataA,
    ensurePrivateDir,
  });
  const mgrB = new PluginManager({ pluginDirs: [install] }, silentLogger(), {
    dataRoot: dataB,
    ensurePrivateDir,
  });
  await mgrA.loadAll();
  await mgrB.loadAll();

  assert.equal(
    globalThis.__iso_evals,
    2,
    "同一个插件模块被两个管理器共用了一次求值 —— cache-busting 的 nonce 丢了",
  );

  await mgrA.unloadAll();
  await mgrB.unloadAll();
  const markerA = readFileSync(join(dataA, "iso", "marker"), "utf8");
  const markerB = readFileSync(join(dataB, "iso", "marker"), "utf8");
  assert.equal(markerA, join(dataA, "iso"), "A 那份插件实例写到了别人的数据根");
  assert.equal(markerB, join(dataB, "iso"), "B 那份插件实例写到了别人的数据根");

  // 白名单那条键**没有**被配置档污染：插件看到的 `pluginDirs` 仍是部署级那一份，
  // 两份配置档逐元素相等（安装是全局的，档只决定开不开）。
  assert.deepEqual(mgrA.config, mgrB.config, "两个管理器看到的运行期配置不该不同");
  assert.deepEqual(mgrA.config, { pluginDirs: [install] });
});

/** 启用清单是**每份配置档**的：装一次、各档自己决定开不开，且默认启用。 */
test("配置档的启用清单：默认开，disabledIds 里的那些不跑 setup", async (t) => {
  delete globalThis.__p10_setups;
  t.after(() => {
    delete globalThis.__p10_setups;
  });
  const install = await mkdtemp(join(tmpdir(), "atri-plugin-enable-"));
  await makeNamedPlugin(
    t,
    install,
    "onandoff",
    `
    export default {
      id: "onandoff",
      version: "1",
      setup() { globalThis.__p10_setups = (globalThis.__p10_setups ?? 0) + 1; },
    };
  `,
  );
  const dataRoot = useDataRoot(t);
  const off = new PluginManager({ pluginDirs: [install] }, silentLogger(), {
    dataRoot,
    ensurePrivateDir,
    disabledIds: ["onandoff"],
  });
  await off.loadAll();
  assert.equal(globalThis.__p10_setups, undefined, "被禁用的插件跑到了 setup()");
  // 但仍要**看得见**：操作者要能分辨「没装」与「装了但这份档没开」。
  const view = off.list().find((p) => p.id === "onandoff");
  assert.equal(view?.status, "disabled");
  assert.equal(view?.enabled, false);

  // 重新启用走 `setEnabled`：加载它，并且 `setup()` 这一次要跑。
  const on = await off.setEnabled("onandoff", true);
  assert.equal(on.status, "active");
  assert.equal(globalThis.__p10_setups, 1);
  // 禁用的一条也**不许**留下可释放的东西：`unload()` 不会把 `teardown()` 调给从没 setup 过的实例。
  assert.deepEqual(
    await off.unload("onandoff"),
    { id: "onandoff", unloaded: true },
    "disabled 记录应该可以卸载",
  );
});

/**
 * `ctx.dataDir` 建出来的目录必须是 0700，已存在的宽松权限也要被收紧。
 *
 * 这条是给「注入」这个形状配的：`ensurePrivateDir` 现在是必填参数，忘记传会编译不过，
 * 但**传一个什么都不做的函数**在类型上同样合法 —— 而它的后果是插件存的 token、缓存与
 * 用户数据落在一个 0755 的目录里，且一路没有任何报错。所以行为本身要在真链路上钉一次，
 * 不能只信签名。
 *
 * 起始权限由测试自己 `chmod` 定住，而不是依赖 umask：在 umask 0077 的机器上
 * 「新建目录」本来就是 0700，那样断言会空跑（与 `config.test.ts` 里那条同一个理由）。
 */
test("ctx.dataDir 的目录是 0700，宽松的旧目录也会被收紧", async (t) => {
  const dataRoot = useDataRoot(t);
  const own = join(dataRoot, "pmode");
  mkdirSync(own, { recursive: true });
  chmodSync(own, 0o755);
  assert.equal(statSync(own).mode & 0o777, 0o755, "前提：起始是 0755");

  const plugin = await makePlugin(
    t,
    `
    import { writeFileSync } from "node:fs";
    export default { id: "pmode", setup(ctx) { writeFileSync(ctx.dataDir + "/token.txt", "t"); } };
  `,
  );
  const mgr = new PluginManager({ pluginDirs: [] }, silentLogger(), { dataRoot, ensurePrivateDir });
  await mgr.load(plugin);

  assert.equal(
    statSync(own).mode & 0o777,
    0o700,
    "插件数据目录里可能是 token：保护必须落在目录上，且每次访问都要成立",
  );
  assert.equal(readFileSync(join(own, "token.txt"), "utf8"), "t", "收紧权限不许动内容");
  await mgr.unloadAll();
});
