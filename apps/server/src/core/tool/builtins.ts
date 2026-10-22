import type { ToolDefinition } from "./types.ts";
import { currentTime } from "./builtins/currentTime.ts";

/**
 * 内置工具的清单。只有组合根 import 这里（`app.ts`），所以注册表不必知道任何具体工具。
 *
 * 一颗工具一个文件（`builtins/<id>.ts`），这里只负责登记 —— 与 provider 那边
 * （`openai.ts` / `anthropic.ts` 各一份实现，`factory.ts` 负责挑）同构。
 *
 * 系统内省类工具（插件列表等）已经搬进 `apps/server/plugins/system/`：它们由插件
 * 声明为 `internal`，不进入用户的工具开关，但仍交给模型。`current_time` 是通用能力，
 * 留在内置清单里由用户决定开不开。
 */
export function createBuiltinTools(): ToolDefinition[] {
  return [currentTime];
}
