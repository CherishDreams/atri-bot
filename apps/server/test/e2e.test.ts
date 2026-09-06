import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createApp } from "#app.ts";
import type { LoginResponse } from "@atri/shared";
import { makeTestConfig } from "./helpers/config.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const staticDir = join(repoRoot, "apps", "dashboard", "dist");
const distIndex = join(staticDir, "index.html");

/**
 * 只回 `{ error }` 的失败响应。
 *
 * 为什么要给 `Response` 单独标一个类型：`Response.json()` 在 undici 的类型里是
 * `Promise<unknown>`（JSON 里可以有任何东西），而有一条断言写成
 * `assert.equal((await bad.json()).error, "账号或密码错误")`——断言序列在本次迁移中
 * 逐字冻结（本仓没有快照机制，靠的是人工比对迁移前后的输出），收窄插不进那一行，只能标在**取到响应的那一行**（不是断言行）。
 * `error` 这个键名来自 `src/api/http.ts` 的 `sendError`：所有失败响应都是
 * `{ error: "<中文说明>" }`。
 */
type ErrorResponse = Omit<Response, "json"> & { json(): Promise<{ error: string }> };

/**
 * WS 握手的结果，做成**以 `opened` 为判别式**的联合。
 *
 * 理由同 `ws-auth.test.ts` 的 `ConnectResult`：有断言紧接着读 `wsResult.frame.type`，
 * 而那一行逐字冻结、插不进守卫；判成联合之后，上一行的
 * `assert.equal(wsResult.opened, true, …)` 就把类型筛到了「带第一帧」那一支。
 * 连不上时本来就没有帧 —— 与迁移前 `done({ opened: false })` 的实际形状一致。
 */
type WsHandshake = { opened: true; frame: { type: string } } | { opened: false; frame?: undefined };

/**
 * 端到端冒烟：在同一个进程里验证「构建产物 + 鉴权闸门 + SPA 回退」协同工作，
 * 这是各单元测试分别覆盖不到的部分。
 *
 * 依赖 `pnpm build` 的产物。没有产物时跳过而不是失败——否则 `pnpm test`
 * 会在干净检出上因为「还没构建」而红，测试就不再是一个可信的信号。
 */
test(
  "端到端：登录 → 取数据 → WS → 登出",
  { skip: !existsSync(distIndex) && "未找到 apps/dashboard/dist，先运行 pnpm build" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atri-e2e-"));
    // 共享 fixture 的默认值与迁移前这里手抄的那份逐项相同（host / port 0 / logLevel /
    // dataDir / pluginDirs / adapters / providers，`"atri_session"` 就是
    // `DEFAULT_AUTH_COOKIE_NAME`、`cookieSecure: false`）。这里的 `staticDir` 是**真实的构建产物**
    // ——本用例要的就是 `cache-control: no-cache` 与带哈希资源的长缓存，不能换成假目录。
    const config = makeTestConfig({ root, staticDir, adminPassword: "e2e-secret" });

    const app = await createApp(config);
    await app.start();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.after(() => app.stop());

    const origin = `http://127.0.0.1:${app.address().port}`;
    const api = `${origin}/api/v1`;

    // 登录页自身必须匿名可取，否则没有人能登录。
    const shell = await fetch(`${origin}/login`);
    const shellHtml = await shell.text();
    assert.equal(shell.status, 200, "登录页应当匿名可取");
    assert.ok(shellHtml.includes('id="app"'), "静态托管的应当是应用外壳");
    assert.equal(
      shell.headers.get("cache-control"),
      "no-cache",
      "外壳不能长缓存，否则发版后拿到旧壳",
    );

    // 匿名访问受保护接口一律 401。
    assert.equal((await fetch(`${api}/sessions`)).status, 401);

    // 静态资源匿名可取，且带长缓存（与外壳相反）。
    const jsPath = shellHtml.match(/src="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(jsPath, "外壳里应当引用构建出的 JS");
    const asset = await fetch(`${origin}${jsPath}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /max-age=/, "带哈希的资源应当长缓存");

    // 口令错误：401、不下发 Cookie、消息不泄露账号是否存在。
    // `as ErrorResponse` 的理由见该类型注释：下面那条断言直接读 `bad.json()` 的 `error`。
    const bad = (await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    })) as ErrorResponse;
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.getSetCookie().length, 0, "登录失败绝不能签发 Cookie");
    assert.equal((await bad.json()).error, "账号或密码错误");

    // 口令正确：签发 HttpOnly Cookie。
    const ok = await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "e2e-secret" }),
    });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.getSetCookie().join("; ");
    assert.ok(setCookie.includes("HttpOnly"), "会话 Cookie 必须 HttpOnly");
    assert.ok(setCookie.includes("SameSite=Lax"));
    const cookie = setCookie.split(";")[0];
    // 守卫：`split(";")[0]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`，
    // 而下面几处要把它塞进 `headers`（fetch 的 Header 值不接受 undefined）。
    // 上一行已经断言过 Set-Cookie 非空，这里为空只可能是解析坏了。
    assert.ok(cookie, "登录响应的 Set-Cookie 里必须有 name=value 分段");

    // 带 Cookie 后可读受保护数据。
    assert.equal((await fetch(`${api}/sessions`, { headers: { cookie } })).status, 200);
    const meRes = await fetch(`${api}/auth/me`, { headers: { cookie } });
    // 边界收窄：`Response.json()` 的类型是 `Promise<unknown>`，而 `/auth/me` 的响应体就是
    // 线协议里的 `LoginResponse`（见 `src/api/server.ts`：`{ user, expiresAt }`）。
    const me = (await meRes.json()) as LoginResponse;
    assert.equal(me.user.username, "admin");

    // WS 复用同一 Cookie 完成握手，浏览器无需为鉴权做任何额外动作。
    const wsResult = await new Promise<WsHandshake>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.address().port}/ws`, { headers: { cookie } });
      const timer = setTimeout(() => {
        ws.terminate();
        done({ opened: false });
      }, 5000);
      ws.on("open", () => {
        ws.once("message", (raw) => {
          clearTimeout(timer);
          ws.close();
          done({ opened: true, frame: JSON.parse(raw.toString()) });
        });
        ws.send(JSON.stringify({ type: "ping" }));
      });
      ws.on("error", () => {
        clearTimeout(timer);
        done({ opened: false });
      });
      ws.on("unexpected-response", () => {
        clearTimeout(timer);
        done({ opened: false });
      });
    });
    assert.equal(wsResult.opened, true, "带有效 Cookie 的 WS 应当握手成功");
    assert.equal(wsResult.frame.type, "pong");

    // 登出后旧令牌立即失效。
    assert.equal(
      (await fetch(`${api}/auth/logout`, { method: "POST", headers: { cookie } })).status,
      200,
    );
    assert.equal((await fetch(`${api}/auth/me`, { headers: { cookie } })).status, 401);

    // history 模式深链接刷新应当回退到外壳而不是 404。
    assert.equal((await fetch(`${origin}/some/deep/link`)).status, 200);

    // 路径穿越不得读出仓库外的文件。
    const traversal = await fetch(`${origin}/../../etc/passwd`);
    assert.ok(!(await traversal.text()).includes("root:x:"), "不得泄露静态目录之外的文件");
  },
);
