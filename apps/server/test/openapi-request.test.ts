/**
 * openapi.json 的**请求侧与鉴权侧**守卫。
 *
 * 与 `openapi-response-shape.test.ts` 的分工：那个文件管「响应体长什么样」，
 * 这个文件管「规格声明的必填字段代码真的在挡吗」+「闸门与规格对 401 的说法一致吗」。
 * 两者合起来才把「规格可能说谎」这件事盖住 —— 路径级的检查由 `openapi.test.ts` 负责。
 *
 * ## 红了怎么办
 * 改 `apps/server/openapi.json` 或对应实现（`src/api/server.ts` / `src/core/provider/store.ts`），
 * **不要改这个测试**。特别是「省略必填字段竟然没被拒」这条：它意味着有人删了运行时校验，
 * 而规格里还写着 required，前端会以为传空也能被服务端挡住。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "#app.ts";
import { makeTestConfig } from "./helpers/config.ts";

const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8"),
);

/** `POST /auth/login` 之类操作的必填字段（直接读规格，不在这里重抄一遍）。 */
function requiredBodyFields(
  operationId: string,
): { path: string; method: string; required: string[] } | null {
  for (const [path, item] of Object.entries(
    SPEC.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, raw] of Object.entries(item)) {
      const op = raw as {
        operationId?: string;
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      };
      if (op.operationId !== operationId) continue;
      const ref = Object.values(op.requestBody?.content ?? {})[0]?.schema?.$ref;
      if (!ref) return null;
      const name = ref.split("/").pop() as string;
      const required = (SPEC.components.schemas[name] as { required?: string[] }).required;
      if (!required) return null;
      return { path, method: method.toUpperCase(), required };
    }
  }
  return null;
}

interface App {
  origin: string;
  cookie: string;
}

async function start(t: TestContext): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), "atri-openapi-req-"));
  // 必须预置一个真实存在的源：探针是「只省略一个字段」的测试，如果 full 里引用的
  // 源本身不存在，那 400 是「源不存在」给的，model 校验被删掉也照样绿 —— 假绿。
  const app = await createApp(
    makeTestConfig({
      root,
      providerSources: {
        stub: {
          type: "openai",
          name: "stub",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "",
          timeoutMs: 5000,
        },
      },
    }),
  );
  await app.start();
  const origin = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const first = login.headers.getSetCookie()[0];
  if (!first) throw new Error("登录没有拿到 Cookie");
  return { origin, cookie: first.split(";")[0] as string };
}

/** 省略一个必填字段后发请求：规格里写了 required，代码就必须挡成 400。 */
test("规格声明的必填请求字段，实现真的在拒", async (t) => {
  const h = await start(t);
  const session = await (
    await fetch(`${h.origin}/api/v1/sessions`, {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const sessionId = (session as { session: { id: string } }).session.id;
  /** 有些操作的路径里要有真实资源 id。 */
  const paths: Record<string, string> = {
    "/sessions/{id}/messages": `/sessions/${sessionId}/messages`,
    "/sessions/{id}/messages/stream": `/sessions/${sessionId}/messages/stream`,
    // 内置工具由组合根无条件注册，id 是代码里的常量。用假 id 的话，
    // 省略必填得到的 400 是「未知工具」给的，enabled 校验被删也照样绿。
    "/tools/{id}/enable": "/tools/current_time/enable",
  };

  const cases: { operationId: string; full: Record<string, unknown> }[] = [
    { operationId: "login", full: { username: "admin", password: "pw" } },
    { operationId: "sendMessage", full: { content: "你好" } },
    { operationId: "streamMessage", full: { content: "你好" } },
    { operationId: "createProvider", full: { id: "req-probe", source: "stub", model: "m" } },
    { operationId: "createProviderSource", full: { id: "req-probe-src" } },
    { operationId: "setToolEnabled", full: { enabled: true } },
  ];

  for (const { operationId, full } of cases) {
    const spec = requiredBodyFields(operationId);
    assert.ok(spec, `规格里找不到 ${operationId} 的必填 requestBody`);
    for (const drop of spec.required) {
      await t.test(`${operationId} 省略 ${drop}`, async () => {
        const body = { ...full };
        delete body[drop];
        const path = paths[spec.path] ?? spec.path;
        const res = await fetch(`${h.origin}/api/v1${path}`, {
          method: spec.method,
          headers: { cookie: h.cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as Record<string, unknown>;
        assert.equal(
          res.status,
          400,
          `${operationId} 省略了规格里标 required 的 ${drop}，竟然拿到 ${res.status}（打到 ${path}）：` +
            `要么实现的校验被删了，要么规格写错了必填，要么这条路径没有真实资源 id。`,
        );
        assert.deepEqual(Object.keys(json), ["error"], `400 的响应体必须是 { error } 形状`);
        assert.equal(typeof json.error, "string");
      });
    }
  }
});

/** 畸形 JSON：规格里这些操作声明了 400，实现不能把它冒成 500。 */
test("畸形请求体回 400 而不是 500", async (t) => {
  const h = await start(t);
  const ops: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(
    SPEC.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, raw] of Object.entries(item)) {
      const op = raw as { requestBody?: unknown; responses?: Record<string, unknown> };
      if (!op.requestBody || !op.responses?.["400"]) continue;
      ops.push({ method: method.toUpperCase(), path });
    }
  }
  assert.ok(
    ops.length >= 8,
    `带 requestBody 且声明 400 的操作只剩 ${ops.length} 个，规格是不是被动过了？`,
  );
  for (const { method, path } of ops.toSorted((a, b) => a.path.localeCompare(b.path))) {
    await t.test(`${method} ${path}`, async () => {
      // 路径里的 {id} 用假值即可：畸形 JSON 的判定发生在查库之前。
      const url = `${h.origin}/api/v1${path.replace("{id}", "does-not-exist")}`;
      const res = await fetch(url, {
        method,
        headers: { cookie: h.cookie, "content-type": "application/json" },
        body: "{这不是 JSON",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      assert.equal(res.status, 400, `${method} ${path} 的畸形 JSON 应当是 400，实际 ${res.status}`);
      assert.deepEqual(Object.keys(body), ["error"], "错误体必须是 { error }，不能夹带内部细节");
    });
  }
});

/**
 * 鉴权闸门与规格的双向核对：
 * - 真实路由里凡是**不**在公开表里的，匿名访问必须是 401（安全：新增路由默认受保护）；
 * - 反过来，规格里那个 operation 必须声明 401（否则前端 SDK 不知道要处理未登录分支）。
 */
test("匿名访问：闸门拒掉的与规格声明的 401 完全一致", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-openapi-401-"));
  const app = await createApp(makeTestConfig({ root }));
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  // 与 src/api/server.ts 的 PUBLIC_PATHS 同一份清单：那 4 条必须免鉴权，
  // 否则前端连「要不要登录」都问不到。
  const publicPaths = new Set([
    "/api/v1/health",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/status",
  ]);

  const undeclared: string[] = [];
  for (const { method, pattern } of app.routes()) {
    if (publicPaths.has(pattern)) continue;
    const res = await fetch(`${origin}${pattern.replace(/:id/g, "probe")}`, { method });
    if (res.status !== 401) {
      undeclared.push(`${method} ${pattern} → 匿名可访问（实际 ${res.status}）`);
      continue;
    }
    const specPath = pattern.replace(/^\/api\/v1/, "").replace(/:id/g, "{id}");
    const op = (
      SPEC.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>
    )[specPath]?.[method.toLowerCase()];
    if (!op?.responses?.["401"])
      undeclared.push(`${method} ${pattern}：闸门拒了，但规格里没声明 401`);
  }
  assert.deepEqual(
    undeclared,
    [],
    `鉴权与规格不一致：\n${undeclared.join("\n")}\n红了怎么办：改 openapi.json 补 401，或把新路由加进 PUBLIC_PATHS 并说明理由。`,
  );
});
