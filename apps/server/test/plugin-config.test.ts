import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, pluginRuntimeConfig } from "#plugins/manager.ts";
import { createApp } from "#app.ts";
import type { AppConfig } from "#config/index.ts";
import { DEFAULT_PROFILE_ID, profileConfigPath, profilesRoot } from "#config/profiles.ts";
import type { Logger } from "#core/logger.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 守住「插件看不到整份运行期配置」这条边界（见 `docs/architecture.md` 的插件章节）。
 *
 * 探针挂在 `globalThis` 上：插件是同进程被动态 `import()` 进来的，所以插件代码能把它
 * 实际看到的东西直接交回测试。与 `plugins.test.ts` 同样的理由逐个声明类型、
 * 不给 `globalThis` 开索引签名 —— 探针名拼错必须报错，而不是静默变成 `undefined`。
 */
declare global {
  /** 工厂写法里 `shared.config` 的键。 */
  var __sharedKeys: string[] | undefined;
  /** `setup(ctx)` 里 `ctx.config` 的**整个对象**：用 deepEqual 比对，多一条键就红。 */
  var __ctxConfig: Record<string, unknown> | undefined;
}

const ADMIN_PASSWORD = "口令-绝不该出现在插件里";
const API_KEY = "sk-密钥-绝不该出现在插件里";

/** 往 `pluginsRoot` 下写一个插件目录（`loadAll` 按目录扫描，所以每个插件一个子目录）。 */
async function writePlugin(pluginsRoot: string, name: string, source: string): Promise<void> {
  const dir = join(pluginsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), source, "utf8");
}

/**
 * 两个探针插件：工厂写法看 `shared.config`，`setup` 看 `ctx.config`。
 * `probe-ctx` 故意声明一条与运行期同名的 `pluginDirs`，用来钉住既有的合并方向
 * （插件的键优先，且只改写它自己那份副本）；`greeting` 是它自己的键，必须仍然可见。
 */
async function makeProbePlugins(pluginsRoot: string): Promise<void> {
  await writePlugin(
    pluginsRoot,
    "probe-shared",
    `export default (shared) => {
       globalThis.__sharedKeys = Object.keys(shared.config).sort();
       return { id: "probe-shared", setup() {} };
     };
     `,
  );
  await writePlugin(
    pluginsRoot,
    "probe-ctx",
    `export default {
       id: "probe-ctx",
       config: { greeting: "你好", pluginDirs: ["插件自己声明的"] },
       setup(ctx) {
         globalThis.__ctxConfig = ctx.config;
       },
     };
     `,
  );
}

/**
 * 每个可能泄漏的键都填上真值：投影挡不住哪一个，下面的断言就会撞上哪一个。
 *
 * 两类秘密现在住在**两个地方**，所以守卫也分两处：口令在 `AppConfig` 里（部署级），
 * apiKey 在配置档文件里（`profiles/default/config.json`，由 `createApp` 从 bootstrap
 * seed 出来）。后者尤其要证 —— 「插件看不到密钥」如果只在内存对象上成立，
 * 那么下一次有人图省事把配置文件整个递给它，这条边界就没了。
 */
function configWithSecrets(root: string, pluginDirs: string[]): AppConfig {
  return makeTestConfig({
    root,
    pluginDirs,
    adminPassword: ADMIN_PASSWORD,
    providerSources: {
      leak: {
        type: "openai",
        name: "带密钥的源",
        baseUrl: "https://example.invalid/v1",
        apiKey: API_KEY,
        timeoutMs: 5000,
      },
    },
    providers: { leak: { source: "leak", model: "m" } },
  });
}

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("插件只看到白名单里的运行期配置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-plugin-config-"));
  const pluginsRoot = join(root, "plugins");
  await makeProbePlugins(pluginsRoot);
  delete globalThis.__sharedKeys;
  delete globalThis.__ctxConfig;

  const config = configWithSecrets(root, [pluginsRoot]);
  const app = await createApp(config);
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(globalThis.__sharedKeys, ["pluginDirs"]);
  assert.deepEqual(globalThis.__ctxConfig, {
    pluginDirs: ["插件自己声明的"],
    greeting: "你好",
  });

  // 这两句是为了让上面那两条不能假绿：口令与 apiKey 必须真的在这个部署里存在着，
  // 否则「插件没看到秘密」就成了在空输入上证明的一句空话。
  const configDump = JSON.stringify(config);
  assert.ok(configDump.includes(ADMIN_PASSWORD), "测试配置里没带上口令，守卫失去意义");
  const profileDump = readFileSync(
    profileConfigPath(profilesRoot(config.dataDir), DEFAULT_PROFILE_ID),
    "utf8",
  );
  assert.ok(profileDump.includes(API_KEY), "配置档文件里没带上 apiKey，守卫失去意义");
  const pluginDump = JSON.stringify(globalThis.__ctxConfig);
  assert.ok(!pluginDump.includes(ADMIN_PASSWORD), "口令泄漏到了 ctx.config");
  assert.ok(!pluginDump.includes(API_KEY), "apiKey 泄漏到了 ctx.config");
});

test("插件声明的同名键只改写它自己那份副本", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atri-plugin-view-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginsRoot = join(root, "plugins");
  await makeProbePlugins(pluginsRoot);
  delete globalThis.__ctxConfig;

  const config = configWithSecrets(root, [pluginsRoot]);
  const view = pluginRuntimeConfig(config);
  // 视图里的数组必须是副本：共享同一个数组的话，插件一次 `push` 就改到了运行期配置本体。
  view.pluginDirs.push("插件的写入");
  assert.deepEqual(config.pluginDirs, [pluginsRoot], "视图与运行期配置共享了数组");

  // `dataRoot` 与 `config` 是两个参数不是偶然：这条用例证的正是「插件只看到白名单那一份」，
  // 而 dataRoot 只进框架内部、连视图都不给（`ctx.dataDir` 才是插件能碰到的那一个目录）。
  const mgr = new PluginManager(pluginRuntimeConfig(config), silentLogger(), {
    dataRoot: join(config.dataDir, "plugins"),
  });
  await mgr.loadAll();
  assert.deepEqual(
    mgr
      .list()
      .map((p) => p.id)
      .toSorted(),
    ["probe-ctx", "probe-shared"],
  );
  // `probe-ctx` 声明了 `pluginDirs: ["插件自己声明的"]`，管理器用来扫描的那份不能跟着变，
  // 否则一个插件就能改写所有后续插件看到的运行期配置。
  assert.deepEqual(mgr.config, { pluginDirs: [pluginsRoot] });
  assert.deepEqual(globalThis.__ctxConfig, {
    pluginDirs: ["插件自己声明的"],
    greeting: "你好",
  });
});
