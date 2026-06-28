import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { DEFAULT_SERVER_PORT } from "@atri/shared";
import AutoImport from "unplugin-auto-import/vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";
import Components from "unplugin-vue-components/vite";

// dev server 把 /api 和 /ws 代理到后端，
// 这样 UI 在 dev 和生产环境都能使用同源的相对 URL。
export default defineConfig({
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({
      imports: [
        "vue",
        {
          "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"],
        },
      ],
    }),

    Components({
      resolvers: [NaiveUiResolver()],
    }),
  ],
  base: "/",
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.ATRI_PORT ?? DEFAULT_SERVER_PORT}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${process.env.ATRI_PORT ?? DEFAULT_SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
