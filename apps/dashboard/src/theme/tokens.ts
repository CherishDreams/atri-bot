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
  /**
   * 压在 primary 实心填充上的文字/图标色。
   *
   * 不能复用 `surface`：那一档在深色主题下会翻成接近黑的面色，而 primary 的
   * 两套主题只差一点明度 —— 深色下会变成深底深字。主色填充上的字按语义永远是浅色。
   */
  onPrimary: string;

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

/* 主色只在这一处定义；hover/pressed/suppl 由它向两侧明暗推，保持同一个色相。
 * 取靛蓝而不是「默认蓝」（`#4f8cff` 那一版）：后者在浅色底上偏亮、饱和度低，
 * 主按钮与选中态都显得发灰；靛蓝和顶栏 logo 的蓝→紫渐变也更接得上。 */
const PRIMARY = "#4f6bf5";

const light: Palette = {
  canvas: "#f4f6fa",
  surface: "#ffffff",
  raised: "#f3f5f9",
  tint: "#edf0f6",

  line: "#e5e9f0",
  lineStrong: "#d4dae6",

  ink: "#151922",
  inkMuted: "#58606e",
  inkFaint: "#8b93a2",
  onPrimary: "#ffffff",

  primary: { base: PRIMARY, hover: "#7189ff", pressed: "#3a52d9", suppl: "#6280ff" },
  info: { base: PRIMARY, hover: "#7189ff", pressed: "#3a52d9", suppl: "#6280ff" },
  success: { base: "#22a06b", hover: "#3bb87f", pressed: "#188559", suppl: "#2fb277" },
  warning: { base: "#d98b1f", hover: "#e9a343", pressed: "#b7740f", suppl: "#e09a33" },
  danger: { base: "#d92d4b", hover: "#e85a72", pressed: "#b01f39", suppl: "#e04761" },

  ring: `${PRIMARY}5c`,
  primarySoft: `${PRIMARY}14`,

  scrollbar: "#0f172a24",
  scrollbarHover: "#0f172a3d",
};

/**
 * 深色值直接沿用改造前 uno.config.ts 里那套（`#0f1115`/`#171a21`/`#222836`/
 * `#2b3040`/`#e6e8ec`/`#8b93a1`），这样控制台那几页换成语义 token 后
 * 外观不变——它们本来就是按这套深色设计的。
 */
const dark: Palette = {
  canvas: "#0c0e13",
  surface: "#151920",
  raised: "#1d2330",
  tint: "#1a1f2a",

  line: "#29303d",
  lineStrong: "#3a4354",

  ink: "#e8ebf2",
  inkMuted: "#98a1b3",
  inkFaint: "#6e7788",
  onPrimary: "#ffffff",

  primary: { base: PRIMARY, hover: "#7b90ff", pressed: "#4056d4", suppl: "#4a63dd" },
  info: { base: PRIMARY, hover: "#7b90ff", pressed: "#4056d4", suppl: "#4a63dd" },
  success: { base: "#4bd39b", hover: "#6ee0b1", pressed: "#34b47f", suppl: "#3dbe88" },
  warning: { base: "#eab255", hover: "#f2c578", pressed: "#c99637", suppl: "#d8a344" },
  danger: { base: "#f2556b", hover: "#f77a8c", pressed: "#d33a52", suppl: "#e34a60" },

  ring: `${PRIMARY}80`,
  primarySoft: `${PRIMARY}2e`,

  scrollbar: "#ffffff2e",
  scrollbarHover: "#ffffff47",
};

export const palettes = { light, dark } as const;

export type ThemeName = keyof typeof palettes;

/** 圆角基准。naive-ui 默认是 3px，这里整档抬到 8px 基准；大面（卡片/弹层）走 12–16px。 */
export const radius = {
  sm: "6px",
  md: "8px",
  lg: "12px",
  xl: "16px",
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
 * 三层 elevation。
 *
 * 换成两层、低透明度的「环境光 + 接触阴影」：原来的三层带 12px/48px 的大扩散，
 * 在白卡片上一圈灰雾，反而把界面压脏。深色底上同样的黑色透明度会看不见，
 * 所以深色那一组把透明度抬到 .34–.55 并收窄扩散。
 */
export const shadow = {
  light: {
    sm: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
    md: "0 4px 10px -2px rgba(15, 23, 42, 0.08), 0 12px 28px -8px rgba(15, 23, 42, 0.1)",
    lg: "0 12px 32px -8px rgba(15, 23, 42, 0.16), 0 24px 64px -24px rgba(15, 23, 42, 0.22)",
  },
  dark: {
    sm: "0 1px 2px rgba(0, 0, 0, 0.34), 0 1px 3px rgba(0, 0, 0, 0.28)",
    md: "0 4px 12px -2px rgba(0, 0, 0, 0.46), 0 16px 32px -12px rgba(0, 0, 0, 0.4)",
    lg: "0 16px 40px -10px rgba(0, 0, 0, 0.55), 0 32px 72px -24px rgba(0, 0, 0, 0.5)",
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
