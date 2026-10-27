/**
 * 技能相关工具（`read_skill`）与报头注入块的装配函数。
 *
 * `read_skill` 是 **internal** 工具（与 `list_plugins` 同一条判据）：技能目录的
 * 渐进式披露契约是「报头给目录、工具给全文」——目录注入了就必然要能读全文，
 * 它不是用户可以选择授予/收回的能力，而是这套机制本身的另一半。
 */
import type { ToolDefinition } from "#core/tool/types.ts";
import type { SkillInfo, SkillStore } from "./store.ts";

/**
 * 本轮的技能目录块：启用的技能各一行「名字（id）：说明」。
 * 没启用任何东西、或启用的 id 一个都对不上现算目录时返回 `null`（不注入空块）。
 */
export function skillDirectoryBlock(
  enabled: readonly string[],
  skills: readonly SkillInfo[],
): string | null {
  if (enabled.length === 0) return null;
  const lines: string[] = [];
  for (const id of enabled) {
    const skill = skills.find((item) => item.id === id);
    if (skill === undefined) continue;
    lines.push(`- ${skill.name}（${skill.id}）：${skill.description || "（无说明）"}`);
  }
  if (lines.length === 0) return null;
  return [
    "【可用技能】以下技能是按既定流程完成任务的操作手册；需要时先用 read_skill 工具读取对应技能的全文，再按它的指引做：",
    ...lines,
  ].join("\n");
}

export function createSkillTools(store: SkillStore): ToolDefinition[] {
  return [
    {
      id: "read_skill",
      description:
        "读取一条技能（操作手册）的完整内容。当对话里出现了【可用技能】目录中的某条技能、" +
        "且本轮任务与它相关时，先调用它拿到全文再按指引执行。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "技能 id（目录里括号里的那个）" },
        },
        required: ["id"],
      },
      internal: true,
      run: async (args) => {
        const id = args.id;
        if (typeof id !== "string" || id === "") return "id 必须是非空字符串。";
        const content = store.read(id);
        if (content === null) return `没有「${id}」这条技能，或它没有可读的内容。`;
        return content;
      },
    },
  ];
}
