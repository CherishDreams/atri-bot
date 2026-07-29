/**
 * provider 配置存储的行为契约。
 *
 * 这一层是「界面能改配置」的唯一写入路径，所以测试的重点不是它开心时返回
 * 什么，而是**它在什么情况下必须拒绝**、以及拒绝之后有没有把文件弄脏：
 * 配置文件里有用户的 host / auth 等其它设置，一次失败的写入把它们抹掉
 * 是比「保存不上」严重得多的故障。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  ProviderConfigError,
  ProviderConfigStore,
} from "../src/core/provider/store.js";
import { configFilePath } from "../src/config/file.ts";

/** 建一个临时 root，并在需要时预置一份配置文件。 */
function withRoot(preset) {
  const root = mkdtempSync(join(tmpdir(), "atri-store-"));
  if (preset !== undefined) {
    writeFileSync(configFilePath(root), JSON.stringify(preset, null, 2) + "\n", "utf8");
  }
  return {
    root,
    store: new ProviderConfigStore({ root }, { warn() {}, error() {} }),
    read: () => JSON.parse(readFileSync(configFilePath(root), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withStore(preset, fn) {
  const ctx = withRoot(preset);
  try {
    await fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

// --- 校验：必须拒绝的输入 ---------------------------------------------------

test("校验：id 只允许字母数字点下划线连字符", async () => {
  await withStore({}, ({ store }) => {
    assert.throws(
      () => store.createSource({ id: "有空格 的 id" }),
      (err) => err instanceof ProviderConfigError && err.field === "id" && err.status === 400,
    );
    assert.throws(() => store.createSource({ id: "" }), /必须提供 id/);
  });
});

test("校验：provider 的 id 不能占用保留键 default", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    assert.throws(
      () => store.createProvider({ id: "default", source: "s", model: "m" }),
      /default/,
    );
    // 源没有这个限制：`default` 只作为 providers 的保留键存在。
    assert.doesNotThrow(() => store.createSource({ id: "default" }));
  });
});

test("校验：type 必须是实现得出来的类型", async () => {
  await withStore({}, ({ store }) => {
    assert.throws(() => store.createSource({ id: "s", type: "gemini" }), /openai|anthropic/);
  });
});

test("校验：baseUrl 得是 http/https，空串表示用实现类的默认值", async () => {
  await withStore({}, ({ store }) => {
    assert.throws(() => store.createSource({ id: "s", baseUrl: "不是地址" }), /不是合法的 URL/);
    assert.throws(() => store.createSource({ id: "s2", baseUrl: "ftp://x/v1" }), /http 或 https/);
    assert.doesNotThrow(() => store.createSource({ id: "s3", baseUrl: "" }));
    assert.doesNotThrow(() => store.createSource({ id: "s4", baseUrl: "https://x/v1" }));
  });
});

test("校验：timeoutMs 必须是 1000..600000 之间的整数", async () => {
  await withStore({}, ({ store }) => {
    // 下限防的是 AbortSignal.timeout(0) 那种「一发出就中止」。
    assert.throws(() => store.createSource({ id: "s", timeoutMs: 0 }), /必须在 .* 毫秒之间/);
    assert.throws(() => store.createSource({ id: "s", timeoutMs: MIN_TIMEOUT_MS - 1 }), /毫秒之间/);
    assert.throws(() => store.createSource({ id: "s", timeoutMs: MAX_TIMEOUT_MS + 1 }), /毫秒之间/);
    assert.throws(() => store.createSource({ id: "s", timeoutMs: 1500.5 }), /必须是整数/);
    assert.throws(() => store.createSource({ id: "s", timeoutMs: "3000" }), /必须是整数/);
    assert.doesNotThrow(() => store.createSource({ id: "s", timeoutMs: MIN_TIMEOUT_MS }));
    assert.doesNotThrow(() => store.createSource({ id: "s2", timeoutMs: MAX_TIMEOUT_MS }));
  });
});

test("校验：timeoutMs 缺省时用 120000 而不是留下 undefined", async () => {
  await withStore({}, ({ store }) => {
    const source = store.createSource({ id: "s" });
    assert.equal(source.timeoutMs, 120_000);
    // 落盘的也必须是具体数字：undefined 会被 JSON.stringify 直接删掉，
    // 读回来就成了「没配超时」，与界面显示的值不是一回事。
    assert.equal(store.getSource("s").timeoutMs, 120_000);
  });
});

test("校验：provider 必须有非空的 model", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    assert.throws(() => store.createProvider({ id: "p", source: "s" }), /model/);
    assert.throws(() => store.createProvider({ id: "p", source: "s", model: "  " }), /model/);
  });
});

test("校验：id 重复要被拒绝而不是静默覆盖", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    assert.throws(() => store.createSource({ id: "s" }), /已存在/);
    store.createProvider({ id: "p", source: "s", model: "m" });
    assert.throws(() => store.createProvider({ id: "p", source: "s", model: "m" }), /已存在/);
  });
});

test("校验：引用不存在的源是配置错误（400 而不是 404）", async () => {
  await withStore({}, ({ store }) => {
    assert.throws(
      () => store.createProvider({ id: "p", source: "不存在", model: "m" }),
      (err) => err instanceof ProviderConfigError && err.status === 400,
    );
  });
});

test("校验：update 不存在的东西回 404", async () => {
  await withStore({}, ({ store }) => {
    assert.throws(
      () => store.updateSource("没有这个", { name: "x" }),
      (err) => err instanceof ProviderConfigError && err.status === 404,
    );
    assert.throws(
      () => store.updateProvider("也没有", { name: "x" }),
      (err) => err instanceof ProviderConfigError && err.status === 404,
    );
  });
});

// --- enabled / default 的语义 -----------------------------------------------

test("语义：新建 provider 默认启用", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    // 刻意不继承 AstrBot 的 enabled:false 默认值——否则「配置里明明有、
    // 就是选不到」这种状态很难自查。
    assert.equal(store.createProvider({ id: "p", source: "s", model: "m" }).enabled, true);
    assert.equal(store.getProvider("p").enabled, true);
  });
});

test("语义：name 缺省时取 id，不至于在界面上显示空白", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    assert.equal(store.createSource({ id: "s2" }).name, "s2");
    assert.equal(store.createProvider({ id: "p", source: "s", model: "m" }).name, "p");
  });
});

test("语义：providers 列表不含保留键 default", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p", source: "s", model: "m" });
    store.updateProvider("p", { default: true });
    assert.deepEqual(
      store.providers.map((p) => p.id),
      ["p"],
    );
    assert.equal(store.defaultId, "p");
  });
});

test("语义：删掉默认项要顺手清掉 providers.default", async () => {
  await withStore({}, ({ store, read }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p", source: "s", model: "m" });
    store.updateProvider("p", { default: true });
    store.deleteProvider("p");
    // 不清的话，保留键会指向一个不存在的 id，选路时静默落到第一个 provider，
    // 而用户看到的是「默认项」这个说法，两边对不上。
    assert.equal(store.defaultId, null);
    assert.equal("default" in read().providers, false);
  });
});

test("语义：deleteProvider 返回被删的 id，删不存在的回 404", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p", source: "s", model: "m" });
    assert.deepEqual(store.deleteProvider("p"), { deleted: "p" });
    assert.throws(() => store.deleteProvider("p"), /未找到/);
  });
});

test("语义：不能把保留键 default 当成 provider 来删", async () => {
  await withStore(
    { providers: { p: { type: "openai", models: ["m"] }, default: "p" } },
    ({ store }) => {
      // 保留键不是一个 provider，删它应当被当成「找不到」，而不是把默认项顺手删掉。
      assert.throws(() => store.deleteProvider("default"), /未找到/);
      assert.equal(store.getProvider("p").id, "p");
      assert.equal(store.defaultId, "p");
    },
  );
});

// --- patch 语义 -------------------------------------------------------------

test("patch：只覆盖出现的字段，其余保持原值", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s", baseUrl: "https://a/v1", apiKey: "k", timeoutMs: 5000 });
    store.updateSource("s", { name: "改名" });
    const after = store.getSource("s");
    assert.equal(after.name, "改名");
    assert.equal(after.baseUrl, "https://a/v1");
    assert.equal(after.apiKey, "k");
    assert.equal(after.timeoutMs, 5000);
  });
});

test("patch：源 id 不可改（写了也被忽略，不当成新源）", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.updateSource("s", { id: "换名字" });
    assert.equal(store.getSource("s").id, "s");
    assert.equal(store.sources.length, 1);
  });
});

test("patch：能覆盖 provider 的 model 与 source", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "a" });
    store.createSource({ id: "b" });
    store.createProvider({ id: "p", source: "a", model: "m1" });
    store.updateProvider("p", { model: "m2", source: "b" });
    const after = store.getProvider("p");
    assert.equal(after.model, "m2");
    assert.equal(after.source, "b");
  });
});

test("patch：改成引用不存在的源要拒绝", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "a" });
    store.createProvider({ id: "p", source: "a", model: "m" });
    assert.throws(() => store.updateProvider("p", { source: "不存在" }), /不存在/);
    assert.equal(store.getProvider("p").source, "a");
  });
});

test("patch：把 default 置 false 只对「本来就是默认」的那一项生效", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "a", source: "s", model: "m" });
    store.createProvider({ id: "b", source: "s", model: "m" });
    store.updateProvider("a", { default: true });
    // b 不是默认项，对它写 default:false 不该把 a 的默认身份顶掉。
    store.updateProvider("b", { default: false });
    assert.equal(store.defaultId, "a");
    store.updateProvider("a", { default: false });
    assert.equal(store.defaultId, null);
  });
});

test("patch：未知字段一律忽略，不会漏进配置文件", async () => {
  await withStore({}, ({ store, read }) => {
    store.createSource({ id: "s" });
    store.updateSource("s", { 乱写的: "值", type: "anthropic" });
    assert.equal(store.getSource("s").type, "anthropic");
    assert.equal("乱写的" in read().providerSources.s, false);
  });
});

// --- 删除源的引用保护 -------------------------------------------------------

test("删源：还有 provider 引用时拒绝，并指出是谁在用", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p1", source: "s", model: "m" });
    store.createProvider({ id: "p2", source: "s", model: "m" });

    assert.throws(
      () => store.deleteSource("s"),
      (err) => {
        assert.ok(err instanceof ProviderConfigError);
        assert.equal(err.field, "id");
        // 光说「不能删」没法让用户决定怎么办，得把引用者列出来。
        assert.match(err.message, /p1/);
        assert.match(err.message, /p2/);
        return true;
      },
    );
    assert.equal(store.sources.length, 1);
  });
});

test("删源：cascade 一并删掉引用者并报出被删的 id", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p1", source: "s", model: "m" });
    store.createProvider({ id: "p2", source: "s", model: "m" });

    // 返回的第一项是源自身，后面是被连带删掉的 provider——前端据此提示「删了几个模型」。
    assert.deepEqual(store.deleteSource("s", { cascade: true }), {
      deleted: ["s", "p1", "p2"],
    });
    assert.equal(store.sources.length, 0);
    assert.equal(store.providers.length, 0);
  });
});

test("删源：cascade 时被删的 provider 若是默认项，保留键要清掉", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p", source: "s", model: "m" });
    store.updateProvider("p", { default: true });
    store.deleteSource("s", { cascade: true });
    assert.equal(store.defaultId, null);
  });
});

test("删源：没人引用时直接删", async () => {
  await withStore({}, ({ store }) => {
    store.createSource({ id: "s" });
    assert.deepEqual(store.deleteSource("s"), { deleted: ["s"] });
    assert.equal(store.getSource("s"), null);
  });
});

// --- 落盘：往返与「不破坏其它键」 -------------------------------------------

test("落盘：写进 atri.config.json 后能原样读回", async () => {
  await withStore({}, ({ store, read, root }) => {
    store.createSource({ id: "deepseek", type: "openai", baseUrl: "https://x/v1", apiKey: "sk-1" });
    store.createProvider({ id: "p", source: "deepseek", model: "deepseek-chat" });

    const file = read();
    assert.equal(file.providerSources.deepseek.apiKey, "sk-1");
    assert.equal(file.providers.p.model, "deepseek-chat");

    // 换一个 store 实例读同一份文件，结果应完全一致（这才是「落盘成功」）。
    const fresh = new ProviderConfigStore({ root }, {});
    assert.equal(fresh.getSource("deepseek").apiKey, "sk-1");
  });
});

test("落盘：不改动 host / auth 等其它配置", async () => {
  const preset = {
    host: "0.0.0.0",
    port: 7000,
    auth: { adminUser: "root", adminPassword: "pw" },
    pluginDirs: ["./plugins"],
  };
  await withStore(preset, ({ store, read }) => {
    store.createSource({ id: "s" });
    store.createProvider({ id: "p", source: "s", model: "m" });

    const file = read();
    assert.equal(file.host, "0.0.0.0");
    assert.equal(file.port, 7000);
    assert.deepEqual(file.auth, { adminUser: "root", adminPassword: "pw" });
    assert.deepEqual(file.pluginDirs, ["./plugins"]);
  });
});

test("落盘：写到一半失败不会留下半份配置", async () => {
  await withStore({ providers: { p: { type: "openai", models: ["m"] } } }, ({ store, read }) => {
    const before = JSON.stringify(read());
    // 校验失败发生在 mutate 内部；此时文件必须一个字节都没动。
    assert.throws(() => store.createSource({ id: "坏 id" }));
    assert.equal(JSON.stringify(read()), before);
  });
});

test("落盘：配置文件损坏时拒绝写入，而不是当成空配置覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "atri-store-"));
  try {
    writeFileSync(configFilePath(root), "{ 这不是 JSON", "utf8");
    const store = new ProviderConfigStore({ root }, {});
    assert.throws(() => store.createSource({ id: "s" }), /不是合法 JSON/);
    // 关键：原文件必须原封不动。若被当成空配置写回，用户其它设置就没了。
    assert.equal(readFileSync(configFilePath(root), "utf8"), "{ 这不是 JSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("落盘：注入式配置（没有 root）退化为只读，写操作明确报错", async () => {
  const store = new ProviderConfigStore({ providers: { p: { type: "openai", models: ["m"] } } });
  assert.equal(store.writable, false);
  assert.equal(store.filePath, null);
  // 读得到注入的那份：直接构造 config 的调用方（测试、嵌入式使用）靠这个。
  assert.equal(store.providers.length, 1);
  assert.throws(() => store.createSource({ id: "s" }), /没有落盘位置/);
});
