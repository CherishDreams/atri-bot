import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER_PORT } from "@atri/shared";
import { loadConfig } from "#config/index.ts";
import { configFilePath } from "#config/file.ts";

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
