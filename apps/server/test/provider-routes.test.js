/**
 * provider 配置路由的端到端测试。
 *
 * 这里要证的是一件在别处测不到的事：**改完配置不重启就生效**。
 * 配置存储、工厂、注册表各自都有自己的单元测试，但「HTTP 写操作 → 重建注册表
 * → 下一次发消息真的打到新上游」这条链只有整条跑起来才能验证，
 * 而它恰恰是这个功能存在的理由（否则用户得改文件再重启）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.js";
import { configFilePath } from "../src/config/file.ts";

/**
 * 一个最小的上游：记下每次收到的请求，并按 `label` 回一句固定的流式回复。
 * 回复里带上 label，就能从聊天结果反推「这次到底打了哪个上游」。
 */
async function startUpstream(label) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: label } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 起一个真的 app。
 *
 * `preset` 会在 app 启动**之前**写进 `atri.config.json`：用来构造「启动时就有
 * 别的内容」或「启动时就带着一条坏 provider」的场景——这两种都必须在
 * `createApp` 之前就位，事后改文件是模拟不出来的（注册表不会因此重建）。
 */
async function startApp(t, preset) {
  const root = mkdtempSync(join(tmpdir(), "atri-routes-"));
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  if (preset) writeFileSync(configFilePath(root), `${JSON.stringify(preset, null, 2)}\n`);
  const app = await createApp({
    root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    dataDir: join(root, "data"),
    pluginDirs: [],
    adapters: {},
    providers: {},
    auth: {
      adminUser: "admin",
      adminPassword: "pw",
      cookieName: "atri_session",
      cookieSecure: false,
      staticDir: join(root, "nonexistent"),
    },
  });
  await app.start();
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    root,
    stop: async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function login(origin) {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

function call(origin, cookie, method, path, body) {
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    // GET 不允许带 body，连值为 undefined 的键都不能出现。
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const get = (o, c, p) => call(o, c, "GET", p);
const post = (o, c, p, b) => call(o, c, "POST", p, b);
const del = (o, c, p) => call(o, c, "DELETE", p);

/** 建会话、发一条消息、读完整条 SSE，返回助手回复文本。 */
async function chat(origin, cookie, model) {
  const { body: created } = await post(origin, cookie, "/sessions", { title: "t" });
  const res = await fetch(`${origin}/api/v1/sessions/${created.session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "你好", model }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const final = text
    .split("\n\n")
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.replace(/^data:\s*/, "")))
    .at(-1);
  return final?.message?.content ?? "";
}

// --- CRUD 全链路 ------------------------------------------------------------

test("路由：源的增改查删", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  const created = await post(app.origin, cookie, "/provider-sources", {
    id: "deepseek",
    type: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-1",
    timeoutMs: 30_000,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.source.id, "deepseek");
  assert.equal(created.body.source.timeoutMs, 30_000);

  const listed = await get(app.origin, cookie, "/provider-sources");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.sources.map((s) => s.id),
    ["deepseek"],
  );

  const updated = await post(app.origin, cookie, "/provider-sources/deepseek", {
    apiKey: "sk-2",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.source.apiKey, "sk-2");
  // patch 语义：没提到的字段保持原值。
  assert.equal(updated.body.source.baseUrl, "https://api.deepseek.com/v1");

  const removed = await del(app.origin, cookie, "/provider-sources/deepseek");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.deleted, ["deepseek"]);
  assert.deepEqual((await get(app.origin, cookie, "/provider-sources")).body.sources, []);
});

test("路由：provider 实例的增改查删，并带 loaded 标注", async (t) => {
  const upstream = await startUpstream("ok");
  const app = await startApp(t);
  t.after(() => upstream.stop());
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  await post(app.origin, cookie, "/provider-sources", {
    id: "s",
    type: "openai",
    baseUrl: upstream.baseUrl,
    apiKey: "k",
  });

  const created = await post(app.origin, cookie, "/providers", {
    id: "s-model-a",
    source: "s",
    model: "model-a",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.provider.model, "model-a");
  assert.equal(created.body.provider.enabled, true, "新建的实例默认启用");

  const listed = await get(app.origin, cookie, "/providers");
  assert.equal(listed.body.providers.length, 1);
  // 配置里写着 ≠ 真的能跑。这一层要显式告诉前端它到底注册成功没有。
  assert.equal(listed.body.providers[0].loaded, true);

  const disabled = await post(app.origin, cookie, "/providers/s-model-a", { enabled: false });
  assert.equal(disabled.body.provider.enabled, false);

  const madeDefault = await post(app.origin, cookie, "/providers/s-model-a", { default: true });
  assert.equal(madeDefault.body.provider.default, true);

  const removed = await del(app.origin, cookie, "/providers/s-model-a");
  assert.equal(removed.status, 200);
  assert.deepEqual((await get(app.origin, cookie, "/providers")).body.providers, []);
});

test("路由：校验失败回 400，未知 id 回 404", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  const bad = await post(app.origin, cookie, "/provider-sources", { id: "有 空格" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /非法字符/);

  const missing = await post(app.origin, cookie, "/provider-sources/不存在", { name: "x" });
  assert.equal(missing.status, 404);

  // provider 引用不存在的源：是配置错误（400），不是「资源缺失」。
  const dangling = await post(app.origin, cookie, "/providers", {
    id: "p",
    source: "不存在",
    model: "m",
  });
  assert.equal(dangling.status, 400);
});

// --- 引用保护 ---------------------------------------------------------------

test("路由：源被引用时拒绝删除，cascade 才连带删掉", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  await post(app.origin, cookie, "/provider-sources", { id: "s" });
  await post(app.origin, cookie, "/providers", { id: "p1", source: "s", model: "m1" });
  await post(app.origin, cookie, "/providers", { id: "p2", source: "s", model: "m2" });

  const refused = await del(app.origin, cookie, "/provider-sources/s");
  // 静默级联会悄悄删掉用户配好的模型，到下次请求才暴露。
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /p1/);
  assert.match(refused.body.error, /p2/);
  assert.equal((await get(app.origin, cookie, "/provider-sources")).body.sources.length, 1);

  const cascaded = await del(app.origin, cookie, "/provider-sources/s?cascade=1");
  assert.equal(cascaded.status, 200);
  assert.deepEqual(cascaded.body.deleted, ["s", "p1", "p2"]);
  assert.deepEqual((await get(app.origin, cookie, "/providers")).body.providers, []);
});

// --- 落盘与实时生效 ---------------------------------------------------------

test("路由：改动写进 atri.config.json，且不碰文件里别的配置", async (t) => {
  // 预置别的设置：provider 写入是读-改-写，一次失手就会连带抹掉这些敏感项。
  const app = await startApp(t, {
    port: 0,
    auth: { adminUser: "admin", adminPassword: "keep-me" },
    pluginDirs: ["./plugins"],
  });
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  await post(app.origin, cookie, "/provider-sources", {
    id: "s",
    type: "anthropic",
    apiKey: "sk-x",
  });
  await post(app.origin, cookie, "/providers", { id: "p", source: "s", model: "claude-x" });

  const file = JSON.parse(readFileSync(configFilePath(app.root), "utf8"));
  assert.equal(file.providerSources.s.type, "anthropic");
  assert.equal(file.providers.p.model, "claude-x");
  assert.equal(file.auth.adminUser, "admin");
  assert.equal(file.auth.adminPassword, "keep-me");
  assert.deepEqual(file.pluginDirs, ["./plugins"]);
});

test("路由：改完配置立刻生效，不需要重启", async (t) => {
  const upstreamA = await startUpstream("来自 A");
  const upstreamB = await startUpstream("来自 B");
  const app = await startApp(t);
  t.after(() => upstreamA.stop());
  t.after(() => upstreamB.stop());
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  // 先建 A，确认真的打到 A。
  await post(app.origin, cookie, "/provider-sources", {
    id: "a",
    type: "openai",
    baseUrl: upstreamA.baseUrl,
    apiKey: "k",
  });
  await post(app.origin, cookie, "/providers", { id: "a-m", source: "a", model: "m" });
  assert.equal(await chat(app.origin, cookie, "a-m"), "来自 A");

  // 再建 B 并设为默认，不重启服务。
  await post(app.origin, cookie, "/provider-sources", {
    id: "b",
    type: "openai",
    baseUrl: upstreamB.baseUrl,
    apiKey: "k",
  });
  await post(app.origin, cookie, "/providers", { id: "b-m", source: "b", model: "m" });
  await post(app.origin, cookie, "/providers/b-m", { default: true });

  assert.equal(await chat(app.origin, cookie, undefined), "来自 B");
  // 显式选中 A 的那一行时仍要打到 A——选择器发上来的是**实例 id**，
  // 若选路只按模型名匹配，这里会落到默认项 B 上。
  assert.equal(await chat(app.origin, cookie, "a-m"), "来自 A");

  // 上游真的收到了我们配置的模型名，而不是实例 id。
  assert.equal(upstreamB.seen.at(-1).body.model, "m");
});

test("路由：删掉默认实例后保留键被清掉，选路回退到剩下的", async (t) => {
  const upstream = await startUpstream("唯一");
  const app = await startApp(t);
  t.after(() => upstream.stop());
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  await post(app.origin, cookie, "/provider-sources", {
    id: "s",
    type: "openai",
    baseUrl: upstream.baseUrl,
    apiKey: "k",
  });
  await post(app.origin, cookie, "/providers", { id: "p", source: "s", model: "m" });
  await post(app.origin, cookie, "/providers/p", { default: true });
  assert.equal((await get(app.origin, cookie, "/providers")).body.providers[0].default, true);

  await del(app.origin, cookie, "/providers/p");
  const file = JSON.parse(readFileSync(configFilePath(app.root), "utf8"));
  // 保留键不清的话会指向一个不存在的 id，而 `/providers` 上什么也看不出来。
  assert.equal("default" in file.providers, false);
});

test("路由：加载失败（缺源）的条目仍出现在列表里并带上原因", async (t) => {
  // 直接在启动时给一份「provider 引用了不存在的源」的配置：这正是用户手工改坏
  // 文件、或早先删源没走 cascade 之后重启会看到的样子。
  const app = await startApp(t, {
    providerSources: { s: { id: "s", type: "openai", model: "m" } },
    providers: { p: { id: "p", source: "ghost", model: "m" } },
  });
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  const listed = await get(app.origin, cookie, "/providers");
  const entry = listed.body.providers.find((p) => p.id === "p");
  // 旧语义下这条会凭空消失，用户看到的是「我配的东西不见了」而无从下手。
  assert.ok(entry, "加载失败的条目也要列出来");
  assert.equal(entry.loaded, false);
  assert.match(entry.error, /未找到/);
});
