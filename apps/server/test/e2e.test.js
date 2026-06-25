import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createApp } from "../src/app.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const staticDir = join(repoRoot, "apps", "dashboard", "dist");
const distIndex = join(staticDir, "index.html");

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
    const config = {
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
        adminPassword: "e2e-secret",
        cookieName: "atri_session",
        cookieSecure: false,
        staticDir,
      },
    };

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
    const bad = await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
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

    // 带 Cookie 后可读受保护数据。
    assert.equal((await fetch(`${api}/sessions`, { headers: { cookie } })).status, 200);
    const me = await (await fetch(`${api}/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.user.username, "admin");

    // WS 复用同一 Cookie 完成握手，浏览器无需为鉴权做任何额外动作。
    const wsResult = await new Promise((done) => {
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
