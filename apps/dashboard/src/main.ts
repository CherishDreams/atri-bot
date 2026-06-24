import { createApp } from "vue";
import { createPinia } from "pinia";
// `./uno.css` 是本地基础样式（reset + 全局），必须先于原子类载入。
import "./uno.css";
// `virtual:uno.css` 是 UnoCSS vite 插件提供的虚拟入口，原子类由它注入；
// 缺了这一行，构建产物里一个工具类都不会有。
import "virtual:uno.css";
import App from "./App.vue";
import { router } from "./router/index.js";

createApp(App).use(createPinia()).use(router).mount("#app");
