import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * `apps/server/openapi.json` 是手写的规格，前端 SDK 由它生成。
 *
 * 这里比对**真实注册的路由**与规格里的路径，因为代码 → 规格这一跳没人守着：
 * 生成物与规格永远一致，`codegen:check` 发现不了「新增了端点但忘了写进规格」。
 * 结果是前端 SDK 少一个方法，而且要到调用时才报错。
 */

const SPEC_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));

/**
 * 本文件要用到的那一小块 OpenAPI 形状。
 *
 * 刻意写得只到「路径 × 方法」这一层：这条用例只做集合比对，`paths` 下每个条目
 * （Path Item）的值一概不看。规格是手写的，给它配一个完整的 OpenAPI 类型是另一件事，
 * 不是这里的职责——写宽了反而会让「规格里多写了别的键」变成类型错误而不是断言失败。
 */
interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

/** `createApp` 的产物中本文件用到的那一角：真实注册的路由表（见 `api/router.ts` 的 `routes`）。 */
interface AppWithRoutes {
  routes(): Array<{ method: string; pattern: string }>;
}

/** 把 `/sessions/{id}/messages` 归一成 `/sessions/:id/messages`，与路由模式同形。 */
function normalizeSpecPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":_$1");
}

/** 把路由模式归一成同一个形状，好做集合比较。 */
function normalizeRoutePath(pattern: string): string {
  return pattern.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, ":_$1");
}

function specOperations(spec: OpenApiSpec): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      // 路径项里除 HTTP 方法外还可能有 parameters/summary 等键，只取方法。
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      ops.push(`${method.toUpperCase()} ${normalizeSpecPath(path)}`);
    }
  }
  return ops.toSorted();
}

function routeOperations(app: AppWithRoutes): string[] {
  return app
    .routes()
    .map(({ method, pattern }) => `${method} ${normalizeRoutePath(pattern)}`)
    .toSorted();
}

test("openapi.json 覆盖了所有真实注册的 API 路由，且没有多写的路径", async (t) => {
  // 这里**必须**带上 `root`（`AppConfig` 的必填键，`createApp` 要求完整配置），
  // 而这条用例刻意不写 `root` 是有原因的：provider 存储由此进入只读模式。
  // 换成一个空的临时目录后行为等价，理由是全程不发生任何写入——
  // `adminPassword` 已给定，所以 `auth.init()` 不落盘；`pluginDirs: []`；没有适配器；
  // 而且这里只调 `app.routes()`（HTTP 服务根本没 listen），一次请求都不发。
  // 唯一会被读到的地方是 `ProviderConfigStore.#current()`：它读不到 `<root>/atri.config.json`
  // 就退回构造时注入的 baseline，而 baseline 与只读模式下用的是同一份 `{providers,
  // providerSources}`（都来自这里传进去的空对象），所以两条路径给出同一个结果。
  const root = mkdtempSync(join(tmpdir(), "atri-openapi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 共享 fixture 的默认值与本用例迁移前手抄的那份逐项相同（host / port 0 / logLevel /
  // pluginDirs / adapters / providers / cookieName / cookieSecure）；`dataDir` 与 `staticDir`
  // 全程没人读（见上一条注释：不发生任何写入，也不发请求），所以取 fixture 的默认值。
  const config = makeTestConfig({ root, adminPassword: "test-password" });

  const app = await createApp(config);
  t.after(() => app.stop());

  // 边界收窄：`JSON.parse` 的返回是 `any`，规格的形状只由 `OpenApiSpec` 声明的
  // 那一角把关（键名与 Path Item 的「方法键」），其余键一概不看。
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiSpec;
  const inSpec = specOperations(spec);
  const inCode = routeOperations(app);

  const missingFromSpec = inCode.filter((op) => !inSpec.includes(op));
  assert.deepEqual(
    missingFromSpec,
    [],
    `这些路由存在于代码中但不在 openapi.json 里，前端 SDK 会缺少对应方法:\n${missingFromSpec.join("\n")}`,
  );

  const staleInSpec = inSpec.filter((op) => !inCode.includes(op));
  assert.deepEqual(
    staleInSpec,
    [],
    `openapi.json 里有这些路径，但代码中已不存在（规格过期了）:\n${staleInSpec.join("\n")}`,
  );
});
