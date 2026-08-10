import type { ToolDefinition } from "./types.ts";

/**
 * 内置工具。只有组合根 import 这里（`app.ts`），所以注册表不必知道任何具体工具。
 *
 * 目前只有一颗，而且刻意选**无副作用**的那颗：工具一旦能读写磁盘或外呼，就要连带
 * 决定作用域、超时与响应体上限（对照 `/provider-sources/:id/models` 为 SSRF 付过的代价，
 * 见 `docs/architecture.md`），那些不该和「把 function calling 这条路打通」混在一次改动里。
 */
export function createBuiltinTools(): ToolDefinition[] {
  return [currentTime];
}

const currentTime: ToolDefinition = {
  id: "current_time",
  name: "当前时间",
  // 这句是给模型读的：不说清「什么时候该用它」，模型就会拿训练记忆里的日期硬答。
  description:
    "获取此刻的日期与时钟。凡是要用到「今天 / 现在 / 距今多少天」这类信息，" +
    "先调用本工具，不要凭记忆推算时间。",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA 时区名，例如 Asia/Shanghai 或 UTC。省略时使用 UTC。",
      },
    },
  },

  async run({ timezone }) {
    // 逐键检查写在这里（而不是靠某个 schema 校验器）：`timezone` 是唯一入参，
    // 而非法的 IANA 名字交给 Intl 抛 RangeError 正好 —— 注册表会把它兜成
    // isError 结果回喂，模型下一次改用 UTC 就能自愈。
    const timeZone = typeof timezone === "string" && timezone ? timezone : "UTC";
    const local = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
      hour12: false,
    }).format(new Date());
    return `${local}（时区 ${timeZone}；ISO UTC 为 ${new Date().toISOString()}）`;
  },
};
