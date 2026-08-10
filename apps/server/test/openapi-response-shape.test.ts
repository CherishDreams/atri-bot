/**
 * openapi.json 的**响应形状**守卫：真实驱动全部 27 个端点，把真实响应体与规格声明逐个对。
 *
 * ## 为什么需要它
 * `openapi.json` 是手写的，而它是前端类型化 SDK 的唯一源头。已有的 `openapi.test.ts`
 * 守的是「路径与方法有没有少写/多写」，比的是 `METHOD /path` 字符串 —— 于是
 * **「路径没变、字段改了」这一类漂移没人管**：多一个字段、把 string 改成 null、枚举多个值，
 * 规格都会悄悄说谎，而 `codegen:check` 只保证「生成物 = 规格」，照样绿。
 * 做这轮迁移时实测就存在两处说谎：`PluginInfo.error` 发 `null` 而规格写 `string`、
 * `ProviderInfo.name` 必填而代码可能不输出（都已在上一轮修掉）。
 *
 * ## 红了怎么办
 * **改 `apps/server/openapi.json`，然后 `pnpm codegen` 并把生成物一起提交。不要改这个测试。**
 * 每条报警都是「前端拿到的类型 ≠ 实际收到的 JSON」。确属实现写错了，就改
 * `src/api/server.ts` 里对应 handler 的 `sendJson`。
 *
 * ## 为什么不装 ajv、为什么不由代码生成规格
 * 全份规格只用到 7 个校验关键字（`$ref` `allOf` `type` `required` `properties` `items`
 * `enum`；`additionalProperties`/`oneOf`/`anyOf`/`nullable`/`pattern`/数值边界 出现 0 次），
 * 手写几十行就够。而「服务端外部运行时依赖只有 `ws`」是 `AGENTS.md` 里刻意维护的属性：
 * 自动生成规格要引入框架（fastify 传递依赖 ~70 包、hono+zod ~7 包），都被否掉。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterInfo } from "@atri/shared";
import { AdapterManager } from "../src/adapters/manager.ts";
import { AgentEngine } from "../src/core/agent/engine.ts";
import { ProviderRegistry } from "../src/core/provider/registry.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import { createLogger } from "../src/core/logger.ts";
import { createApp } from "../src/app.ts";
import { makeTestConfig } from "./helpers/config.ts";

const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8"),
);

interface Op {
  operationId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  responses: Record<string, ResponseDecl>;
}
interface ResponseDecl {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: Node }>;
}
interface Node {
  $ref?: string;
  allOf?: Node[];
  type?: string | string[];
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  enum?: unknown[];
}

/**
 * 驱动顺序。先建资源再读，破坏性的放最后且各自带自己的受害者，
 * 免得一条用例把另一条的前提删掉。
 * 这个表**必须覆盖规格里全部 operationId**，下面的用例会检查。
 */
const ORDER = [
  "health",
  "authStatus",
  "login",
  "me",
  "listProviderSources",
  "createProviderSource",
  "updateProviderSource",
  "fetchProviderModels",
  "listProviders",
  "createProvider",
  "updateProvider",
  "createSession",
  "listSessions",
  "sendMessage",
  "getSession",
  "streamMessage",
  "listPlugins",
  "reloadPlugin",
  "setPluginEnabled",
  "listAdapters",
  "listTools",
  "setToolEnabled",
  "deleteSession",
  "deleteProvider",
  "unloadPlugin",
  "deleteProviderSource",
  "logout",
];

// --- 规格的窄子集校验器 -----------------------------------------------------

/**
 * `GET /adapters` 的元素数组恒空：仓库里没有任何适配器实现（`AdapterManager.register()`
 * 无调用方），HTTP 侧造不出非空列表。放行空数组的同时，元素形状改由「进程内核对」那条
 * 用例负责 —— 它直接调 `AdapterManager.list()`，用的就是端点读的同一个函数。
 */
const EMPTY_OK = new Set(["adapters"]);

/** 解析文档内 `$ref`，并合并 `allOf`（本规格只有一处 allOf：SessionDetail）。 */
function resolve(node: unknown, stack: string[] = []): Node {
  if (!node || typeof node !== "object") return {};
  const n = node as Node & ResponseDecl;
  if (n.$ref) {
    if (stack.includes(n.$ref)) {
      throw new Error(`openapi.json 存在循环引用: ${[...stack, n.$ref].join(" -> ")}`);
    }
    let cur: unknown = SPEC;
    // 本规格的 $ref 一律是 `#/components/...` 形式，没有跨文件引用。
    for (const seg of n.$ref.slice(2).split("/")) {
      cur = (cur as Record<string, unknown> | undefined)?.[seg];
    }
    if (!cur) throw new Error(`openapi.json 里的 $ref 指不到东西: ${n.$ref}`);
    return resolve(cur, [...stack, n.$ref]);
  }
  if (n.allOf) {
    const parts = n.allOf.map((p) => resolve(p, stack));
    return {
      type: "object",
      properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
      required: [...new Set(parts.flatMap((p) => p.required ?? []))],
    };
  }
  return n;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * 空数组一律算假绿 —— **唯一的例外是 `EMPTY_OK`**（见其注释）。
 *
 * 递归比对。**相对 JSON Schema 有一处刻意收紧**：对象按「闭合」处理 ——
 * 实际多出、规格没声明的键也算漂移。JSON Schema 默认允许额外属性，而
 * 「代码加了字段、规格不知道 → 前端类型少字段」正是本测试要抓的那一类。
 */
function checkShape(value: unknown, rawNode: Node, path: string, problems: string[]): void {
  const node = resolve(rawNode);
  if (node.enum) {
    if (!node.enum.includes(value)) {
      problems.push(
        `${path}: 值 ${JSON.stringify(value)} 不在规格枚举 ${JSON.stringify(node.enum)} 里`,
      );
    }
    return;
  }
  const declared = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const actual = jsonType(value);
  const compatible =
    !declared.length ||
    declared.includes(actual) ||
    // integer 是 number 的子集，JSON Schema 就这么规定；反向不行。
    (declared.includes("integer") && actual === "number");
  if (!compatible) {
    problems.push(`${path}: 类型不符 —— 规格 <${declared.join("|")}>，实际 <${actual}>`);
    return;
  }
  if (actual === "array") {
    if (!node.items) return;
    const arr = value as unknown[];
    // 空数组会让「元素形状」整层静默通过，所以驱动必须真的造出数据。
    if (arr.length === 0) {
      if (EMPTY_OK.has(path.replace(/^\$\./, ""))) return;
      problems.push(`${path}: 数组为空，元素形状根本没被检查（这是假绿，驱动没造出数据）`);
      return;
    }
    arr.forEach((item, i) => checkShape(item, node.items as Node, `${path}[${i}]`, problems));
    return;
  }
  if (actual !== "object") return;
  const props = node.properties ?? {};
  const obj = value as Record<string, unknown>;
  for (const key of node.required ?? []) {
    if (!(key in obj))
      problems.push(`${path}.${key}: 规格写了 required，实际响应里没有 → 前端类型会骗人`);
  }
  for (const key of Object.keys(obj)) {
    if (!(key in props)) {
      problems.push(`${path}.${key}: 实际多出这个键，规格里没声明 → 前端 SDK 类型里不会有它`);
      continue;
    }
    checkShape(obj[key], props[key] as Node, `${path}.${key}`, problems);
  }
}

/** 某个 operation 在某个状态码上声明的 JSON schema；没有 JSON 体则 null。 */
function jsonSchemaOf(op: Op, status: number): Node | null {
  const decl = op.responses[String(status)];
  if (!decl) return null;
  const resolved = resolve(decl) as ResponseDecl;
  return resolved.content?.["application/json"]?.schema ?? null;
}

function eventStreamSchemaOf(op: Op): Node | null {
  for (const decl of Object.values(op.responses)) {
    const resolved = resolve(decl) as ResponseDecl;
    const schema = resolved.content?.["text/event-stream"]?.schema;
    if (schema) return schema;
  }
  return null;
}

// --- 夹具 ------------------------------------------------------------------

/** openai 兼容桩上游：补全、流式、模型列表三条都够用。 */
function startUpstream(): Promise<{ baseUrl: string; close(): void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-up" }, { id: "m-up-2" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const streaming = Boolean(JSON.parse(raw || "{}").stream);
      if (!streaming) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "上游完整回复" } }],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "上游" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "增量" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("桩上游没有拿到 TCP 端口");
      done({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, close: () => server.close() });
    });
  });
}

/** 一个最小合法插件：让 `GET /plugins` 与三个写端点有真实对象可操作。 */
function writePluginFixture(pluginsRoot: string, id: string): void {
  const dir = join(pluginsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.js"),
    `export default {\n` +
      `  id: ${JSON.stringify(id)},\n` +
      `  name: "形状守卫夹具",\n` +
      `  version: "1.2.3",\n` +
      `  description: "只为检查插件响应的字段形状而存在",\n` +
      `  setup() {},\n` +
      `};\n`,
    "utf8",
  );
}

interface Harness {
  origin: string;
  cookie: string;
  call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  sse(path: string, body: unknown): Promise<{ status: number; frames: Record<string, unknown>[] }>;
}

async function setup(t: TestContext): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "atri-openapi-shape-"));
  const upstream = await startUpstream();
  const pluginsRoot = join(root, "plugins");
  writePluginFixture(pluginsRoot, "fixture");

  const app = await createApp(
    makeTestConfig({
      root,
      pluginDirs: [pluginsRoot],
      providerSources: {
        stub: {
          type: "openai",
          name: "stub",
          baseUrl: upstream.baseUrl,
          apiKey: "sk",
          timeoutMs: 5000,
        },
      },
      providers: {
        stub: { source: "stub", model: "m-up", name: "stub" },
        // 故意留一条引用不存在的源的实例：`loaded: false` 与 `error` 这两根键
        // 只在加载失败的条目上出现，不预置就永远检查不到。
        broken: { source: "ghost", model: "m" },
      },
    }),
  );
  await app.start();
  t.after(async () => {
    await app.stop();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(login.status, 200, "登录不成功的話，后面全是在测 401");
  const first = login.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Set-Cookie");
  const cookie = first.split(";")[0] as string;

  return {
    origin,
    cookie,
    async call(method, path, body) {
      const res = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async sse(path, body) {
      const res = await fetch(`${origin}/api/v1${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const frames = text
        .split("\n\n")
        .map((block) =>
          block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6),
        )
        .filter((data): data is string => Boolean(data))
        .map((data) => JSON.parse(data) as Record<string, unknown>);
      return { status: res.status, frames };
    },
  };
}

// --- 用例 ------------------------------------------------------------------

function operations(): Op[] {
  const out: Op[] = [];
  for (const [path, item] of Object.entries(
    SPEC.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, raw] of Object.entries(item)) {
      if (!["get", "post", "delete"].includes(method)) continue;
      const op = raw as { operationId: string; responses: Record<string, ResponseDecl> };
      out.push({
        operationId: op.operationId,
        method: method.toUpperCase() as Op["method"],
        path,
        responses: op.responses,
      });
    }
  }
  return out;
}

/** 把 `{id}` 占位换成真实 id（规格里所有路径参数都叫 id）。 */
function fill(path: string, id: string): string {
  return path.replace("{id}", encodeURIComponent(id));
}

test("openapi.json 的 operationId 集合与驱动表一致", () => {
  const ids = operations().map((o) => o.operationId);
  const missing = ids.filter((id) => !ORDER.includes(id));
  assert.deepEqual(
    missing,
    [],
    `这些端点没有驱动，形状根本没被检查：${missing.join(", ")}。给它们补一条驱动，不要把它们从测试里删掉。`,
  );
  const stale = ORDER.filter((id) => !ids.includes(id));
  assert.deepEqual(stale, [], `驱动表里这些 operationId 在规格里已经不存在了：${stale.join(", ")}`);
});

test("每个端点的真实响应与规格逐字段一致", async (t) => {
  const h = await setup(t);
  const ops = operations();
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  /** 共享的资源 id：先建后用，顺序见 ORDER。 */
  const ids: Ids = { sourceId: "", providerId: "", sessionId: "", streamSessionId: "" };

  for (const operationId of ORDER) {
    await t.test(operationId, async () => {
      const op = byId.get(operationId);
      assert.ok(op, `规格里没有 ${operationId}`);
      const driven = await drive(operationId, op, h, ids);
      const declaredCodes = Object.keys(op.responses).filter((c) => c !== "default");
      assert.ok(
        declaredCodes.includes(String(driven.status)),
        `${operationId}: 实际状态码 ${driven.status} 不在规格声明的 {${declaredCodes.join(",")}} 里`,
      );

      const problems: string[] = [];
      if (driven.frames) {
        const schema = eventStreamSchemaOf(op);
        assert.ok(schema, `${operationId}: 规格里没有 text/event-stream 的响应体`);
        assert.ok(driven.frames.length >= 2, `${operationId}: 流一帧都没有，形状检查会是假绿`);
        driven.frames.forEach((frame, i) =>
          checkShape(frame, schema as Node, `$[帧${i}]`, problems),
        );
      } else {
        const schema = jsonSchemaOf(op, driven.status);
        assert.ok(schema, `${operationId}: 规格没为 ${driven.status} 声明 JSON 响应体`);
        checkShape(driven.body, schema as Node, "$", problems);
        for (const extra of driven.also ?? []) {
          checkShape(extra.body, jsonSchemaOf(op, extra.status) ?? schema, "$[另一半]", problems);
        }
      }
      assert.deepEqual(
        problems,
        [],
        `${operationId}（${op.method} ${op.path} → ${driven.status}）的响应体与规格不一致：\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\n红了怎么办：改 apps/server/openapi.json，再 pnpm codegen 并提交生成物；不要改这个测试。`,
      );
    });
  }
});

/** `GET /adapters` 恒空：没有适配器实现，`register()` 无调用方。 */
test("GET /adapters 的元素形状（经进程内 AdapterManager 核对）", () => {
  // 真实协作者而不是桩：AdapterManager 只把 engine 存起来（没有任何读取点），
  // 传 `undefined as never` 能过编译但会把「它其实没被用」这件事藏起来。
  const logger = createLogger("error");
  const engine = new AgentEngine({
    sessions: new SessionManager(),
    providers: new ProviderRegistry(),
    logger,
  });
  const manager = new AdapterManager({ config: { adapters: {} }, engine, logger });
  manager.register("spec-x", { name: "X", start() {}, stop() {} });
  const listed: AdapterInfo[] = manager.list();
  const problems: string[] = [];
  const schema: Node = {
    type: "array",
    items: resolve(SPEC.components.schemas.AdapterInfo as unknown as Node),
  };
  checkShape(listed, schema, "$", problems);
  assert.deepEqual(
    problems,
    [],
    `AdapterManager.list() 的返回值与规格 AdapterInfo 不一致：\n${problems.join("\n")}`,
  );
});

/** 共享资源 id。写成接口而不是 Record：索引签名会让每个读取都带上 undefined。 */
interface Ids {
  sourceId: string;
  providerId: string;
  sessionId: string;
  streamSessionId: string;
}

/**
 * 一条 operation 的一次调用结果。`frames` 表示流式响应；`also` 是同一次调用里
 * 顺带产生的其它响应，也会按同一份规格检查 —— 有极个别端点的**另一半枚举值**
 * 只有在那里才出现（见 setPluginEnabled），少了这个通道，规格的 enum 只会被验到一半。
 */
type Driven =
  | {
      status: number;
      body: Record<string, unknown>;
      frames?: undefined;
      also?: { status: number; body: Record<string, unknown> }[];
    }
  | {
      status: number;
      body?: undefined;
      frames: Record<string, unknown>[];
    };

async function drive(id: string, op: Op, h: Harness, ids: Ids): Promise<Driven> {
  const at = (path: string, body?: unknown) =>
    h.call(op.method, fill(path, pathIds(id, ids)), body);

  switch (id) {
    case "health":
    case "authStatus": {
      // 公开端点：不带 cookie 直接取，顺带证明它们真的免鉴权。
      const res = await fetch(`${h.origin}/api/v1/${id === "health" ? "health" : "auth/status"}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }
    case "login": {
      const res = await fetch(`${h.origin}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "pw" }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }
    case "me":
      return at("/auth/me");
    case "logout":
      return at("/auth/logout");

    case "createSession": {
      const r = await at("/sessions", { title: "形状守卫" });
      ids.sessionId = idOf(r.body);
      ids.streamSessionId = idOf(r.body);
      return r;
    }
    case "listSessions":
      return at("/sessions");
    case "getSession":
      return at(`/sessions/${"{id}"}`);
    case "deleteSession": {
      // 自带受害者：不能删掉别人还要读的会话。
      const created = await h.call("POST", "/sessions", { title: "待删" });
      const victim = idOf(created.body);
      return h.call("DELETE", `/sessions/${victim}`);
    }
    case "sendMessage":
      return at(`/sessions/${"{id}"}/messages`, { content: "你好" });
    case "streamMessage": {
      const r = await h.sse(`/sessions/${ids.streamSessionId}/messages/stream`, {
        content: "流一下",
      });
      return { status: r.status, frames: r.frames };
    }

    case "listProviderSources":
      return at("/provider-sources");
    case "createProviderSource": {
      const r = await at("/provider-sources", { id: "made-by-guard", type: "openai" });
      ids.sourceId = "made-by-guard";
      return r;
    }
    case "updateProviderSource": {
      ids.sourceId = ids.sourceId || "stub";
      return at(`/provider-sources/${"{id}"}`, { name: "改名后的源" });
    }
    case "fetchProviderModels": {
      // 「获取模型列表」只认已保存的源，所以拿预置的 stub（baseUrl 指向桩上游）。
      const r = await h.call("POST", `/provider-sources/stub/models`);
      return r;
    }
    case "deleteProviderSource": {
      const created = await h.call("POST", "/provider-sources", {
        id: "to-be-deleted",
        type: "openai",
      });
      const owner = idOf(created.body);
      await h.call("POST", "/providers", {
        id: "owned-by-to-be-deleted",
        source: owner,
        model: "m",
      });
      return h.call("DELETE", `/provider-sources/${owner}?cascade=1`);
    }

    case "listProviders":
      return at("/providers");
    case "createProvider": {
      const r = await at("/providers", { id: "guard-provider", source: "stub", model: "m-up" });
      ids.providerId = "guard-provider";
      return r;
    }
    case "updateProvider":
      return at(`/providers/${"{id}"}`, { name: "改名后的实例", default: true });
    case "deleteProvider": {
      const created = await h.call("POST", "/providers", {
        id: "guard-victim",
        source: "stub",
        model: "m",
      });
      return h.call("DELETE", `/providers/${idOf(created.body)}`);
    }

    case "listPlugins":
      return at("/plugins");
    case "reloadPlugin":
      return at("/plugins/fixture/reload");
    case "setPluginEnabled": {
      // 跑两遍：`disabled` 与 `active` 是全规格仅有的两个 enum 之一，只走一遍就漏掉一半。
      // （被形状检查的是第二遍；第一遍用下面的断言直接盯住它的 status/enabled。）
      const off = await h.call("POST", "/plugins/fixture/enable", { enabled: false });
      const on = await h.call("POST", "/plugins/fixture/enable", { enabled: true });
      // 禁用态也交给校验器（走 `also`）：它是全规格里唯一一份 status === "disabled" 的响应。
      return { ...on, also: [off] };
    }
    case "unloadPlugin":
      return at("/plugins/fixture/unload");
    case "listAdapters":
      return at("/adapters");
    case "listTools":
      return at("/tools");
    case "setToolEnabled": {
      // 内置工具的 id 是代码里的常量，不需要先创建资源。
      // 三次写入：先关（证明 enabled=false 这一支的形状）、再开、最后关回原样 ——
      // 被当作本次响应校验的是「开」，另两次走 `also`，两种布尔值都过校验器。
      const off = await h.call("POST", "/tools/current_time/enable", { enabled: false });
      const on = await h.call("POST", "/tools/current_time/enable", { enabled: true });
      const back = await h.call("POST", "/tools/current_time/enable", { enabled: false });
      return { ...on, also: [off, back] };
    }
    default:
      throw new Error(`驱动表里没有 ${id} 的驱动`);
  }
}

/** 规格里这些路径的 `{id}` 该换成哪个真实 id。 */
function pathIds(operationId: string, ids: Ids): string {
  switch (operationId) {
    case "getSession":
    case "sendMessage":
      return ids.sessionId;
    case "updateProviderSource":
      return ids.sourceId;
    case "updateProvider":
      return ids.providerId;
    default:
      return "";
  }
}

/** 从 `{session: {...}}` / `{provider: {...}}` / `{source: {...}}` 里取出 id。 */
function idOf(body: Record<string, unknown>): string {
  const only = Object.values(body)[0];
  if (!only || typeof only !== "object") throw new Error("响应体里找不到被创建的对象");
  const id = (only as Record<string, unknown>).id;
  if (typeof id !== "string") throw new Error("被创建的对象没有 id");
  return id;
}
