import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createApp } from "../src/app.ts";
import { resolveStaticPath } from "../src/api/server.ts";
import { DEFAULT_AUTH_COOKIE_NAME, API_PREFIX } from "@atri/shared";

/**
 * 端到端：起一个真实的 HTTP 服务，用真实请求走完
 * 「401 -> 登录 -> 受保护接口可用 -> 登出 -> 又回到 401」。
 *
 * 之所以不 mock：本任务最容易出错的地方恰恰在接线——Cookie 属性、闸门位置、
 * SPA 回退的边界，只有真跑起来才会暴露。而 `resolveStaticPath` 是例外，
 * 它在 HTTP 层几乎不可能被触发（理由见该函数注释），因此单独做单元测试。
 */
async function startServer(t, { auth: authOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atri-http-"));
  const staticDir = join(root, "dist");
  mkdirSync(staticDir, { recursive: true });

  const config = {
    root,
    host: "127.0.0.1",
    port: 0, // 随机端口，避免测试之间抢端口
    logLevel: "error",
    dataDir: join(root, "data"),
    pluginDirs: [],
    adapters: {},
    providers: {},
    auth: {
      adminUser: "admin",
      adminPassword: "pw-for-test",
      cookieName: DEFAULT_AUTH_COOKIE_NAME,
      cookieSecure: false,
      staticDir,
      ...authOverrides,
    },
  };

  const app = await createApp(config);
  await app.start();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => app.stop());

  const port = app.address().port;
  return {
    config,
    staticDir,
    port,
    origin: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}${API_PREFIX}`,
  };
}

/** 手动管理 Cookie：Node 的 fetch 没有 cookie jar，正好用来逐条断言属性。 */
async function call(base, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    // GET 不允许带 body，无请求体时连这个键都不能出现。
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, setCookie: res.headers.getSetCookie() };
}

/** 从 Set-Cookie 里取出 `name=value`，便于下一步放进 Cookie 头。 */
function cookiePair(setCookieHeaders, name = DEFAULT_AUTH_COOKIE_NAME) {
  const header = setCookieHeaders.find((h) => h.startsWith(`${name}=`));
  return header ? header.split(";")[0] : null;
}

const CREDS = { username: "admin", password: "pw-for-test" };

test("未登录访问受保护接口一律 401", async (t) => {
  const { base } = await startServer(t);

  for (const path of ["/sessions", "/plugins", "/providers", "/adapters", "/auth/me"]) {
    const res = await call(base, path);
    assert.equal(res.status, 401, `${path} 应当要求登录`);
    assert.equal(res.body.error, "未认证");
  }
});

test("未登录访问 provider 配置接口一律 401", async (t) => {
  const { base } = await startServer(t);

  // 这些接口会返回**明文 API Key**，也会改写 atri.config.json。
  // 少漏一条就是未认证的读写通道，所以逐条按方法覆盖，而不是只测列表接口。
  const cases = [
    ["GET", "/provider-sources"],
    ["POST", "/provider-sources"],
    ["POST", "/provider-sources/s"],
    ["DELETE", "/provider-sources/s"],
    ["POST", "/provider-sources/s/models"],
    ["POST", "/providers"],
    ["POST", "/providers/p"],
    ["DELETE", "/providers/p"],
  ];

  for (const [method, path] of cases) {
    // `base` 里已经带了 API_PREFIX，这里只拼路由部分——拼两遍会打到一条
    // 不存在的路径上，那样测的就成了「未知路径也 401」，而不是这些路由本身。
    const res = await call(base, path, {
      method,
      ...(method === "GET" || method === "DELETE" || path.endsWith("/models")
        ? {}
        : { body: { id: "x" } }),
    });
    assert.equal(res.status, 401, `${method} ${path} 应当要求登录`);
    assert.equal(res.body.error, "未认证");
  }
});

test("登录后 provider 配置接口可达（证明上一条测的是这些路由本身）", async (t) => {
  const { base } = await startServer(t);
  const login = await call(base, "/auth/login", { method: "POST", body: CREDS });
  const cookie = cookiePair(login.setCookie);

  // 没有这条正向断言，上面的用例即使把路径拼错（打到不存在的路径上，
  // fail-closed 也会回 401）看起来照样是绿的。
  const listed = await call(base, "/provider-sources", { cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { sources: [] });
});

test("公开接口无需登录即可访问", async (t) => {
  const { base } = await startServer(t);

  const health = await call(base, "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // 登录页要能在拿到身份之前就问出「要不要登录」。
  const status = await call(base, "/auth/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { required: true });
});

test("登录失败一律 401，且不区分用户名错与口令错", async (t) => {
  const { base } = await startServer(t);

  const wrongPass = await call(base, "/auth/login", {
    method: "POST",
    body: { username: "admin", password: "nope" },
  });
  const wrongUser = await call(base, "/auth/login", {
    method: "POST",
    body: { username: "root", password: "pw-for-test" },
  });

  assert.equal(wrongPass.status, 401);
  assert.equal(wrongUser.status, 401);
  // 两条消息必须完全一致，否则等于把「用户名是否存在」告诉了攻击者。
  assert.equal(wrongPass.body.error, wrongUser.body.error);
  assert.equal(wrongPass.setCookie.length, 0, "登录失败不得下发 Cookie");
});

test("缺少字段返回 400（而不是 401）", async (t) => {
  const { base } = await startServer(t);
  const res = await call(base, "/auth/login", { method: "POST", body: { username: "admin" } });
  assert.equal(res.status, 400);
});

test("登录成功下发 HttpOnly Cookie，并可用它访问受保护接口", async (t) => {
  const { base } = await startServer(t);

  const login = await call(base, "/auth/login", { method: "POST", body: CREDS });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, "admin");
  assert.ok(login.body.expiresAt);

  const raw = login.setCookie.join("\n");
  assert.match(raw, /HttpOnly/, "令牌必须不可被脚本读取");
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Path=\//);
  assert.match(raw, /Max-Age=1296000/, "Max-Age 应当等于 15 天");
  assert.ok(!/Secure/.test(raw), "默认明文部署不应带 Secure，否则浏览器直接丢弃");

  const cookie = cookiePair(login.setCookie);
  assert.ok(cookie, "应当能在 Set-Cookie 里找到会话 Cookie");

  const me = await call(base, "/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, "admin");

  const sessions = await call(base, "/sessions", { cookie });
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray(sessions.body.sessions));
});

test("会话详情回带消息历史，未知 id 返回 404", async (t) => {
  const { base } = await startServer(t);
  const login = await call(base, "/auth/login", { method: "POST", body: CREDS });
  const cookie = cookiePair(login.setCookie);

  const created = await call(base, "/sessions", {
    method: "POST",
    body: { title: "恢复用" },
    cookie,
  });
  assert.equal(created.status, 201);
  const id = created.body.session.id;

  // 发一条消息，制造历史。
  const sent = await call(base, `/sessions/${id}/messages`, {
    method: "POST",
    body: { content: "你好" },
    cookie,
  });
  assert.equal(sent.status, 200);

  const detail = await call(base, `/sessions/${id}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.title, "恢复用");
  assert.equal(detail.body.session.messages.length, 2, "应当同时有用户与助手两条");
  assert.deepEqual(
    detail.body.session.messages.map((m) => m.role),
    ["user", "assistant"],
  );

  // 列表接口仍然只回摘要，不把消息内容搬过来。
  const list = await call(base, "/sessions", { cookie });
  assert.equal(list.body.sessions[0].messages, undefined);

  assert.equal((await call(base, "/sessions/does-not-exist", { cookie })).status, 404);
});

test("带上伪造的令牌仍然 401", async (t) => {
  const { base } = await startServer(t);
  const res = await call(base, "/sessions", {
    cookie: `${DEFAULT_AUTH_COOKIE_NAME}=00000000-0000-0000-0000-000000000000`,
  });
  assert.equal(res.status, 401);
});

test("登出后原令牌立即失效，且登出幂等", async (t) => {
  const { base } = await startServer(t);
  const login = await call(base, "/auth/login", { method: "POST", body: CREDS });
  const cookie = cookiePair(login.setCookie);
  assert.equal((await call(base, "/sessions", { cookie })).status, 200);

  const out = await call(base, "/auth/logout", { method: "POST", cookie });
  assert.equal(out.status, 200);
  assert.ok(
    out.setCookie.some((h) => /Max-Age=0/.test(h)),
    "登出应当清 Cookie",
  );

  assert.equal((await call(base, "/sessions", { cookie })).status, 401, "登出后旧令牌必须失效");

  // 未登录时再登出一次也要 200：否则前端会卡在「登不出去」的状态。
  assert.equal((await call(base, "/auth/logout", { method: "POST" })).status, 200);
});

test("多个浏览器会话互不影响，登出一个不牵连另一个", async (t) => {
  const { base } = await startServer(t);

  const a = cookiePair(
    (await call(base, "/auth/login", { method: "POST", body: CREDS })).setCookie,
  );
  const b = cookiePair(
    (await call(base, "/auth/login", { method: "POST", body: CREDS })).setCookie,
  );
  assert.notEqual(a, b);

  await call(base, "/auth/logout", { method: "POST", cookie: a });
  assert.equal((await call(base, "/sessions", { cookie: a })).status, 401);
  assert.equal((await call(base, "/sessions", { cookie: b })).status, 200, "另一个会话不应被牵连");
});

test("下发 Secure 属性后带上它（前置 HTTPS 场景）", async (t) => {
  const { base } = await startServer(t, { auth: { cookieSecure: true } });
  const login = await call(base, "/auth/login", { method: "POST", body: CREDS });
  assert.match(login.setCookie.join("\n"), /Secure/);
});

test("未配置口令时，落盘生成的密码可以直接登录", async (t) => {
  const { base, config } = await startServer(t, { auth: { adminPassword: null } });

  const saved = JSON.parse(readFileSync(join(config.root, "atri.config.json"), "utf8"));
  const password = saved.auth.adminPassword;
  assert.ok(password, "应当生成并落盘一个密码，否则重启后没人知道密码");

  const login = await call(base, "/auth/login", {
    method: "POST",
    body: { username: config.auth.adminUser, password },
  });
  assert.equal(login.status, 200);
});

test("静态资源可匿名获取，SPA 深链接回退到 index.html", async (t) => {
  const { staticDir, origin } = await startServer(t);

  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>控制台</title>", "utf8");
  writeFileSync(join(staticDir, "app.js"), "console.log(1)", "utf8");

  // 前端壳必须能匿名拿到，否则登录页根本加载不出来。
  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /控制台/);

  assert.equal((await fetch(`${origin}/app.js`)).status, 200);

  // history 路由深链接刷新时也要能打开。
  const deep = await fetch(`${origin}/some/deep/route`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /控制台/);

  // 不存在的 API 路径不能被 SPA 回退吞掉，也不能靠 401/404 的差异泄露端点是否存在。
  const api = await fetch(`${origin}${API_PREFIX}/nope`);
  assert.equal(api.status, 401, "未知 API 路径先过鉴权闸门，未登录应当 401");
});

test("登录后未知 API 路径才回 404，避免靠状态码枚举端点", async (t) => {
  const { base, origin } = await startServer(t);

  // 登录前：401（放行与否取决于登录态，而不是端点是否存在）。
  assert.equal((await fetch(`${origin}${API_PREFIX}/nope`)).status, 401);

  // 登录后：这才应该是 404，且是 JSON 而不是 SPA 的 HTML。
  const cookie = cookiePair(
    (await call(base, "/auth/login", { method: "POST", body: CREDS })).setCookie,
  );
  const res = await fetch(`${origin}${API_PREFIX}/nope`, { headers: { cookie } });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "接口不存在");
});

test("静态目录未构建时给出可读提示", async (t) => {
  const { origin } = await startServer(t);
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /pnpm build/);
});

test("resolveStaticPath 拒绝越出静态目录的路径", () => {
  const base = join(tmpdir(), "atri-static");
  const inside = (p) => p === base || p.startsWith(base + sep);

  // 正常路径落在目录内；站点根解析为目录本身，后续 statFile 会判定它不是文件并回退到 index.html。
  assert.equal(resolveStaticPath(base, "/"), base);
  assert.equal(resolveStaticPath(base, "/index.html"), join(base, "index.html"));
  assert.equal(resolveStaticPath(base, "/assets/app.js"), join(base, "assets", "app.js"));

  // 真正的逃逸路径：必须返回 null。
  // HTTP 层拿到的 pathname 已被 `new URL()` 规范化，所以这里测的是
  // 「万一前面有人先 decode 一次、或改成传原始 URL」时的兜底。
  for (const hostile of [
    "/../secrets.txt",
    "/../../etc/passwd",
    "/a/../../outside.txt",
    "/./../up.txt",
    "/foo/../../../up.txt",
  ]) {
    assert.equal(resolveStaticPath(base, hostile), null, `${hostile} 必须被拒绝`);
  }

  // 前缀陷阱：`<base>-evil` 以 `<base>` 为字符串前缀，但不是它的子路径。
  // 用朴素 startsWith 拼字符串的写法会在这里放行，必须由 sep 兜住。
  assert.equal(resolveStaticPath(base, "/../atri-static-evil/x.txt"), null);

  // 编码后的 `%2f` 不会被解码，因此它只是一个带怪名字的普通文件，
  // 不构成逃逸。真正要守住的不变式是：返回的路径永远在目录内。
  for (const encoded of ["/..%2fup.txt", "/%2e%2e%2fup.txt", "/..%5cup.txt"]) {
    const resolved = resolveStaticPath(base, encoded);
    assert.ok(resolved === null || inside(resolved), `${encoded} 若被放行也必须落在目录内`);
    assert.ok(
      !resolved || join(resolved) !== join(base, "..", "up.txt"),
      `${encoded} 不得指向上级`,
    );
  }
});
