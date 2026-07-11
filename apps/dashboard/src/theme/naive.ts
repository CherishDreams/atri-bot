import type { GlobalTheme, GlobalThemeOverrides } from "naive-ui";
import { darkTheme, lightTheme } from "naive-ui";
import type { ColorRamp, Palette, ThemeName } from "./tokens.ts";
import { easing, font, layout, palettes, radius, shadow } from "./tokens.ts";

/**
 * naive-ui 主题层。
 *
 * **这里的颜色一律是字面量，不能写 `var(--atri-*)`。**
 * `_mixins/use-theme.mjs` 会先把 `common` 合并，再把它喂进每个组件的 `self(common)`；
 * 组件在 self 里对颜色做运算，例如 `menu/styles/light.mjs` 的
 * `itemColorActive: changeColor(primaryColor, { alpha: .1 })`。
 * 而 `seemly/es/color/index.js` 解析不了 `var(...)`，直接
 * `throw new Error('[seemly/rgba]: Invalid color value ...')`——
 * 侧栏每个布局都有 `n-menu`，所以那是一次整页白屏，而不是少个颜色。
 *
 * 值只从 `tokens.ts` 取，UnoCSS 与 naive-ui 因此共用同一份定义。
 *
 * 另外两个容易踩的点：
 *
 * 1. `primaryColorHover/Pressed/Suppl` **不是**从 `primaryColor` 推导出来的，
 *    它们是 `_styles/common/light.mjs` 里四个独立字面量。只写 `primaryColor`
 *    会留下 naive-ui 自带的绿色 hover/选中态，所以每个色系四档都要写全。
 * 2. `baseColor` 是 naive-ui 的**材质基色**而非品牌色：它同时充当实心主按钮上的
 *    文字色与 Alert 的混色底。写成彩色会反转按钮文字对比度，所以这里不动它，
 *    让 naive-ui 按主题自己取白/黑。
 */

/** 一个色系展开成 naive-ui 的四个键（`common` 里每个色系都是这四件套）。 */
function ramp(prefix: string, r: ColorRamp, target: Record<string, string>): void {
  target[`${prefix}Color`] = r.base;
  target[`${prefix}ColorHover`] = r.hover;
  target[`${prefix}ColorPressed`] = r.pressed;
  target[`${prefix}ColorSuppl`] = r.suppl;
}

function buildCommon(name: ThemeName): Record<string, string> {
  const p = palettes[name];
  const sh = shadow[name];
  const c: Record<string, string> = {
    /* 尺度：本次改造的核心诉求，整档抬到 8px 基准。 */
    borderRadius: radius.md,
    borderRadiusSmall: radius.sm,
    fontFamily: font.family,
    fontFamilyMono: font.familyMono,
    fontWeight: font.weight.normal,
    fontWeightStrong: font.weight.semibold,
    lineHeight: font.leading.normal,
    cubicBezierEaseInOut: easing.easeInOut,
    cubicBezierEaseOut: easing.easeOut,
    cubicBezierEaseIn: easing.easeIn,

    fontSize: font.size.base,
    fontSizeMini: font.size.xs,
    fontSizeTiny: font.size.xs,
    fontSizeSmall: font.size.sm,
    fontSizeMedium: font.size.base,
    fontSizeLarge: font.size.lg,
    fontSizeHuge: font.size.xl,

    /* 面与线 */
    bodyColor: p.canvas,
    cardColor: p.surface,
    modalColor: p.surface,
    popoverColor: p.surface,
    tableColor: p.surface,
    tagColor: p.tint,
    codeColor: p.raised,
    tabColor: p.raised,
    actionColor: p.tint,
    hoverColor: p.tint,
    pressedColor: p.raised,
    inputColor: p.raised,
    invertedColor: p.ink,
    borderColor: p.lineStrong,
    dividerColor: p.line,

    /* 文字三档 */
    textColorBase: p.ink,
    textColor1: p.ink,
    textColor2: p.inkMuted,
    textColor3: p.inkFaint,
    placeholderColor: p.inkFaint,

    scrollbarColor: p.scrollbar,
    scrollbarColorHover: p.scrollbarHover,
    /* naive-ui 自带 5px 细滚动条，比浏览器默认的原生条贴合得多，保留。 */
    scrollbarWidth: "8px",
    scrollbarHeight: "8px",
    scrollbarBorderRadius: "8px",

    boxShadow1: sh.sm,
    boxShadow2: sh.md,
    boxShadow3: sh.lg,
  };

  ramp("primary", p.primary, c);
  ramp("info", p.info, c);
  ramp("success", p.success, c);
  ramp("warning", p.warning, c);
  ramp("error", p.danger, c);

  return c;
}

/**
 * 组件级覆盖。
 *
 * 三个反复踩坑的键名，写错不会报错、只会静默失效（`pnpm typecheck` 能拦住拼错，
 * 拦不住"这个组件根本没有这个键"）：
 *
 * - `Button` **没有** `borderRadius`，只有 `borderRadiusTiny/Small/Medium/Large`，
 *   四者默认都取 `common.borderRadius`。
 * - `Select` 的圆角不在自己身上，来自 `peers.InternalSelection.borderRadius`；
 *   `Modal` 用 `preset="card"` 时圆角来自 `peers.Card`。
 * - `InputNumber` 没有任何自有样式键，只能通过 `peers.Input`/`peers.Button` 间接改。
 */
function buildComponents(name: ThemeName, p: Palette): Record<string, object> {
  const sh = shadow[name];
  return {
    Button: {
      fontWeightStrong: font.weight.semibold,
      paddingSmall: "0 10px",
      paddingMedium: "0 14px",
      borderRadiusSmall: radius.md,
      borderRadiusMedium: radius.md,
      borderRadiusLarge: radius.md,
      // naive-ui 的焦点态走 colorFocus 而不是 outline，不给就看不见键盘焦点。
      colorFocus: p.raised,
      colorFocusPrimary: p.primary.hover,
      iconMarginSmall: "6px",
    },
    Card: {
      borderRadius: radius.lg,
      paddingSmall: "16px",
      titleFontSizeSmall: font.size.base,
      borderColor: p.line,
    },
    Input: {
      borderRadius: radius.md,
      paddingSmall: "0 10px",
      paddingMedium: "0 12px",
      // 焦点必须同时有描边和一圈浅色环，只变描边在深色主题下几乎看不出来。
      boxShadowFocus: `0 0 0 2px ${p.ring}`,
      boxShadowFocusError: `0 0 0 2px ${p.danger.base}40`,
    },
    Form: {
      labelFontWeightStrong: font.weight.medium,
      labelFontSizeTopMedium: font.size.sm,
      feedbackFontSizeMedium: font.size.xs,
    },
    Modal: {
      // 弹层要明显浮起来，用三层阴影里最重的一档。
      boxShadow: sh.lg,
      peers: {
        Card: { borderRadius: radius.xl },
      },
    },
    Popover: {
      borderRadius: radius.md,
      boxShadow: sh.md,
      padding: "8px",
    },
    Dropdown: {
      borderRadius: radius.md,
      optionHeightMedium: "32px",
      padding: "4px",
      /*
       * 阴影必须挂在 peers.Popover 下：use-theme 取的是
       * `selfOverrides.peers`，写成顶层 Popover 会被静默忽略。
       * 这条结论来自 TopBarMenu.vue 的实测注释，不是推测。
       * 顶层同时给一份，是防"别处直接用 n-popover 时拿不到同一个阴影"。
       */
      peers: {
        Popover: { boxShadow: sh.md },
      },
    },
    Layout: {
      // 用库的 token 画分隔线，而不是在 UnoCSS 里手写 border 类：
      // naive-ui 把 `--n-*` 写在元素内联样式上，工具类和它的胜负取决于类顺序。
      // 分隔线是否出现仍由模板上的 `bordered` prop 决定，这里只给颜色。
      siderBorderColor: p.line,
      headerBorderColor: p.line,
      color: p.surface,
      siderColor: p.surface,
      headerColor: p.surface,
      colorEmbedded: p.canvas,
    },
    Menu: {
      borderRadius: radius.md,
      itemHeight: "36px",
      fontSize: font.size.base,
      itemIconMargin: "8px",
    },
    Tag: {
      borderRadius: radius.sm,
      heightSmall: "22px",
      heightMedium: "26px",
    },
    Switch: {
      railBorderRadiusSmall: radius.full,
      buttonBorderRadiusSmall: radius.full,
    },
    /*
     * 顶栏的平台切换原本是 `<style>` 里的
     * `:deep(.n-radio-button){ height: 32px; font-size: 12px }`，
     * 为的是和 32px 的汉堡按钮对齐。这里用 token 表达同一件事，
     * 从此不需要压私有类名。两处高度共用 `layout.controlH`，
     * 以后汉堡按钮改高度只会挪一个数。
     */
    Radio: {
      buttonHeightSmall: layout.controlH,
      buttonBorderRadius: radius.md,
    },
    Alert: {
      borderRadius: radius.md,
    },
    Scrollbar: {
      color: p.scrollbar,
      colorHover: p.scrollbarHover,
    },
    Empty: { textColor: p.inkFaint },
    Divider: { color: p.line },
  };
}

function build(name: ThemeName): GlobalThemeOverrides {
  const p = palettes[name];
  return {
    // `Record<string,string>` 与 naive-ui 的具体字面量类型不同形，
    // 但 naive-ui 的 common 本来就只要求这些字符串键；集中在一处断言，
    // 让上面 buildCommon 能保持可读的写法。
    common: buildCommon(name) as GlobalThemeOverrides["common"],
    ...buildComponents(name, p),
  };
}

export const themeOverrides: Record<ThemeName, GlobalThemeOverrides> = {
  light: build("light"),
  dark: build("dark"),
};

export const themeOf: Record<ThemeName, GlobalTheme> = {
  light: lightTheme,
  dark: darkTheme,
};
