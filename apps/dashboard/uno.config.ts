import { defineConfig, presetWind4 } from "unocss";
import { cssVariables } from "./src/theme/css-vars.ts";
import { font, layout, radius } from "./src/theme/tokens.ts";

/**
 * UnoCSS 主题色全部指向 `var(--atri-*)`，而变量由 `src/theme/tokens.ts` 经
 * preflight 生成——**不要在这里写 hex**。颜色若写两遍，深浅色切换时
 * 未走变量的那一份就会停在某个主题上。
 *
 * presetWind4 对 `var()` 有显式支持（`isCSSVar` 分支），走的是和字面量同一套
 * `color-mix(...)` 输出路径，所以换成变量不引入新的浏览器要求，`/50` 这类
 * 透明度修饰符也照常可用。
 */
export default defineConfig({
  presets: [presetWind4()],
  /**
   * preflight 保证这段变量一定输出，即使某个页面一个原子类都没用到；
   * 换成独立的 `.css` 文件就得把 hex 重述一遍，两份定义迟早漂移。
   */
  preflights: [{ getCSS: () => cssVariables() }],
  theme: {
    colors: {
      canvas: "var(--atri-canvas)",
      surface: "var(--atri-surface)",
      raised: "var(--atri-raised)",
      tint: "var(--atri-tint)",

      line: "var(--atri-line)",
      "line-strong": "var(--atri-line-strong)",

      ink: "var(--atri-ink)",
      "ink-muted": "var(--atri-ink-muted)",
      "ink-faint": "var(--atri-ink-faint)",

      primary: "var(--atri-primary)",
      "primary-hover": "var(--atri-primary-hover)",
      "primary-pressed": "var(--atri-primary-pressed)",
      "primary-soft": "var(--atri-primary-soft)",
      info: "var(--atri-info)",
      success: "var(--atri-success)",
      warning: "var(--atri-warning)",
      danger: "var(--atri-danger)",
      "danger-hover": "var(--atri-danger-hover)",
      ring: "var(--atri-ring)",
      scrollbar: "var(--atri-scrollbar)",
    },

    radius: {
      DEFAULT: radius.md,
      none: "0",
      sm: radius.sm,
      md: radius.md,
      lg: radius.lg,
      xl: radius.xl,
      "2xl": "18px",
      "3xl": "24px",
      full: radius.full,
    },

    shadow: {
      sm: "var(--atri-shadow-sm)",
      md: "var(--atri-shadow-md)",
      lg: "var(--atri-shadow-lg)",
    },

    /**
     * presetWind4 的字号档位是 `{ fontSize, lineHeight }` 对象而不是裸字符串，
     * 行高跟着字号走，免得出现 `text-3xl` 配 1.5 行高把标题挤成一团。
     */
    text: {
      xs: { fontSize: font.size.xs, lineHeight: font.leading.normal },
      sm: { fontSize: font.size.sm, lineHeight: font.leading.normal },
      base: { fontSize: font.size.base, lineHeight: font.leading.normal },
      lg: { fontSize: font.size.lg, lineHeight: font.leading.tight },
      xl: { fontSize: font.size.xl, lineHeight: font.leading.tight },
      "2xl": { fontSize: font.size["2xl"], lineHeight: font.leading.tight },
      "3xl": { fontSize: font.size["3xl"], lineHeight: font.leading.tight },
    },

    font: {
      sans: font.family,
      mono: font.familyMono,
    },

    /** 具名列宽：`max-w-prose` 给聊天正文，`max-w-form` 给配置表单。 */
    container: {
      prose: layout.readingW,
      form: "48rem",
    },
  },
  shortcuts: {
    /*
     * 次级按钮。宽度靠 `px-2 py-1` 撑，不写死 height——
     * 图标按钮和文字按钮共用它，写死后者会被顶偏。
     */
    "btn-ghost":
      "cursor-pointer rounded-md border border-line bg-raised px-2 py-1 text-xs text-ink transition-colors hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    /** 卡片外壳：LoginView、NewSession、PluginPanel 三处原本各写一份。 */
    "surface-card": "rounded-lg border border-line bg-surface shadow-sm",

    /** 可点行的底色变化；和 `row-active` 配对使用。 */
    "row-base":
      "cursor-pointer rounded-md transition-colors hover:bg-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "row-active": "bg-primary-soft text-ink",

    /** 表单字段（LoginView 用的是原生 input，不走 naive-ui）。 */
    "field-input":
      "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-ring",

    /** 需要内部滚动的区域：必须配 `min-h-0`，否则在 flex 里撑不满也不滚。 */
    "scroll-y": "overflow-y-auto min-h-0",
  },
});
