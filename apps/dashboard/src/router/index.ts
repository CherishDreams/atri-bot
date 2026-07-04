import { createRouter, createWebHistory } from "vue-router";
import { AUTH_LOGIN_PATH } from "@atri/shared";
import { useAuthStore } from "../stores/auth.js";
import LoginView from "../views/LoginView.vue";
import ConsoleView from "../views/ConsoleView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: AUTH_LOGIN_PATH, name: "login", component: LoginView },
    {
      path: "/",
      component: () => import("@/layouts/bot/BotLayout.vue"),
      meta: { requiresAuth: true },
      children: [
        { path: "", name: "console", component: ConsoleView },
        {
          path: "provider",
          name: "providerConfig",
          component: () => import("@/views/ProviderConfig.vue"),
        },
      ],
    },
    {
      path: "/chat",
      name: "chat",
      component: () => import("@/layouts/chat/ChatLayout.vue"),
      meta: { requiresAuth: true },
      // /chat 自身没有可渲染的子路由，落到创建页而不是空白。
      redirect: { name: "chat-new" },
      children: [
        { path: "new", name: "chat-new", component: () => import("@/views/chat/NewSession.vue") },
        {
          path: ":sessionId",
          name: "chat-session",
          component: () => import("@/views/chat/ChatSessionView.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 未确认过身份时先问一次服务端。fetchMe 在 401 时返回 null，不抛错。
  if (auth.user === null) {
    try {
      await auth.fetchStatus();
      await auth.fetchMe();
    } catch {
      /* 网络/服务端故障不阻塞导航，按未登录处理 */
    }
  }

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    // 注意：跳转目标带 redirect 查询参数，但 login 自身不需要鉴权，
    // 因此不会再命中这个分支，循环在此处终止。
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (to.name === "login" && auth.isAuthenticated) {
    return { path: "/" };
  }

  return true;
});
