import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, Session, SessionDetail } from "@atri/shared";
import { SessionManager } from "#core/session/manager.ts";

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

test("创建、读取并列出会话", () => {
  const m = known(new SessionManager());
  const s = m.create({ title: "t" });
  assert.equal(m.get(s.id).title, "t");
  assert.equal(m.list().length, 1);
});

test("对未知会话追加消息应报错", () => {
  const m: AppendLoose = new SessionManager();
  assert.throws(() => m.appendMessage("missing", {}), /未知会话/);
});

test("统计消息数量且不泄露消息内容", () => {
  const m = known(new SessionManager());
  const s = m.create();
  // fixture 补全：`shared.Message` 是**已落库**的消息（带 id / sessionId / createdAt），
  // 不是发给上游的 `ChatMessage`。这三条字段不参与任何断言。
  m.appendMessage(s.id, {
    id: "m-1",
    sessionId: s.id,
    role: "user",
    content: "hi",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const view = m.get(s.id);
  assert.equal(view.messageCount, 1);
  assert.equal(view.messages, undefined);
});

test("会话详情带上完整消息历史，且是副本", () => {
  const m = known(new SessionManager());
  const s = m.create({ title: "t" });
  m.appendMessage(s.id, {
    id: "m-1",
    sessionId: s.id,
    role: "user",
    content: "hi",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
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

  // 拿到的数组必须是副本：外部改动不能污染内部状态。
  detail.messages.push({
    id: "m-3",
    sessionId: s.id,
    role: "user",
    content: "注入",
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  assert.equal(m.getDetail(s.id).messages.length, 2);
});

test("未知会话的详情返回 null 而不是抛错", () => {
  const m = new SessionManager();
  assert.equal(m.getDetail("missing"), null);
});
