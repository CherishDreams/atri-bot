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
 * **这里只有「本配置档」的东西**：工具开关、单轮步数与档默认都写在
 * `data/profiles/<id>/config.json`，换一份档就该换一套。
 *
 * 供应商与接入平台**不在**这张表里：它们是部署级全局一份（`data/providers.json` 与
 * `atri.config.json` 的 adapters 段），改一次对所有档生效，所以各自是主导航里的整页
 * （AstrBot 的「模型提供商」「平台配置」也是这个位置）。曾经把它们当成本工作台的
 * 「全局」分组，症状是左上角明明写着当前档名，而那一项改的东西立刻影响所有档 ——
 * 分组标签挡不住这种误读，只有「它不在这一页」能挡住。
 *
 * 插件同样不在这里：它有自己的 `/plugins` 页（启停 + 由 `_conf_schema.json` 驱动的配置），
 * 那份写入是即时的、跟着插件实例走，与本页「草稿 + 一次保存」不是同一种语义。
 */
export const CATEGORIES: Category[] = [
  {
    key: "model",
    label: "默认模型",
    hint: "这一档不带 model 时打的那个模型。清单是全局的，这里只选一个。",
    icon: "provider",
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
