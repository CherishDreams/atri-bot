import type { ToolCall, ToolResult } from "@atri/shared";
import { errorMessage } from "../errors.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * 回喂给模型的单条结果上限（字符）。
 *
 * 本仓自选的数字，不是上游惯例：工具结果会整段进入下一轮上下文，太大既费 token
 * 又把对话历史挤掉；8000 字符大致相当于 2–3k token，够放下一次正常的抓取或查询结果，
 * 又不足以让一轮把上下文塞满。
 */
const RESULT_LIMIT_CHARS = 8_000;

/**
 * 工具注册表：只管存、取、执行转发。
 *
 * 与 `core/provider/registry.ts` 同一层规矩 —— **不 import 任何具体工具实现，也不读配置**。
 * 内置工具由组合根注册进来（见 `app.ts`）；启用与否是配置的事，由 `ToolConfigStore` 管，
 * 注册表只回答「这颗工具存在吗、跑它会得到什么」。
 */
export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): ToolDefinition {
    if (!tool?.id) throw new Error("工具必须带有 id");
    // `run` 在类型上是必填的，这道检查只为「装配写错时立刻失败」：
    // 现在不报，就要等到模型真调它那一刻才炸，而那一刻用户已经在等一条长回复了。
    if (typeof tool.run !== "function") throw new Error(`工具「${tool.id}」缺少 run()`);
    this.#tools.set(tool.id, tool);
    return tool;
  }

  get(id: string): ToolDefinition | null {
    return this.#tools.get(id) ?? null;
  }

  /** 注册顺序，不是配置顺序：上游看到的工具顺序由此确定，与谁先写配置文件无关。 */
  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /**
   * 挑出本轮要交给模型的工具。未注册的 id 忽略 —— 配置文件里拼错一颗工具名
   * 不该让整轮失败；那种情况由调用方（引擎）对照 `list()` 记一条 warn。
   */
  pick(ids: readonly string[]): ToolDefinition[] {
    const wanted = new Set(ids);
    return this.list().filter((tool) => wanted.has(tool.id));
  }

  /**
   * 执行一次调用，永远返回结果、从不抛错。
   *
   * 「模型幻觉出一个工具名」与「参数不是合法 JSON」是 function calling 的常态，
   * 把它们抛出去会让整轮变成 400/500（见 `api/server.ts` 的错误分派），
   * 而回喂一条 `isError` 才是可纠正的一回合。**provider 层错误不经过这里**，照旧抛。
   */
  async run(call: ToolCall, limitChars = RESULT_LIMIT_CHARS): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (!tool) {
      return this.#failure(call, `没有名为「${call.name}」的工具`);
    }

    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.arguments);
    } catch (err) {
      return this.#failure(call, `参数不是合法的 JSON 对象：${errorMessage(err)}`);
    }

    let text: string;
    try {
      text = await tool.run(args);
    } catch (err) {
      // 只把 `errorMessage` 给模型，绝不给堆栈：工具内部错误可能带着路径或上游响应体。
      return this.#failure(call, `工具「${call.name}」执行失败：${errorMessage(err)}`);
    }

    const content =
      text.length > limitChars
        ? `${text.slice(0, limitChars)}\n…（结果已截断，原长 ${text.length} 字符）`
        : text;
    return { toolCallId: call.id, name: call.name, content };
  }

  #failure(call: ToolCall, content: string): ToolResult {
    return { toolCallId: call.id, name: call.name, content, isError: true };
  }
}

/**
 * 把模型产出的原始参数串收成对象。
 *
 * 空串按 `{}` 处理：不少 OpenAI 兼容网关在「无参数」调用里就发空串或 null。
 * 数组与标量一律拒绝 —— 工具的 `run()` 拿到的是具名参数，不是位置参数。
 */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  // 边界收窄：这段 JSON 是模型写的，形状只能在运行时判定。
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`期望对象，实际是 ${Array.isArray(parsed) ? "array" : typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}
