/**
 * 内置指令。与 `core/tool/builtins.ts` 同一条装配观：这里只造定义，
 * 注册发生在组合根（`app.ts`）—— 注册表不认识具体指令，清单是唯一的装配点。
 *
 * `/help` 需要在运行期读注册表本身，所以这里的工厂收注册表引用；
 * `/plugins` 需要本档插件清单，收访问器而不是让 core import plugins 层
 *（与 `list_plugins` 收 `() => plugins.list()` 同一条先例）。
 */
import type { PluginInfo } from "@atri/shared";
import type { CommandRegistry } from "./registry.ts";
import type { CommandDefinition } from "./types.ts";

/** 按 `CommandInfo` 的口径渲染一条指令的名字（带前缀），别名附在后面。 */
function label(prefix: string, def: CommandDefinition): string {
  const aliases = def.aliases ?? [];
  const head = `${prefix}${def.name}`;
  return aliases.length === 0
    ? head
    : `${head}（别名：${aliases.map((a) => `${prefix}${a}`).join("、")}）`;
}

export function createBuiltinCommands(deps: {
  registry: CommandRegistry;
  /** 本档插件清单访问器；缺省时 `/plugins` 说明没有可看的东西。 */
  listPlugins?: () => PluginInfo[];
}): CommandDefinition[] {
  const { registry, listPlugins } = deps;

  const help: CommandDefinition = {
    name: "help",
    aliases: ["帮助"],
    description: "查看可用指令",
    usage: "help [指令名]",
    run: (args, ctx) => {
      const all = registry.list();
      const name = args.args[0]?.replace(/^\//, "") ?? "";
      if (name !== "") {
        const key = name.toLowerCase();
        const entry = all.find((item) =>
          [item.def.name, ...(item.def.aliases ?? [])].some((n) => n.toLowerCase() === key),
        );
        if (!entry) return `没有「${ctx.prefix}${name}」这条指令。`;
        const def = entry.def;
        const lines = [
          `${label(ctx.prefix, def)} — ${def.description}`,
          `来源：${entry.source}`,
          `权限：${def.permission === "admin" ? "仅管理员" : "所有人"}`,
        ];
        if (def.usage !== undefined) lines.push(`用法：${ctx.prefix}${def.usage}`);
        return lines.join("\n");
      }
      const grouped = new Map<string, string[]>();
      for (const entry of all) {
        const list = grouped.get(entry.source) ?? [];
        list.push(`  ${label(ctx.prefix, entry.def)} — ${entry.def.description}`);
        grouped.set(entry.source, list);
      }
      const sections = [...grouped.entries()].map(([source, lines]) =>
        [`[${source}]`, ...lines].join("\n"),
      );
      return [
        "可用指令：",
        ...sections,
        `提示：${ctx.prefix}help <指令名> 查看一条指令的详情。`,
      ].join("\n");
    },
  };

  const plugins: CommandDefinition = {
    name: "plugins",
    aliases: ["插件"],
    description: "查看已安装插件的运行状态",
    run: () => {
      const peers = listPlugins?.() ?? [];
      if (peers.length === 0) return "当前没有已安装的插件。";
      return peers
        .map((peer) => `- ${peer.name}（id: ${peer.id}）：${peer.enabled ? "运行中" : "已禁用"}`)
        .join("\n");
    },
  };

  return [help, plugins];
}
