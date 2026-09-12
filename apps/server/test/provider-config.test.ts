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

import type { Logger } from "#core/logger.ts";
import { ApiError } from "#core/errors.ts";
import type { FileConfig, ProviderEntryConfig, ProviderSourceEntryConfig } from "#config/file.ts";
import {
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  ProviderConfigError,
  ProviderConfigStore,
} from "#core/provider/store.ts";
import type { WriteInput } from "#core/provider/store.ts";
import { configFilePath } from "#config/file.ts";

/** 这些用例断言的是返回值与落盘内容，不看日志（store 只在删掉默认项时 warn 一条）。 */
const quietLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * 落盘文件里 store 会写的那两个键的「已写入」形状。
 *
 * `FileConfig` 的键**全可选**（文件由人手写，任何键都可能缺），照它读 `read()` 的结果会
 * 到处是 `undefined`；而这里的用例读的都是自己刚写进去的那几个 id，所以把它们声明成必有键。
 * 这只描述这几条 fixture，不是在声称运行时一定存在。
 */
interface WrittenFile extends FileConfig {
  providerSources: Record<string, ProviderSourceEntryConfig> & {
    s: ProviderSourceEntryConfig;
    deepseek: ProviderSourceEntryConfig;
  };
  providers: Record<string, ProviderEntryConfig | string> & {
    p: ProviderEntryConfig;
  };
}

/**
 * store 的「读不到就失败」视图。
 *
 * `getSource()` / `getProvider()` 的返回带 `| null`（未知 id 就是 null，「注入式配置退化为
 * 只读」那条用例正专门断言这个 null）。多数用例读的是刚写进去的那条，那一步分支走不到，
 * 于是包一层：读到 null 就明确失败。这样断言不必每处补 `!`，真读不到时报的是「没有这条
 * 记录」，而不是 `Cannot read properties of null`（看不出是被测行为坏了还是 fixture 写错）。
 *
 * 其余方法逐个转发，**不用原型链委托**：`ProviderConfigStore` 的状态在私有字段里
 * （`#root` / `#baseline`），`this` 换成别的对象就读不到，brand 检查会直接 TypeError。
 */
function strictStore(store: ProviderConfigStore) {
  return {
    createSource: (input?: WriteInput) => store.createSource(input),
    updateSource: (id: string, patch?: WriteInput) => store.updateSource(id, patch),
    deleteSource: (id: string, options?: { cascade?: boolean }) => store.deleteSource(id, options),
    createProvider: (input?: WriteInput) => store.createProvider(input),
    updateProvider: (id: string, patch?: WriteInput) => store.updateProvider(id, patch),
    deleteProvider: (id: string) => store.deleteProvider(id),
    get sources() {
      return store.sources;
    },
    get providers() {
      return store.providers;
    },
    get defaultId() {
      return store.defaultId;
    },
    getSource(id: string) {
      const found = store.getSource(id);
      if (!found) throw new Error(`没有 source「${id}」`);
      return found;
    },
    getProvider(id: string) {
      const found = store.getProvider(id);
      if (!found) throw new Error(`没有 provider「${id}」`);
      return found;
    },
  };
}

/** 建一个临时 root，并在需要时预置一份配置文件。 */
function withRoot(preset?: FileConfig) {
  const root = mkdtempSync(join(tmpdir(), "atri-store-"));
  // store 提到外面构造，是因为 `strict` 要包**同一个**实例。构造只存基线、不读盘
  // （读发生在 `#current()`），所以放在写预置文件之前不改变行为。
  const store = new ProviderConfigStore({ filePath: configFilePath(root) }, quietLogger);
  if (preset !== undefined) {
    writeFileSync(configFilePath(root), JSON.stringify(preset, null, 2) + "\n", "utf8");
  }
  return {
    root,
    store,
    strict: strictStore(store),
    // `read()` 是 JSON 边界：解析结果按 `WrittenFile` 认领（见该类型的说明）。
    read: (): WrittenFile => JSON.parse(readFileSync(configFilePath(root), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withStore(
  preset: FileConfig | undefined,
  fn: (ctx: ReturnType<typeof withRoot>) => void,
) {
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
  await withStore({}, ({ strict: store }) => {
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
  await withStore({}, ({ strict: store }) => {
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
    ({ strict: store }) => {
      // 保留键不是一个 provider，删它应当被当成「找不到」，而不是把默认项顺手删掉。
      assert.throws(() => store.deleteProvider("default"), /未找到/);
      assert.equal(store.getProvider("p").id, "p");
      assert.equal(store.defaultId, "p");
    },
  );
});

// --- patch 语义 -------------------------------------------------------------

test("patch：只覆盖出现的字段，其余保持原值", async () => {
  await withStore({}, ({ strict: store }) => {
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
  await withStore({}, ({ strict: store }) => {
    store.createSource({ id: "s" });
    store.updateSource("s", { id: "换名字" });
    assert.equal(store.getSource("s").id, "s");
    assert.equal(store.sources.length, 1);
  });
});

test("patch：能覆盖 provider 的 model 与 source", async () => {
  await withStore({}, ({ strict: store }) => {
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
  await withStore({}, ({ strict: store }) => {
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
  await withStore({}, ({ strict: store, read }) => {
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
    const fresh = strictStore(
      new ProviderConfigStore({ filePath: configFilePath(root) }, quietLogger),
    );
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
  // 记录 error 那一条：store 现在把细节**只**写进日志，所以「细节去哪了」是可证的，
  // 而不是「我们把信息丢了」—— 只断言对外那句固定文案的测试会在有人删掉 logger 调用后照样绿。
  const logged: string[] = [];
  const recordingLogger: Logger = {
    ...quietLogger,
    error(msg: string) {
      logged.push(msg);
    },
  };
  try {
    writeFileSync(configFilePath(root), "{ 这不是 JSON", "utf8");
    const store = new ProviderConfigStore({ filePath: configFilePath(root) }, recordingLogger);
    assert.throws(
      () => store.createSource({ id: "s" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, `应是 ApiError，实际是 ${String(err)}`);
        assert.equal(err.status, 500);
        // 对外一句固定的中文：这句里**不得**有配置文件绝对路径（`errorMessage` 那条原文有）。
        assert.equal(err.message, "保存 provider 配置失败，详情见服务端日志");
        assert.doesNotMatch(err.message, /atri-store|atri\.config\.json/);
        return true;
      },
    );
    assert.match(logged.join("\n"), /不是合法 JSON/, "真实原因必须留在日志里");
    // 关键：原文件必须原封不动。若被当成空配置写回，用户其它设置就没了。
    assert.equal(readFileSync(configFilePath(root), "utf8"), "{ 这不是 JSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("落盘：`filePath: null` 退化为只读内存视图，写操作明确报错", async () => {
  const store = new ProviderConfigStore({
    filePath: null,
    providers: { p: { type: "openai", models: ["m"] } },
  });
  assert.equal(store.writable, false);
  assert.equal(store.filePath, null);
  // 读得到注入的那份：直接构造 config 的调用方（测试、嵌入式使用）靠这个。
  assert.equal(store.providers.length, 1);
  assert.throws(() => store.createSource({ id: "s" }), /没有落盘位置/);
});

test("给了 filePath 就以那个文件为唯一真相：文件不存在即读空，绝不退回注入的 baseline", async () => {
  // 这是多配置档的一条结构性前提。以前 `#current()` 的判据是「文件里有没有 providers /
  // providerSources 键」，没有就退回注入的 baseline —— 于是**还没配过任何模型的配置档 B**
  // 会答出 A 的那一份，而界面上看得到、日志里没有任何异常。
  // 现在规则收成一句：baseline 只在 `filePath` 为 null 时生效。
  const root = mkdtempSync(join(tmpdir(), "atri-store-empty-"));
  try {
    const store = new ProviderConfigStore({
      filePath: configFilePath(root),
      providers: { p: { type: "openai", models: ["m"] } },
      providerSources: { s: { type: "openai" } },
    });
    assert.equal(store.providers.length, 0, "文件不存在时不得读出注入的 provider");
    assert.equal(store.sources.length, 0, "文件不存在时不得读出注入的 source");
    assert.equal(store.writable, true, "有落盘位置就应当可写（只读与否只看 filePath）");
    // 而且第一次写入不会顺手把 baseline 抄进文件（那会让「B 抄 A」换一种形式活下来）。
    store.createSource({ id: "mine", type: "openai", baseUrl: "https://x/v1", apiKey: "sk-1" });
    const written = JSON.parse(readFileSync(configFilePath(root), "utf8"));
    assert.deepEqual(Object.keys(written.providerSources), ["mine"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本类没有任何 async 方法：读-改-写之间不许出现 await", () => {
  // 落盘的安全性质是「`readConfigFileAt` 与 `writeConfigFileAt` 之间不可能被别的请求插进来」，
  // 而这**完全依赖 `node:fs` 是同步 I/O** —— 单线程里一段同步代码不可打断。
  // 一旦有人把某个写方法改成 async（哪怕只是想 `await` 一下别的东西），两次写入就会
  // 各读各写、后者把前者的段落整个抹掉，而两边都回 `201`。
  // 从本阶段起 provider 段与 tools 段住在**同一个配置档文件**里，这条不等式没有别的守护者，
  // 所以由测试守着而不是由注释守着。与 `tool-registry.test.ts` 的同名用例是一对。
  const proto = ProviderConfigStore.prototype as unknown as Record<string, unknown>;
  const asyncNames = Object.getOwnPropertyNames(proto).filter((name) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    return (
      typeof d?.value === "function" &&
      Object.prototype.toString.call(d.value) === "[object AsyncFunction]"
    );
  });
  assert.deepEqual(asyncNames, [], `这些方法不该是 async：${asyncNames.join(", ")}`);
});
