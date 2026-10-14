import type { IconName } from "@/components/shared/icons";

/** 分类的归属。**这一条不是排版参数，而是本仓的一条真界**： */
export type CategoryScope = "profile" | "global";

export interface Category {
  key: string;
  label: string;
  /** 卡片/面板顶部那句「这一类在管什么」。写在这里而不是散在各面板里，
   *  是为了让左菜单的 tooltip 与右侧标题永远同一句。 */
  hint: string;
  icon: IconName;
  scope: CategoryScope;
}

/**
 * 配置工作台的分类清单。顺序即菜单顺序。
 *
 * 分组的根据是「**这个东西占的资源属于谁**」：供应商里面是密钥与端点，属于整个部署
 * （改一次每档都生效，见 `data/providers.json`）；工具开关、插件启用清单、单轮步数
 * 与档默认属于那一跑法（各自写在 `data/profiles/<id>/config.json`）。
 * 把它们混在一个平铺列表里，症状是有人以为「在这一档改了源，另一档不受影响」。
 */
export const CATEGORIES: Category[] = [
  {
    key: "model",
    label: "默认模型",
    hint: "这一档不带 model 时打的那个模型。清单是全局的，这里只选一个。",
    icon: "provider",
    scope: "profile",
  },
  {
    key: "tools",
    label: "工具",
    hint: "模型在这份配置档里能使哪些动作。默认全部关闭。",
    icon: "tool",
    scope: "profile",
  },
  {
    key: "plugins",
    label: "插件",
    hint: "装载的代码是全局安装的，这里只决定这份档开不开它。",
    icon: "plugin",
    scope: "profile",
  },
  {
    key: "runtime",
    label: "运行参数",
    hint: "一轮对话里最多跑几步工具。",
    icon: "settings",
    scope: "profile",
  },
  {
    key: "providers",
    label: "供应商",
    hint: "连接与模型实例，整个部署共用一份：在这里保存一次，每档都生效。",
    icon: "layers",
    scope: "global",
  },
  {
    key: "adapters",
    label: "接入端",
    hint: "外部平台跑在哪份配置档上。这一类此刻只读 —— 配置写在 atri.config.json。",
    icon: "chat",
    scope: "global",
  },
];

export const PROFILE_CATEGORIES = CATEGORIES.filter((c) => c.scope === "profile");
export const GLOBAL_CATEGORIES = CATEGORIES.filter((c) => c.scope === "global");

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
