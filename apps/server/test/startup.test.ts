import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "#app.ts";
import { makeTestConfig } from "./helpers/config.ts";

/**
 * 启动失败的那条路径。
 *
 * 单独一个文件而不是塞进 `e2e.test.ts`：那边的用例挂在「有没有 `pnpm build` 产物」上跳过，
 * 而这里与构建产物无关 —— 混进去会让这条最重要的启动检查在干净检出上被一起跳过。
 */

function tempRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "atri-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 占住一个端口并把它交出来（`port: 0` 让系统分配，避免测试之间抢固定端口）。 */
async function occupyPort(t: TestContext): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("占位服务没有拿到端口");
  return bound.port;
}

test("端口被占用时 start() 给出中文错误，而不是永久挂起", async (t) => {
  const port = await occupyPort(t);
  const app = await createApp({ ...makeTestConfig({ root: tempRoot(t) }), port });
  // createApp 会启动后台引擎（调度器、主动消息的分钟级定时器）；这条用例的 start()
  // 注定失败，但**引擎已经在跑了** —— 不 stop 的话事件循环被定时器挂住，整个文件超时。
  t.after(() => app.stop().catch(() => undefined));

  // 这条的**失败形态是「不失败」**：`server.listen` 的错误是一个事件而不是异常，
  // 没有接住它的 promise 就永不 settle，`main().catch` 抓不到东西，测试只能挂到整个文件超时。
  // 所以量法必须是「带超时的竞速」——挂起与失败要能被分开说，否则这条用例只会 red 成 timeout，
  // 读的人以为上游卡了，其实是错误出口缺失。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    app.start().then(
      () => null,
      (err: unknown) => err,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("挂起"), 3000);
    }),
  ]);
  if (timer) clearTimeout(timer);

  assert.notEqual(outcome, "挂起", "listen 失败必须让这个 promise settle");
  assert.ok(outcome instanceof Error, `应该抛错而不是启动成功，实际 ${String(outcome)}`);
  // 用户可见字符串一律中文（AGENTS.md）：以前这里得到的是 Node 默认出口打的一条英文裸栈。
  assert.match(outcome.message, /无法监听 127\.0\.0\.1:/);
  assert.match(outcome.message, /地址已被占用/);
  assert.equal(
    (outcome as { cause?: { code?: string } }).cause?.code,
    "EADDRINUSE",
    "包装必须带 cause，否则堆栈里丢了原始错误，排查变成猜",
  );
});
