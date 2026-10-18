import { h } from "vue";
import type { VNodeChild } from "vue";

/**
 * 16×16 线性图标工厂，统一 1.5px 描边与圆头端点。
 *
 * 抽成模块是为了让顶栏的汉堡菜单与平台切换按钮共用同一套画法——
 * 两处各写一份路径字符串，改一处就会有一处显得比另一处粗一点。
 */
export function strokeIcon(path: string): () => VNodeChild {
  return () =>
    h(
      "svg",
      {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
      },
      [
        h("path", {
          d: path,
          stroke: "currentColor",
          "stroke-width": 1.5,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      ],
    );
}

/**
 * 命名图标表。
 *
 * 刻意不引 `@iconify` + `unplugin-icons`：本仓在 `pnpm-workspace.yaml` 里写了
 * 发布窗口门禁，为一组 16px 描边图标拉进整套图标集不值得。
 * 走命名表而不是各处在模板里写 `<svg>`，是因为文字字形（`✓`、`↓`、`+`）
 * 没法对齐、没法旋转、也不该被读屏念出来；`strokeIcon` 统一带 `aria-hidden`。
 *
 * 新增图标：往这张表里加一条 16×16 的路径即可，`viewBox` 与描边都由工厂给。
 */
export const icons = {
  menu: "M2 4h12M2 8h12M2 12h12",
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5 6.5 12 13 4.5",
  close: "M4 4l8 8M12 4l-8 8",
  trash: "M2.5 4.5h11M6 4.5V3h4v1.5M4.2 4.5 4.8 13h6.4l.6-8.5M6.6 7v3.5M9.4 7v3.5",
  chevronDown: "M4 6.5 8 10.5 12 6.5",
  arrowUp: "M8 12.5v-9M8 3.5 4.5 7M8 3.5 11.5 7",
  logout: "M6 2.5H3.5v11H6M10 5.5 12.5 8 10 10.5M12.5 8H6.5",
  console: "M3 3h4.5v4.5H3zM8.5 3H13v4.5H8.5zM3 8.5h4.5V13H3zM8.5 8.5H13V13H8.5z",
  provider: "M8 2.5 13.5 5v6L8 13.5 2.5 11V5zM2.5 5 8 7.5 13.5 5M8 7.5v6",
  chat: "M2.5 3.5h11v7.5H7.5L4.5 13.5V11h-2z",
  /** 终端窗口：一条提示符 + 一行输出。与 chat（气泡）刻意不同形。 */
  logs: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 9.5h2.5",
  plugin: "M5 2.5V6M11 2.5V6M4 6.5h8V9a4 4 0 0 1-8 0z",
  /** 扳手。与 plugin（插头）刻意不同形：一个是「模型能使的动作」，一个是「装载的代码」。 */
  tool: "M9.8 2.7a3.3 3.3 0 0 0 4 4.2L6.6 13.3a1.9 1.9 0 0 1-2.7-2.7z M4.6 9.9 2.5 12",
  refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5h-3",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.4 10.4 13.5 13.5",
  settings: "M3 4.5h10M3 8h10M3 11.5h10M6 3.2v2.6M10 6.7v2.6M5 10.2v2.6",
  /** 三层叠块：一份文件里装着许多家的连接。与 provider（单颗六边形）刻意分开画。 */
  layers: "M8 2 13.5 5 8 8 2.5 5zM2.5 8 8 11l5.5-3M2.5 11 8 14l5.5-3",
  attachment: "M9.6 4.2 5.7 8.1a2.1 2.1 0 0 0 3 3l4.2-4.2a3.3 3.3 0 0 0-4.7-4.7L3.8 6.7",
  copy: "M5.5 5.5h6v6h-6zM3.5 11.5v-8h8",
  sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1",
  moon: "M12.6 9.8A5.6 5.6 0 0 1 6.2 3.4 5.6 5.6 0 1 0 12.6 9.8z",
  warning: "M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3",
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName): () => VNodeChild {
  return strokeIcon(icons[name]);
}
