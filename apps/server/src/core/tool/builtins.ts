import type { ToolDefinition } from "./types.ts";
import { currentTime } from "./builtins/currentTime.ts";
import { createListPluginsTool, type PluginSummary } from "./builtins/listPlugins.ts";

/**
 * 内置工具的清单。只有组合根 import 这里（`app.ts`），所以注册表不必知道任何具体工具。
 *
 * 一颗工具一个文件（`builtins/<id>.ts`），这里只负责登记 —— 与 provider 那边
 * （`openai.ts` / `anthropic.ts` 各一份实现，`factory.ts` 负责挑）同构。
 *
 * 两颗都刻意选**不读写磁盘、不外呼**的：`current_time` 只用 `Intl`，`list_plugins` 只读进程内存
 * 里已有的状态。工具一旦能落盘或外呼，就要连带决定作用域、超时与响应体上限（对照
 * `/provider-sources/:id/models` 为 SSRF 付过的代价，见 `docs/architecture.md`），
 * 那些不该和「加一颗工具」混在一次改动里。
 */
export interface BuiltinToolDeps {
  /**
   * 当前已安装插件的**实时**视图。
   *
   * 收函数而不是数组，有两个理由：一是 `app.ts` 在 `plugins.loadAll()` 之前就注册工具，
   * 快照等于把清单冻在装配那一刻；二是 `core/` 不得 import `plugins/`，数据只能由组合根
   * 递进来 —— 这条约束没有任何检查守着，所以这里宁可多一个函数参数。
   */
  listPlugins: () => readonly PluginSummary[];
}

export function createBuiltinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  return [currentTime, createListPluginsTool(deps.listPlugins)];
}
