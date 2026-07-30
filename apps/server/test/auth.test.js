import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS, AuthManager } from "../src/core/auth/manager.ts";

/** 静默 logger，避免测试输出被日志刷屏。 */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 可推进的假时钟。过期测试用它真正把时间往前拨，
 * 而不是回拨内部字段——后者只能证明字段被读了，证明不了「时间到了就失效」。
 */
function makeClock(start = Date.UTC(2025, 0, 1)) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** 造一个临时 root 下的配置，password 传 null 表示「未配置，应自动生成」。 */
function makeConfig(t, { password = "secret-pw", user = "admin" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atri-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    auth: {
      adminUser: user,
      adminPassword: password,
      cookieName: "atri_session",
      cookieSecure: false,
      staticDir: join(root, "dist"),
    },
  };
}

async function makeAuth(t, opts) {
  const config = makeConfig(t, opts);
  const clock = makeClock();
  const auth = new AuthManager(config, silentLogger, { now: clock.now });
  await auth.init();
  return { auth, config, clock };
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
  const { token } = auth.login("admin", "secret-pw");
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
  assert.notEqual(a.token, b.token);
  assert.equal(auth.stats.activeSessions, 2);

  auth.revokeAll();
  assert.equal(auth.stats.activeSessions, 0);
  assert.equal(auth.getByToken(a.token), null);
  assert.equal(auth.getByToken(b.token), null);
});

test("活跃请求把空闲计时重新推后（滑动续期）", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const { token } = auth.login("admin", "secret-pw");

  // 快到 7 天时就差一点超时，此时命中一次。
  clock.advance(IDLE_TTL_MS - 60_000);
  assert.ok(auth.getByToken(token), "空闲未超时前应当有效");

  // 再往后走「原本会超时」的量：因为刚续期过，仍然有效。
  clock.advance(120_000);
  assert.ok(auth.getByToken(token), "命中后空窗重新计时，不应失效");
});

test("空闲超时后令牌失效，即使绝对有效期未到", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const { token } = auth.login("admin", "secret-pw");

  clock.advance(IDLE_TTL_MS);
  assert.equal(auth.getByToken(token), null);
  assert.equal(auth.stats.activeSessions, 0, "惰性清理应当移除过期条目");
});

test("超过绝对有效期后失效，即使期间一直活跃", async (t) => {
  const { auth, clock } = await makeAuth(t);
  const { token } = auth.login("admin", "secret-pw");
  assert.ok(ABSOLUTE_TTL_MS > IDLE_TTL_MS, "绝对有效期必须严于空闲有效期才有意义");

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

  clock.advance(IDLE_TTL_MS + 1000);
  auth.login("admin", "secret-pw");

  assert.equal(auth.stats.activeSessions, 1);
  assert.equal(auth.getByToken(stale.token), null);
});

test("未配置口令时生成随机口令，写入配置文件并回填运行期配置", async (t) => {
  const { auth, config } = await makeAuth(t, { password: null });
  const generated = config.auth.adminPassword;

  assert.equal(typeof generated, "string");
  assert.equal(generated.length, 24, "18 字节 base64url 应为 24 个字符");

  const filePath = join(config.root, "atri.config.json");
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
    join(config.root, "atri.config.json"),
    JSON.stringify({ port: 6185, pluginDirs: ["./plugins"] }),
    "utf8",
  );

  await new AuthManager(config, silentLogger).init();

  const saved = JSON.parse(readFileSync(join(config.root, "atri.config.json"), "utf8"));
  assert.equal(saved.port, 6185);
  assert.deepEqual(saved.pluginDirs, ["./plugins"]);
  assert.equal(saved.auth.adminPassword, config.auth.adminPassword);
});

test("配置文件损坏时不覆盖它，改为只存内存", async (t) => {
  const config = makeConfig(t, { password: null });
  const filePath = join(config.root, "atri.config.json");
  writeFileSync(filePath, "{ 这不是 JSON", "utf8");

  const auth = new AuthManager(config, silentLogger);
  await auth.init();

  // 关键：损坏的文件必须原样保留，不能被生成的密码覆盖掉。
  assert.equal(readFileSync(filePath, "utf8"), "{ 这不是 JSON");
  assert.ok(config.auth.adminPassword, "仍然要有一个可用口令");
  assert.equal(auth.verifyPassword("admin", config.auth.adminPassword), true);
});

test("自定义管理员用户名生效；enabled / cookie 配置透出给 API 层", async (t) => {
  const { auth } = await makeAuth(t, { user: "atri" });
  assert.equal(auth.username, "atri");
  assert.equal(auth.enabled, true);
  assert.equal(auth.cookieName, "atri_session");
  assert.equal(auth.cookieSecure, false);

  assert.equal(auth.verifyPassword("atri", "secret-pw"), true);
  assert.equal(auth.verifyPassword("admin", "secret-pw"), false);
  assert.equal(auth.login("atri", "secret-pw").user.username, "atri");
});
