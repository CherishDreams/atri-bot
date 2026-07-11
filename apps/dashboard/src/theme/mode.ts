import { computed, readonly, ref } from "vue";
import type { ThemeName } from "./tokens.ts";
import { THEME_ATTR } from "./css-vars.ts";

export type ThemeMode = ThemeName | "system";

const STORAGE_KEY = "atri.themeMode";

function readStored(): ThemeMode {
  // 读写都包一层：隐私模式下 localStorage 会直接抛，主题不该因此让应用起不来。
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function writeStored(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 存不下就算了，本次会话内仍然生效 */
  }
}

const prefersDark =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

/**
 * 模块级单例。
 *
 * 主题是全应用共享的一份状态，为它单开一个 Pinia store 反而让 App.vue 多一个依赖，
 * 而 naive-ui 的 `:theme` 与 UnoCSS 的变量都得在首帧就有值，
 * 所以这里直接持有一个 ref，谁 import 谁拿到同一份。
 *
 * 这个文件不在 `uno.config.ts` 的依赖链上（那边只 import tokens.ts / css-vars.ts），
 * 所以它可以放心用 `matchMedia` 与 `document`——那两个 API 在 Node 侧不存在。
 */
const mode = ref<ThemeMode>(readStored());
const systemIsDark = ref(prefersDark?.matches ?? false);

const scheme = computed<ThemeName>(() =>
  mode.value === "system" ? (systemIsDark.value ? "dark" : "light") : mode.value,
);

/**
 * 把当前主题写到根元素上。
 *
 * UnoCSS 的明暗靠这条属性选择器翻转 CSS 变量（见 theme/css-vars.ts），
 * naive-ui 的 `:theme` 由 App.vue 读 `scheme` 得到——两边必须同一个来源，
 * 否则会出现「外壳深色、卡片浅色」这种最难查的错位。
 */
function apply(): void {
  document.documentElement.setAttribute(THEME_ATTR, scheme.value);
}

apply();

if (prefersDark) {
  // 监听挂在模块上、只注册一次：它要在应用整个生命周期里生效，
  // 而 `scheme` 已是 computed，系统偏好变化时会自动重算并驱动两边主题。
  prefersDark.addEventListener("change", (e) => {
    systemIsDark.value = e.matches;
  });
}

function setMode(next: ThemeMode): void {
  mode.value = next;
  writeStored(next);
  apply();
}

/** 顶栏那颗按钮用的简化版：只在明/暗之间跳，不引入「跟随系统」这个第三态。 */
function toggle(): void {
  setMode(scheme.value === "dark" ? "light" : "dark");
}

export function useTheme() {
  return {
    mode: readonly(mode),
    scheme: readonly(scheme),
    setMode,
    toggle,
  };
}
