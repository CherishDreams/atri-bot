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
        /*
         * 配置文件页：左上角切档 + 左侧分类 + 右侧配置项。分类只有本档的五类
         * （默认模型 / 人格 / 工具 / 运行参数 / 访问控制），都写在档文件里，
         * 所以这一页**需要** `?profile=`。人格库与计划任务是独立的全局页，
         * 不属于这条 route record。
         */
        {
          path: "config",
          name: "config",
          component: () => import("@/views/ConfigWorkbench.vue"),
        },
        // 人格库是全局内容资产；配置档只在配置文件页里引用它。
        {
          path: "personas",
          name: "personas",
          component: () => import("@/views/PersonasView.vue"),
          meta: { noProfile: true },
        },
        // 插件是独立一页（启用清单 + schema 驱动的配置）：配置抽屉的保存是即时动作，
        // 与工作台「草稿 + 一次保存」不是同一种语义，合进 `?cat=` 会让两套写入方式并存。
        {
          path: "plugins",
          name: "plugins",
          component: () => import("@/views/PluginsView.vue"),
        },
        /*
         * 供应商与接入平台是**部署级**的两页（AstrBot 的「模型提供商」「平台配置」就是主导航里
         * 各自的一项）：前者写 `data/providers.json`，后者写 `data/adapters.json`（实例管理）。
         * 两者都不随档变，所以标 `noProfile` —— 给它们挂一个与页面无关的 `?profile=`，
         * 等于在 URL 上谎称「这一页是按档的」。
         */
        {
          path: "providers",
          name: "providers",
          component: () => import("@/views/ProvidersView.vue"),
          meta: { noProfile: true },
        },
        {
          path: "adapters",
          name: "adapters",
          component: () => import("@/views/AdaptersView.vue"),
          meta: { noProfile: true },
        },
        // 技能库是部署级内容资产（与人格同类）：这一页只读目录与全文，启停在配置文件页。
        {
          path: "skills",
          name: "skills",
          component: () => import("@/views/SkillsView.vue"),
          meta: { noProfile: true },
        },
        // MCP 服务器是部署级的第三页：连接清单与工具桥接不随档变（工具开关在配置文件页）。
        {
          path: "mcp",
          name: "mcp",
          component: () => import("@/views/McpView.vue"),
          meta: { noProfile: true },
        },
        // 计划任务是部署级调度：任务自己保存所用配置档，不跟随 URL 上的档名。
        {
          path: "cron",
          name: "cron",
          component: () => import("@/views/CronView.vue"),
          meta: { noProfile: true },
        },
        // 日志是进程级的：不属于任何一份配置，也不该在 URL 上挂一个无关的档名。
        {
          path: "logs",
          name: "logs",
          component: () => import("@/views/LogsView.vue"),
          meta: { noProfile: true },
        },
        // 旧入口保留成 redirect，而不是删掉：它们可能已经出现在书签或文档里。
        // `/tools` 仍是档级页面，所以用函数形式把 `?profile=` 一并带过去（丢掉它的话，
        // 从旧链接进来会先换一档）；`/provider` 现在是不随档的独立页，query 原样丢掉。
        {
          path: "tools",
          redirect: (to) => ({ name: "config", query: { ...to.query, cat: "tools" } }),
        },
        {
          path: "provider",
          redirect: { name: "providers" },
        },
        // 访问控制已并入配置文件页的「本档配置」分类；旧整页 URL 留 redirect，
        // 落到对应的 `?cat=`，而不是回 404 或默认分类。人格与计划任务重新有独立页，
        // 不需要 redirect。
        {
          path: "access",
          redirect: { name: "config", query: { cat: "access" } },
        },
        // 配置的增删不单独占一页：它就在配置文件页左上角切换器的「管理配置」弹窗里。
        // `/profiles` 这个旧入口留一条 redirect（它可能已经出现在书签里）。
        {
          path: "profiles",
          redirect: { name: "config" },
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
 * 这个目标路由需不需要 `?profile=`。登录页、供应商、接入平台、人格配置、计划任务与日志
 * 都是部署级或进程级的一份，与当前是哪一份配置无关 —— 这几处都不带。配置文件页与插件页
 * 按档，所以带档名。（`/profiles` 已经降成 redirect，配置的增删改在配置文件页的切换器弹窗里。）
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
