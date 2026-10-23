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
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "#app.ts";
import { configFilePath, providersFilePath } from "#config/file.ts";
import type { FileConfig } from "#config/file.ts";
import { DEFAULT_PROFILE_ID, profileConfigPath, profilesRoot } from "#config/profiles.ts";
import type { SourceEntry } from "#core/provider/store.ts";
import type { ProviderListItem, ProviderMutationResult } from "#api/server.ts";
import { makeTestConfig } from "./helpers/config.ts";
import type { ProfileRecord, Session } from "@atri/shared";

/**
 * 桩上游记下的一次补全请求。
 * `url` 在 Node 的类型上本来就可为 undefined，不是把它写宽了。
 */
interface SeenRequest {
  url: string | undefined;
  /** 上游收到的请求体。桩上游只会被打 `POST /chat/completions`，所以是补全参数。 */
  body: { model?: string; messages?: unknown };
}

/**
 * 桩上游的请求日志。
 *
 * `at()` 在 `Array<T>` 上的返回类型带 `| undefined`（越界就是 undefined），而断言行在本次
 * 迁移里逐字冻结（本仓没有快照机制，靠的是人工比对迁移前后的输出），那条读 `seen.at(-1).body.model` 的断言加不了守卫。
 * 用例读的都是**刚刚发生的那一次请求**（上一行才发过消息），所以这里把返回收窄成
 * `SeenRequest`；真的没有请求时运行时仍是 TypeError，与迁移前 `any[]` 的表现一致。
 */
interface RequestLog extends Array<SeenRequest> {
  at(index: number): SeenRequest;
}

/**
 * 桩上游绑定后取它的 TCP 端口。
 *
 * `server.address()` 的类型是 `AddressInfo | string | null`（TCP / Unix socket / 未监听
 * 共用一个方法）。这里用运行时判断而不是 `as AddressInfo`：真没监听上时要得到一句
 * 说得通的错误，而不是在模板串里冒出 TypeError（`src/api/server.ts` 的 `address()` 同形）。
 */
function listenPort(server: Server): number {
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error(`桩上游未绑定 TCP 端口（address=${String(bound)}）`);
  }
  return bound.port;
}

/**
 * 一个最小的上游：记下每次收到的请求，并按 `label` 回一句固定的流式回复。
 * 回复里带上 label，就能从聊天结果反推「这次到底打了哪个上游」。
 */
async function startUpstream(label: string) {
  // 暴露出去时收窄成 RequestLog，理由见那儿的说明。
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  // `listen` 的回调类型是 `() => void`，直接把 Promise 的 resolve 递过去会带上一个
  // 必填参数而不匹配，所以包一层空参箭头函数。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = listenPort(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen: seen as RequestLog,
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
async function startApp(t: TestContext, preset?: FileConfig) {
  const root = mkdtempSync(join(tmpdir(), "atri-routes-"));
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  if (preset) writeFileSync(configFilePath(root), `${JSON.stringify(preset, null, 2)}\n`);
  // `dataDir` 写出来而不是吃 helper 的默认值：下面要按它算出配置档文件的路径，
  // 让 helper 的默认值偷偷参与，测试就在断言一个它自己没说明的位置。
  const dataDir = join(root, "data");
  // 共享 fixture 的默认值与迁移前这里手抄的那份逐字段相同
  // （`"atri_session"` 就是 `DEFAULT_AUTH_COOKIE_NAME`），所以换成它不改变行为。
  const app = await createApp(makeTestConfig({ root, dataDir }));
  await app.start();
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    root,
    /** 全局供应商配置落在那个文件上（连接与密钥是部署级一份，不再按档）。 */
    providersPath: providersFilePath(dataDir),
    /** 唯一那份配置档的文件：本条要证「供应商的写**不碰**它」。 */
    profilePath: profileConfigPath(profilesRoot(dataDir), DEFAULT_PROFILE_ID),
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
  // 缺头就意味着登录没成功（上一行的状态码断言先兜住），这里用抛错做类型守卫，
  // 不新增断言行：断言序列是本次迁移的比对基线。
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");
  return cookie;
}

/** provider 实例在 HTTP 层的视图（`default`/`loaded`/`error` 这几根键只在这条路由上出现），
 *  与写操作的返回形状都直接从 `src/api/server.ts` 导入 —— 测试不另述一份，
 *  否则接口改了形状而测试还绿，就等于没在测。 */

/**
 * `call()` 的返回体形状：这几个用例里被断言读到的那些键。
 *
 * 为什么是「一根类型上多根键都必填」而不是每个端点一个形状：有 5 处断言把
 * `await get(...)` 直接内联写在断言里（列表端点那几条），而断言行在本次迁移中逐字冻结
 * （本仓没有快照机制，靠的是人工比对迁移前后的输出），内联的调用点加不了类型参数，于是 `call()` 的返回体只能有**一个**形状。
 * 实际每个响应只填其中一根键（见 `src/api/server.ts` 的各 handler），读到不存在的键在
 * 运行时是 undefined，与迁移前一模一样，断言该失败时照样失败。
 *
 * 为什么 `sources` / `providers` 是「首项必填」的元组：`noUncheckedIndexedAccess` 让
 * 普通数组的 `[0]` 带 undefined，而有一处内联断言读 `providers[0].default`——那条用例
 * 刚刚创建并把这一项设成了默认，空列表时它本来就该失败。
 */
interface ApiBody {
  source: SourceEntry;
  sources: [SourceEntry, ...SourceEntry[]];
  provider: ProviderMutationResult;
  providers: [ProviderListItem, ...ProviderListItem[]];
  /** 删源返回的被删 id 列表（删实例返回的是单个 id，那几个用例不读它）。 */
  deleted: string[];
  /** 失败响应：`{ error: "<中文说明>" }`（见 `api/http.ts` 的 sendError）。 */
  error: string;
  /** `GET /profiles` 的列表；只有少数用例读它。 */
  profiles: { id: string; defaultProviderId: string | null }[];
  /** 档级默认那条端点的返回：`{ profile: ProfileRecord }`。 */
  profile: ProfileRecord;
  session: Session;
}

function call(
  origin: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: ApiBody }> {
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    // GET 不允许带 body，连值为 undefined 的键都不能出现。
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (res) => ({
    status: res.status,
    // 边界收窄：`Response.json()` 的返回是 `unknown`（JSON 里可以有任何东西）。
    body: (await res.json()) as ApiBody,
  }));
}

const get = (o: string, c: string, p: string) => call(o, c, "GET", p);
const post = (o: string, c: string, p: string, b?: unknown) => call(o, c, "POST", p, b);
const del = (o: string, c: string, p: string) => call(o, c, "DELETE", p);

/** 建会话、发一条消息、读完整条 SSE，返回助手回复文本。 */
async function chat(
  origin: string,
  cookie: string,
  model?: string,
  profile: string = DEFAULT_PROFILE_ID,
): Promise<string> {
  const { body: created } = await post(origin, cookie, "/sessions", { title: "t" });
  const res = await fetch(
    `${origin}/api/v1/sessions/${created.session.id}/messages/stream?profile=${profile}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "你好", model }),
    },
  );
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

  // 禁用中的实例不能当默认：否则保存成功、下一条消息却静默回退到别的模型。
  const rejectedDefault = await post(app.origin, cookie, "/providers/s-model-a", {
    default: true,
  });
  assert.equal(rejectedDefault.status, 400);
  assert.equal(
    (await post(app.origin, cookie, "/providers/s-model-a", { enabled: true })).status,
    200,
  );
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

test("级联删除源时，配置档里指向被删模型的默认引用也一起清掉", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  await post(app.origin, cookie, "/provider-sources", { id: "s" });
  await post(app.origin, cookie, "/providers", { id: "p1", source: "s", model: "m1" });
  const setDefault = await post(
    app.origin,
    cookie,
    `/profiles/${DEFAULT_PROFILE_ID}/default-provider`,
    { providerId: "p1" },
  );
  assert.equal(setDefault.status, 200);

  const cascaded = await del(app.origin, cookie, "/provider-sources/s?cascade=1");
  assert.equal(cascaded.status, 200);
  assert.equal(
    (JSON.parse(readFileSync(app.profilePath, "utf8")) as Record<string, unknown>).defaultProvider,
    undefined,
    "档里的默认引用必须随级联删除一起消失",
  );
  const profiles = (await get(app.origin, cookie, "/profiles")).body.profiles;
  assert.equal(
    profiles.find((row) => row.id === DEFAULT_PROFILE_ID)?.defaultProviderId,
    null,
    "目录状态也要同步清空",
  );
});

/**
 * 「档级默认」是这次改动里唯一一条**写在档里的**供应商引用，所以它要能被真的看见：
 * 两份档各自默认打不同上游，不带 `model` 的消息各走各的。
 *
 * 为什么必须端到端证：`defaultProviderId` 的生效次序（请求带的 → 档的 → 全局的）落在
 * 引擎与装配两处，任何一处接错都得到「A 档发的消息打了 B 的模型」这种只在多档部署上
 * 才出现的错 —— 而它的界面症状只是「回复不太对」，没人会想到是选路。
 */
test("路由：两份配置档各设默认，不带 model 的消息各打各的上游", async (t) => {
  const upstreamA = await startUpstream("来自 A");
  const upstreamB = await startUpstream("来自 B");
  const app = await startApp(t);
  t.after(() => upstreamA.stop());
  t.after(() => upstreamB.stop());
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  // 两个源与两个实例都建在**全局那一份**里（不带 profile）。
  await post(app.origin, cookie, "/provider-sources", {
    id: "a",
    type: "openai",
    baseUrl: upstreamA.baseUrl,
    apiKey: "k",
  });
  await post(app.origin, cookie, "/providers", { id: "a-m", source: "a", model: "m" });
  await post(app.origin, cookie, "/provider-sources", {
    id: "b",
    type: "openai",
    baseUrl: upstreamB.baseUrl,
    apiKey: "k",
  });
  await post(app.origin, cookie, "/providers", { id: "b-m", source: "b", model: "m" });

  // 第二份档由 API 建。
  const other = "second-profile";
  assert.equal((await post(app.origin, cookie, "/profiles", { id: other })).status, 201);

  // 各设一个默认。**刻意不设全局 `providers.default`**：那一级的回退由上一条用例管，
  // 这里要单独证「档里那一级不是靠全局兜住的」。
  assert.equal(
    (
      await post(app.origin, cookie, `/profiles/${DEFAULT_PROFILE_ID}/default-provider`, {
        providerId: "a-m",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post(app.origin, cookie, `/profiles/${other}/default-provider`, {
        providerId: "b-m",
      })
    ).status,
    200,
  );

  assert.equal(await chat(app.origin, cookie, undefined), "来自 A");
  assert.equal(await chat(app.origin, cookie, undefined, other), "来自 B");
  // 请求里显式带的 model 仍然是第一级：档默认只补空缺，不覆盖明确的选择。
  assert.equal(await chat(app.origin, cookie, "b-m"), "来自 B");
  assert.equal(await chat(app.origin, cookie, "b-m", other), "来自 B");

  // 发给上游的是配置里的模型名，不是实例 id（`#modelFor` 那一层）。
  assert.equal(upstreamB.seen.at(-1).body.model, "m");

  // 落盘：写进各自档文件，而全局那份一个字节都没动（档默认不是供应商配置）。
  const globalFile = readFileSync(app.providersPath, "utf8");
  assert.doesNotMatch(globalFile, /second-profile/);
  const providers = (await get(app.origin, cookie, "/providers")).body.providers;
  assert.deepEqual(
    providers.map((x) => x.default),
    providers.map(() => false),
    "没有任何一条被设成默认，`default` 标注必须全是 false",
  );
});

test("路由：把档默认指向清单里没有的 id 必须被拒，且档文件不许被改", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);
  const before = readFileSync(app.profilePath, "utf8");

  const res = await post(app.origin, cookie, `/profiles/${DEFAULT_PROFILE_ID}/default-provider`, {
    providerId: "ghost",
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /全局供应商清单里没有/);
  assert.equal(readFileSync(app.profilePath, "utf8"), before, "被拒的写入还是碰到了档文件");

  // 省略 `providerId` 与「显式清空」是两件事：前者必须被拒，
  // 否则一次误发的空请求就会悄悄改掉某一档的默认模型。
  const bare = await post(
    app.origin,
    cookie,
    `/profiles/${DEFAULT_PROFILE_ID}/default-provider`,
    {},
  );
  assert.equal(bare.status, 400);

  // 清空要成功，而且**真的删掉那个键**（留一个空串会让下一次读它的人判断两次）。
  await post(app.origin, cookie, "/providers", { id: "p", model: "m" });
  const ok = await post(app.origin, cookie, `/profiles/${DEFAULT_PROFILE_ID}/default-provider`, {
    providerId: "p",
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.profile.defaultProviderId, "p");
  const cleared = await post(
    app.origin,
    cookie,
    `/profiles/${DEFAULT_PROFILE_ID}/default-provider`,
    { providerId: null },
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.profile.defaultProviderId, null);
  assert.equal(
    (JSON.parse(readFileSync(app.profilePath, "utf8")) as Record<string, unknown>).defaultProvider,
    undefined,
    "清空之后档文件里还留着那个键",
  );
});

// --- 落盘与实时生效 ---------------------------------------------------------

test("路由：改动写进全局 providers.json，而配置档与部署级文件一个字节都不动", async (t) => {
  // 预置别的设置：provider 写入是读-改-写，一次失手就会连带抹掉这些敏感项。
  const app = await startApp(t, {
    port: 0,
    auth: { adminUser: "admin", adminPassword: "keep-me" },
    pluginDirs: ["./plugins"],
  });
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  // 启动之后取一次快照：本条要证的是「写入之后部署级文件与写入前**逐字节相同**」，
  // 而不是「里面还有那几个键」。seed 只在配置档不存在时动一次，之后这条路径没人再碰它。
  const bootstrapBefore = readFileSync(configFilePath(app.root), "utf8");
  const profileBefore = readFileSync(app.profilePath, "utf8");

  await post(app.origin, cookie, "/provider-sources", {
    id: "s",
    type: "anthropic",
    apiKey: "sk-x",
  });
  await post(app.origin, cookie, "/providers", { id: "p", source: "s", model: "claude-x" });

  const globalFile = JSON.parse(readFileSync(app.providersPath, "utf8"));
  assert.equal(globalFile.providerSources.s.type, "anthropic");
  assert.equal(globalFile.providers.p.model, "claude-x");
  // 供应商的写**不碰任何配置档**：那正是「全局一份」的全部含义。少了这一句，
  // 「两处都写了一份」照样绿，而两处都写就是两个真源。
  assert.equal(readFileSync(app.profilePath, "utf8"), profileBefore, "供应商的写动到了配置档文件");

  const bootstrap = JSON.parse(bootstrapBefore);
  assert.equal(bootstrap.auth.adminUser, "admin");
  assert.equal(bootstrap.auth.adminPassword, "keep-me");
  assert.deepEqual(bootstrap.pluginDirs, ["./plugins"]);
  // 反向也要钉住：运行期的段不得回流到部署级文件（那会造出第二个真源，
  // 而下一次 seed 已经不会再跑，两边就会永久分叉）。
  assert.equal(bootstrap.providerSources, undefined);
  assert.equal(bootstrap.providers, undefined);
  assert.equal(readFileSync(configFilePath(app.root), "utf8"), bootstrapBefore);
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
  const file = JSON.parse(readFileSync(app.providersPath, "utf8"));
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
  // `error` 在 HTTP 视图上只在 `loaded: false` 时才出现（见 api/server.ts 的 GET /providers），
  // 而这条用例验的正是「失败必须给原因」。先做运行时守卫让类型收窄，不新增断言行：
  // 断言序列是本次迁移的比对基线。
  if (typeof entry.error !== "string") {
    throw new Error("加载失败的条目没有带上 error 原因");
  }
  assert.match(entry.error, /未找到/);
});

/**
 * 5xx 的原文不回客户端 —— 只在 HTTP 层才成立的那一半。
 *
 * `store.ts` 把落盘故障包成 `ApiError(…, 500)` 是单元层面测过的；这里要证的是**响应体**里
 * 没有配置文件的绝对路径。这条以前是破的：十个 handler 各写一遍
 * `sendError(res, statusForError(err), errorMessage(err))`，而 `errorMessage` 那句里
 * 带着 `${this.filePath}`，于是 500 把 `/run/user/…/atri.config.json` 原样发出去了，
 * 而同一个文件的顶层兜底早就规定了「500 的文案固定、细节只在日志」。
 */
test("路由：存储故障回固定文案的 500，不把配置文件的路径回出去", async (t) => {
  const app = await startApp(t);
  t.after(() => app.stop());
  const cookie = await login(app.origin);

  // 启动之后再把**全局供应商文件**改坏：store 每次写都现读它，所以这一步必然让下一次
  // 写入失败（它不把坏文件当成空配置，那是更严重的故障）。改 bootstrap 是没用的 —— 运行期没人读它。
  const broken = "{ 这不是 JSON";
  writeFileSync(app.providersPath, broken, "utf8");

  const res = await post(app.origin, cookie, "/provider-sources", {
    id: "probe",
    type: "openai",
    baseUrl: "https://example.test/v1",
  });
  assert.equal(res.status, 500);
  // 固定文案，且这一条对「存储层自己包好的那句」也成立：判据是「凡是 5xx 都不往外说」，
  // 不是「这条消息看起来安全」。后者要求每一次抛错的人都判断对一次。
  assert.equal(res.body.error, "服务器内部错误，详情见服务端日志");
  // 整个响应体里都不该出现路径：临时目录名、两层配置文件的**目录与文件名**都是可辨认的记号，
  // 缺了后一条的话，配置档那句「…/profiles/default/config.json」就能原样漏出去。
  assert.doesNotMatch(JSON.stringify(res.body), /atri-routes|atri\.config\.json|providers\.json/);
  // 坏文件仍在原地，没被「顺手」覆盖掉 —— 覆盖等于把用户的其它设置抹了。
  assert.equal(readFileSync(app.providersPath, "utf8"), broken);

  // **这份坏文件不许把每一档都拖成 failed**：以前只坏一档，现在全局一份读坏如果上抛，
  // 症状是整个服务全部 503，而那一刻操作者最需要它活着去改这个文件。
  const profiles = (
    await fetch(`${app.origin}/api/v1/profiles`, {
      headers: { cookie },
    })
  ).json() as Promise<{ profiles: { id: string; status: string }[] }>;
  assert.deepEqual(
    (await profiles).profiles.map((x) => [x.id, x.status]),
    [[DEFAULT_PROFILE_ID, "ready"]],
    "全局供应商文件读坏之后，配置档不该被算成 failed",
  );
  // 而它必须**说得出原因**：空清单与「读不出来」是两件事，混起来用户会去检查一个
  // 本来就空的配置。
  const listed = await get(app.origin, cookie, "/providers");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.providers, []);
  assert.match(String(listed.body.error), /不是合法 JSON/);
});

/**
 * 补上被引用的源之后，那条旧错误必须从 `GET /providers` 上消失。
 *
 * 这条钉的是「错误表**整份重写**而不是累加」。它以前不存在是因为错误由 HTTP 层现算
 *（在请求里再跑一遍工厂），而那个形状有它自己的问题（见 `ProfileBundle.providerLoadErrors`）。
 * 改成由装配那一次记下错误之后，漏掉 `clear()` 的形态是：配置修好了、注册表也重建了，
 * 界面却继续挂着上一轮的「未找到 id 为「ghost」的 provider source」——
 * 而这一句读起来像是「还没修好」，用户会照着它去检查一个已经正确的配置。
 */
test("引用不到源、修好、再禁用：禁用后的原因不许还是上一轮那句「未找到」", async (t) => {
  const app = await startApp(t, {
    providerSources: { s: { type: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k" } },
    providers: { p: { source: "ghost", model: "m" } },
  });
  t.after(() => app.stop());
  const cookie = await login(app.origin);
  const entry = async () =>
    (await get(app.origin, cookie, "/providers")).body.providers.find((x) => x.id === "p");

  const broken = await entry();
  assert.ok(broken, "前提：引用不到源的条目也要列出来");
  assert.equal(broken.loaded, false);
  assert.match(String(broken.error), /未找到/);

  // 先把源补上。这一步的重建**不再产出任何错误**，而 `p` 变成 `loaded: true` ——
  // 于是错误表里的陈旧条目在这一刻是**看不见**的（`error` 只在 `loaded: false` 时输出）。
  const created = await post(app.origin, cookie, "/provider-sources", {
    id: "ghost",
    type: "openai",
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
  });
  assert.equal(created.status, 201);
  const repaired = await entry();
  assert.ok(repaired, "补上源之后这一条仍要在列表里");
  assert.equal(repaired.loaded, true, "补上源之后这一条就该是已加载");

  // 再把它禁用 —— 这才是能观察出「错误表是整份重写还是累加」的那一步：工厂对禁用的条目
  // 不产出错误（只 log 一句「已禁用，跳过加载」），所以它 `loaded: false` 而**没有对应原因**。
  // 如果上一步的陈旧条目还留着，这里回出去的就是「未找到 provider source」，
  // 而那句话读起来像「还没修好」，用户会照着它去检查一个已经正确的配置。
  assert.equal((await post(app.origin, cookie, "/providers/p", { enabled: false })).status, 200);
  const disabled = await entry();
  assert.ok(disabled);
  assert.equal(disabled.loaded, false);
  assert.doesNotMatch(
    String(disabled.error),
    /未找到/,
    "重建之后的列表里不该再挂着上一轮那条「未找到 provider source」",
  );
  assert.match(String(disabled.error), /已禁用/, "主动禁用不能显示成「加载失败」");
});
