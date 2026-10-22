/**
 * 系统能力插件。
 *
 * 这里放的是「框架自己要用、但不该出现在用户工具开关里」的工具：
 * - 它们随程序发布，不需要用户配置；
 * - 用户关掉它们会把模型的内省能力弄坏，而不是省下一颗工具。
 *
 * 工具标 `internal: true`：引擎始终交给模型，`GET /tools` 与配置页不展示。
 * 插件页仍然能看到这个插件，可以整体停用（停用后工具也随之消失）。
 */
export default {
  id: "system",
  name: "系统能力",
  version: "0.1.0",
  description: "框架内部使用的系统内省工具；工具不进入用户的工具开关列表。",

  tools(ctx) {
    return [
      {
        id: "list_plugins",
        name: "插件列表",
        internal: true,
        description:
          "列出本程序当前已安装的插件及其启用状态。凡是要确认「有没有某个插件」" +
          "或者插件提供的功能表现异常时，先调用本工具，不要凭对话内容假设插件已经安装。",
        parameters: { type: "object", properties: {} },
        async run() {
          // ctx.plugins() 是实时投影；插件能在运行期被加载、重载、启停。
          const plugins = ctx.plugins();
          if (plugins.length === 0) return "当前没有安装任何插件。";
          return plugins
            .map(
              (plugin) =>
                `- ${plugin.name}（id: ${plugin.id}）：${plugin.enabled ? "运行中" : "已禁用"}`,
            )
            .join("\n");
        },
      },
    ];
  },
};
