import { defineConfig, presetWind4 } from "unocss";

// 原来 src/styles.css 里的 6 个主题变量，迁到这里成为 UnoCSS 主题色，
// 因此 `bg-bg`、`bg-panel`、`text-fg`、`text-muted`、`text-accent`、
// `bg-accent`、`text-danger`、`border-panel` 这些类名都可用。
export default defineConfig({
  presets: [presetWind4()],
  theme: {
    colors: {
      bg: "#0f1115",
      panel: "#171a21",
      fg: "#e6e8ec",
      muted: "#8b93a1",
      accent: "#4f8cff",
      danger: "#ff5f56",
    },
  },
  shortcuts: {
    // 原 .plugin-actions button 的次级按钮；#2b3040 是旧 styles.css 的控件边框色。
    "btn-ghost":
      "cursor-pointer rounded-lg border border-[#2b3040] bg-[#222836] px-2 py-1 text-xs text-fg",
    // 面板之间的分隔线（原 #232733）。
    "edge-line": "border-[#232733]",
  },
});
