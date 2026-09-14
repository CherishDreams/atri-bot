/**
 * 适配器与配置档的**绑定**。
 *
 * 这一层要证的只有一件事的两种写法：绑不到就不启动，还是换一个跑跑看。
 * 本仓选前者，理由是这类错误没有症状 —— 平台侧的流量持续进来、服务一切正常，
 * 只有「这个平台其实用的是另一套模型」这一件事没人知道。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterInfo } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import { AdapterManager, type Adapter, type AdapterTarget } from "#adapters/manager.ts";

function silentLogger(lines: string[]): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error: (msg: string) => lines.push(msg),
  };
}

/** 记一次 `start()` 被调过的适配器桩。 */
function stubAdapter(name: string, started: string[], fail = false): Adapter {
  return {
    name,
    start() {
      if (fail) throw new Error("端口被占");
      started.push(name);
    },
  };
}

function manager(opts: {
  adapters: Record<string, { enabled?: boolean; profile?: string }>;
  available?: string[];
  lines: string[];
}): { mgr: AdapterManager; asked: string[] } {
  const asked: string[] = [];
  const available = new Set(opts.available ?? []);
  const mgr = new AdapterManager({
    config: { adapters: opts.adapters },
    logger: silentLogger(opts.lines),
    resolveProfile: (id): AdapterTarget | null => {
      asked.push(id);
      return available.has(id) ? ({ engine: {} } as unknown as AdapterTarget) : null;
    },
  });
  return { mgr, asked };
}

test("绑定可用才启动：没写 profile 与写了但档不可用，各自说得清", async () => {
  const started: string[] = [];
  const lines: string[] = [];
  const { mgr, asked } = manager({
    adapters: { unbound: {}, ghost: { profile: "nope" }, ok: { profile: "default" } },
    available: ["default"],
    lines,
  });
  mgr.register("unbound", stubAdapter("unbound", started));
  mgr.register("ghost", stubAdapter("ghost", started));
  mgr.register("ok", stubAdapter("ok", started));
  await mgr.startAll();

  assert.deepEqual(started, ["ok"], "只有绑定可用的那个该启动");
  assert.equal(
    lines.filter((l) => l.includes("unbound") && /没绑定配置档/.test(l)).length,
    1,
    "缺绑定要单独报一条，而不是与「档不可用」混成一句",
  );
  assert.equal(lines.filter((l) => l.includes("ghost") && /nope/.test(l)).length, 1);
  // 没写 profile 时根本不该去问解析器（那会掩盖「其实没人给我绑」这个原因）。
  assert.deepEqual(asked, ["nope", "default"]);
});

test("不静默改绑：绑不到就是不动，绝不退回 default 或第一个档", async () => {
  const started: string[] = [];
  const lines: string[] = [];
  const { mgr } = manager({
    adapters: { webhook: { profile: "typo-default" } },
    available: ["default"],
    lines,
  });
  mgr.register("webhook", stubAdapter("webhook", started));
  await mgr.startAll();
  assert.deepEqual(started, [], "拼错的档名不能被当成「那就是要 default」");
  assert.equal(lines.length, 1);
});

test("启用的判据仍是 `!== false`，但关掉的那个连绑定都不去解析", async () => {
  const started: string[] = [];
  const lines: string[] = [];
  const { mgr, asked } = manager({
    adapters: { off: { enabled: false, profile: "gone" } },
    available: [],
    lines,
  });
  mgr.register("off", stubAdapter("off", started));
  await mgr.startAll();
  assert.deepEqual(started, []);
  assert.deepEqual(asked, [], "已经关掉的适配器不该去问它的档存在吗");
  assert.deepEqual(lines, [], "关掉不是错误，不该报一条 error");
});

test("单个适配器 start() 抛错只记一条，其余照启", async () => {
  const started: string[] = [];
  const lines: string[] = [];
  const { mgr } = manager({
    adapters: { bad: { profile: "default" }, good: { profile: "default" } },
    available: ["default"],
    lines,
  });
  mgr.register("bad", stubAdapter("bad", started, true));
  mgr.register("good", stubAdapter("good", started));
  await mgr.startAll();
  assert.deepEqual(started, ["good"], "一个平台端口被占不该让另一个平台也收不到流量");
  assert.equal(lines.filter((l) => l.includes("bad") && l.includes("端口被占")).length, 1);
});

test("list() 把「已启用」与「绑定可用」分成两项报", () => {
  const lines: string[] = [];
  const { mgr } = manager({
    adapters: { a: { profile: "default" }, b: { profile: "gone" }, c: {} },
    available: ["default"],
    lines,
  });
  mgr.register("a", { start() {} });
  mgr.register("b", { start() {} });
  mgr.register("c", { start() {} });
  const byId = new Map<string, AdapterInfo>(mgr.list().map((x) => [x.id, x]));
  assert.deepEqual(
    [byId.get("a"), byId.get("b"), byId.get("c")].map((x) => [x?.enabled, x?.profile, x?.bound]),
    [
      [true, "default", true],
      [true, "gone", false],
      [true, null, false],
    ],
  );
});

// 这一层的**组合根接线**（`app.ts` 里那条 `resolveProfile: (id) => profiles.get(id)?.engine`）
// 今天没有端到端测试，原因要说清而不是假装覆盖：仓库里还没有任何适配器实现
//（`register()` 无调用方），所以外部没法把一个真适配器塞进运行中的 app 去观察它启没启。
// 上面那几条用的是注入的解析器，它们证得到启动规则，证不到「app.ts 把线接对了」。
// 第一个真适配器落地时要补的就是这一条：经 `createApp` 起服务、绑定一份存在的档与一份不存在的档，
// 看 `GET /adapters` 的 `bound` 一真一假。在那之前留一个断言空数组的用例只会让这里看起来已被覆盖。
