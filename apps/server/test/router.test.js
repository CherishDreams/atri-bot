import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/api/router.ts";

test("匹配静态路由", () => {
  const r = new Router().get("/api/v1/health", () => {});
  const hit = r.match("GET", "/api/v1/health");
  assert.ok(hit);
  assert.deepEqual(hit.params, {});
});

test("提取路径参数", () => {
  const r = new Router().get("/api/v1/sessions/:id", () => {});
  const hit = r.match("GET", "/api/v1/sessions/abc");
  assert.ok(hit);
  assert.equal(hit.params.id, "abc");
});

test("方法不同则不匹配", () => {
  const r = new Router().get("/x", () => {});
  assert.equal(r.match("POST", "/x"), null);
});

test("忽略结尾的斜杠", () => {
  const r = new Router().get("/x", () => {});
  assert.ok(r.match("GET", "/x/"));
});
