import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER_PORT } from "@atri/shared";
import { loadConfig } from "#config/index.ts";
import { configFilePath, writeConfigFileAt } from "#config/file.ts";

/**
 * `loadConfig()` 的**失败语义**。
 *
 * 这个文件以前不存在，因为 `loadConfig()` 从未被直接测过 —— 而它正是「同一个配置文件
 * 有两套读法」的地方：它自己 `existsSync` + `JSON.parse`，少掉了 `readConfigFile()`
 * 的「顶层必须是对象」那一条。后果是一个内容为 `[]` 的文件能顺利启动（每个键都退化成
 * 内置默认），等到控制台第一次保存时才由 `updateConfigFile()` 抛出那句话。
 * 两处读法收成一处之后，检查在启动时就生效，这里把它钉住。
 */

/**
 * `loadConfig()` 会读的环境变量。列出来不是因为它们参与被测行为，恰恰相反：
 * 环境变量优先级**高于**配置文件，测试环境里残留一条 `ATRI_PORT` 就会让断言证的
 * 不再是「文件解析」而是「某台机器的 shell 配置」。
 */
const CONFIG_ENV_KEYS = [
  "ATRI_ROOT",
  "ATRI_HOST",
  "ATRI_PORT",
  "ATRI_LOG_LEVEL",
  "ATRI_DATA_DIR",
] as const;

/**
 * 建一个临时 root，写一份内容为 `contents` 的配置文件（省略则**不写**这个文件），
 * 并把 `ATRI_ROOT` 指到它；收尾时还原环境变量、删掉目录。
 */
function withRoot(t: TestContext, contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "atri-config-"));
  const saved: Record<string, string | undefined> = {};
  for (const key of CONFIG_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ATRI_ROOT = root;
  t.after(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  if (contents !== undefined) writeFileSync(configFilePath(root), contents, "utf8");
  return root;
}

test("顶层不是对象的配置文件：启动即失败", (t) => {
  withRoot(t, "[]");
  // 正则取的是 `readConfigFile()` 的原话，不是「抛了个错」——兜底 catch 也会抛错，
  // 那样这条测试就证不到「顶层形状」这一层。
  assert.throws(() => loadConfig(), /顶层必须是对象/);
});

test("不是合法 JSON 的配置文件：启动即失败，并带上原因", (t) => {
  withRoot(t, "{ 这不是 JSON");
  assert.throws(() => loadConfig(), /不是合法 JSON/);
});

test("合法配置文件照常解析", (t) => {
  // 反面守卫：前两条把坏文件钉成硬失败，很容易顺手把读取改成「一律抛」而全绿。
  const root = withRoot(t, JSON.stringify({ port: 6185, logLevel: "warn" }));
  const config = loadConfig();
  assert.equal(config.port, 6185);
  assert.equal(config.logLevel, "warn");
  assert.equal(config.root, root);
});

test("没有配置文件时走内置默认，而不是报错", (t) => {
  // 首次启动就是这个形状（`README` 的「首次启动会生成管理员口令」依赖它跑得起来），
  // 所以「文件不存在」与「文件是坏的」必须是两种结果。
  withRoot(t);
  assert.equal(loadConfig().port, DEFAULT_SERVER_PORT);
});

/**
 * 默认 root 锚在**仓库根**，不锚在进程 cwd。
 *
 * 这条是本文件里唯一测「默认值从哪来」的用例，因为那个默认值曾经是 `process.cwd()`，
 * 而 `dev`/`start` 都经 `pnpm --filter` 执行、cwd 是 `apps/server/`。两者一错开，
 * 同一个部署就在仓库根与 `apps/server/` 各长出一份 `atri.config.json` 和一个 `data/`
 * （两份互不可见的对话库），而 `staticDir` 的默认值被解析成 `apps/server/apps/dashboard/dist`
 * （不存在）—— `pnpm build && pnpm start` 的单进程托管整站 404。
 */
test("未设 ATRI_ROOT 时，root 是仓库根而不是进程 cwd", (t) => {
  const savedRoot = process.env.ATRI_ROOT;
  delete process.env.ATRI_ROOT;
  // 故意跳到一个**不是**仓库根、也不含配置文件的目录：只要默认值还读 cwd，
  // 断言里拿到的就是它，这条立刻红。
  const outside = mkdtempSync(join(tmpdir(), "atri-root-"));
  const previousCwd = process.cwd();
  process.chdir(outside);
  t.after(() => {
    // 顺序要紧：先把 cwd 换回去再删目录，`rmSync` 删不掉进程正站在里面的目录。
    process.chdir(previousCwd);
    if (savedRoot === undefined) delete process.env.ATRI_ROOT;
    else process.env.ATRI_ROOT = savedRoot;
    rmSync(outside, { recursive: true, force: true });
  });

  const config = loadConfig();
  // 本文件在 `<仓库根>/apps/server/test/`，往上三层就是仓库根（与 `DEFAULT_ROOT` 各走一遍，
  // 两个数只有「锚在仓库根」同时成立才会相等）。
  assert.equal(config.root, resolve(fileURLToPath(new URL("../../../", import.meta.url))));
  assert.notEqual(config.root, outside, "root 不该跟着启动目录跑");
});

/**
 * `writeConfigFileAt()` 的**落盘**语义（读的那几条在上面）。
 *
 * 这里的判据是「一次失败的写不许留下任何可被误读成配置的东西」：实现是先写同目录的
 * `.tmp` 再 rename，而坏配置的既定语义是「启动即失败」，所以半截文件与残留的 `.tmp`
 * 都是会把一份配置档永久锁死在 failed 的东西。
 */
test("写不进去时，原来那份完整配置必须原样还在", (t) => {
  // 这条才是对「截断后重写」真正有判别力的一条。做法是把临时文件的路径**占成目录**：
  // 于是失败发生在「还没碰过目标文件」的时候 —— 旧实现是直接 `writeFileSync(filePath)`，
  // 它会先把目标截断再报错，留下一份半截/空的 JSON；新实现必须让目标一字不动。
  // （拿目录冒充是很便宜的注入点：不需要磁盘写满，也不需要 kill 进程。）
  const dir = mkdtempSync(join(tmpdir(), "atri-write-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "atri.config.json");
  writeConfigFileAt(filePath, { port: 6185, logLevel: "info" });
  const blocker = `${filePath}.tmp`;
  mkdirSync(blocker);

  assert.throws(() => writeConfigFileAt(filePath, { port: 7000 }), /写入 .* 失败/);

  assert.deepEqual(
    JSON.parse(readFileSync(filePath, "utf8")),
    { port: 6185, logLevel: "info" },
    "失败的写不许改动已经躺在磁盘上的那一份",
  );
  rmSync(blocker, { recursive: true, force: true });
});

test("写失败在 rename 阶段：不留半截目标文件，也不把 .tmp 落在目录里", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atri-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "atri.config.json");
  // 拿**目录**冒充目标文件：`writeFileSync(tmp)` 会成功，`rename(tmp → 目录)` 必失败，
  // 于是能确定性地走到「tmp 已经写出来之后才失败」那一支 —— 这正是残留会被看见的时刻。
  mkdirSync(filePath);

  assert.throws(() => writeConfigFileAt(filePath, { port: 6185 }), /写入 .* 失败/);

  assert.equal(existsSync(`${filePath}.tmp`), false, "临时文件必须被清掉");
  assert.equal(statSync(filePath).isDirectory(), true, "失败不许动到原来那个占位");
});

test("成功的写也不留下 .tmp，且原文件内容是完整的一份 JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atri-write-ok-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "atri.config.json");

  writeConfigFileAt(filePath, { port: 6185, dataDir: "data" });

  assert.equal(existsSync(`${filePath}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { port: 6185, dataDir: "data" });
});

test("已存在的 0644 配置文件，被写过一次之后就收紧成 0600", (t) => {
  // rename 换掉的是目录项，所以最终文件的权限来自那个以 `mode: 0o600` 创建的临时文件。
  // 这条钉住的是**升级路径**：老部署的 `atri.config.json` 里既有口令也可能有残留的明文
  // `apiKey`，而它可能是 0644 —— 一次保存就该把它带进 0600，不需要等某个专门的修复动作。
  const dir = mkdtempSync(join(tmpdir(), "atri-write-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, "atri.config.json");
  writeFileSync(filePath, '{"port":6185}\n', { mode: 0o644 });
  chmodSync(filePath, 0o644); // mode 只在创建时生效，这里显式定住前提
  assert.equal(statSync(filePath).mode & 0o777, 0o644, "前提：起始是 0644");

  writeConfigFileAt(filePath, { port: 6185 });

  assert.equal(statSync(filePath).mode & 0o777, 0o600, "写过一次之后必须不再是别人可读的");
});
