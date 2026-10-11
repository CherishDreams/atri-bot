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

/**
 * 规格里「带 requestBody 且声明了 400」的全部操作。
 *
 * 提成一处是因为有两条用例都要它：畸形 **语法** 与非对象 **形状** 走的是同一批端点，
 * 而两边的判据应该一样硬（少一处就是漏测）。列端点这件事本身由规格给，不在测试里重抄，
 * 否则新增一个接受 body 的端点就又是靠人记得。
 */
function bodyOperations(): { method: string; path: string }[] {
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
  return ops;
}

/** 畸形 JSON：规格里这些操作声明了 400，实现不能把它冒成 500。 */
test("畸形请求体回 400 而不是 500", async (t) => {
  const h = await start(t);
  const ops = bodyOperations();
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
 * 「合法 JSON 但不是对象」也一样要 400。
 *
 * `readJson` 的返回类型声明的是 `Record<string, unknown>`，而 `JSON.parse("null")` 给的就是
 * `null`：调用方第一处 `body.content` 直接 TypeError → 500「服务器内部错误」。
 * 那条路径以前没人挡，所以这里逐个端点过一遍四种非对象形状。
 */
test("合法的 JSON 但不是对象时回 400，不是 500", async (t) => {
  const h = await start(t);
  const bodies = ["null", "[]", "42", '"一个字符串"'];
  for (const { method, path } of bodyOperations().toSorted((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    await t.test(`${method} ${path}`, async () => {
      for (const bodyText of bodies) {
        const url = `${h.origin}/api/v1${path.replace("{id}", "does-not-exist")}`;
        const res = await fetch(url, {
          method,
          headers: { cookie: h.cookie, "content-type": "application/json" },
          body: bodyText,
        });
        const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        // 500 是这里唯一可接受的错法之外的错法：形状问题在边界上就该说完。
        assert.equal(
          res.status,
          400,
          `${method} ${path} 收到 ${bodyText} 应当是 400，实际 ${res.status}（${String(parsed.error ?? "")}）`,
        );
        assert.deepEqual(Object.keys(parsed), ["error"], "错误体必须是 { error }");
      }
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

/**
 * 配置档作用域的守卫（R4）。
 *
 * 挡的是这一类静默错：**半个控制台都在改 `default`，因为某个调用点忘了带 `profile`**。
 * 只要服务端允许「缺了就回落到 default」，忘了带就没有任何症状 —— 请求成功、界面显示绿勾，
 * 只是写进了另一份配置档。所以判据是「缺参数必须 400」，而这条判据本身要能被检查。
 *
 * 三个方向各自钉住，少一个都会留下一种「守卫绿着而现实坏了」的形状：
 * 1. 规格里标了 `x-profile-scoped` 的每个 operation，**不带参数打过去必须 400，
 *    且那句错误文案是「缺少 profile」**。只比状态码不够：这些端点全都可能因为
 *    别的理由回 400（缺 content、id 不存在），于是 handler 里那道检查被整段删掉也照样绿。
 * 2. **带参数打过去不得再是那句 400**。这是防空跑的常规做法反过来用在这里：
 *    有人把守卫写成「一律 400」时，第 1 条会绿。
 * 3. 标记集合 == 规格里全部 operation − 下面那份显式全局清单，**双向**成立。
 *    新加一个作用域端点却忘了标记 → 第一个方向漏掉它，而第三个方向当场红。
 *    「忘了标记」比「多标了」危险得多，因为前者是静默的。
 *
 * 为什么不直接遍历 `app.routes()` 来推「哪些端点是作用域化的」：路由表里没有任何
 * 作用域信息，那份划分只存在于 handler 里；本守卫要证的恰恰是「handler 与规格说的是同一件事」，
 * 所以一侧读规格、一侧打真请求，两边不许互相抄。
 * 而「规格的路由 == 真实注册的路由」由 `openapi.test.ts` 管，两条合起来才闭合。
 */
test("配置档作用域：标记的端点缺 profile 必须 400，且标记集合与路由表双向一致", async (t) => {
  const h = await start(t);

  /** 这些 operation 跨配置档共享，或直接就是「管配置档」的，**不该**带 `profile`。 */
  const GLOBAL = new Set([
    "health",
    "login",
    "logout",
    "me",
    "authStatus",
    "listSessions",
    "createSession",
    "getSession",
    "deleteSession",
    "listAdapters",
    "listProfiles",
    "createProfile",
    "renameProfile",
    "reloadProfile",
    "deleteProfile",
    // 「这一档默认用全局清单里的哪一个」写在档自己的文件里，但路径参数就是档 id，
    // 与 rename / reload 同构，不需要再有一份 query 参数。
    "setDefaultProvider",
    // 供应商这一族整体是**部署级全局**的一份（`providers.json`）：连接与密钥按档各存一份
    // 只会让同一个 apiKey 躺在 N 个文件里，而「换一档换一套后端」从来没人在用。
    // 带 `profile` 反而危险 —— 它会让「在 A 上改了源、B 却以为自己也有」变成可能。
    "listProviders",
    "createProvider",
    "updateProvider",
    "deleteProvider",
    "listProviderSources",
    "createProviderSource",
    "updateProviderSource",
    "deleteProviderSource",
    "fetchProviderModels",
  ]);

  interface SpecOp {
    method: string;
    path: string;
    operationId: string;
    declaresProfile: boolean;
    has400: boolean;
    scoped: boolean;
  }
  const all: SpecOp[] = [];
  for (const [path, item] of Object.entries(
    SPEC.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, raw] of Object.entries(item)) {
      if (!["get", "post", "delete"].includes(method)) continue;
      const op = raw as {
        operationId: string;
        "x-profile-scoped"?: boolean;
        parameters?: { $ref?: string }[];
        responses?: Record<string, unknown>;
      };
      all.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        declaresProfile: (op.parameters ?? []).some(
          (p) => p.$ref === "#/components/parameters/Profile",
        ),
        has400: op.responses?.["400"] !== undefined,
        scoped: op["x-profile-scoped"] === true,
      });
    }
  }
  const scoped = all.filter((o) => o.scoped);

  // 第 3 个方向（双向之一）：既不许有「没标记又不在全局清单」的 operation，
  // 也不许有「全局清单里列着一个规格里已经没有的 operationId」——后者会让清单
  // 变成装饰：有人把某个端点改回全局、忘了同时改标记，两边都在，检查照样绿。
  const unmarked = all
    .filter((o) => !o.scoped && !GLOBAL.has(o.operationId))
    .map((o) => `${o.operationId}（${o.method} ${o.path}）`);
  assert.deepEqual(
    unmarked,
    [],
    `这些 operation 既没有 x-profile-scoped 也不在显式全局清单里：${unmarked.join(", ")}。\n` +
      "新加端点时必须选一个：它是某份配置档里的东西（加标记），还是跨配置档的（进清单并说清为什么）。",
  );
  const stale = [...GLOBAL].filter((id) => !all.some((o) => o.operationId === id));
  assert.deepEqual(
    stale,
    [],
    `全局清单里这些 operationId 在规格里已经不存在：${stale.join(", ")}。把它们删掉 —— ` +
      "留着会让清单比现实宽，将来真有同名端点时它会被静默当成「已经是全局的」。",
  );

  for (const o of scoped) {
    // 标记了却没声明那个 required 参数，等于给生成 SDK 撒谎：客户端类型里没有
    // `profile` 这个字段，而规格说它是必填的。
    assert.ok(o.declaresProfile, `${o.operationId} 标了 x-profile-scoped 却没带 Profile 参数`);
    assert.ok(o.has400, `${o.operationId} 没声明 400 —— 缺 profile 的那个 400 会在 SDK 里凭空出现`);

    await t.test(`${o.operationId} 缺 profile`, async () => {
      // `{id}` 换成一个**不存在**的 id：这条要证的是「参数缺失的 400 先于任何资源查找」，
      // 而 handler 里作用域检查确实排在最前（排在 readJson 之前）。
      const target = `${h.origin}/api/v1${o.path.replace("{id}", "probe")}`;
      const headers = { cookie: h.cookie, "content-type": "application/json" };

      const bare = await fetch(target, {
        method: o.method,
        headers,
        body: o.method === "POST" ? "{}" : undefined,
      });
      const bareBody = (await bare.json().catch(() => ({}))) as { error?: string };
      // 比**文案**而不只比状态码：这些端点全都可能因为别的理由回 400
      //（缺 content、未知工具、id 不存在）。只比状态码的话，handler 里那道检查
      // 被整段删掉也照样绿 —— 那正是本守卫存在的理由。
      assert.equal(bare.status, 400, `${o.operationId} 不带 profile 回了 ${bare.status}`);
      assert.match(
        String(bareBody.error),
        /缺少 profile/,
        `那句 400 的理由不是「缺配置档」，实际是「${bareBody.error}」—— ` +
          "说明作用域检查被跳过或被挪到了别的校验之后",
      );

      // 反向控制：带上参数后**不得**再是同一句 400。有人把它写成无条件拒绝时，
      // 上面两条都会绿。
      const withIt = await fetch(`${target}?profile=default`, {
        method: o.method,
        headers,
        body: o.method === "POST" ? "{}" : undefined,
      });
      const withBody = (await withIt.json().catch(() => ({}))) as { error?: string };
      assert.ok(
        !/缺少 profile/.test(String(withBody.error ?? "")),
        "带上 profile 仍然报「缺少 profile」—— 守卫被写成了无条件拒绝",
      );
    });
  }
});

/**
 * 作用域守卫的**另一半**：上面那份 `GLOBAL` 清单只说「这些端点不要求带 `profile`」，
 * 它挡不住「有人把 `scopedProfile` 那道守卫又挪回这些 handler 上」—— 那时候清单照旧、
 * 标记照旧没有，而配置页全体 400。
 *
 * 所以这里反向打一次真请求：供应商这一族**不属于任何一份配置档**，不带参数就必须能用。
 * 红了怎么办：那是有人给这一族加回了档级守卫 —— 先确认 `providers.json` 是不是真的
 * 该按档各存一份（要改回去得同时改规格、这份守卫、和 dashboard 的调用点）。
 */
test("供应商端点不带 profile 也能用（它们是部署级全局那一份）", async (t) => {
  const h = await start(t);
  for (const path of ["/providers", "/provider-sources"]) {
    const res = await fetch(`${h.origin}/api/v1${path}`, { headers: { cookie: h.cookie } });
    // 边界收窄：失败响应也是 JSON，解析不出来时按空对象处理。
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    assert.equal(res.status, 200, `${path} 不带 profile 回了 ${res.status}：${body.error ?? ""}`);
    assert.doesNotMatch(String(body.error ?? ""), /缺少 profile/, `${path} 又开始要求配置档了`);
  }
});
