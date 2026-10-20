import type { IconName } from "@/components/shared/icons";

export interface Category {
  key: string;
  label: string;
  /** 卡片/面板顶部那句「这一类在管什么」。写在这里而不是散在各面板里，
   *  是为了让左菜单的 tooltip 与右侧标题永远同一句。 */
  hint: string;
  icon: IconName;
}

/**
 * 配置工作台的分类清单。顺序即菜单顺序。
 *
 * **这里只有「本配置档」的东西**：工具开关、单轮步数、档默认、人格引用与准入名单
 * 都写在 `data/profiles/<id>/config.json`，换一份档就该换一套。
 *
 * 人格库与计划任务是主导航的独立整页：前者是全局内容资产，后者是部署级调度，
 * 它们都不属于某一份档。访问控制**属于本档** —— 绑定到这一档的适配器共用同一张
 * 名单，换一档就是另一张，所以它是这一页的分类，而不是全局页。
 *
 * 供应商、接入平台与插件也不在这张表里：供应商与接入平台改外部连接，
 * 插件有自己的页面与 schema 驱动的表单；三者都不是「这一档怎么跑」。
 */
export const CATEGORIES: Category[] = [
  {
    key: "model",
    label: "默认模型",
    hint: "这一档不带 model 时打的那个模型。清单是全局的，这里只选一个。",
    icon: "provider",
  },
  {
    key: "persona",
    label: "人格",
    hint: "这一档每轮对话使用的人格。人格正文在「人格配置」页维护，这里只做引用。",
    icon: "persona",
  },
  {
    key: "tools",
    label: "工具",
    hint: "模型在这份配置里能使哪些动作。默认全部关闭。",
    icon: "tool",
  },
  {
    key: "runtime",
    label: "运行参数",
    hint: "一轮对话里最多跑几步工具。",
    icon: "settings",
  },
  {
    key: "access",
    label: "访问控制",
    hint: "这一档的白名单与管理员名单；绑定到这一档的接入平台共用它。",
    icon: "shield",
  },
];

/** `?cat=` 的兜底：未知或缺失都回到第一项，而不是给一片空白。 */
export function categoryOf(key: unknown): Category {
  const found = CATEGORIES.find((c) => c.key === key);
  return found ?? CATEGORIES[0]!;
}

/**
 * 搜索判据：任一字段包含关键词（大小写不敏感）。
 *
 * 只有一处实现，面板与左菜单的「有没有命中」都调它 —— 两处各写一遍的话，
 * 迟早出现「菜单灰着而点进去有结果」这种互相打脸的界面。
 */
export function matches(keyword: string, ...texts: (string | undefined)[]): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((text) => (text ?? "").toLowerCase().includes(needle));
}
