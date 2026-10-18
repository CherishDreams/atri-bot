import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry } from "@atri/shared";
import { createApp } from "#app.ts";
import { LOG_BUFFER_CAPACITY, LogStore, createLogger } from "#core/logger.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 日志功能的两层：
 *
 * - `LogStore` 是纯内存逻辑，直接单测；环形上限、序号、续传与订阅者隔离都在这一层。
 * - HTTP 层用真 app 验证：历史、鉴权、参数校验、SSE 先补发后实时，以及「流开着
 *   也不能拖住关停」——那条只有真连接才看得见。
 */

async function startApp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "atri-logs-"));
  const pluginsRoot = join(root, "plugins");
  const pluginDir = join(pluginsRoot, "fixture");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "index.js"),
    'export default { id: "fixture", setup() {} };\n',
    "utf8",
  );

  const app = await createApp(
    makeTestConfig({ root, logLevel: "info", pluginDirs: [pluginsRoot] }),
  );
  await app.start();
  const origin = `http://127.0.0.1:${app.address().port}`;

  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  assert.equal(login.status, 200, "登录不成功的话，后面全是在测 401");
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  const [cookie] = setCookie.split(";");
  if (!cookie) throw new Error("set-cookie 没有 name=value 分段");

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  };
  t.after(stop);
  return { origin, cookie, stop };
}

interface LogStream {
  status: number;
  contentType: string | null;
  next(): Promise<LogEntry>;
  close(): Promise<void>;
}

/** 打开日志 SSE 并逐帧读；注释帧（`: keepalive`）跳过。 */
async function openLogStream(origin: string, cookie: string, query = ""): Promise<LogStream> {
  const res = await fetch(`${origin}/api/v1/logs/stream${query}`, { headers: { cookie } });
  if (!res.body) throw new Error("日志流没有响应体");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const next = async (): Promise<LogEntry> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6)) as LogEntry;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("日志流提前结束");
      buffer += decoder.decode(value, { stream: true });
    }
  };

  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    next,
    close: async () => {
      await reader.cancel().catch(() => {});
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("LogStore：序号单调、环形上限、续传与订阅者隔离", () => {
  const store = new LogStore();
  const seen: LogEntry[] = [];
  const unsubscribe = store.subscribe((entry) => seen.push(entry));

  const total = LOG_BUFFER_CAPACITY + 3;
  for (let i = 0; i < total; i += 1) {
    store.push("info", `第 ${i} 条`, "2026-01-01T00:00:00.000Z");
  }
  assert.equal(store.size, LOG_BUFFER_CAPACITY);
  const recent = store.recent(LOG_BUFFER_CAPACITY);
  assert.equal(recent.length, LOG_BUFFER_CAPACITY);
  assert.ok(recent.every((entry) => entry.instance === store.instance));
  assert.equal(recent[0]?.id, 4, "前三条应被环形缓冲挤掉");
  assert.equal(recent.at(-1)?.id, total);
  assert.equal(store.after(total - 2).length, 2, "续传只给 id 更大的那些");
  assert.equal(seen.length, total, "订阅者应看到每一条，包括已被挤掉的");

  unsubscribe();
  store.push("warn", "退订后", "2026-01-01T00:00:01.000Z");
  assert.equal(seen.length, total, "退订之后不应再收到");
  assert.equal(store.recent(1)[0]?.message, "退订后");

  // 订阅者（HTTP 长连接）在竞态里可能已经断了，它的异常不能反向打断产生日志的业务。
  store.subscribe(() => {
    throw new Error("订阅者坏了");
  });
  assert.doesNotThrow(() => store.push("error", "仍然写入"));

  store.push("info", "x".repeat(5000));
  const last = store.recent(1)[0];
  assert.ok(last);
  assert.ok(last.message.length < 5000, "超长消息应被截断");
  assert.ok(last.message.endsWith("…"));
});

test("createLogger 把达到级别的消息同时交给 sink", () => {
  const seen: { level: string; message: string; time: string }[] = [];
  const logger = createLogger("warn", {
    push(level, message, time) {
      seen.push({ level, message, time });
    },
  });
  logger.info("不显示");
  logger.warn("警告");
  logger.error("错误");
  assert.deepEqual(
    seen.map((entry) => entry.level),
    ["warn", "error"],
  );
  assert.deepEqual(
    seen.map((entry) => entry.message),
    ["警告", "错误"],
  );
  for (const entry of seen) assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
});

test("日志接口：历史、鉴权与参数校验", async (t) => {
  const h = await startApp(t);

  const res = await fetch(`${h.origin}/api/v1/logs?limit=5`, {
    headers: { cookie: h.cookie },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { instance: string; logs: LogEntry[] };
  assert.equal(typeof body.instance, "string");
  assert.ok(body.instance.length > 0);
  assert.ok(body.logs.length >= 2, "启动日志应至少有两行");
  assert.ok(body.logs.length <= 5);
  for (let i = 1; i < body.logs.length; i += 1) {
    assert.ok(body.logs[i]!.id > body.logs[i - 1]!.id, "历史日志必须按 id 升序");
  }
  for (const entry of body.logs) {
    assert.equal(entry.instance, body.instance, "同一份缓冲区里的行必须共享进程实例");
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(["debug", "info", "warn", "error"].includes(entry.level));
    assert.equal(typeof entry.message, "string");
  }

  assert.equal((await fetch(`${h.origin}/api/v1/logs`)).status, 401);
  assert.equal((await fetch(`${h.origin}/api/v1/logs/stream`)).status, 401);

  for (const query of ["limit=0", "limit=501", "limit=abc", "limit=1.5"]) {
    const bad = await fetch(`${h.origin}/api/v1/logs?${query}`, {
      headers: { cookie: h.cookie },
    });
    assert.equal(bad.status, 400, query);
  }
  for (const query of ["after=-1", "after=abc", "after=1.5"]) {
    const bad = await fetch(`${h.origin}/api/v1/logs/stream?${query}`, {
      headers: { cookie: h.cookie },
    });
    assert.equal(bad.status, 400, query);
  }
});

test("日志流：补发历史、实时推送，且不拖住关停", async (t) => {
  const h = await startApp(t);
  const stream = await openLogStream(h.origin, h.cookie, "?after=0");
  assert.equal(stream.status, 200);
  assert.match(stream.contentType ?? "", /text\/event-stream/);
  const first = await withTimeout(stream.next(), 3000, "没有收到历史日志");
  const second = await withTimeout(stream.next(), 3000, "历史日志不足两帧");
  assert.ok(second.id > first.id, "历史日志应按 id 升序");

  // 触发一条真实的服务端日志，证明订阅之后的推送是通的。
  const reload = await fetch(`${h.origin}/api/v1/plugins/fixture/reload?profile=default`, {
    method: "POST",
    headers: { cookie: h.cookie },
  });
  assert.equal(reload.status, 200);
  let live: LogEntry | null = null;
  for (let i = 0; i < 10; i += 1) {
    const entry = await withTimeout(stream.next(), 3000, "没有收到实时日志");
    if (
      entry.message.includes("正在重载插件: fixture") ||
      entry.message.includes("插件已加载: fixture")
    ) {
      live = entry;
      break;
    }
  }
  assert.ok(live, "实时日志流里没有插件重载的日志");
  await stream.close();

  // 第二路流挂着时关停：http.close 必须结束它，而不是等 keepalive 或客户端先走。
  const secondStream = await openLogStream(h.origin, h.cookie, "?after=0");
  await withTimeout(secondStream.next(), 3000, "第二路流没有历史");
  await withTimeout(h.stop(), 3000, "日志流拖住了 app.stop()");
  await secondStream.close();
});
