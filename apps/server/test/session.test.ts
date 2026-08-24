import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Session, SessionDetail } from "@atri/shared";
import { SessionManager } from "#core/session/manager.ts";
import { sessionDbPath } from "#core/session/db.ts";

/**
 * 会话存储的用例跑在**临时目录里的真库**上。
 *
 * 本仓刻意不留「内存实现」这条第二路径（理由见 `manager.ts` 的 `SessionStoreConfig`），
 * 所以这里不 mock 存储，也不给 manager 加一个「只进内存」的开关。
 *
 * `t` 是清理钩子，不是可选参数：`t.after` 先关句柄再删目录，少了它会留下一堆
 * 未关闭的 sqlite 文件（`node:test` 不会退出）。
 */
function useStore(t: TestContext): { open: () => SessionManager; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "atri-session-"));
  // 与 `AppConfig` 的默认值同形（`config.ts:80` 的 `resolve(root, "data")`），
  // 顺带让 `openSessionDb` 的「目录不存在要 mkdir」真的被走到。
  const dataDir = join(root, "data");
  const opened: SessionManager[] = [];

  // 先关句柄、再删目录（顺序反了就在删一个还被占着的文件，Linux 上静默成功、
  // Windows 上报错，而这两种都不该被测试观察到）。
  t.after(() => {
    for (const manager of opened) manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  return {
    open: () => {
      const manager = new SessionManager({ dataDir });
      opened.push(manager);
      return manager;
    },
    dbPath: sessionDbPath(dataDir),
  };
}

/**
 * 负例视图：`appendMessage()` 的签名要求完整 `Message`，而「对未知会话追加消息」这条用例
 * 要喂的正是一个空对象——被测的是「会话 id 查不到就抛」那一步，消息体形状与它无关。
 * 把绑定标成这个「入参更宽」的结构视图就行（方法声明是双变的，真 SessionManager 能满足），
 * 运行时用的仍然是同一个实例，没有绕过任何校验。
 */
interface AppendLoose {
  appendMessage(sessionId: string, message: unknown): unknown;
}

/**
 * `create()` 的同类视图：这条用例测的正是在**类型之外**的输入（`123`、`true`、`null`），
 * 它们来自 `readJson` 返回的 `Record<string, unknown>`，编译期已经在 `api/server.ts` 那边
 * 被擦掉了，只能从运行时的宽视图喂进来。
 */
interface CreateLoose {
  create(input?: { title?: unknown }): unknown;
}

/**
 * 读法包装：本文件多数用例读的都是**刚 create 出来**的那个会话，而 `get()` / `getDetail()`
 * 的返回类型带 `| null`（「未知会话返回 null」由下面两条用例专测）。这里把那一步走不到的
 * null 变成明确失败，于是断言不必每处补 `!`，真坏了时报的也是「会话不见了」而不是
 * `Cannot read properties of null`——后者看不出是被测行为坏了还是 fixture 写错了。
 *
 * `get()` 的返回类型额外带上 `messages?: undefined`：`Session` 摘要里**没有**这个键正是
 * 契约（列表不搬运全文），而有一条用例就是要断言「它确实不在」，读一个类型上不存在、
 * 运行时也不该存在的键需要这个形状。
 */
function known(manager: SessionManager) {
  return {
    create: (input?: { title?: string }): Session => manager.create(input),
    list: (): Session[] => manager.list(),
    appendMessage: (sessionId: string, message: Message): Message =>
      manager.appendMessage(sessionId, message),
    get(id: string): Session & { messages?: undefined } {
      const session = manager.get(id);
      if (!session) throw new Error(`会话不见了: ${id}`);
      return session;
    },
    getDetail(id: string): SessionDetail {
      const detail = manager.getDetail(id);
      if (!detail) throw new Error(`会话详情不见了: ${id}`);
      return detail;
    },
  };
}

/** 用例里反复出现的最小消息体（`id` / `createdAt` 由调用方给，好断言顺序）。 */
function userMessage(id: string, sessionId: string, content: string, createdAt: string): Message {
  return { id, sessionId, role: "user", content, createdAt };
}

test("创建、读取并列出会话", (t) => {
  const { open } = useStore(t);
  const m = known(open());
  const s = m.create({ title: "t" });
  assert.equal(m.get(s.id).title, "t");
  assert.equal(m.list().length, 1);
});

test("对未知会话追加消息应报错", (t) => {
  const { open } = useStore(t);
  const m: AppendLoose = open();
  assert.throws(() => m.appendMessage("missing", {}), /未知会话/);
});

test("统计消息数量且不泄露消息内容", (t) => {
  const { open } = useStore(t);
  const m = known(open());
  const s = m.create();
  // fixture 补全：`shared.Message` 是**已落库**的消息（带 id / sessionId / createdAt），
  // 不是发给上游的 `ChatMessage`。
  m.appendMessage(s.id, userMessage("m-1", s.id, "hi", "2026-01-01T00:00:00.000Z"));
  const view = m.get(s.id);
  assert.equal(view.messageCount, 1);
  assert.equal(view.messages, undefined);
});

test("会话详情带上完整消息历史，且是副本", (t) => {
  const { open } = useStore(t);
  const m = known(open());
  const s = m.create({ title: "t" });
  m.appendMessage(s.id, userMessage("m-1", s.id, "hi", "2026-01-01T00:00:00.000Z"));
  m.appendMessage(s.id, {
    id: "m-2",
    sessionId: s.id,
    role: "assistant",
    content: "yo",
    createdAt: "2026-01-01T00:00:01.000Z",
  });

  const detail = m.getDetail(s.id);
  assert.equal(detail.title, "t");
  assert.equal(detail.messageCount, 2);
  assert.deepEqual(
    detail.messages.map((x) => x.role),
    ["user", "assistant"],
  );

  // 拿到的数组必须是副本：库化后每次读都是一次新查询，外部改动不可能写进库。
  detail.messages.push(userMessage("m-3", s.id, "注入", "2026-01-01T00:00:02.000Z"));
  assert.equal(m.getDetail(s.id).messages.length, 2);
});

test("未知会话的详情返回 null 而不是抛错", (t) => {
  const { open } = useStore(t);
  assert.equal(open().getDetail("missing"), null);
});

test("消息顺序是插入序而不是 created_at，且重启后仍如此", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create({ title: "序" });

  // `createdAt` 刻意与插入顺序**逆序**。这是唯一能杀掉「`ORDER BY created_at`」实现的形状：
  // 那种写法在 SQLite 上会因为相同 key 的行按 rowid 兜底而**碰巧给出正确结果**，
  // 于是测试全绿而实现是坏的。真正排序的是 `messages.seq`（rowid 别名）。
  const ids = ["m-5", "m-4", "m-3", "m-2", "m-1"];
  ids.forEach((id, i) => {
    manager.appendMessage(
      s.id,
      userMessage(id, s.id, `第 ${i} 条`, `2026-02-0${5 - i}T00:00:00.000Z`),
    );
  });
  manager.close();

  const again = open();
  assert.deepEqual(
    again.getDetail(s.id)?.messages.map((m) => m.id),
    ids,
  );
});

test("toolCalls 原样往返，读回的行是普通对象", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  const withCalls: Message = {
    id: "m-call",
    sessionId: s.id,
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCalls: [
      {
        id: "c1",
        name: "probe",
        // `arguments` 是模型产出的原始串，全程原样搬运（`registry.ts:97-105` 刻意不解析它）。
        arguments: '{"q":"含 \\\\ 反斜杠、\\"引号\\"、换行\n、emoji 🙂 与 } 本身"}',
      },
    ],
  };
  const plain: Message = {
    id: "m-plain",
    sessionId: s.id,
    role: "user",
    content: "你好",
    createdAt: "2026-01-01T00:00:01.000Z",
  };
  manager.appendMessage(s.id, withCalls);
  manager.appendMessage(s.id, plain);
  manager.close();

  const [first, second] = open().getDetail(s.id)?.messages ?? [];
  assert.ok(first);
  assert.ok(second);
  // `deepStrictEqual` 一条同时钉住三件事，下一个人别把它当「只是在测转义」删掉：
  //   1. 反斜杠、引号、换行、非 BMP emoji 逐字符复原；
  //   2. **行的原型是普通对象** —— `node:sqlite` 返回 `null` 原型的行，直接交出时
  //      `JSON.stringify` 恰好正常（HTTP 面看不出问题），而这里是红的最坏一种假绿；
  //   3. 没有调用的那条**不带 `toolCalls` 键**，而不是带一个 `null`（后者会让 shared 类型
  //      与 openapi 规格同时说谎）。
  assert.deepStrictEqual(first, withCalls);
  assert.ok(!("toolCalls" in second));
  assert.deepStrictEqual(second, plain);
});

test("被中断的一轮原样留在库里：不清理、不标记", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  // fixture 照 `engine-tools.test.ts` 的孤儿调用：助手消息带 toolCalls，没有对应的 tool 结果。
  manager.appendMessage(s.id, {
    id: "orphan",
    sessionId: s.id,
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCalls: [{ id: "c1", name: "probe", arguments: "{}" }],
  });
  manager.close();

  const messages = open().getDetail(s.id)?.messages ?? [];
  // 这条测的是「某件事**没有**发生」：孤儿调用必须原样可读。配对修复属于 core
  //（`engine.ts:229-241` 的 `#historyFor`），存储层不替它清理、也不加 incomplete 标记 ——
  // 而上游打断留下的半截一轮是运行期的事实，不是脏数据。
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, "orphan");
  assert.deepEqual(messages[0]?.toolCalls, [{ id: "c1", name: "probe", arguments: "{}" }]);
});

test("删除会话不留孤儿消息（直接查表，不靠 list 反推）", (t) => {
  const { open, dbPath } = useStore(t);
  const manager = open();
  const s = manager.create();
  manager.appendMessage(s.id, userMessage("m-1", s.id, "hi", "2026-01-01T00:00:00.000Z"));
  assert.equal(manager.delete(s.id), true);

  // 直接数 `messages` 表：只断言 `getDetail` 返回 null 证不了消息行也被清掉了，
  // 而「会话没了、消息成孤儿」恰恰是级联/两条 DELETE 没生效时的形态。
  const probe = new DatabaseSync(dbPath);
  try {
    const row = probe
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get(s.id) as { n: number };
    assert.equal(row.n, 0, "删除会话必须连带清掉它的消息");
  } finally {
    probe.close();
  }
  assert.equal(manager.delete(s.id), false, "重复删除回 false，让端点能回 404");
});

test("close 幂等，关闭后的读写是一句中文错而不是 SQLite 原始错", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  manager.close();
  manager.close();

  // `app.stop()` 与 `t.after` 可能各关一次，所以第二次必须静默。
  // 而关闭后还有人写（在途请求）时，要得到一句说得通的中文，不是内部错误码。
  assert.throws(
    () => manager.appendMessage(s.id, userMessage("m-1", s.id, "hi", "2026-01-01T00:00:00.000Z")),
    /会话存储已关闭/,
  );
  assert.throws(() => manager.list(), /会话存储已关闭/);
});

test("create 拒绝非字符串 title：STRICT 表挡不住，只有显式校验挡得住", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const loose: CreateLoose = manager;

  assert.equal(manager.create().title, "新会话");
  assert.equal(manager.create({ title: "x" }).title, "x");

  // `123` 这一条尤其重要：实测 STRICT 表会把整数写进 TEXT 列并静默变成 `'123.0'`，
  // 所以 DDL 挡不住它；而 boolean 会在绑定层抛 `ERR_INVALID_ARG_TYPE`，不校验就冒成 500。
  for (const bad of [123, true, null, ["a"], { a: 1 }]) {
    assert.throws(() => loose.create({ title: bad }), /title 必须是字符串/);
  }
  assert.equal(manager.list().length, 2, "被拒绝的 create 不该留下半成品会话");
});

test("同一个库文件被重复打开时不会重建 schema，计数走 SQL 而不是数组长度", (t) => {
  const { open } = useStore(t);
  const first = open();
  const a = first.create({ title: "A" });
  const b = first.create({ title: "B" });
  first.appendMessage(a.id, userMessage("m-1", a.id, "一", "2026-01-01T00:00:00.000Z"));
  first.appendMessage(a.id, userMessage("m-2", a.id, "二", "2026-01-01T00:00:01.000Z"));

  // 第二个句柄开在同一个文件上（等价于「重启」）：`migrate()` 必须是 no-op，
  // 且 `messageCount` 由 SQL 的相关子查询给出，不是内存数组长度。
  const second = open();
  const counts = new Map(second.list().map((s) => [s.id, s.messageCount]));
  assert.equal(counts.get(a.id), 2);
  assert.equal(counts.get(b.id), 0);
});
