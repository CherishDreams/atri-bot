import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/core/session/manager.ts";

test("创建、读取并列出会话", () => {
  const m = new SessionManager();
  const s = m.create({ title: "t" });
  assert.equal(m.get(s.id).title, "t");
  assert.equal(m.list().length, 1);
});

test("对未知会话追加消息应报错", () => {
  const m = new SessionManager();
  assert.throws(() => m.appendMessage("missing", {}), /未知会话/);
});

test("统计消息数量且不泄露消息内容", () => {
  const m = new SessionManager();
  const s = m.create();
  m.appendMessage(s.id, { role: "user", content: "hi" });
  const view = m.get(s.id);
  assert.equal(view.messageCount, 1);
  assert.equal(view.messages, undefined);
});

test("会话详情带上完整消息历史，且是副本", () => {
  const m = new SessionManager();
  const s = m.create({ title: "t" });
  m.appendMessage(s.id, { role: "user", content: "hi" });
  m.appendMessage(s.id, { role: "assistant", content: "yo" });

  const detail = m.getDetail(s.id);
  assert.equal(detail.title, "t");
  assert.equal(detail.messageCount, 2);
  assert.deepEqual(
    detail.messages.map((x) => x.role),
    ["user", "assistant"],
  );

  // 拿到的数组必须是副本：外部改动不能污染内部状态。
  detail.messages.push({ role: "user", content: "注入" });
  assert.equal(m.getDetail(s.id).messages.length, 2);
});

test("未知会话的详情返回 null 而不是抛错", () => {
  const m = new SessionManager();
  assert.equal(m.getDetail("missing"), null);
});
