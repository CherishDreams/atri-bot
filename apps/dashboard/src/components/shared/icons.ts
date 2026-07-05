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
