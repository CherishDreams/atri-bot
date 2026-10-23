import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonaInfo, ProfileConfig } from "@atri/shared";
import { createApp } from "#app.ts";
import type { Logger } from "#core/logger.ts";
import { PersonaStore } from "#core/persona/store.ts";
import { profileConfigPath, profilesRoot } from "#config/profiles.ts";
import { makeTestConfig } from "./helpers/config.ts";

interface Harness {
  cookie: string;
  call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  profileFile: string;
  personasFile: string;
}

async function start(t: TestContext): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "atri-personas-"));
  const dataDir = join(root, "data");
  const app = await createApp(makeTestConfig({ root, dataDir }));
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
  const first = login.headers.getSetCookie()[0];
  if (!first) throw new Error("登录响应没有 Cookie");
  const cookie = first.split(";")[0] as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  return {
    cookie,
    call,
    profileFile: profileConfigPath(profilesRoot(dataDir), "default"),
    personasFile: join(dataDir, "personas.json"),
  };
}

test("PersonaStore：坏文件时拒绝写入，内存表也不能被污染", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-personas-broken-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "personas.json");
  writeFileSync(file, "{ 不是合法 JSON", "utf8");
  const lines: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  const store = new PersonaStore({ filePath: file, logger });

  assert.equal(store.list().length, 0);
  assert.throws(
    () => store.create({ id: "ghost", name: "不该出现的人格", systemPrompt: "不会生效" }),
    /不能写入/,
  );
  assert.equal(store.list().length, 0, "写失败后 GET /personas 不能凭空多出一条人格");
});

test("人格：默认人格、CRUD、配置档引用与删除保护", async (t) => {
  const h = await start(t);

  const initial = await h.call("GET", "/personas");
  assert.equal(initial.status, 200);
  const seeded = (initial.body.personas as PersonaInfo[]).find((p) => p.id === "default");
  assert.ok(seeded, "首次启动应有一个可编辑的默认人格");
  assert.ok(seeded.systemPrompt.length > 0);

  const created = await h.call("POST", "/personas", {
    id: "work",
    name: "工作人格",
    description: "只谈工作",
    systemPrompt: "你是严谨的工作助手。",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.persona, {
    id: "work",
    name: "工作人格",
    description: "只谈工作",
    systemPrompt: "你是严谨的工作助手。",
  });
  assert.equal(statSync(h.personasFile).mode & 0o777, 0o600);

  const saved = await h.call("POST", "/profiles/default/config", { personaId: "work" });
  assert.equal(saved.status, 200);
  const config = saved.body.config as unknown as ProfileConfig;
  assert.equal(config.personaId, "work");
  const raw = readFileSync(h.profileFile, "utf8");
  assert.match(raw, /"personaId": "work"/);

  const bad = await h.call("POST", "/profiles/default/config", { personaId: "ghost" });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /人格库中没有/);

  const updated = await h.call("POST", "/personas/work", {
    name: "工作人格 v2",
    description: "",
    systemPrompt: "你是更新后的工作助手。",
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.body.persona as PersonaInfo).name, "工作人格 v2");

  const blocked = await h.call("DELETE", "/personas/work");
  assert.equal(blocked.status, 409);
  assert.match(String(blocked.body.error), /正被配置档/);

  assert.equal((await h.call("POST", "/profiles/default/config", { personaId: null })).status, 200);
  const removed = await h.call("DELETE", "/personas/work");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  assert.equal((await h.call("DELETE", "/personas/work")).status, 404);

  const invalid = await h.call("POST", "/personas", {
    id: "Bad Id",
    name: "",
    systemPrompt: "",
  });
  assert.equal(invalid.status, 400);
});
