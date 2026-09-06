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
import type { IncomingHttpHeaders, Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "#app.ts";
import { AnthropicProvider } from "#core/provider/anthropic.ts";
import { OpenAIProvider, normalizeModels } from "#core/provider/openai.ts";
import { ProviderError } from "#core/provider/errors.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 桩上游的应答器：自己决定往 `res` 上写什么。
 * 允许「什么都不写」——测超时用的就是这种（`timeoutMs` 那条用例）。
 */
type StubResponder = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * 桩上游记下的一次请求。
 * `method` / `url` 在 Node 的类型上本来就是 `string | undefined`（还未 route 的请求
 * 可以是空），不是我们把它写宽了。
 */
interface StubRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

/**
 * 桩上游的请求日志：一个「至少已经收到一次请求」的数组。
 *
 * 为什么不是 `StubRequest[]`：断言行在本次迁移里逐字冻结（本仓没有快照机制，靠的是人工比对迁移前后的输出），而
 * `noUncheckedIndexedAccess` 会让 `seen[0]` 与 `const [req] = seen` 的读法带
 * `undefined`，那些直接按下标读日志的断言就加不了守卫。这几个用例读首项时上游必然已被
 * provider 打过一次（就在上一行），所以类型上写成首项必填；真的空了（用例自己写错）
 * 运行时仍是 TypeError，与迁移前 `any[]` 的表现一致，断言没有被放宽。
 * 只读长度不读首项的那条（`evil.seen.length === 0`）不受这个假设影响。
 */
type StubLog = [StubRequest, ...StubRequest[]];

/**
 * 桩上游绑定后取它的 TCP 端口。
 *
 * `server.address()` 的类型是 `AddressInfo | string | null`（TCP / Unix socket / 未监听
 * 三种状态都共用这一个方法）。这里用运行时判断而不是 `as AddressInfo`：真的没监听上时
 * 要得到一句说得通的错误，而不是在模板串里冒出 TypeError。
 */
function listenPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`桩上游未绑定 TCP 端口（address=${String(address)}）`);
  }
  return address.port;
}

/**
 * 起一个假的上游：按 `respond` 决定怎么回，并把收到的请求记下来。
 * `GET /models` 与 `POST /chat/completions` 都走同一个处理器，
 * 因为「模型列表」与「真的能发消息」需要连起来验证。
 */
async function startUpstream(respond: StubResponder) {
  const seen: StubRequest[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });
  // `listen` 的回调类型是 `() => void`，直接把 Promise 的 resolve 递过去会带上一个
  // 必填参数而不匹配，所以包一层空参箭头函数。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = listenPort(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    // 收窄见 StubLog 的说明：请求确实发生过才读它，这里只是把类型写出来。
    seen: seen as StubLog,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 一个总是回同一份模型列表的上游。 */
function modelsResponder(body: unknown, status = 200): StubResponder {
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
      // `detail` 在 ProviderError 上是可选的（上游回了空体时就没有），而 401 这条路径
      // 必然带上原文；先做这个运行时守卫，`assert.match` 才拿得到一个 `string`。
      if (typeof err.detail !== "string") {
        throw new Error(`ProviderError 缺少上游原文: ${err.message}`);
      }
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
  // 共享 fixture 的默认值与迁移前这里手抄的那份逐字段相同
  // （`"atri_session"` 就是 `DEFAULT_AUTH_COOKIE_NAME`），所以换成它不改变行为。
  const app = await createApp(makeTestConfig({ root }));
  await app.start();
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    stop: async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function login(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(res.status, 200);
  // `Headers.get()` 的类型是 `string | null`，第一个分段才是要回传的 `name=value`。
  // 缺头说明登录根本没成功（`res.status` 那条断言在之前就兜住了），这里用抛错做守卫，
  // 不新增 assert 行：断言序列是这次迁移的比对基线。
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");
  return cookie;
}

/**
 * 这几个用例从响应体里读到的键。
 *
 * 为什么收成**一处**而不是每个端点一个形状：`Response.json()` 的返回是 `unknown`，
 * 必须在某个地方收窄；而这几根键就是全部读法，在 `postJson()` 的返回类型上写一次，
 * 比在四个调用点各抄一遍形状更好（形状走散时最先烂掉的就是测试）。
 * 键都写成必填：实际每个响应只填其中一根（见 `src/api/server.ts` 的各 handler），
 * 读到不存在的键在运行时是 undefined，与迁移前一模一样，断言该失败时照样失败。
 */
interface ApiBody {
  /** `/provider-sources/:id/models` 成功时的模型列表。 */
  models: string[];
  /** 失败响应：`{ error: "<中文说明>" }`（见 `api/http.ts` 的 sendError）。 */
  error: string;
}

async function postJson(
  origin: string,
  cookie: string,
  path: string,
  body?: unknown,
): Promise<{ res: Response; body: ApiBody }> {
  const res = await fetch(`${origin}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body ?? {}),
  });
  // 边界收窄：`Response.json()` 的返回是 `unknown`（JSON 里可以有任何东西）。
  return { res, body: (await res.json()) as ApiBody };
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
