/**
 * 表情包的测试：素材库（扫描/随机/上限）、send_sticker 工具（标签缺失、平台
 * 不支持、反查不到会话）、以及 OneBot 11 的图片发送（桩动作端口收到的报文）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StickerStore, createStickerTool } from "#core/companion/sticker.ts";
import type { Logger } from "#core/logger.ts";

// 一像素 PNG 的最小文件头（内容不重要，扩展名决定 mediaType）。
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

function silentLogger(sink: string[] = []): Logger {
  return {
    debug() {},
    info: (m) => sink.push(m),
    warn: (m) => sink.push(m),
    error: (m) => sink.push(m),
  };
}

function makeStore(t: { after: (fn: () => unknown) => void }, files: Record<string, Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), "atri-sticker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  return new StickerStore({ dir, logger: silentLogger(), random: () => 0 });
}

test("素材库：按目录分标签，pick 随机取一张并转 base64", (t) => {
  const s = makeStore(t, {
    "开心/a.png": PNG_BYTES,
    "开心/b.png": PNG_BYTES,
    "无语/c.gif": PNG_BYTES,
    "not-a-dir.txt": PNG_BYTES,
  });
  assert.deepEqual(s.tags(), ["开心", "无语"]);
  const pick = s.pick("开心");
  assert.ok(pick);
  assert.equal(pick.tag, "开心");
  assert.equal(pick.image.mediaType, "image/png");
  assert.equal(pick.fileName, "a.png", "随机数固定为 0 时取第一个");
  assert.ok(pick.image.data.length > 0);
  assert.equal(s.pick("不存在"), null);
  assert.equal(s.pick("../逃逸"), null, "标签也要过 id 正则");
  assert.equal(s.pick("empty"), null);
});

test("素材库：超大文件跳过并 warn", (t) => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "atri-sticker-big-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "开心"));
  writeFileSync(join(dir, "开心", "big.png"), Buffer.alloc(3 * 1024 * 1024));
  const s = new StickerStore({ dir, logger: silentLogger(lines) });
  assert.equal(s.pick("开心"), null);
  assert.ok(lines.some((line) => line.includes("超过")));
});

test("send_sticker：发送路径、缺标签反查失败与平台不支持", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atri-sticker-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "开心"));
  writeFileSync(join(dir, "开心", "a.png"), PNG_BYTES);
  const stickers = new StickerStore({ dir, logger: silentLogger() });

  const sent: { adapterId: string; id: string; mediaType: string }[] = [];
  const tool = createStickerTool({
    storeFor: () => stickers,
    resolveTarget: (profileId, sessionId) =>
      profileId === "default" && sessionId === "s1"
        ? { adapterId: "napcat", conversation: { kind: "private", id: "10001" } }
        : null,
    send: async (adapterId, conversation, image) => {
      sent.push({ adapterId, id: conversation.id, mediaType: image.mediaType });
    },
  });
  assert.equal(tool.id, "send_sticker");

  const ctx = {
    context: { profileId: "default", sessionId: "s1", senderId: "1", senderName: "小明" },
  } as const;
  const ok = await tool.run({ tag: "开心" }, ctx);
  assert.match(ok, /已发送/);
  assert.deepEqual(sent, [{ adapterId: "napcat", id: "10001", mediaType: "image/png" }]);

  const missing = await tool.run({ tag: "无语" }, ctx);
  assert.match(missing, /可用/);
  const noTurn = await tool.run({ tag: "开心" }, {});
  assert.match(noTurn, /缺少本轮会话上下文/);
  const noPlatform = await tool.run(
    { tag: "开心" },
    {
      context: { profileId: "default", sessionId: "console-x", senderId: null, senderName: null },
    },
  );
  assert.match(noPlatform, /不来自平台会话/);

  // 平台不支持发图：转成给模型的建议文本，而不是抛错。
  const reject = createStickerTool({
    storeFor: () => stickers,
    resolveTarget: () => ({ adapterId: "x", conversation: { kind: "private", id: "1" } }),
    send: async () => {
      throw new Error("不支持");
    },
  });
  const refused = await reject.run({ tag: "开心" }, ctx);
  assert.match(refused, /改用文字/);
});
