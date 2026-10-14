import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationNormalized } from "vue-router";
import { AUTH_LOGIN_PATH, DEFAULT_PROFILE_ID } from "@atri/shared";
import type { ProfileRecord } from "@atri/shared";
import { useAuthStore } from "../stores/auth.js";
import { useProfilesStore } from "../stores/profiles.js";
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
        // 配置工作台：左上角切档 + 左侧分类 + 右侧配置项。工具、插件、档默认、步数都在这一页，
        // 所以它**需要** `?profile=`（本档那几类是写在档文件里的）。
        {
          path: "config",
          name: "config",
          component: () => import("@/views/ConfigWorkbench.vue"),
        },
        // 两个旧入口保留成 redirect，而不是删掉：它们可能已经出现在别人的书签或文档里。
        // 用函数形式是为了把 `?profile=` 一并带过去 —— 丢掉它的话，从旧链接进来会先"换一档"。
        {
          path: "tools",
          redirect: (to) => ({ name: "config", query: { ...to.query, cat: "tools" } }),
        },
        {
          path: "provider",
          redirect: (to) => ({ name: "config", query: { ...to.query, cat: "providers" } }),
        },
        // 这一页自己**不需要** ?profile=：它管的是「有哪些档」，所以它是那个让你挑档的页面，
        // 而不是一个挑了档才能用的页面。`noProfile` 就是把这个例外写进路由表 ——
        // 下面的守卫给所有其它已鉴权路由补 `?profile=`，漏标这一条会让「管理配置档」本身
        // 变成需要先选一份档才能访问。
        {
          path: "profiles",
          name: "profiles",
          component: () => import("@/views/ProfilesView.vue"),
          meta: { noProfile: true },
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

/**
 * 自动补 `?profile=` 时选哪一份：`default` 优先，取不到就用第一份 `ready`。
 *
 * 只看 `ready` 是硬要求 —— `failed` 的那一份带着它去请求会得到 503，
 * 「进来就红」比「进来要选一次」糟得多。返回 null 表示没有任何可用档，
 * 那时仍然渲染 `ProfilePicker`（它就是为这个场景留的）。
 *
 * 「第一份」不是任意的：`GET /profiles` 按 id 排序返回，所以这一句是确定性的，
 * 换浏览器、刷新、深链都会落到同一份上。
 */
function pickProfile(usable: ProfileRecord[]): string | null {
  return usable.find((p) => p.id === DEFAULT_PROFILE_ID)?.id ?? usable[0]?.id ?? null;
}

/**
 * 这个目标路由需不需要 `?profile=`。登录页、「配置档」页与「供应商」页都不需要：
 * 前两者管的是档本身，最后那个是全局一份的清单。
 */
function needsProfile(to: RouteLocationNormalized): boolean {
  return Boolean(to.meta.requiresAuth) && to.meta.noProfile !== true;
}

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

  /*
   * 作用域页面缺 `?profile=` 时补上一个可用档，而不是把用户挡在选择器前面。
   *
   * **补在路由里而不是补在服务端**：服务端对缺 profile 一律 400，这条契约由
   * `openapi-request.test.ts` 双向钉着，绝不为了省事改成「回落到 default」——
   * 那会立刻造出「界面显示 A、请求写进 B」这类没有任何错误信号的形态。
   * 这里补完之后 URL 上写着档名，后续每个请求都带着它，所以「绿勾 = 已落盘」仍然成立。
   *
   * 用 `replace` 而不是 `push`：这是一次补全，不是一步导航，留着它用户按一次后退键就回到
   * 一个没有 profile 的 URL，再走一遍这个分支。
   *
   * 已有 `?profile=` 时**一律不碰**，包括它指向一份不存在或 failed 的档 —— 那是用户或
   * 另一台机器写下的深链，界面要如实报错，而不是悄悄把人换到另一份档上。
   */
  if (auth.isAuthenticated && needsProfile(to)) {
    const profiles = useProfilesStore();
    // 列表为空就先拉一次，**包括 URL 已经带着 `?profile=` 的那些导航**。
    // 不只是补值那一条路径要这份列表：顶栏的模型选择器显示的是「这一档默认用哪个」，
    // 而那是档级属性，只存在于 `GET /profiles` 的返回里。少了这一句，深链与刷新进来时
    // 列表是空的，而空列表在界面上的症状是「显示默认模型」—— 一句谎话，
    // 因为档里明明写着另一个。（这条是浏览器实测抓出来的，不是想出来的。）
    if (profiles.profiles.length === 0 && !profiles.loading) {
      await profiles.refresh();
    }
    const requested = to.query.profile;
    const missingProfile = typeof requested !== "string" || requested.length === 0;
    // URL 上已经写着档名：到此为止，**不碰**。它指向一份不存在的或 failed 的档时
    // 也要如实报错，而不是悄悄把人换到另一份档上。
    if (missingProfile) {
      const pick = pickProfile(profiles.usable);
      if (pick !== null) {
        return {
          name: to.name ?? undefined,
          params: to.params,
          query: { ...to.query, profile: pick },
          hash: to.hash,
          replace: true,
        };
      }
    }
  }

  return true;
});
