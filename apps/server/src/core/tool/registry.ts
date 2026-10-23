import type { ToolCall, ToolResult } from "@atri/shared";
import { errorMessage } from "#core/errors.ts";
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
 * 单次工具执行的默认上限。
 *
 * 本仓自选值：30 秒足够一次正常网络查询/命令，又不至于让一条 SSE 或适配器队列
 * 被一颗永远不返回的插件工具永久堵住。工具可以声明自己的 `timeoutMs`；超时只放弃
 * 等待，JS 无法强行终止第三方代码。
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * 工具注册表：只管存、取、执行转发。
 *
 * 与 `core/provider/registry.ts` 同一层规矩 —— **不 import 任何具体工具实现，也不读配置**。
 * 内置工具由组合根注册进来（见 `app.ts`）；启用与否是配置的事，由 `ToolConfigStore` 管，
 * 注册表只回答「这颗工具存在吗、跑它会得到什么」。
 */
export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>();
  /**
   * 运行期工具来源（插件工具）。每次 `list()` 现读，所以插件重载/禁用后
   * 下一轮请求立刻看到新清单；快照会让已卸下的插件继续被模型调用。
   */
  #sources: (() => readonly ToolDefinition[])[] = [];

  register(tool: ToolDefinition): ToolDefinition {
    if (!tool?.id) throw new Error("工具必须带有 id");
    // `run` 在类型上是必填的，这道检查只为「装配写错时立刻失败」：
    // 现在不报，就要等到模型真调它那一刻才炸，而那一刻用户已经在等一条长回复了。
    if (typeof tool.run !== "function") throw new Error(`工具「${tool.id}」缺少 run()`);
    this.#tools.set(tool.id, tool);
    return tool;
  }

  /**
   * 登记一个动态工具来源。静态注册的工具优先：插件不能覆盖内置工具。
   * 同 id 的插件工具由 `PluginManager` 在加载时拒绝，不会走到这里的静默覆盖。
   */
  registerSource(source: () => readonly ToolDefinition[]): void {
    this.#sources.push(source);
  }

  get(id: string): ToolDefinition | null {
    return this.list().find((tool) => tool.id === id) ?? null;
  }

  /** 注册顺序 + 动态来源；静态工具在前，插件工具在后。 */
  list(): ToolDefinition[] {
    const merged = new Map<string, ToolDefinition>();
    for (const tool of this.#tools.values()) merged.set(tool.id, tool);
    for (const source of this.#sources) {
      for (const tool of source()) {
        if (!merged.has(tool.id)) merged.set(tool.id, tool);
      }
    }
    return [...merged.values()];
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
   *
   * 与取消信号/超时竞速：工具不遵守 signal 时，框架至少不会把会话锁与适配器队列
   * 一起拖住；那颗工具的副作用可能仍在后台跑，这是 JS 无法强行终止的现实。
   */
  async run(
    call: ToolCall,
    { limitChars = RESULT_LIMIT_CHARS, signal }: { limitChars?: number; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    const tool = this.get(call.name);
    if (!tool) {
      return this.#failure(call, `没有名为「${call.name}」的工具`);
    }

    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.arguments);
    } catch (err) {
      return this.#failure(call, `参数不是合法的 JSON 对象：${errorMessage(err)}`);
    }
    // 已经取消就别启动工具：竞速只能放弃等待，挡不住工具在取消之后才开始副作用。
    if (signal?.aborted) return this.#failure(call, "工具执行已取消");

    const timeoutMs = validTimeout(tool.timeoutMs);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    let text: string;
    try {
      // `Promise.resolve` 是运行时边界：插件可能忽略类型、返回同步值；直接对返回值
      // 调 `.then` 会把一个正常的同步工具误判成执行失败。
      text = await raceWithAbort(
        Promise.resolve(tool.run(args, { signal: combinedSignal })),
        combinedSignal,
      );
    } catch (err) {
      // 调用方主动取消优先：此时不该让模型看到一条「工具超时」的假原因。
      if (signal?.aborted) return this.#failure(call, "工具执行已取消");
      if (timedOut) {
        return this.#failure(call, `工具「${call.name}」执行超时（${timeoutMs}ms）`);
      }
      // 只把 `errorMessage` 给模型，绝不给堆栈：工具内部错误可能带着路径或上游响应体。
      return this.#failure(call, `工具「${call.name}」执行失败：${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (typeof text !== "string") {
      // 插件是用户手写的 JS，类型标注管不到运行时；不挡住这里会让下面的 `.length`
      // 抛 TypeError 并穿过「run 从不抛错」的契约。
      return this.#failure(call, `工具「${call.name}」返回值不是字符串`);
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

/** 工具声明的超时不可信：非正数会立刻中断，过大则把会话拖到天荒地老。 */
const MAX_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

function validTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }
  return Math.min(value, MAX_TOOL_TIMEOUT_MS);
}

/** 让一个可能永不 resolve 的 Promise 与取消信号竞速。 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("已取消"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
