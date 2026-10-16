<template>
  <!--
    以前这里写成 `<div v-if="!isMobile">` + 一个 `isMobile` prop，而**没有任何调用方传过它**：
    默认 false ⇒ 桌面菜单永远渲染，「窄屏就该换成别的形状」这件事从未发生（实测 375/414 下
    侧栏照样吃掉 232px，把顶栏控件挤出屏幕）。窄屏的处理已经移到 `ChatLayout` 的媒体查询里
    （收起整条侧栏），那个 prop 与它的类名就只剩误导作用，删掉而不是补一条传参。
  -->
  <div class="atri-navigation p-2">
    <!-- `:value` 绑的是从路由算出来的当前项。没有它，n-menu 会自己记住「最后被点的那一项」——
         实测点「供应商」URL 一步没动、高亮却亮起来了：那是一张说谎的当前项指示。 -->
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
 * 第一项指向 `/providers`（供应商）。它曾经指向路由名 `providerConfig` —— 那个名字在
 * 配置工作台重构时就不存在了，于是点它只会在控制台留下一条「No match for ...」而不跳转；
 * 供应商现在是独立页，链接直接接回真实存在的路由名。
 *
 * 「创建会话」要跟着这一份配置走：闸门在 `ChatLayout` 上，链接不带 `?profile=` 的话，
 * 从会话页点它会被守卫重新补一份（不一定是刚在用的那份）。供应商是部署级、不随配置变，
 * 所以它不带 `?profile=`。
 *
 * 因此 `menuOptions` 是 computed 而不是常量 —— 常量等于「setup 那一刻抓的 query」，
 * 而 profile 恰恰会在选完档的那一刻从 null 变成有值。
 */
const route = useRoute();
const { profile } = useProfile();

const menuOptions = computed<MenuOption[]>(() => [
  {
    key: "providers",
    label: () => h(RouterLink, { to: { name: "providers" } }, { default: () => "供应商" }),
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
