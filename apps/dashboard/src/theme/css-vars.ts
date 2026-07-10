import type { ColorRamp, Palette, ThemeName } from "./tokens.ts";
import { easing, font, layout, palettes, radius, shadow } from "./tokens.ts";

/**
 * 把 tokens.ts 展开成 `:root` 上的 CSS 变量。
 *
 * 单向派生，没有第二处真源：变量名在这里生成，值只来自 tokens.ts。
 * 输出交给 uno.config.ts 的 `preflights`，因此随 `virtual:uno.css` 一起打包，
 * 不需要再引入一个 `.css` 文件（那样会把 hex 重述一遍，两份定义迟早漂移）。
 */

/** 把 `primaryColor` 风格的驼峰转成 `primary-color`，用于生成变量名后缀。 */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function ramp(name: string, r: ColorRamp): string[] {
  return [
    `--atri-${name}: ${r.base};`,
    `--atri-${name}-hover: ${r.hover};`,
    `--atri-${name}-pressed: ${r.pressed};`,
    `--atri-${name}-suppl: ${r.suppl};`,
  ];
}

function colorLines(p: Palette): string[] {
  const flat: Array<keyof Palette> = [
    "canvas",
    "surface",
    "raised",
    "tint",
    "line",
    "lineStrong",
    "ink",
    "inkMuted",
    "inkFaint",
    "ring",
    "primarySoft",
    "scrollbar",
    "scrollbarHover",
  ];
  const lines = flat.map((key) => `--atri-${kebab(String(key))}: ${String(p[key])};`);
  return [
    ...lines,
    ...ramp("primary", p.primary),
    ...ramp("info", p.info),
    ...ramp("success", p.success),
    ...ramp("warning", p.warning),
    ...ramp("danger", p.danger),
  ];
}

/**
 * 两套主题共享的尺度类变量：圆角、字号、阴影之外的缓动。
 * 阴影跟着主题走（深色底上同样的黑色透明度会看不见），所以单独放。
 */
const sharedScaleLines = [
  `--atri-radius-sm: ${radius.sm};`,
  `--atri-radius-md: ${radius.md};`,
  `--atri-radius-lg: ${radius.lg};`,
  `--atri-radius-xl: ${radius.xl};`,
  `--atri-radius-full: ${radius.full};`,
  `--atri-font-family: ${font.family};`,
  `--atri-font-family-mono: ${font.familyMono};`,
  `--atri-ease-in-out: ${easing.easeInOut};`,
  `--atri-ease-out: ${easing.easeOut};`,
  `--atri-ease-in: ${easing.easeIn};`,
  `--atri-header-h: ${layout.headerH};`,
  `--atri-nav-w: ${layout.navW}px;`,
  `--atri-control-h: ${layout.controlH};`,
  `--atri-reading-w: ${layout.readingW};`,
];

function block(selector: string, name: ThemeName): string {
  const p = palettes[name];
  const s = shadow[name];
  const lines = [
    ...colorLines(p),
    `color-scheme: ${name};`,
    `--atri-shadow-sm: ${s.sm};`,
    `--atri-shadow-md: ${s.md};`,
    `--atri-shadow-lg: ${s.lg};`,
  ];
  return `${selector}{\n${lines.map((l) => `  ${l}`).join("\n")}\n}`;
}

/**
 * 默认态取浅色，`[data-atri-theme="dark"]` 整块翻转。
 *
 * 浅色写在 `:root` 而不是 `html[data-atri-theme="light"]`，是为了让首帧内联脚本
 * 万一没跑起来（或被 CSP 挡掉）时页面仍是可读的浅色，而不是带着一堆未定义变量。
 * 选择器由 theme/mode.ts 负责写，属性名两边都取自 `THEME_ATTR`，不会各写一份。
 */
export const THEME_ATTR = "data-atri-theme";

export function cssVariables(): string {
  return [
    `:root{\n${sharedScaleLines.map((l) => `  ${l}`).join("\n")}\n}`,
    block(":root", "light"),
    block(`html[${THEME_ATTR}="dark"]`, "dark"),
  ].join("\n");
}
