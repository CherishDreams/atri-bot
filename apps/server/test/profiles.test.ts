/**
 * 配置档（profile）的文件层与一次性 seed。
 *
 * 这里证的都是「编译器与单条存储测试都看不见」的那一类：
 * seed 的**幂等性**（跑第二次还把 bootstrap 抄回来，就等于养出两个真源）、
 * 权限落在**目录**上、以及一份坏文件不拖垮别的配置档。
 * 端到端那几条真起 app（`port: 0`、`t.after` 收尾），因为 seed 发生在装配里，
 * 不在 `config/profiles.ts` 里 —— 只测函数会漏掉「调用顺序」这一整类错。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { configFilePath } from "#config/file.ts";
import {
  DEFAULT_PROFILE_ID,
  PROFILE_FILE_NAME,
  assertProfileId,
  listProfileDirs,
  profileConfigPath,
  profileDir,
  profilesRoot,
  readProfileConfig,
  runShapeKeysIn,
  seedProfile,
  writeProfileConfig,
} from "#config/profiles.ts";
import { makeTestConfig } from "./helpers/config.ts";

function tmpRoot(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("id 必须能当目录名用：穿越、大写、分隔符、超长都拒", () => {
  for (const bad of ["", "..", ".", "../evil", "a/b", "默认", "Work", "x".repeat(65)]) {
    assert.throws(() => assertProfileId(bad), /不合法/, `「${bad}」不该被接受为配置档 id`);
  }
  assert.equal(assertProfileId("work-2"), "work-2");
  // 拼接入口同样要拒：`profileDir` 是 `join` 之前唯一的那道闸。
  assert.throws(() => profileDir("/tmp", ".."), /不合法/);
});

test("列目录只认合规的目录，忽略散落的文件与坏名字", (t) => {
  const root = tmpRoot(t, "atri-profiles-ls-");
  const profiles = profilesRoot(root);
  mkdirSync(join(profiles, "work"), { recursive: true });
  mkdirSync(join(profiles, "home"), { recursive: true });
  mkdirSync(join(profiles, "默认"), { recursive: true });
  writeFileSync(join(profiles, "leftover.json"), "{}", "utf8");

  assert.deepEqual(listProfileDirs(profiles), ["home", "work"]);
  // 目录还不存在（首次启动）不是错误：一份配置档都没有。
  assert.deepEqual(listProfileDirs(join(root, "nope")), []);
});

test("seed：把「跑法」四段搬进配置档，部署级段落留在原地", (t) => {
  const root = tmpRoot(t, "atri-profiles-seed-");
  const profiles = profilesRoot(root);
  const moved = seedProfile(profiles, DEFAULT_PROFILE_ID, {
    port: 6185,
    auth: { adminUser: "admin", adminPassword: "pw" },
    providers: { p: { model: "m" } },
    providerSources: { s: { type: "openai" } },
    tools: { current_time: { enabled: true } },
    maxToolSteps: 9,
  });
  assert.deepEqual(moved, ["providers", "providerSources", "tools", "maxToolSteps"]);

  const filePath = profileConfigPath(profiles, DEFAULT_PROFILE_ID);
  assert.ok(filePath.endsWith(join(DEFAULT_PROFILE_ID, PROFILE_FILE_NAME)));
  const profile = readProfileConfig(filePath);
  assert.deepEqual(Object.keys(profile).toSorted(), [
    "maxToolSteps",
    "providerSources",
    "providers",
    "tools",
  ]);
  // 口令与端口**没有**跟过来：配置档不是第二个 `atri.config.json`。
  assert.equal(profile.auth, undefined);
  assert.equal(profile.port, undefined);
});

test("seed 是**一次性**的：配置档已存在时一个字都不动，哪怕 bootstrap 又变了", (t) => {
  const root = tmpRoot(t, "atri-profiles-seedce-");
  const profiles = profilesRoot(root);
  const filePath = profileConfigPath(profiles, DEFAULT_PROFILE_ID);
  writeProfileConfig(filePath, { providers: { mine: { model: "m" } } });
  const before = readFileSync(filePath, "utf8");

  assert.equal(
    seedProfile(profiles, DEFAULT_PROFILE_ID, { providers: { other: { model: "x" } } }),
    null,
    "目标文件已存在时必须什么都不做",
  );
  assert.equal(readFileSync(filePath, "utf8"), before, "seed 第二次运行改到了已有配置档");
});

test("bootstrap 里还留着哪些「跑法」段：空对象与只带部署级段落都算干净", () => {
  assert.deepEqual(runShapeKeysIn({}), []);
  assert.deepEqual(runShapeKeysIn({ port: 6185, auth: { adminUser: "admin" } }), []);
  assert.deepEqual(runShapeKeysIn({ tools: {} }), ["tools"]);
  // 「写了但值是 undefined」不算留着：那是不存在的键，seed 不会搬它，也不该每次启动 warn。
  assert.deepEqual(runShapeKeysIn({ providers: undefined }), []);
});

test("配置档目录收到 0700：先预置宽松权限，再证明它被收紧", (t) => {
  const root = tmpRoot(t, "atri-profiles-mode-");
  const profiles = profilesRoot(root);
  mkdirSync(profiles, { recursive: true, mode: 0o755 });
  const dir = profileDir(profiles, "work");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // 先确认预置真的生效，否则下一条断言只是在测「默认 umask 碰巧是 0700」。
  assert.equal(statSync(dir).mode & 0o777, 0o755, "预置的宽松权限没生效，这条测试是空跑");

  writeProfileConfig(profileConfigPath(profiles, "work"), { name: "工作" });
  assert.equal(statSync(dir).mode & 0o777, 0o700, "写入配置档没有收紧它自己的目录");
});

test("一份配置档坏了不拖垮别的：坏文件只让它自己读不出来", (t) => {
  const root = tmpRoot(t, "atri-profiles-broken-");
  const profiles = profilesRoot(root);
  const good = profileConfigPath(profiles, "good");
  const bad = profileConfigPath(profiles, "bad");
  writeProfileConfig(good, { name: "好的" });
  // 坏文件要**先有目录**再直接写：用 `writeProfileConfig` 就等于让被测函数替我把
  // 「目录已建好、权限已收紧」这两件事做了，那条路径就不是「一份坏文件」而是「一份好文件 + 手工改坏」。
  mkdirSync(profileDir(profiles, "bad"), { recursive: true });
  writeFileSync(bad, "{ 这不是 JSON", "utf8");

  assert.deepEqual(listProfileDirs(profiles), ["bad", "good"]);
  assert.deepEqual(readProfileConfig(good), { name: "好的" });
  // 抛出的那句带着绝对路径 —— 所以它只能进日志或操作者字段，不能原样回给客户端
  // （`provider-routes.test.ts` 有一条专门钉住这一点）。
  assert.throws(() => readProfileConfig(bad), /不是合法 JSON/);
});

/** 起一个真 app，返回它的 root 与配置档文件路径（`dataDir` 显式传，不让 helper 的默认值隐身）。 */
async function runApp(t: TestContext, bootstrap: Record<string, unknown>) {
  const root = tmpRoot(t, "atri-profiles-app-");
  const dataDir = join(root, "data");
  writeFileSync(configFilePath(root), `${JSON.stringify(bootstrap, null, 2)}\n`, "utf8");
  const app = await createApp(makeTestConfig({ root, dataDir }));
  await app.start();
  t.after(() => app.stop());
  return { app, root, profilePath: profileConfigPath(profilesRoot(dataDir), DEFAULT_PROFILE_ID) };
}

test("端到端：首次启动把 bootstrap 的 provider seed 进配置档，之后改 bootstrap 不再有影响", async (t) => {
  const { root, profilePath } = await runApp(t, {
    logLevel: "error",
    auth: { adminUser: "admin", adminPassword: "pw" },
    providerSources: { s: { type: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k" } },
    providers: { p: { source: "s", model: "m" } },
    maxToolSteps: 9,
  });

  // 第一次启动：seed 跑过，配置档里带着那几段；`data/profiles` 与档位目录都是 0700。
  const seeded = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.deepEqual(Object.keys(seeded.providerSources), ["s"]);
  assert.equal(seeded.maxToolSteps, 9);
  assert.equal(statSync(profilesRoot(join(root, "data"))).mode & 0o777, 0o700);

  // 第二次启动同一个 root：把 bootstrap 改成另一套 provider，配置档必须**原样不动**。
  // 这一条是「不删 bootstrap 里的键，但它不再是真源」的全部含义 —— 少了它，
  // 下一次改动就会在两个文件之间来回漂移，而界面上看到的永远是后写的那一个。
  const before = readFileSync(profilePath, "utf8");
  writeFileSync(
    configFilePath(root),
    JSON.stringify({
      logLevel: "error",
      auth: { adminUser: "admin", adminPassword: "pw" },
      providerSources: { other: { type: "openai", baseUrl: "https://x.invalid/v1", apiKey: "k" } },
      providers: { other: { source: "other", model: "z" } },
    }),
  );
  const second = await createApp(
    makeTestConfig({ root, dataDir: join(root, "data"), staticDir: join(root, "nope") }),
  );
  await second.start();
  t.after(() => second.stop());
  assert.equal(readFileSync(profilePath, "utf8"), before, "第二次启动又跑了一遍 seed");
});
