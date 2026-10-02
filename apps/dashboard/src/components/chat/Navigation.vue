<template>
  <!--
    以前这里写成 `<div v-if="!isMobile">` + 一个 `isMobile` prop，而**没有任何调用方传过它**：
    默认 false ⇒ 桌面菜单永远渲染，「窄屏就该换成别的形状」这件事从未发生（实测 375/414 下
    侧栏照样吃掉 232px，把顶栏控件挤出屏幕）。窄屏的处理已经移到 `ChatLayout` 的媒体查询里
    （收起整条侧栏），那个 prop 与它的类名就只剩误导作用，删掉而不是补一条传参。
  -->
  <div class="atri-navigation">
    <!-- `:value` 绑的是从路由算出来的当前项。没有它，n-menu 会自己记住「最后被点的那一项」——
         实测点「供应商配置」URL 一步没动、高亮却亮起来了：那是一张说谎的当前项指示。 -->
    <n-menu :options="menuOptions" :value="activeKey" />
  </div>
</template>
<script lang="ts" setup>
import type { MenuOption } from "naive-ui";
import { computed, h } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useProfile } from "@/composables/useProfile";

/**
 * 与 `BotNavigation.vue` 同一个形状：项用 `RouterLink` 渲染（产出真实的 `<a href>`，
 * 中键/右键「在新标签页打开」与状态栏预览都正常），`key` 直接取路由名，
 * 高亮由 `activeKey` 从同一路由名算出。
 *
 * 以前第一项是一条 `label: "模型配置"` 的**纯文本**项：既没有链接也没有 `@update:value`，
 * 于是点它什么都不发生（实测 URL 仍是 `/chat/new`），而 n-menu 依旧把它标成选中——
 * 「点了没反应」加「高亮说你在另一页」是两种病，一句里同时得着。
 * 目的地本来就存在（bot 侧的 `providerConfig`），所以这里接上去而不是删掉这一项。
 * 文案跟着改成「供应商配置」：一个写着「模型配置」的链接把人送到「供应商配置」页，
 * 是另一种形式的说谎，而两个词在本仓指同一件事（见 `ProfileGate` 那条链的终点）。
 *
 * 这一份档要跟着链接走：闸门在 `ChatLayout` 上，链接不带 `?profile=` 的话，
 * 从会话页点任何一项都会先把人退回「先选一份配置档」，刚选的档白选一次。
 * 因此 `menuOptions` 是 computed 而不是常量 —— 常量等于「setup 那一刻抓的 query」，
 * 而 profile 恰恰会在选完档的那一刻从 null 变成有值。
 */
const route = useRoute();
const { profile } = useProfile();

const menuOptions = computed<MenuOption[]>(() => [
  {
    key: "providerConfig",
    label: () =>
      h(
        RouterLink,
        { to: { name: "providerConfig", query: { profile: profile.value } } },
        { default: () => "供应商配置" },
      ),
  },
  {
    key: "chat-new",
    label: () =>
      h(
        RouterLink,
        // 原来这里带着 `params: { lang: "zh-CN" }`，但 chat-new 的路径里没有 `:lang`
        // 段——多余参数不会出现在 URL 里、也不会被路由消费，只会在控制台刷一条
        // `Discarded invalid param(s) "lang"`。BotNavigation 里同样的问题已经修过。
        { to: { name: "chat-new", query: { profile: profile.value } } },
        { default: () => "创建会话" },
      ),
  },
]);

/** 只认这两个已知路由名，其余情况（`/chat/:sessionId`）不高亮，避免误标成「在创建页」。 */
const activeKey = computed<string | null>(() => {
  const name = route.name;
  return typeof name === "string" && menuOptions.value.some((o) => o.key === name) ? name : null;
});
</script>
