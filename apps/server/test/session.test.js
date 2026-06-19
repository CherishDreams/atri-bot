import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/core/session/manager.js";

test("创建、读取并列出会话", () => {
  const m = new SessionManager({});
  const s = m.create({ title: "t" });
  assert.equal(m.get(s.id).title, "t");
  assert.equal(m.list().length, 1);
});

test("对未知会话追加消息应报错", () => {
  const m = new SessionManager({});
  assert.throws(() => m.appendMessage("missing", {}), /未知会话/);
});

test("统计消息数量且不泄露消息内容", () => {
  const m = new SessionManager({});
  const s = m.create();
  m.appendMessage(s.id, { role: "user", content: "hi" });
  const view = m.get(s.id);
  assert.equal(view.messageCount, 1);
  assert.equal(view.messages, undefined);
});
