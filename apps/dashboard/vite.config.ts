import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { API_PREFIX, DEFAULT_SERVER_PORT, WS_PATH } from "@atri/shared";
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
    // 代理键用 shared 的常量，而不是手抄 `"/api"` / `"/ws"`。
    // 手抄那两条各有两个问题：Vite 的 proxy 键是**字符串前缀**匹配，`"/api"` 连
    // `/apis/v1/…` 都会跟着转发（过度匹配，改错了也不报）；而 `API_PREFIX` 一改，
    // 服务端挂的是新前缀、SDK 打的是规格里那一份、代理还在转 `/api`，
    // 症状是 dev 下整片 404 而 `vue-tsc` 全绿。第三个真源没了，
    // 剩下的对应关系由 `test/openapi.test.ts` 那条「规格的 servers.url == API_PREFIX」守着。
    proxy: {
      [API_PREFIX]: {
        target: `http://127.0.0.1:${process.env.ATRI_PORT ?? DEFAULT_SERVER_PORT}`,
        changeOrigin: true,
      },
      [WS_PATH]: {
        target: `ws://127.0.0.1:${process.env.ATRI_PORT ?? DEFAULT_SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
