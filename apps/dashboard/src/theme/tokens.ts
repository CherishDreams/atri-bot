/**
 * 全站视觉 token 的唯一真源。
 *
 * **这个文件会被执行两次**：一次在 Node 侧（unconfig 用 jiti 读 uno.config.ts，
 * 好让改 token 能触发配置热重载），一次在浏览器侧（Vite 打包 theme/naive.ts）。
 * 因此这里只能放纯数据与纯字符串运算——任何 `document` 引用会让 Vite 启动即崩，
 * 任何模块级副作用会实打实跑两遍。
 *
 * 之所以用字面量而不是 CSS 变量当源头：naive-ui 会把 `themeOverrides.common`
 * 的每个颜色喂进组件自己的 `self(common)` 去做混色（见 theme/naive.ts 顶部说明），
 * 而 seemly 解析不了 `var(...)`，会直接抛错。真源必须是能被解析的字面值，
 * CSS 变量只是它派生出来的产物。
 */

export interface ColorRamp {
  /** 常态：文字、图标、描边、实心填充。 */
  base: string;
  /** hover 态。naive-ui **不会**从 base 推导，必须逐个给出。 */
  hover: string;
  /** active/pressed 态。同上，不给出就退回 naive-ui 自带的那一档。 */
  pressed: string;
  /** 出现在深色/反色底上时用的那一档（naive-ui 的 `*ColorSuppl`）。 */
  suppl: string;
}

export interface Palette {
  /* 面 */
  canvas: string;
  surface: string;
  /** 需要浮在 surface 之上的层：输入框、嵌套卡片、气泡。 */
  raised: string;
  /**
   * 行、菜单项的 hover 底。
   *
   * 命名刻意不叫 `hover`：类名会写成 `hover:bg-hover`，读起来像在口吃，
   * 而且和 UnoCSS 的 `hover:` 变体撞词，容易让人误以为这是个变体。
   */
  tint: string;

  /* 线 */
  line: string;
  lineStrong: string;

  /* 字 */
  ink: string;
  inkMuted: string;
  inkFaint: string;

  /* 品牌与状态 */
  primary: ColorRamp;
  info: ColorRamp;
  success: ColorRamp;
  warning: ColorRamp;
  danger: ColorRamp;

  /** 焦点环：`box-shadow: 0 0 0 2px var(--atri-ring)`，比描边变化更容易被看见。 */
  ring: string;
  /** 选中行/选中项的浅铺底，等于把 primary 以低透明度压在表面上。 */
  primarySoft: string;

  scrollbar: string;
  scrollbarHover: string;
}

/* 主色只在这一处定义；hover/pressed/suppl 由它向两侧明暗推，保持同一个色相。 */
const PRIMARY = "#4f8cff";

const light: Palette = {
  canvas: "#f5f6f8",
  surface: "#ffffff",
  raised: "#f2f4f7",
  tint: "#eceff3",

  line: "#e2e5ea",
  lineStrong: "#cdd2da",

  ink: "#1c2027",
  inkMuted: "#59616e",
  inkFaint: "#8b93a1",

  primary: { base: PRIMARY, hover: "#7aa8ff", pressed: "#3b78e0", suppl: "#6ba1ff" },
  info: { base: PRIMARY, hover: "#7aa8ff", pressed: "#3b78e0", suppl: "#6ba1ff" },
  success: { base: "#2fa36b", hover: "#4fb883", pressed: "#22855a", suppl: "#43b07c" },
  warning: { base: "#e8a33d", hover: "#f0b866", pressed: "#c8862a", suppl: "#eeb25e" },
  danger: { base: "#d03050", hover: "#de576d", pressed: "#ab1f3f", suppl: "#e0607a" },

  ring: `${PRIMARY}66`,
  primarySoft: `${PRIMARY}1a`,

  scrollbar: "#00000029",
  scrollbarHover: "#00000040",
};

/**
 * 深色值直接沿用改造前 uno.config.ts 里那套（`#0f1115`/`#171a21`/`#222836`/
 * `#2b3040`/`#e6e8ec`/`#8b93a1`），这样控制台那几页换成语义 token 后
 * 外观不变——它们本来就是按这套深色设计的。
 */
const dark: Palette = {
  canvas: "#0f1115",
  surface: "#171a21",
  raised: "#222836",
  tint: "#1d222c",

  line: "#2b3040",
  lineStrong: "#3a4152",

  ink: "#e6e8ec",
  inkMuted: "#8b93a1",
  inkFaint: "#6c7482",

  primary: { base: PRIMARY, hover: "#7aa8ff", pressed: "#3b78e0", suppl: "#3f77d8" },
  info: { base: PRIMARY, hover: "#7aa8ff", pressed: "#3b78e0", suppl: "#3f77d8" },
  success: { base: "#5ed6a4", hover: "#7ee0b8", pressed: "#43b886", suppl: "#4bbd8c" },
  warning: { base: "#f0b95f", hover: "#f5c97f", pressed: "#d29a41", suppl: "#dca54c" },
  danger: { base: "#ff5f56", hover: "#ff8078", pressed: "#e0463f", suppl: "#f2685f" },

  ring: `${PRIMARY}80`,
  primarySoft: `${PRIMARY}26`,

  scrollbar: "#ffffff33",
  scrollbarHover: "#ffffff4d",
};

export const palettes = { light, dark } as const;

export type ThemeName = keyof typeof palettes;

/** 圆角基准。naive-ui 默认是 3px，这里整档抬到 8px。 */
export const radius = {
  sm: "6px",
  md: "8px",
  lg: "12px",
  xl: "14px",
  full: "9999px",
} as const;

export const font = {
  family:
    'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  familyMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
  size: {
    xs: "12px",
    sm: "13px",
    base: "14px",
    lg: "16px",
    xl: "18px",
    "2xl": "20px",
    "3xl": "24px",
  },
  weight: { normal: "400", medium: "500", semibold: "600", bold: "700" },
  leading: { none: "1", tight: "1.25", normal: "1.5", relaxed: "1.7" },
} as const;

/**
 * 三层 elevation。数字沿用 naive-ui 自带阴影的结构，只是按主题调深浅——
 * 深色底上同样的黑色透明度会几乎看不见，所以深色这一组更重。
 */
export const shadow = {
  light: {
    sm: "0 1px 2px -2px rgba(0, 0, 0, 0.08), 0 3px 6px 0 rgba(0, 0, 0, 0.06), 0 5px 12px 4px rgba(0, 0, 0, 0.04)",
    md: "0 5px 5px -3px rgba(0, 0, 0, 0.16), 0 8px 10px 1px rgba(0, 0, 0, 0.12), 0 3px 14px 2px rgba(0, 0, 0, 0.08)",
    lg: "0 6px 16px -9px rgba(0, 0, 0, 0.12), 0 9px 28px 0 rgba(0, 0, 0, 0.08), 0 12px 48px 16px rgba(0, 0, 0, 0.05)",
  },
  dark: {
    sm: "0 1px 2px -2px rgba(0, 0, 0, 0.4), 0 3px 6px 0 rgba(0, 0, 0, 0.32), 0 5px 12px 4px rgba(0, 0, 0, 0.28)",
    md: "0 5px 5px -3px rgba(0, 0, 0, 0.5), 0 8px 10px 1px rgba(0, 0, 0, 0.42), 0 3px 14px 2px rgba(0, 0, 0, 0.34)",
    lg: "0 6px 16px -9px rgba(0, 0, 0, 0.56), 0 9px 28px 0 rgba(0, 0, 0, 0.46), 0 12px 48px 16px rgba(0, 0, 0, 0.36)",
  },
} as const;

export const easing = {
  easeInOut: "cubic-bezier(.4, 0, .2, 1)",
  easeOut: "cubic-bezier(0, 0, .2, 1)",
  easeIn: "cubic-bezier(.4, 0, 1, 1)",
} as const;

export const layout = {
  /**
   * 顶栏高度。原先硬写在 src/uno.css 的 `:root` 里，被两处 header 与两处 layout
   * 用 `h-[var(--atri-header-h)]` / `top-[var(--atri-header-h)]!` 共 7 处引用。
   * 迁到这里的目的是让偏移量与颜色走同一个出口；`uno.css` 里那份 `:root`
   * 兜底在迁移期先留着——它一旦解析成 unset，header 会静默塌成内容高度且不报错。
   */
  headerH: "60px",
  /**
   * 侧栏宽度。写成数字而不是 `"232px"`，因为 `n-layout-sider` 的 `width` prop
   * 收的是 number（内部自己补 px），模板里 `:width="layout.navW"` 直接用。
   */
  navW: 232,
  /**
   * 顶栏里并排控件的统一高度。汉堡按钮和平台切换按钮原本各写一份像素值，
   * 靠 `<style>` 里的 `:deep()` 把 28px 抬到 32px 才对齐；共用这个值之后，
   * 要改只改一处。
   */
  controlH: "32px",
  /** 正文阅读列宽：再宽下去行长就不好读了。 */
  readingW: "48rem",
} as const;
