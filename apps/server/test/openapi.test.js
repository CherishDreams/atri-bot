import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

/**
 * `apps/server/openapi.json` 是手写的规格，前端 SDK 由它生成。
 *
 * 这里比对**真实注册的路由**与规格里的路径，因为代码 → 规格这一跳没人守着：
 * 生成物与规格永远一致，`codegen:check` 发现不了「新增了端点但忘了写进规格」。
 * 结果是前端 SDK 少一个方法，而且要到调用时才报错。
 */

const SPEC_PATH = fileURLToPath(new URL("../openapi.json", import.meta.url));

/** 把 `/sessions/{id}/messages` 归一成 `/sessions/:id/messages`，与路由模式同形。 */
function normalizeSpecPath(path) {
  return path.replace(/\{([^}]+)\}/g, ":_$1");
}

/** 把路由模式归一成同一个形状，好做集合比较。 */
function normalizeRoutePath(pattern) {
  return pattern.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, ":_$1");
}

function specOperations(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      // 路径项里除 HTTP 方法外还可能有 parameters/summary 等键，只取方法。
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      ops.push(`${method.toUpperCase()} ${normalizeSpecPath(path)}`);
    }
  }
  return ops.toSorted();
}

function routeOperations(app) {
  return app
    .routes()
    .map(({ method, pattern }) => `${method} ${normalizeRoutePath(pattern)}`)
    .toSorted();
}

test("openapi.json 覆盖了所有真实注册的 API 路由，且没有多写的路径", async (t) => {
  const config = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    dataDir: fileURLToPath(new URL("../.tmp-openapi-test", import.meta.url)),
    pluginDirs: [],
    adapters: {},
    providers: {},
    auth: { adminUser: "admin", adminPassword: "test-password", cookieName: "atri_session" },
  };

  const app = await createApp(config);
  t.after(() => app.stop());

  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
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
