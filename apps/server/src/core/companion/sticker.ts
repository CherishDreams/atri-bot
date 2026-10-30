/**
 * 表情包素材库：`<dataDir>/profiles/<档 id>/stickers/<标签>/<文件>`。
 *
 * 按目录分标签（目录名即标签），素材就是图片文件 —— 与技能同一条「文件即真相」
 * 的哲学：加一张表情 = 往对应标签目录放一个 png/gif，没有写端点、没有数据库。
 * `pick()` 随机取一张（同样的情绪配不同的图，才像人）。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageImage } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
import type { Logger } from "#core/logger.ts";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 单张表情的字节上限（base64 前的估算）。表情包不是相册，太大说明放错了。 */
export const MAX_STICKER_BYTES = 2 * 1024 * 1024;

export interface StickerPick {
  tag: string;
  fileName: string;
  image: MessageImage;
}

export class StickerStore {
  readonly #root: string;
  readonly #logger: Logger;
  readonly #random: () => number;

  constructor({
    dir,
    logger,
    random = () => randomBytes(4).readUInt32BE(0) / 0x1_0000_0000,
  }: {
    dir: string;
    logger: Logger;
    /** 测试注入固定随机数；生产用 crypto。 */
    random?: () => number;
  }) {
    this.#root = dir;
    this.#logger = logger;
    this.#random = random;
  }

  /** 全部标签（每次现扫：放一个目录，下一个工具调用就能用到）。 */
  tags(): string[] {
    try {
      return readdirSync(this.#root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\S{1,32}$/u.test(entry.name))
        .map((entry) => entry.name)
        .toSorted();
    } catch {
      return []; // 目录不存在 = 还没放任何表情
    }
  }

  /**
   * 从标签里随机取一张。空标签/全是不认识的扩展名返回 `null`；
   * 单张超过字节上限的跳过并 warn（base64 后进 provider 请求，太大会拖垮整轮）。
   */
  pick(tag: string): StickerPick | null {
    if (!/^\S{1,32}$/u.test(tag)) return null;
    const dir = join(this.#root, tag);
    if (!existsSync(dir)) return null;
    let files: string[];
    try {
      files = readdirSync(dir).filter(
        (name) => MEDIA_TYPES[name.slice(name.lastIndexOf(".")).toLowerCase()] !== undefined,
      );
    } catch (err) {
      this.#logger.warn(`读取表情目录「${tag}」失败: ${errorMessage(err)}`);
      return null;
    }
    while (files.length > 0) {
      const index = Math.min(files.length - 1, Math.floor(this.#random() * files.length));
      const fileName = files.splice(index, 1)[0]!;
      const filePath = join(dir, fileName);
      try {
        const bytes = readFileSync(filePath);
        if (bytes.byteLength > MAX_STICKER_BYTES) {
          this.#logger.warn(`表情「${tag}/${fileName}」超过 ${MAX_STICKER_BYTES} 字节，已跳过`);
          continue;
        }
        const mediaType =
          MEDIA_TYPES[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()] ?? "image/png";
        return {
          tag,
          fileName,
          image: { data: bytes.toString("base64"), mediaType },
        };
      } catch (err) {
        this.#logger.warn(`读取表情「${tag}/${fileName}」失败: ${errorMessage(err)}`);
      }
    }
    return null;
  }
}

import type { ToolDefinition } from "#core/tool/types.ts";

/**
 * `send_sticker` 工具：模型按情绪选一个标签，框架随机取一张图经适配器发出。
 *
 * 这是一颗**用户开关**（默认关）：发图是能力授予。回喂给模型的文本刻意把
 * 失败原因说全（没有标签 / 平台不支持）—— 模型需要这些信息才能改用文字。
 */
export function createStickerTool(deps: {
  storeFor(profileId: string): StickerStore;
  /**
   * 由内部会话 id 反查「这一轮对话来自哪个平台会话」。找不到（控制台、cron）
   * 返回 `null` —— 那些来源没有平台通道可发。
   */
  resolveTarget(
    profileId: string,
    sessionId: string,
  ): { adapterId: string; conversation: { kind: "private" | "group"; id: string } } | null;
  send(
    adapterId: string,
    conversation: { kind: "private" | "group"; id: string },
    image: MessageImage,
    profileId: string,
  ): Promise<void>;
}): ToolDefinition {
  return {
    id: "send_sticker",
    name: "发表情",
    description:
      "发一张表情包到当前对话。在情绪明显（开心、无语、安慰、打招呼……）且表情比文字更合适时用；" +
      "一次一条消息最多配一张，不要连续发。",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "表情标签（情绪类别），从可用标签里选" },
      },
      required: ["tag"],
    },
    async run(args, options) {
      const context = options?.context;
      if (context === undefined) return "缺少本轮会话上下文，发不出表情。";
      const tag = args.tag;
      if (typeof tag !== "string" || tag.trim() === "") return "tag 必须是非空字符串。";
      const store = deps.storeFor(context.profileId);
      const sticker = store.pick(tag.trim());
      if (sticker === null) {
        const available = store.tags();
        return available.length === 0
          ? "还没有任何表情素材（素材库是空的）。"
          : `没有「${tag}」这个标签。可用的有：${available.join("、")}`;
      }
      const target = deps.resolveTarget(context.profileId, context.sessionId);
      if (target === null) return "这一轮对话不来自平台会话，发不出表情。";
      try {
        await deps.send(target.adapterId, target.conversation, sticker.image, context.profileId);
      } catch {
        return "这个平台不支持发图片，改用文字表达吧。";
      }
      return `已发送「${tag}」表情。`;
    },
  };
}
