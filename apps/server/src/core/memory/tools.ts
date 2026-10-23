/**
 * 记忆相关工具（`memory_write` / `memory_search`）。与 `core/tool/builtins.ts`
 * 同一条装配观：这里只造定义，注册发生在组合根 —— 注册表不认识具体工具，
 * 工具要的数据（MemoryService）由组合根注入。
 *
 * 这两颗是**用户开关**而不是 internal：记忆写入是模型能力授予，默认关闭，
 * 与其它工具同一条判据（一次升级不该静默给模型新增能力）。开箱即用的部分是
 * `autoRecord`（引擎自动记录交互），不依赖这两颗。
 */
import type { ToolDefinition } from "#core/tool/types.ts";
import type { MemoryService } from "./service.ts";

/** 引擎总是带上下文；直接调用（测试、嵌入式）没有坐标时由 run() 自己说明。 */
function turnOf(context?: { profileId: string; sessionId: string }) {
  return context === undefined
    ? null
    : { profileId: context.profileId, sessionId: context.sessionId, userText: "" };
}

export function createMemoryTools(service: MemoryService): ToolDefinition[] {
  return [
    {
      id: "memory_write",
      name: "记住",
      description:
        "把值得长期记住的事实写入长期记忆（用户的偏好、背景、约定、重要经历）。" +
        "在用户明确说「记住」时必须调用；其他你认为后续对话会需要的信息也可以主动记。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "要记住的事实，尽量一句话说清（谁、什么事）",
          },
        },
        required: ["content"],
      },
      async run(args, options) {
        const turn = turnOf(options?.context);
        if (turn === null) return "记忆工具缺少本轮会话上下文，无法保存。";
        const content = args.content;
        if (typeof content !== "string") return "content 必须是字符串。";
        return service.remember(turn, content);
      },
    },
    {
      id: "memory_search",
      name: "检索记忆",
      description: "在长期记忆里检索与关键词相关的过往记录（用户自己可能都忘了的事）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词或短语" },
          limit: { type: "integer", description: "最多返回几条（默认由配置决定）" },
        },
        required: ["query"],
      },
      async run(args, options) {
        const turn = turnOf(options?.context);
        if (turn === null) return "记忆工具缺少本轮会话上下文，无法检索。";
        const query = args.query;
        if (typeof query !== "string") return "query 必须是字符串。";
        const limit = args.limit;
        return service.search(turn, query, typeof limit === "number" ? limit : undefined);
      },
    },
  ];
}
