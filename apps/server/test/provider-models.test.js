/**
 * 「获取模型列表」的测试：provider 的实现层 + HTTP 端点层。
 *
 * 两家的响应体形状相同（`{data:[{id,...}]}`），差别只在鉴权头，所以这里
 * 刻意把**两个实现都真打一次** stub 上游并检查收到的请求头——只看返回值的话，
 * 「Anthropic 误用了 Bearer」这种错会完全看不出来。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.js";
import { AnthropicProvider } from "../src/core/provider/anthropic.js";
import { OpenAIProvider, normalizeModels } from "../src/core/provider/openai.js";
import { ProviderError } from "../src/core/provider/errors.js";

/**
 * 起一个假的上游：按 `respond` 决定怎么回，并把收到的请求记下来。
 * `GET /models` 与 `POST /chat/completions` 都走同一个处理器，
 * 因为「模型列表」与「真的能发消息」需要连起来验证。
 */
async function startUpstream(respond) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 一个总是回同一份模型列表的上游。 */
function modelsResponder(body, status = 200) {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

// --- normalizeModels --------------------------------------------------------

test("normalizeModels：去重 + 字典序 + 丢掉非字符串项", () => {
  const out = normalizeModels([
    { id: "b" },
    { id: "a" },
    { id: "b" },
    { id: 123 },
    { id: "" },
    null,
    { name: "没有 id" },
    "字符串项",
  ]);
  // 去重是必要的：有些网关会把同一个模型列两次（按不同 owner 分组），
  // 界面上就会出现两行一模一样的可点项。
  assert.deepEqual(out, ["a", "b"]);
});

test("normalizeModels：非数组（网关回了个对象）当作空列表", () => {
  assert.deepEqual(normalizeModels(undefined), []);
  assert.deepEqual(normalizeModels({ data: [] }), []);
  assert.deepEqual(normalizeModels("不是数组"), []);
});

// --- 实现层 -----------------------------------------------------------------

test("OpenAI：listModels 打 /models 并带 Bearer 鉴权", async (t) => {
  const upstream = await startUpstream(
    modelsResponder({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }),
  );
  t.after(() => upstream.stop());

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "sk-test",
    models: ["m"],
  });
  assert.deepEqual(await provider.listModels(), ["gpt-4o", "gpt-4o-mini"]);

  const [req] = upstream.seen;
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/v1/models");
  assert.equal(req.headers.authorization, "Bearer sk-test");
});

test("Anthropic：listModels 用 x-api-key 与 anthropic-version，不带 Bearer", async (t) => {
  const upstream = await startUpstream(
    modelsResponder({ data: [{ id: "claude-sonnet-4-5", display_name: "Sonnet" }] }),
  );
  t.after(() => upstream.stop());

  const provider = new AnthropicProvider({
    id: "c",
    baseUrl: upstream.baseUrl,
    apiKey: "sk-ant",
    models: ["m"],
  });
  assert.deepEqual(await provider.listModels(), ["claude-sonnet-4-5"]);

  const [req] = upstream.seen;
  assert.equal(req.url, "/v1/models");
  assert.equal(req.headers["x-api-key"], "sk-ant");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  // 带上 Bearer 会让 Anthropic 直接拒绝请求；这个断言防的是「照抄 OpenAI 实现」。
  assert.equal(req.headers.authorization, undefined);
});

test("密钥为空时不发鉴权头，让上游自己回 401", async (t) => {
  const upstream = await startUpstream(modelsResponder({ data: [] }));
  t.after(() => upstream.stop());

  const provider = new OpenAIProvider({ id: "p", baseUrl: upstream.baseUrl, models: ["m"] });
  await provider.listModels();
  // 不发一个空 Bearer：那会让上游的报错从「没给密钥」变成「密钥格式不对」，
  // 反而更难判断根因。
  assert.equal(upstream.seen[0].headers.authorization, undefined);
});

test("上游 401 归一成一句可读的话（密钥无效）", async (t) => {
  const upstream = await startUpstream(
    modelsResponder({ error: { message: "Invalid API key" } }, 401),
  );
  t.after(() => upstream.stop());

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "bad",
    models: ["m"],
  });
  await assert.rejects(
    () => provider.listModels(),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.status, 401);
      assert.match(err.message, /密钥无效/);
      // 上游原文要保留，否则用户拿不到能搜索的关键词。
      assert.match(err.detail, /Invalid API key/);
      return true;
    },
  );
});

test("上游没有 /models（404）时报「模型或接口不存在」", async (t) => {
  const upstream = await startUpstream(modelsResponder({ error: "Not Found" }, 404));
  t.after(() => upstream.stop());

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "k",
    models: ["m"],
  });
  await assert.rejects(
    () => provider.listModels(),
    (err) => err instanceof ProviderError && err.status === 404 && /不存在/.test(err.message),
  );
});

test("连不上上游时报网络错误，而不是伪装成空列表", async () => {
  // 先起再关，拿到一个确定没人监听的端口。
  const upstream = await startUpstream(modelsResponder({ data: [] }));
  const { baseUrl } = upstream;
  await upstream.stop();

  const provider = new OpenAIProvider({ id: "p", baseUrl, apiKey: "k", models: ["m"] });
  await assert.rejects(
    () => provider.listModels(),
    (err) => err instanceof ProviderError && /无法连接上游/.test(err.message),
  );
});

test("上游挂起不返回时按 timeoutMs 中断", async (t) => {
  const upstream = await startUpstream(() => {
    /* 故意什么都不回 */
  });
  t.after(() => upstream.stop());

  const provider = new OpenAIProvider({
    id: "p",
    baseUrl: upstream.baseUrl,
    apiKey: "k",
    models: ["m"],
    // 下限是 1000ms；测试里只验证「会超时」，不追求快。
    timeoutMs: 1000,
  });
  const started = Date.now();
  await assert.rejects(
    () => provider.listModels(),
    (err) => err instanceof ProviderError,
  );
  // 真的等了超时时长才失败，说明停的是那次 fetch 而不是别的东西。
  assert.ok(Date.now() - started >= 900, "应当在超时后才失败");
});

// --- HTTP 端点层 ------------------------------------------------------------

async function startApp() {
  const root = mkdtempSync(join(tmpdir(), "atri-models-"));
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

async function postJson(origin, cookie, path, body) {
  const res = await fetch(`${origin}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body ?? {}),
  });
  return { res, body: await res.json() };
}

test("端点：用已保存的源拉到模型列表", async (t) => {
  const upstream = await startUpstream(
    modelsResponder({ data: [{ id: "z-model" }, { id: "a-model" }] }),
  );
  const app = await startApp();
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const created = await postJson(app.origin, cookie, "/provider-sources", {
    id: "s1",
    type: "openai",
    baseUrl: upstream.baseUrl,
    apiKey: "sk-1",
  });
  assert.equal(created.res.status, 201);

  const { res, body } = await postJson(app.origin, cookie, "/provider-sources/s1/models");
  assert.equal(res.status, 200);
  assert.deepEqual(body.models, ["a-model", "z-model"]);
});

test("端点：未知的源回 404", async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  const { res, body } = await postJson(app.origin, cookie, "/provider-sources/没有这个/models");
  assert.equal(res.status, 404);
  assert.match(body.error, /未找到/);
});

test("端点：上游没有 /models 时回 400 并给出可读原因", async (t) => {
  const upstream = await startUpstream(modelsResponder({ error: "no such route" }, 404));
  const app = await startApp();
  t.after(() => upstream.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  await postJson(app.origin, cookie, "/provider-sources", {
    id: "s2",
    type: "openai",
    baseUrl: upstream.baseUrl,
    apiKey: "k",
  });

  const { res, body } = await postJson(app.origin, cookie, "/provider-sources/s2/models");
  // 400 而不是 502：网关没有 /models 是**用户可修**的配置问题，
  // 前端据此引导去用「自定义模型」手填。
  assert.equal(res.status, 400);
  assert.match(body.error, /不存在/);
});

test("端点：不接受请求体里的 baseUrl / apiKey（否则成了任意地址转发器）", async (t) => {
  const evil = await startUpstream(modelsResponder({ data: [{ id: "被偷的模型" }] }));
  const app = await startApp();
  t.after(() => evil.stop());
  t.after(() => app.stop());

  const cookie = await login(app.origin);
  await postJson(app.origin, cookie, "/provider-sources", { id: "s3", type: "openai" });

  const { body } = await postJson(app.origin, cookie, "/provider-sources/s3/models", {
    baseUrl: evil.baseUrl,
    apiKey: "偷来的",
  });
  // 请求体被完全忽略：打的是源上保存的空 baseUrl（实现类默认地址），
  // 因此拿不到 evil 那份列表，也说明它没有成为转发器。
  assert.notDeepEqual(body.models, ["被偷的模型"]);
  assert.equal(evil.seen.length, 0, "不该向上游发出任何请求");
});
