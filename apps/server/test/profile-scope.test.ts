/**
 * 多配置档同时在线时的两条「会静默错」检查。
 *
 * R2 —— **handler 关错配置档**。症状是「界面在 B、写进 A、还回 201」：没有任何错误，
 * 只有下一次刷新时那行配置回到了原样。所以每条作用域化的写都要证两件事：
 * 目标文件里确实出现了这次改动，**且另一份配置档的文件逐字节没动**。
 * 只比「B 变了」是抓不到写错档的 —— 那正是写错档的样子。
 *
 * 供应商改成全局一份之后，这一条的范围**缩小了**：只剩工具开关、插件启用清单、
 * 发消息这三族是档级的，外加「这一档默认用哪个 provider」这条新写的档级引用。
 * 剩下的 provider 写入因此要证**反面**：它们谁家的档文件都不许碰。
 *
 * R5 —— **会话锁留在配置档内部**。两个配置档各持一份锁时，同一个会话会被两路并发写，
 * `tool_calls` 与它的结果交错落库，而 `AgentEngine.#historyFor` 的配对修复会把那半截调用
 * 降级成正文 —— 坏掉的历史不但存下来，还会被当成正常历史喂给下一次请求。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { providersFilePath } from "#config/file.ts";
import { DEFAULT_PROFILE_ID, profilesRoot, readProfileConfig } from "#config/profiles.ts";
import type { Session } from "@atri/shared";
import { makeTestConfig } from "./helpers/config.ts";

const A = DEFAULT_PROFILE_ID;
const B = "other-profile";

/** 一个立即回 200 的桩上游：R2 只关心落盘，不关心对话内容。 */
async function startStubUpstream() {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "好" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("桩上游没有绑定 TCP 端口");
  return {
    baseUrl: `http://127.0.0.1:${bound.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Harness {
  origin: string;
  cookie: string;
  /** 两份配置档各自的落盘位置。 */
  file: (id: string) => string;
  bytes: (id: string) => Buffer;
  /** 全局供应商文件的位置（部署级那一份，不属于任何档）。 */
  providersPath: string;
  call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; json: Record<string, unknown> | null }>;
}

async function setup(t: TestContext, upstreamUrl: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "atri-profile-scope-"));
  const dataDir = join(root, "data");
  const app = await createApp(
    makeTestConfig({
      root,
      dataDir,
      providerSources: { stub: { type: "openai", baseUrl: upstreamUrl, apiKey: "sk" } },
      providers: { stub: { source: "stub", model: "m" } },
    }),
  );
  await app.start();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(login.status, 200, "登录不成功的话，后面全是在测 401");
  const first = login.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Set-Cookie");
  const cookie = first.split(";")[0] as string;
  const profilesDir = profilesRoot(dataDir);
  const file = (id: string) => join(profilesDir, id, "config.json");

  // 第二份配置档由 API 建（顺带证明这条路真的走得通）。
  const created = await fetch(`${origin}/api/v1/profiles`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: B, name: "另一份" }),
  });
  assert.equal(created.status, 201, `建第二份配置档失败：${JSON.stringify(await created.json())}`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      // 边界收窄：`Response.json()` 的返回是 `unknown`。失败响应的 `{error}` 也有内容，
      // 所以这里不能用「解析失败才算 null」当判据 —— 只有空响应体才是 null。
      json: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };
  return {
    origin,
    cookie,
    file,
    bytes: (id) => readFileSync(file(id)),
    call,
    providersPath: providersFilePath(dataDir),
  };
}

test("作用域化的每一条写只动它自己那份配置档的文件", async (t) => {
  const upstream = await startStubUpstream();
  t.after(() => upstream.close());
  const h = await setup(t, upstream.baseUrl);

  // `stub` 这一源/实例是启动时从 bootstrap 收进**全局那份**的（`providers.json`），
  // 所以两家都能直接用，不需要各配一套 —— 那正是这次改动的全部内容。
  const session = await h.call("POST", "/sessions", { title: "串档检查" });
  assert.equal(session.status, 201);
  const sessionId = (session.json as { session: Session }).session.id;

  /**
   * 每一条**档级**的写：期望状态码 + 「它有没有改动 B 的文件」。
   * 那几条 `nope` 是要证「连失败都不许写到别人家去」，所以期望 404、不改任何文件。
   */
  const writes: { label: string; expect: number; changesB: boolean; run: () => Promise<number> }[] =
    [
      {
        label: "启工具",
        expect: 200,
        changesB: true,
        run: async () =>
          (await h.call("POST", `/tools/current_time/enable?profile=${B}`, { enabled: true }))
            .status,
      },
      {
        label: "停插件（未知 id，应当 404）",
        expect: 404,
        changesB: false,
        run: async () =>
          (await h.call("POST", `/plugins/nope/enable?profile=${B}`, { enabled: false })).status,
      },
      {
        label: "重载插件（未知 id，应当 404）",
        expect: 404,
        changesB: false,
        run: async () => (await h.call("POST", `/plugins/nope/reload?profile=${B}`)).status,
      },
      {
        label: "卸插件（未知 id，应当 404）",
        expect: 404,
        changesB: false,
        run: async () => (await h.call("POST", `/plugins/nope/unload?profile=${B}`)).status,
      },
      {
        label: "设这一档默认的 provider（引用全局清单里那一个）",
        expect: 200,
        changesB: true,
        run: async () =>
          (await h.call("POST", `/profiles/${B}/default-provider`, { providerId: "stub" })).status,
      },
      {
        label: "把档默认改成清单里不存在的 id（应当 400，且什么都不写）",
        expect: 400,
        changesB: false,
        run: async () =>
          (await h.call("POST", `/profiles/${B}/default-provider`, { providerId: "ghost" })).status,
      },
      {
        label: "发一条消息",
        expect: 200,
        // 对话历史落在全局 sqlite，不写配置文件 —— 这一条同时钉住「历史是共享的一份」。
        changesB: false,
        run: async () =>
          (
            await h.call("POST", `/sessions/${sessionId}/messages?profile=${B}`, {
              content: "你好",
            })
          ).status,
      },
    ];

  const failures: string[] = [];
  for (const { label, expect, changesB, run } of writes) {
    const beforeA = h.bytes(A);
    const beforeB = h.bytes(B);
    const status = await run();
    if (status !== expect) failures.push(`${label}：期望 ${expect}，实际 ${status}`);
    // **A 逐字节不变**：这是这一条的全部要点，无论这次写成功还是失败。
    if (!beforeA.equals(h.bytes(A)))
      failures.push(`${label}（${status}）改动落到了另一份配置档上：A 的文件被改了`);
    const bChanged = !beforeB.equals(h.bytes(B));
    if (changesB !== bChanged)
      failures.push(
        `${label}：B 的文件${changesB ? "应该被改但没改" : "不该被改但被改了"}（改动没落到它自己的档里）`,
      );
  }
  assert.deepEqual(failures, [], `配置档之间串了：\n${failures.join("\n")}`);

  // --- 供应商那一族：证的是**反面** ---------------------------------------
  //
  // 「谁家的档文件都不许碰」。这一句不是装饰：如果哪一天有人把写入改回
  // 「顺手也写一份到当前档」，上面那些断言全都还是绿的，而两个真源已经成形了。
  const providersBefore = readFileSync(h.providersPath, "utf8");
  const beforeA = h.bytes(A);
  const beforeB = h.bytes(B);
  assert.equal(
    (await h.call("POST", "/provider-sources", { id: "g", type: "openai", apiKey: "k" })).status,
    201,
  );
  assert.equal(
    (await h.call("POST", "/providers", { id: "q", source: "g", model: "m" })).status,
    201,
  );
  assert.equal((await h.call("POST", "/providers/q", { name: "改过名" })).status, 200);
  // 「改过东西」要在**删掉之前**比：建完就删会让那份文件回到逐字节相同，
  // 那时候这条断言证的就不再是「写进了全局文件」，而是一次空比较。
  const providersAfterWrites = readFileSync(h.providersPath, "utf8");
  assert.notEqual(providersAfterWrites, providersBefore, "供应商的写**什么都没改动**全局那份文件");
  assert.match(providersAfterWrites, /"q"/);
  assert.equal((await h.call("DELETE", "/providers/q")).status, 200);
  assert.equal((await h.call("DELETE", "/provider-sources/g")).status, 200);
  // 这里用 `assert.ok` 而不是继续往上面那个 `failures` 里 push：那条数组在
  // `deepEqual(failures, [])` 之后被类型收窄成了 `never[]`，再 push 就是类型错误。
  assert.ok(beforeA.equals(h.bytes(A)), "供应商的写碰到了 A 的文件");
  assert.ok(beforeB.equals(h.bytes(B)), "供应商的写碰到了 B 的文件");

  // 全部端点都**不带** `?profile=` 也照样能用：那条档级守卫已经从这一族上摘掉了。
  assert.equal((await h.call("GET", "/providers")).status, 200);
  assert.equal((await h.call("GET", "/provider-sources")).status, 200);

  // 两份档的文件里都**不该**出现供应商段：seed 不抄它，运行期也不往档里写它。
  for (const [id, cfg] of [
    [A, readProfileConfig(h.file(A))],
    [B, readProfileConfig(h.file(B))],
  ] as const) {
    assert.equal(cfg.providerSources, undefined, `${id} 的文件里有 providerSources 段`);
    assert.equal(cfg.providers, undefined, `${id} 的文件里有 providers 段`);
  }
  const profileA = readProfileConfig(h.file(A));
  assert.equal(profileA.plugins, undefined, "B 上碰过插件开关，A 的文件里不该出现 plugins 段");
  assert.equal(profileA.tools, undefined, "B 上开关过工具，A 的文件里不该出现 tools 段");
  // 只有 B 设过档默认，A 没有 —— 「谁家的默认在谁家的文件里」是这一族唯一的档级键。
  assert.equal(profileA.defaultProvider, undefined, "A 没设过默认，却在 B 那次写入之后有了它");
  assert.equal(readProfileConfig(h.file(B)).defaultProvider, "stub");
});

/**
 * R5：占着会话的那一轮属于**另一份配置档**时，也必须被挡住，而且不落任何库。
 *
 * 这条是本期最重要的一条：锁如果在引擎里（每档一个），两个配置档对同一个会话并发写会
 * 交错落库，而交错后的历史被 `#historyFor` 主动降级成正文 —— 症状出现在很久以后的
 * 一次对话里，排查时没人会想到是并发。
 */
test("一份配置档占着会话时，另一份打同一个会话必须 409 且一个字都不落库", async (t) => {
  // 进入即挂住的上游：让「一轮还在进行中」撑到可以被第二个配置档撞上。
  let mark!: () => void;
  const entered = new Promise<void>((resolve) => (mark = resolve));
  let go!: () => void;
  const hold = new Promise<void>((resolve) => (go = resolve));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", async () => {
      mark();
      await hold;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "答完了" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("桩上游没有绑定 TCP 端口");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const h = await setup(t, `http://127.0.0.1:${bound.port}/v1`);
  // 源与实例都是**全局那一份**里的（`setup` 把它们从 bootstrap 收进 `providers.json`），
  // 所以两家档共用同一个上游，正是这一条要的前提：锁必须是跨档共享的。

  const session = await h.call("POST", "/sessions", { title: "跨档并发" });
  const sessionId = (session.json as { session: Session }).session.id;
  const send = (profile: string) =>
    fetch(`${h.origin}/api/v1/sessions/${sessionId}/messages?profile=${profile}`, {
      method: "POST",
      headers: { cookie: h.cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "你好", model: "m" }),
    });

  // 第一轮由 A 发出去、不 await，等它真的进了上游。
  const first = send(A);
  await entered;

  const conflict = await send(B);
  assert.equal(conflict.status, 409, "另一个配置档占着这个会话时，必须 409 而不是并发写库");
  const conflictBody = (await conflict.json()) as { error?: string };
  assert.match(String(conflictBody.error), /还没结束/);

  go();
  assert.equal((await first).status, 200);

  // 关键：被拒的那一次**一个字都没落库**。历史里只有 A 那一个完整往返。
  const detail = await fetch(`${h.origin}/api/v1/sessions/${sessionId}`, {
    headers: { cookie: h.cookie },
  });
  const { session: full } = (await detail.json()) as {
    session: { messages: { role: string; content: string }[] };
  };
  assert.deepEqual(
    full.messages.map((m) => [m.role, m.content]),
    [
      ["user", "你好"],
      ["assistant", "答完了"],
    ],
    "被 409 拒掉的那一轮留下了消息，说明拒绝发生在写库之后",
  );
});
