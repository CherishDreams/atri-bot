import type { ToolDefinition } from "./types.ts";
import { currentTime } from "./builtins/currentTime.ts";

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
