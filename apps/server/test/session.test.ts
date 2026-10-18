import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Session, SessionDetail } from "@atri/shared";
import { SessionManager } from "#core/session/manager.ts";
import { ApiError } from "#core/errors.ts";
import { openSessionDb, sessionDbPath } from "#core/session/db.ts";

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
  // 与 `AppConfig` 的默认值同形（`loadConfig()` 对 `dataDir` 是 `resolve(root, "data")`），
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
    list: (): Session[] => manager.list().sessions,
    appendMessage: (sessionId: string, message: Message): Message =>
      manager.appendMessage(sessionId, message),
    get(id: string): Session & { messages?: undefined } {
      const session = manager.get(id);
      if (!session) throw new Error(`会话不见了: ${id}`);
      return session;
    },
    getDetail(id: string): SessionDetail {
      // 拆掉分页的包装（默认页 = 最新 100 条，这些用例最多 2 条，永远取满）。
      // 分页语义由下面的用例**直接**调 `manager.getDetail(id, opts)` 来测。
      const page = manager.getDetail(id);
      if (!page) throw new Error(`会话详情不见了: ${id}`);
      return page.detail;
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

test("对未知会话追加消息应报 404，而不是把内部串回给客户端", (t) => {
  const { open } = useStore(t);
  const m: AppendLoose = open();
  // 断言的是**类型与状态码**，不是消息文本：旧写法只 match `/未知会话/`，于是那句话改成
  // 任何中文都还是绿的，而 `appendMessage` 的 catch 靠它区分「刻意 404」与「存储故障」。
  assert.throws(
    () => m.appendMessage("missing", {}),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, `应是 ApiError，实际是 ${String(err)}`);
      assert.equal(err.status, 404);
      assert.equal(err.message, "会话不存在");
      return true;
    },
  );
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
    again.getDetail(s.id)?.detail.messages.map((m) => m.id),
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
        // `arguments` 是模型产出的原始串，全程原样搬运（`ToolRegistry` 的 `parseArguments` 只把它喂给
        // 工具的具名参数，刻意不进一步解析）。
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

  const [first, second] = open().getDetail(s.id)?.detail.messages ?? [];
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

test("图片附件原样往返，纯文本消息不带 images 键", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  const withImage: Message = {
    id: "m-image",
    sessionId: s.id,
    role: "user",
    content: "",
    images: [{ data: "aGVsbG8=", mediaType: "image/png" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const plain: Message = {
    id: "m-text",
    sessionId: s.id,
    role: "user",
    content: "没有图",
    createdAt: "2026-01-01T00:00:01.000Z",
  };
  manager.appendMessage(s.id, withImage);
  manager.appendMessage(s.id, plain);
  manager.close();

  const [first, second] = open().getDetail(s.id)?.detail.messages ?? [];
  assert.deepStrictEqual(first, withImage);
  assert.ok(second);
  assert.ok(!("images" in second), "纯文本消息读回来不能多一个 images: null");
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

  const messages = open().getDetail(s.id)?.detail.messages ?? [];
  // 这条测的是「某件事**没有**发生」：孤儿调用必须原样可读。配对修复属于 core
  //（`AgentEngine.#historyFor`），存储层不替它清理、也不加 incomplete 标记 ——
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
  assert.equal(manager.list().sessions.length, 2, "被拒绝的 create 不该留下半成品会话");
});

/**
 * 造 N 条消息，返回它们的 id（插入序）。
 *
 * id 补零到三位，这样「逐页拼接等于全量」比对的是字符串数组，而不是靠 id 的生成顺序
 * 恰好等于字典序 —— 那会让断言自己也在赌一个巧合。
 */
function seed(manager: SessionManager, sessionId: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `m-${String(i).padStart(3, "0")}`;
    manager.appendMessage(
      sessionId,
      userMessage(id, sessionId, `第 ${i} 条`, "2026-01-01T00:00:00.000Z"),
    );
    ids.push(id);
  }
  return ids;
}

/**
 * 分页的逐页拼接必须**等于**全量：漏一条的 bug 在界面上表现为「中间少一句」，
 * 不报错、不重复、肉眼完全看不出，只有这一条断言抓得住。
 *
 * 它的杀伤力来自 `nextCursor` 的取值：SQL 取的是 `limit + 1` 条，第 limit+1 条只用来
 * 证明「还有更早的」，不进响应。游标如果取**被丢掉那一行**的 seq，下一页的条件
 * `seq < cursor` 就正好把它排除掉 —— 而响应看起来完全正常。
 */
test("分页逐页拼接等于全量：一条不漏、一条不重", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  const ids = seed(manager, s.id, 101);

  const first = manager.getDetail(s.id, { limit: 100 });
  assert.ok(first);
  assert.equal(first.detail.messages.length, 100);
  assert.ok(first.nextCursor, "还有更早的就必须给游标");

  const second = manager.getDetail(s.id, { limit: 100, before: first.nextCursor });
  assert.ok(second);
  assert.equal(second.nextCursor, null, "翻到最早之后不该再给游标");

  // 默认页是**最新**的一页，且已经按插入序（旧→新），所以第二页拼在前面。
  const paged = [...second.detail.messages, ...first.detail.messages].map((m) => m.id);
  assert.deepEqual(paged, ids);
});

test("一页正好取完时不给游标；空会话给空数组而不是 null", (t) => {
  const { open } = useStore(t);
  const manager = open();

  const exact = manager.create({ title: "刚好一页" });
  seed(manager, exact.id, 100);
  const exactPage = manager.getDetail(exact.id);
  assert.ok(exactPage);
  assert.equal(exactPage.detail.messages.length, 100);
  assert.equal(exactPage.nextCursor, null, "第 101 条不存在时不能给游标");

  const empty = manager.create({ title: "空" });
  const emptyPage = manager.getDetail(empty.id);
  assert.ok(emptyPage);
  assert.deepEqual(emptyPage.detail.messages, []);
  assert.equal(emptyPage.nextCursor, null);
  assert.equal(emptyPage.detail.messageCount, 0);
});

test("limit=1 时逐条翻完，游标链是通的", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const s = manager.create();
  const ids = seed(manager, s.id, 3);

  const pages: string[][] = [];
  let cursor: string | null | undefined;
  // 循环次数有上界：游标严格递减，翻到 null 就停；万一实现错了（游标不前进），
  // 这个 guard 会让它失败而不是挂住。
  for (let guard = 0; guard < 10; guard++) {
    const page = manager.getDetail(s.id, { limit: 1, before: cursor });
    assert.ok(page);
    pages.push(page.detail.messages.map((m) => m.id));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  assert.deepEqual(pages.toReversed().flat(), ids);
});

test("会话列表分页保持创建序：截断而不改序", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const titles = ["A", "B", "C"].map((title) => manager.create({ title }).id);

  // 默认页取**最新**的一批，但数组仍是创建序（旧→新）：dashboard 不做二次排序，
  // 把它实现成 DESC 直出会让整个列表反序，而这条既有事实不会报错、只会静默失效。
  const page = manager.list({ limit: 2 });
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    [titles[1], titles[2]],
  );
  assert.ok(page.nextCursor);

  const older = manager.list({ limit: 2, before: page.nextCursor });
  assert.deepEqual(
    older.sessions.map((s) => s.id),
    [titles[0]],
  );
  assert.equal(older.nextCursor, null);
});

test("非法的 limit 与 before 都是 400，不夹取也不当没传", (t) => {
  const { open } = useStore(t);
  const manager = open();
  manager.create();

  // NaN 是 `Number("abc")` 的结果：它不是整数，所以与「没传」在 `#page()` 里分得开。
  // 下面刻意用**不存在的 id** 问 `getDetail`：分页校验必须在资源查找之前，
  // 否则「未知 id + 非法 limit」会回 404，等于用状态码泄露资源存在性。
  for (const limit of [0, -1, 1.5, 501, Number.NaN]) {
    assert.throws(() => manager.list({ limit }), /limit 必须是/, `limit=${String(limit)}`);
    assert.throws(() => manager.getDetail("x", { limit }), /limit 必须是/);
  }
  // `base64url` 解码对非法字符是**忽略**而不是抛，所以判据只能落在「必须是
  // `<kind>:<纯数字>`」上。`"MTIz"` 解出来是裸的 `123` —— 那是**上一版**的游标格式，
  // 现在归进非法一类：代价是「升级那一瞬间还留在浏览器里的旧游标」会得到一次 400，
  // 而游标不落盘、只在内存里活一页，刷新即好。把它继续当合法值才是说谎。
  for (const before of ["", "!!!", "-1", "0", "abc", "MTIz"]) {
    assert.throws(() => manager.list({ before }), /before 不是合法的游标/, `before=${before}`);
  }
});

/**
 * 两个分页序列的游标不通用。
 *
 * 修之前 `GET /sessions` 的 `nextCursor` 会被 `GET /sessions/:id` 照单收下，拿去过滤
 * **另一条** seq 序列：不报错、不回 400，只是安静地给出一页不相干的消息 —— 两个序列都是
 * 表的 rowid，数值上本来就会互相撞对。判据现在写在游标串里，所以这条要能证伪。
 */
test("会话列表的游标不能拿去翻消息，反之也一样", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const session = manager.create({ title: "两个游标空间" });
  // 三个会话 + 三条消息：两侧都要能翻出「还有更早」，否则游标根本不出现、用例没有前提。
  manager.create({ title: "B" });
  manager.create({ title: "C" });
  for (const i of [0, 1, 2]) {
    manager.appendMessage(
      session.id,
      userMessage(`m-${i}`, session.id, `第 ${i} 条`, `2026-01-0${i + 1}T00:00:00.000Z`),
    );
  }

  const sessionsPage = manager.list({ limit: 1 });
  const messagesPage = manager.getDetail(session.id, { limit: 1 });
  // `getDetail` 的返回带 `| null`（未知 id 那条路径），这里会话是自己刚建的，守卫只为让
  // 后面几次读游标时不必再各自 `?.`。
  assert.ok(messagesPage, "会话存在就该给出一页");
  assert.ok(sessionsPage.nextCursor, "一页装不下三行时才出游标；没出游标这条用例就没前提");
  assert.ok(messagesPage.nextCursor, "同上：消息侧也要先有游标");

  assert.throws(
    () => manager.getDetail(session.id, { before: sessionsPage.nextCursor ?? "" }),
    /before 不是合法的游标/,
    "会话列表的游标不该被消息分页收下",
  );
  assert.throws(
    () => manager.list({ before: messagesPage.nextCursor ?? "" }),
    /before 不是合法的游标/,
    "消息分页的游标也不该被会话列表收下",
  );

  // 各归各用：同一个游标对自己的序列仍然有效（否则这条改动就把分页整个弄坏了）。
  const older = manager.getDetail(session.id, { limit: 1, before: messagesPage.nextCursor ?? "" });
  assert.ok(older);
});

test("游标指向已经没有内容的位置时回空页，而不是 404", (t) => {
  const { open } = useStore(t);
  const manager = open();
  const a = manager.create({ title: "A" });
  const b = manager.create({ title: "B" });
  const c = manager.create({ title: "C" });

  const page = manager.list({ limit: 1 });
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    [c.id],
  );
  assert.ok(page.nextCursor);

  // 游标还有效，但它指向的那一段已经被删空了：分页不该因为「无旧数据」而报不存在。
  manager.delete(a.id);
  manager.delete(b.id);
  const older = manager.list({ limit: 1, before: page.nextCursor });
  assert.deepEqual(older.sessions, []);
  assert.equal(older.nextCursor, null);
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
  const counts = new Map(second.list().sessions.map((s) => [s.id, s.messageCount]));
  assert.equal(counts.get(a.id), 2);
  assert.equal(counts.get(b.id), 0);
});

/**
 * 连接的两个 pragma 是真的下设了，而不只是注释里说了。
 *
 * `journal_mode = WAL` 与 `timeout: 5_000` 都是「只在有两个进程时才看得出差别」的设置：
 * 单进程的测试全绿也挡不住有人把这两行删掉，而删掉的后果是别人备份时读到一句
 * `database is locked`。这里量的是 `openSessionDb` 本人 —— 它是生产路径上唯一建连接的地方。
 * `busy_timeout` 是**每连接**的属性，所以这个探针连接报告的就是 `openSessionDb` 设的那个值。
 */
test("库连接按 WAL + 5 秒 busy timeout 打开", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "atri-pragma-")), "data");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const probe = openSessionDb(dataDir);
  t.after(() => probe.close());

  // 每一句都先摊成普通对象再比：`node:sqlite` 返回的行**原型是 null**（实测，
  // `manager.ts` 的「必须逐字段构造领域对象」就是为它写的），而 `deepStrictEqual`
  // 比原型 —— 直接拿行去比会红在「原型不同」上，看起来像 pragma 没生效。
  const pragma = (sql: string): Record<string, unknown> => {
    const row = probe.prepare(sql).get();
    // `get()` 在类型上是「可能没有这一行」，而 pragma 恒给一行；守卫把它变成必有。
    assert.ok(row, `${sql} 没有返回行`);
    return { ...row };
  };
  assert.deepEqual(pragma("PRAGMA journal_mode"), { journal_mode: "wal" });
  assert.deepEqual(pragma("PRAGMA busy_timeout"), { timeout: 5_000 });
  // 外键**刻意不下设**（`node:sqlite` 自 v22.10 起默认开），但默认必须是开着的：
  // `delete()` 的「只删会话靠级联」那半道保险寄托在它上面。
  assert.deepEqual(pragma("PRAGMA foreign_keys"), { foreign_keys: 1 });
});

/**
 * 库比代码新时要当场说清楚，而不是「跑得起来但读不出东西」。
 *
 * 这条守卫只在 downgrade 的场景发作（拿旧版服务端开新版库），所以平时没人走得到 ——
 * 也正因为平时走不到，它最容易被改掉而无人察觉。
 */
test("库的 schema 比代码新时启动即失败，并给出可读的一句", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "atri-pragma-new-")), "data");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const fresh = openSessionDb(dataDir);
  // 手工把版本号拨到代码之上，模拟「这个库是被更高版本的服务端建的」。
  // `PRAGMA user_version = ?` 是语法错误（pragma 的值不是可绑定参数），只能拼串。
  fresh.exec("PRAGMA user_version = 99");
  fresh.close();

  assert.throws(
    () => openSessionDb(dataDir),
    /schema 版本是 v99，比当前代码支持的 v\d+ 更新/,
    "库比代码新时必须拒绝启动，而不是跳过迁移后在某条 SQL 上报 no such column",
  );
});

/**
 * 追加消息是**一个**原子单元，不是两条各自提交的语句。
 *
 * `appendMessage` 里先 `UPDATE sessions SET updated_at`、再 `INSERT INTO messages`，
 * 两条之间失败的话，症状是「会话在列表上排到了最新，历史里却没有那条」—— 正是引擎侧
 * 那句「不要出现只有半边看得见」要挡的东西。没有 `#tx` 的话这条用例照样绿，
 * 所以这条用例是那个 BEGIN/COMMIT 唯一的守卫。
 */
test("追加消息：INSERT 失败时 updatedAt 也不许留下变化", (t) => {
  const { open } = useStore(t);
  const m = known(open());
  const s = m.create({ title: "半边看不见" });
  m.appendMessage(s.id, userMessage("dup", s.id, "第一条", "2026-01-01T00:00:00.000Z"));
  const committed = m.get(s.id).updatedAt;
  // **同步等过一毫秒**再去撞失败。`appendMessage` 自己取 `new Date().toISOString()`，
  // 毫秒分辨率，连着两次调用完全可以落在同一毫秒里 —— 那时无效实现（没有 BEGIN/COMMIT）
  // 里第二条的 UPDATE 写回的是同一个串，下面的断言就成了空跑。这条用例第一次就是这样假绿的，
  // 所以这一行不是装饰：它把「时间确实前进了」变成断言的前提。
  // `SessionManager` 没有注时钟的地方（`now` 是它内部一次性取的），所以这里等真实时钟。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);

  // 故意复用同一个消息 id：`messages.id` 上有 UNIQUE，INSERT 必失败，
  // 而它前面那条 UPDATE（换一个 `now`）已经执行过了 —— 回滚必须把它一起抹掉。
  assert.throws(() =>
    m.appendMessage(s.id, userMessage("dup", s.id, "又一条", "2026-01-02T00:00:00.000Z")),
  );

  assert.equal(
    m.get(s.id).updatedAt,
    committed,
    "UPDATE 提交而 INSERT 失败 = 列表排到最新、历史里查不到那条",
  );
  assert.equal(m.get(s.id).messageCount, 1, "失败的那条不该留下半个壳子");
});
