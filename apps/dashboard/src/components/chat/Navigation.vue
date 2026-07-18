<template>
  <div class="atri-navigation-mobile" v-if="!isMobile">
    <n-menu :options="menuOptions" />
  </div>
</template>
<script lang="ts" setup>
import type { MenuOption } from "naive-ui";
import { h } from "vue";
import { RouterLink } from "vue-router";

defineProps({
  isMobile: {
    type: Boolean,
    default: false,
  },
});
const menuOptions: MenuOption[] = [
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
        { to: { name: "chat-new" } },
        { default: () => "创建会话" },
      ),
    key: "create-session",
  },
];
</script>
<style lang="scss" scoped></style>
