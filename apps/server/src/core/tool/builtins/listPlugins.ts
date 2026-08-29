import type { ToolDefinition } from "#core/tool/types.ts";

/**
 * `plugins/manager.ts` 的 `PluginView` 的**结构子集**。
 *
 * 为什么在 core 里重新声明而不是 import：`core/` 不得 import `plugins/`（AGENTS.md 的分层
 * 硬约束，且**没有任何检查守着** —— oxlint 不解析模块路径，tsc 不看目录）。声明成「这颗工具
 * 真正读的那几个键」之后，装配处交来的 `PluginView` 是它的超集，可以直接赋值，不需要 `as`。
 *
 * 取 `enabled` 而不是 `status`：`PluginInfo.status` 在类型上是可选的（`shared` 的 `PluginInfo`），
 * 而 `enabled` 必填、`PluginManager.#view()` 总是按 `status === "active"` 算出来。
 * 收必填的那个键，就不必为一个类型上不存在的可能值写兜底分支。
 */
export interface PluginSummary {
  id: string;
  name: string;
  enabled: boolean;
  /** 只当「上一次加载有没有失败」的标记用，它的**文本不外传**，见 `run()` 里那条理由。 */
  error: string | null;
}

export function createListPluginsTool(listPlugins: () => readonly PluginSummary[]): ToolDefinition {
  return {
    id: "list_plugins",
    name: "插件列表",
    // 这句是给模型读的：不说清「什么时候该用它」，它就永远不调。对照 currentTime 那句的写法。
    description:
      "列出本程序当前已安装的插件及其加载结果。凡是要确认「有没有某个插件」「某个插件的能力现在可用吗」，" +
      "或者插件提供的功能表现异常时，先调用本工具，不要凭对话内容假设插件已经安装。",
    parameters: { type: "object", properties: {} },
    async run() {
      // 每次调用现读：装配处传的是 getter 而不是快照，因为插件能在运行期被加载 / 重载 /
      // 启用 / 禁用。快照会让这颗工具在几小时后继续说出装配那一刻的事实。
      const plugins = listPlugins();
      if (plugins.length === 0) return "当前没有安装任何插件。";
      return plugins
        .map((p) => {
          // `error` 先判，否则一条失败记录会被读成「操作者把它禁用了」（failed ⇒ `enabled`
          // 为 false ⇒ 先印「已禁用」），而模型会据此给出完全错的建议。
          const state = p.error ? "上次加载失败" : p.enabled ? "运行中" : "已禁用";
          // 只报「失败」这个事实，不带上 error 原文：那是**第三方文本**（动态 import 的报错、
          // 插件自己抛的错都可能带着绝对路径），而工具结果会整段发给第三方 provider。
          // 模型需要知道别声称该插件的能力可用，这一句就够了；
          // 失败原因是给操作者看的，控制台插件页已经在显示它。
          return `- ${p.name}（id: ${p.id}）：${state}`;
        })
        .join("\n");
    },
  };
}
