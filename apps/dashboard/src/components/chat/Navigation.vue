<template>
  <!--
    以前这里写成 `<div v-if="!isMobile">` + 一个 `isMobile` prop，而**没有任何调用方传过它**：
    默认 false ⇒ 桌面菜单永远渲染，「窄屏就该换成别的形状」这件事从未发生（实测 375/414 下
    侧栏照样吃掉 232px，把顶栏控件挤出屏幕）。窄屏的处理已经移到 `ChatLayout` 的媒体查询里
    （收起整条侧栏），那个 prop 与它的类名就只剩误导作用，删掉而不是补一条传参。
  -->
  <div class="atri-navigation">
    <n-menu :options="menuOptions" />
  </div>
</template>
<script lang="ts" setup>
import type { MenuOption } from "naive-ui";
import { computed, h } from "vue";
import { RouterLink } from "vue-router";
import { useProfile } from "@/composables/useProfile";

/**
 * 这一份档要跟着链接走：闸门在 `ChatLayout` 上，链接不带 `?profile=` 的话，
 * 从会话页点「创建会话」会先把人退回「先选一份配置档」，刚选的档白选一次。
 *
 * 因此 `menuOptions` 是 computed 而不是常量 —— 常量等于「setup 那一刻抓的 query」，
 * 而 profile 恰恰会在选完档的那一刻从 null 变成有值。
 */
const { profile } = useProfile();

const menuOptions = computed<MenuOption[]>(() => [
  {
    label: "模型配置",
    key: "model-config",
  },
  {
    label: () =>
      h(
        RouterLink,
        // 原来这里带着 `params: { lang: "zh-CN" }`，但 chat-new 的路径里没有 `:lang`
        // 段——多余参数不会出现在 URL 里、也不会被路由消费，只会在控制台刷一条
        // `Discarded invalid param(s) "lang"`。BotNavigation 里同样的问题已经修过。
        { to: { name: "chat-new", query: { profile: profile.value } } },
        { default: () => "创建会话" },
      ),
    key: "create-session",
  },
]);
</script>
<style lang="scss" scoped></style>
