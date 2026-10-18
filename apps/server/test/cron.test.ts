import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJobInfo, Message, SessionDetail } from "@atri/shared";
import { createApp } from "#app.ts";
import type { AgentEngine } from "#core/agent/engine.ts";
import { CronScheduler } from "#core/cron/manager.ts";
import { CronStore } from "#core/cron/store.ts";
import { nextCronTime, parseCron } from "#core/cron/cron.ts";
import type { Logger } from "#core/logger.ts";
import { SessionManager } from "#core/session/manager.ts";
import { makeTestConfig } from "./helpers/config.ts";

function quietLogger(lines: string[] = []): Logger {
  return {
    debug() {},
    info: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

function reply(content: string): Message {
  return {
    id: crypto.randomUUID(),
    sessionId: "s",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("cron：5 段解析、步长、非法值与本地时区的下一时刻", () => {
  assert.equal(nextCronTime(parseCron("0 9 * * *"), new Date(2026, 0, 1, 10, 0)).getHours(), 9);
  const every15 = nextCronTime(parseCron("*/15 * * * *"), new Date(2026, 0, 1, 10, 3));
  assert.deepEqual([every15.getHours(), every15.getMinutes()], [10, 15]);
  const next = nextCronTime(parseCron("0 9 * * *"), new Date(2026, 0, 1, 10, 0));
  assert.equal(next.getDate(), 2, "过了今天的 9 点应落到明天 9 点");

  for (const bad of ["* * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "*/0 * * * *"]) {
    assert.throws(() => parseCron(bad), /cron|超出|步长/);
  }
});

test("CronScheduler：到点执行、复用任务会话并记录结果", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atri-cron-unit-"));
  mkdirSync(join(root, "data"), { recursive: true });
  const sessions = new SessionManager({ dataDir: join(root, "data") });
  const lines: string[] = [];
  const prompts: string[] = [];
  const fakeEngine = {
    async handleMessage(options: { sessionId: string; content: string }) {
      prompts.push(options.content);
      const now = new Date().toISOString();
      sessions.appendMessage(options.sessionId, {
        id: crypto.randomUUID(),
        sessionId: options.sessionId,
        role: "user",
        content: options.content,
        createdAt: now,
      });
      const answer = reply(`完成：${options.content}`);
      sessions.appendMessage(options.sessionId, { ...answer, sessionId: options.sessionId });
      return answer;
    },
  } as unknown as AgentEngine;
  let now = new Date(2026, 0, 1, 10, 0, 30);
  let timer: (() => void) | null = null;
  const store = new CronStore({
    filePath: join(root, "data", "cron.json"),
    logger: quietLogger(lines),
  });
  const scheduler = new CronScheduler({
    store,
    logger: quietLogger(lines),
    sessions,
    resolveEngine: (id) => (id === "default" ? fakeEngine : null),
    now: () => now,
    setTimer: (callback) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => {},
  });
  t.after(() => {
    scheduler.stop();
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  });

  const created = scheduler.create({
    name: "每分钟",
    cron: "* * * * *",
    prompt: "汇报状态",
    profile: "default",
    enabled: true,
  });
  assert.equal(created.nextRunAt, new Date(2026, 0, 1, 10, 1).toISOString());
  assert.ok(timer, "创建后应安排下一次定时器");

  now = new Date(2026, 0, 1, 10, 1, 0);
  assert.equal(await scheduler.runDue(), 1, "到点任务应被执行");
  assert.deepEqual(prompts, ["汇报状态"]);

  const job = scheduler.list()[0];
  assert.ok(job);
  assert.equal(job.running, false);
  assert.equal(job.lastStatus, "success");
  assert.equal(job.lastError, null);
  assert.ok(job.sessionId);
  const detail = sessions.getWithMessages(job.sessionId);
  assert.deepEqual(
    detail?.messages.map((m) => [m.role, m.content]),
    [
      ["user", "汇报状态"],
      ["assistant", "完成：汇报状态"],
    ],
  );

  // 同一分钟重复调用不会执行第二次；下一次定时器仍在。
  assert.equal(await scheduler.runDue(), 0);
  assert.equal(prompts.length, 1);

  const file = join(root, "data", "cron.json");
  assert.match(readFileSync(file, "utf8"), /汇报状态/);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  assert.throws(
    () =>
      scheduler.create({
        name: "坏档",
        cron: "0 9 * * *",
        prompt: "x",
        profile: "missing",
        enabled: true,
      }),
    /不存在或当前不可用/,
  );
});

test("计划任务 API：创建、手动执行、会话结果与删除", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "atri-cron-api-"));
  const app = await createApp(makeTestConfig({ root, dataDir: join(root, "data") }));
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
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("登录失败");
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

  const bad = await call("POST", "/cron", {
    name: "坏 cron",
    cron: "每天九点",
    prompt: "x",
    profile: "default",
  });
  assert.equal(bad.status, 400);

  const created = await call("POST", "/cron", {
    name: "手动执行",
    cron: "0 9 * * *",
    prompt: "说一句定时任务测试",
    profile: "default",
    enabled: false,
  });
  assert.equal(created.status, 201);
  const job = created.body.job as CronJobInfo;
  assert.equal(job.enabled, false);
  assert.equal(job.nextRunAt, null);

  const listed = await call("GET", "/cron");
  assert.equal((listed.body.jobs as CronJobInfo[]).length, 1);

  assert.equal((await call("POST", `/cron/${job.id}/run`)).status, 202);
  await waitFor(async () => {
    const res = await call("GET", "/cron");
    const current = (res.body.jobs as CronJobInfo[]).find((item) => item.id === job.id);
    return current?.lastStatus !== null;
  });
  const done = ((await call("GET", "/cron")).body.jobs as CronJobInfo[])[0];
  assert.ok(done);
  assert.equal(done.lastStatus, "success");
  assert.ok(done.sessionId);

  const detail = await call("GET", `/sessions/${done.sessionId}`);
  const messages = (detail.body.session as SessionDetail).messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(messages[0]?.content, "说一句定时任务测试");
  assert.match(messages[1]?.content ?? "", /\[回声/);

  const removed = await call("DELETE", `/cron/${job.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await call("DELETE", `/cron/${job.id}`)).status, 404);
});
