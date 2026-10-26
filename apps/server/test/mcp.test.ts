/**
 * MCP 模块的测试：存储（校验/持久化/坏条目跳过）、管理器（真实 stdio 桩服务器的
 * 连接与工具调用）、以及 `/mcp` 端到端。
 *
 * 桩上游用 SDK 自己的 `McpServer`（stdio 传输）：这证的是「我们的客户端与一个
 * 标准实现互通」，而不是「与一个照着我们误解写的桩互通」。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "#app.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { McpServerStore, validMcpTimeout, type McpStateIo } from "#core/mcp/store.ts";
import { McpManager } from "#core/mcp/manager.ts";
import type { Logger } from "#core/logger.ts";

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info: (m) => sink.push(m),
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

function fakeIo(files: { value: Record<string, unknown> } = { value: {} }): McpStateIo {
  return {
    exists: () => false,
    ensureDir() {},
    read: () => files.value,
    write(_file: string, value: Record<string, unknown>) {
      files.value = value;
      return "";
    },
  };
}

// --- 存储 -------------------------------------------------------------------

test("McpServerStore：CRUD、持久化与校验", () => {
  const files = { value: {} as Record<string, unknown> };
  const store = new McpServerStore({
    filePath: "/tmp/atri-mcp.json",
    logger: silentLogger(),
    io: fakeIo(files),
  });
  assert.deepEqual(store.list(), [], "没有文件时是空清单");

  const created = store.create({
    id: "tools",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: { TOKEN: "secret" },
  });
  assert.equal(created.enabled, true, "缺省启用");
  assert.equal(validMcpTimeout(created.timeoutMs), 60_000);
  assert.deepEqual((files.value.servers as Record<string, unknown>).tools, created, "写进盘");

  assert.throws(() => store.create({ id: "tools", transport: "sse", url: "http://x" }), /已经存在/);
  assert.throws(() => store.create({ id: "Bad Id", transport: "sse", url: "http://x" }), /不合法/);
  assert.throws(() => store.create({ id: "h", transport: "http" }), /必须提供 http\(s\) URL/);
  assert.throws(
    () => store.create({ id: "s", transport: "stdio", command: "node", headers: { a: "b" } }),
    /不接受 headers/,
  );

  const updated = store.update("tools", {
    transport: "stdio",
    command: "node",
    timeoutMs: 120_000,
  });
  assert.equal(updated.timeoutMs, 120_000);
  store.setEnabled("tools", false);
  assert.equal(store.get("tools")?.enabled, false);
  assert.equal(store.remove("tools"), true);
  assert.equal(store.get("tools"), null);
});

test("validMcpTimeout：非法值退缺省，上限夹取", () => {
  assert.equal(validMcpTimeout(undefined), 60_000);
  assert.equal(validMcpTimeout(-1), 60_000);
  assert.equal(validMcpTimeout(999_999), 600_000);
  assert.equal(validMcpTimeout(2_000), 2_000);
});

// --- 管理器：真实 stdio 桩 ----------------------------------------------------

/** 桩服务器是仓库内的标准实现 fixture（依赖解析按脚本位置向上找 node_modules）。 */
const STUB_SERVER = fileURLToPath(new URL("./fixtures/stub-mcp.mjs", import.meta.url));

async function stubManager(t: TestContext, lines: string[] = []): Promise<McpManager> {
  const dir = mkdtempSync(join(tmpdir(), "atri-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new McpServerStore({
    filePath: join(dir, "mcp.json"),
    logger: silentLogger(lines),
    io: {
      exists: () => true,
      ensureDir() {},
      read: () => ({}) as never,
      write: () => "",
    },
  });
  store.create({ id: "stub", transport: "stdio", command: process.execPath, args: [STUB_SERVER] });
  // 解析 SDK 的路径：桩脚本从仓库的 node_modules 拿依赖，cwd 指到服务端包。
  const manager = new McpManager({ store, logger: silentLogger(lines) });
  await manager.startAll();
  t.after(() => manager.stopAll());
  return manager;
}

test("McpManager：连上 stdio 桩、跳过拼不出 id 的工具、调用与错误回喂", async (t) => {
  const lines: string[] = [];
  const mcp = await stubManager(t, lines);
  const view = mcp.list()[0];
  assert.ok(view);
  assert.equal(view.status, "connected");
  // 「大写工具」的 id（mcp.stub.大写工具）不合规：跳过而不是改名硬塞。
  assert.deepEqual(view.tools.map((tool) => tool.name).toSorted(), ["boom", "echo"]);
  assert.ok(lines.some((line) => line.includes("大写工具") && line.includes("跳过")));

  const tools = mcp.tools();
  const echo = tools.find((tool) => tool.id === "mcp.stub.echo");
  assert.ok(echo, "工具按 mcp.<server>.<tool> 进注册表");
  assert.equal(await echo.run({ text: "你好" }, {}), "回声:你好");

  const boom = tools.find((tool) => tool.id === "mcp.stub.boom");
  assert.ok(boom);
  await assert.rejects(() => boom.run({}, {}), /炸了/, "远端 isError 的文本要带给回喂层");
});

test("McpManager：禁用后工具消失，重新启用即恢复", async (t) => {
  const mcp = await stubManager(t);
  mcp.store.setEnabled("stub", false);
  await mcp.applyConfig("stub");
  assert.deepEqual(mcp.tools(), [], "禁用的服务器不提供工具");
  const view = mcp.list()[0];
  assert.equal(view?.status, "disabled");

  mcp.store.setEnabled("stub", true);
  await mcp.applyConfig("stub");
  assert.ok(mcp.tools().length >= 2, "重新启用后工具回来");
});

test("McpManager：连接失败记进视图，probe 可重试", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atri-mcp-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new McpServerStore({
    filePath: join(dir, "mcp.json"),
    logger: silentLogger(),
    io: { exists: () => true, ensureDir() {}, read: () => ({}) as never, write: () => "" },
  });
  store.create({
    id: "ghost",
    transport: "stdio",
    command: process.execPath,
    args: [join(dir, "不存在.js")],
  });
  const mcp = new McpManager({ store, logger: silentLogger() });
  await mcp.startAll();
  t.after(() => mcp.stopAll());
  const view = mcp.list()[0];
  assert.equal(view?.status, "error");
  assert.ok(view?.error, "失败原因要看得见");
  assert.deepEqual(view?.tools, []);
  const probed = await mcp.probe("ghost");
  assert.equal(probed?.status, "error", "probe 失败仍是 200 的 error 状态，不是异常");
});

// --- 端到端 -------------------------------------------------------------------

async function startApp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "atri-mcp-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createApp(makeTestConfig({ root }));
  await app.start();
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.address().port}`;
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("登录响应没有 Set-Cookie");
  return { root, origin, cookie };
}

async function call(
  origin: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("端到端：创建 stdio 服务器 -> 工具进 GET /tools -> 删除", async (t) => {
  const { origin, cookie } = await startApp(t);
  const created = await call(origin, cookie, "POST", "/mcp", {
    id: "stub",
    transport: "stdio",
    command: process.execPath,
    args: [STUB_SERVER],
  });
  assert.equal(created.status, 201);
  const server = created.json.server as { status: string; tools: { id: string }[] };
  assert.equal(server.status, "connected", "创建时立即连接");

  const tools = await call(origin, cookie, "GET", "/tools?profile=default");
  const ids = (tools.json.tools as { id: string }[]).map((tool) => tool.id);
  assert.ok(ids.includes("mcp.stub.echo"), "MCP 工具进档的工具开关清单");

  const bad = await call(origin, cookie, "POST", "/mcp", { id: "x", transport: "stdio" });
  assert.equal(bad.status, 400, "缺 command 校验拒绝");

  const again = await call(origin, cookie, "POST", "/mcp", {
    id: "stub",
    transport: "stdio",
    command: process.execPath,
    args: [STUB_SERVER],
  });
  assert.equal(again.status, 409, "重复 id 拒绝");

  const removed = await call(origin, cookie, "DELETE", "/mcp/stub");
  assert.equal(removed.status, 200);
  const toolsAfter = await call(origin, cookie, "GET", "/tools?profile=default");
  assert.ok(
    !(toolsAfter.json.tools as { id: string }[]).some((tool) => tool.id === "mcp.stub.echo"),
    "删掉服务器后工具立刻消失（注册表现读）",
  );
});
