import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS, AuthManager } from "#core/auth/manager.ts";
import type { LoginResult } from "#core/auth/manager.ts";
import type { Logger } from "#core/logger.ts";
import { configFilePath } from "#config/file.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 静默 logger，避免测试输出被日志刷屏。
 *
 * 四个方法一个都不能少：`Logger` 的 `debug / info / warn / error` 全是必填
 *（见 `src/core/logger.ts`）。少写一个在类型上就是不合法的 logger，那是另一种错误。
 */
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * 可推进的假时钟。过期测试用它真正把时间往前拨，
 * 而不是回拨内部字段——后者只能证明字段被读了，证明不了「时间到了就失效」。
 */
function makeClock(start = Date.UTC(2025, 0, 1)) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** `makeConfig` / `makeAuth` 的覆盖项，沿用本文件既有的 `password` / `user` 称呼。 */
interface AuthFixtureOptions {
  /** `null` 表示「未配置口令，应自动生成」。 */
  password?: string | null;
  user?: string;
}

/**
 * 造一个临时 root 下的配置。
 *
 * 改用共享 fixture 而不是就地手抄：迁到 TS 之后 `AppConfig` 的必填键必须逐字给全，
 * 而本文件原本没写的那些（`dataDir` / `pluginDirs` / `adapters` / `providers`…）
 * `AuthManager` 一个都不读。`makeTestConfig` 的默认值与迁移前手抄的那份逐项相同
 * （`"atri_session"` 就是 `DEFAULT_AUTH_COOKIE_NAME`，`cookieSecure: false`，
 * `adminUser: "admin"`），只有 `staticDir` 显式传回原来的 `<root>/dist`：
 * 两个目录都不存在，`AuthManager` 也不读它，写出来只为了「值与迁移前一字不差」。
 */
function makeConfig(
  t: TestContext,
  { password = "secret-pw", user = "admin" }: AuthFixtureOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), "atri-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makeTestConfig({
    root,
    staticDir: join(root, "dist"),
    adminPassword: password,
    auth: { adminUser: user },
  });
}

async function makeAuth(t: TestContext, opts: AuthFixtureOptions = {}) {
  const config = makeConfig(t, opts);
  const clock = makeClock();
  const auth = new AuthManager(config, silentLogger, { now: clock.now });
  await auth.init();
  return { auth, config, clock };
}

/**
 * 「凭证校验已通过 ⇒ 必然签发令牌」这条运行时事实的类型写法。
 *
 * 为什么需要它：最后一条断言写成 `auth.login("atri", "secret-pw").user.username`，
 * 而断言序列在本次迁移中逐字冻结（本仓没有快照机制，靠的是人工比对迁移前后的输出），无法在那一行前插 `assert.ok`：
 * 守卫只能收窄「引用」（变量与属性路径），收窄不了每次重新发出的调用表达式，
 * 于是 `login()` 的返回类型仍是 `LoginResult | null`，点 `.user` 就是 TS2531。
 * 这里只覆盖 `login` 一个成员（其余成员由 `AuthManager` 原样提供），运行时仍是同一个
 * 对象、同一次调用；真的返回 null 时行为与迁移前一致（TypeError），断言照样红。
 */
interface LoginIssuingAuth extends AuthManager {
  login(username: string, password: string): LoginResult;
}

test("用户名与口令都对才通过校验", async (t) => {
  const { auth } = await makeAuth(t);
  assert.equal(auth.verifyPassword("admin", "secret-pw"), true);
  assert.equal(auth.verifyPassword("admin", "wrong"), false);
  assert.equal(auth.verifyPassword("root", "secret-pw"), false);
  assert.equal(auth.verifyPassword("", ""), false);
});

test("非字符串凭证不会抛错，只返回 false", async (t) => {
  const { auth } = await makeAuth(t);
  assert.equal(auth.verifyPassword(undefined, undefined), false);
  assert.equal(auth.verifyPassword({}, []), false);
  assert.equal(auth.verifyPassword(null, "secret-pw"), false);
});

test("登录成功后可用令牌换回身份", async (t) => {
  const { auth } = await makeAuth(t);
  const result = auth.login("admin", "secret-pw");
  assert.ok(result);
  assert.equal(result.user.username, "admin");
  assert.ok(result.token);

  const session = auth.getByToken(result.token);
  // 守卫：`getByToken()` 的类型是 `LoginResponse | null`，下一行要直接点 `.user`。
  assert.ok(session, "刚签发的令牌必须能换回会话身份");
  assert.equal(session.user.username, "admin");
  assert.equal(auth.stats.activeSessions, 1);
});

test("口令错误不签发令牌", async (t) => {
  const { auth } = await makeAuth(t);
  assert.equal(auth.login("admin", "nope"), null);
  assert.equal(auth.login("root", "secret-pw"), null);
  assert.equal(auth.stats.activeSessions, 0);
});

test("登出后令牌立即失效，且重复登出不报错", async (t) => {
  const { auth } = await makeAuth(t);
  const login = auth.login("admin", "secret-pw");
  // 守卫：`login()` 失败返回 null，而下面三行都要读它的 `token`。
  assert.ok(login, "口令正确时必须签发令牌");
  const { token } = login;
  assert.ok(auth.getByToken(token));

  assert.equal(auth.logout(token), true);
  assert.equal(auth.getByToken(token), null);
  // 幂等：再登出一次只是返回 false，不应抛错。
  assert.equal(auth.logout(token), false);
});

test("未知令牌返回 null", async (t) => {
  const { auth } = await makeAuth(t);
  assert.equal(auth.getByToken("nope"), null);
  assert.equal(auth.getByToken(""), null);
  assert.equal(auth.getByToken(undefined), null);
});

test("每个令牌都不同，revokeAll 一次清空全部登录态", async (t) => {
  const { auth } = await makeAuth(t);
  const a = auth.login("admin", "secret-pw");
  const b = auth.login("admin", "secret-pw");
  // 守卫：两处都要读 `.token`，而 `login()` 的类型带 null。
  assert.ok(a, "口令正确时必须签发令牌");
  assert.ok(b, "口令正确时必须签发令牌");
  assert.notEqual(a.token, b.token);
  assert.equal(auth.stats.activeSessions, 2);

  auth.revokeAll();
  assert.equal(auth.stats.activeSessions, 0);
  assert.equal(auth.getByToken(a.token), null);
  assert.equal(auth.getByToken(b.token), null);
});

test("活跃请求把空闲计时重新推后（滑动续期）", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const login = auth.login("admin", "secret-pw");
  // 守卫：下面每次续期都读 `token`。
  assert.ok(login, "口令正确时必须签发令牌");
  const { token } = login;

  // 快到 7 天时就差一点超时，此时命中一次。
  clock.advance(IDLE_TTL_MS - 60_000);
  assert.ok(auth.getByToken(token), "空闲未超时前应当有效");

  // 再往后走「原本会超时」的量：因为刚续期过，仍然有效。
  clock.advance(120_000);
  assert.ok(auth.getByToken(token), "命中后空窗重新计时，不应失效");
});

test("空闲超时后令牌失效，即使绝对有效期未到", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const login = auth.login("admin", "secret-pw");
  assert.ok(login, "口令正确时必须签发令牌");
  const { token } = login;

  clock.advance(IDLE_TTL_MS);
  assert.equal(auth.getByToken(token), null);
  assert.equal(auth.stats.activeSessions, 0, "惰性清理应当移除过期条目");
});

test("超过绝对有效期后失效，即使期间一直活跃", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const login = auth.login("admin", "secret-pw");
  assert.ok(login, "口令正确时必须签发令牌");
  const { token } = login;
  // 方向要说对：**绝对期限比空闲期限长**，这条用例才有「期间一直活跃」这种东西可演。
  // 写成「严于」会让人以为 15 天 < 7 天，而下一个人可能会照那个意思去「修」常量。
  assert.ok(
    ABSOLUTE_TTL_MS > IDLE_TTL_MS,
    "绝对有效期必须长于空闲有效期，否则「一直活跃也躲不过绝对上限」根本做不到",
  );

  // 每 6 天续期一次，足以躲开空闲超时，但躲不过 15 天的绝对上限。
  for (let i = 0; i < 3; i += 1) {
    clock.advance(6 * 24 * 60 * 60 * 1000);
    if (auth.getByToken(token)) continue;
    break;
  }
  assert.equal(auth.getByToken(token), null, "滑动续期不能突破绝对有效期");
});

test("登录时顺带清理已过期条目，避免 Map 无限增长", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const stale = auth.login("admin", "secret-pw");
  // 守卫：最后一条断言要读 `stale.token`。
  assert.ok(stale, "口令正确时必须签发令牌");

  clock.advance(IDLE_TTL_MS + 1000);
  auth.login("admin", "secret-pw");

  assert.equal(auth.stats.activeSessions, 1);
  assert.equal(auth.getByToken(stale.token), null);
});

test("未配置口令时生成随机口令，写入配置文件并回填运行期配置", async (t) => {
  const { auth, config } = await makeAuth(t, { password: null });
  const generated = config.auth.adminPassword;

  assert.equal(typeof generated, "string");
  // 守卫：上一条只说明 `typeof`，类型检查器仍把 `adminPassword` 当作 `string | null`，
  // 而运行期配置里的这个键是 `init()` 回填进去的，必然有值。
  assert.ok(generated, "回填后的运行期口令必须存在");
  assert.equal(generated.length, 24, "18 字节 base64url 应为 24 个字符");

  const filePath = configFilePath(config.root);
  assert.ok(existsSync(filePath), "生成的密码必须落盘，否则重启即丢失");
  const saved = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(saved.auth.adminPassword, generated);

  // 生成的口令就是生效的口令。
  assert.equal(auth.verifyPassword("admin", generated), true);
  assert.ok(auth.login("admin", generated));
});

test("两次自动生成的口令不相同", async (t) => {
  const a = await makeAuth(t, { password: null });
  const b = await makeAuth(t, { password: null });
  assert.notEqual(a.config.auth.adminPassword, b.config.auth.adminPassword);
});

test("落盘时保留配置文件里原有的其它键", async (t) => {
  const config = makeConfig(t, { password: null });
  writeFileSync(
    configFilePath(config.root),
    JSON.stringify({ port: 6185, pluginDirs: ["./plugins"] }),
    "utf8",
  );

  await new AuthManager(config, silentLogger).init();

  const saved = JSON.parse(readFileSync(configFilePath(config.root), "utf8"));
  assert.equal(saved.port, 6185);
  assert.deepEqual(saved.pluginDirs, ["./plugins"]);
  assert.equal(saved.auth.adminPassword, config.auth.adminPassword);
});

test("配置文件损坏时不覆盖它，改为只存内存", async (t) => {
  const config = makeConfig(t, { password: null });
  const filePath = configFilePath(config.root);
  writeFileSync(filePath, "{ 这不是 JSON", "utf8");

  const auth = new AuthManager(config, silentLogger);
  await auth.init();

  // 关键：损坏的文件必须原样保留，不能被生成的密码覆盖掉。
  assert.equal(readFileSync(filePath, "utf8"), "{ 这不是 JSON");
  assert.ok(config.auth.adminPassword, "仍然要有一个可用口令");
  assert.equal(auth.verifyPassword("admin", config.auth.adminPassword), true);
});

test("自定义管理员用户名生效；enabled / cookie 配置透出给 API 层", async (t) => {
  const { auth: manager } = await makeAuth(t, { user: "atri" });
  // 见 `LoginIssuingAuth` 的注释：最后一条断言逐字冻结，守卫插不进去。
  const auth = manager as LoginIssuingAuth;
  assert.equal(auth.username, "atri");
  assert.equal(auth.enabled, true);
  assert.equal(auth.cookieName, "atri_session");
  assert.equal(auth.cookieSecure, false);

  assert.equal(auth.verifyPassword("atri", "secret-pw"), true);
  assert.equal(auth.verifyPassword("admin", "secret-pw"), false);
  assert.equal(auth.login("atri", "secret-pw").user.username, "atri");
});
