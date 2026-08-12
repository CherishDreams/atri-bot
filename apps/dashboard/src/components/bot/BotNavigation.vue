<template>
  <div class="atri-bot-navigation">
    <n-menu :options="menuOptions" :value="activeKey" @update:value="onSelect" />
  </div>
</template>

<script setup lang="ts">
import type { MenuOption } from "naive-ui";
import { computed, h } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { icon } from "@/components/shared/icons";

/**
 * 导航项用 RouterLink 渲染，而不是绑点击事件手动 push：
 * 前者产出真实的 <a href>，中键/右键「在新标签页打开」与状态栏预览都正常。
 *
 * `key` 直接取路由名，当前项高亮由 `activeKey` 据此算出——两者同一个来源，
 * 不会出现「点了菜单但高亮停在别处」。
 *
 * 原来第二项传了 `params: { lang: "zh-CN" }`，但 providerConfig 的路径里
 * 并没有 `:lang` 段，这类多余参数在 vue-router 里只会招来警告（URL 里看不到它，
 * 也不会被路由消费），因此一并去掉。
 */
const route = useRoute();
const router = useRouter();

const menuOptions: MenuOption[] = [
  {
    key: "console",
    icon: icon("console"),
    label: () => h(RouterLink, { to: { name: "console" } }, { default: () => "控制台" }),
  },
  {
    key: "providerConfig",
    icon: icon("provider"),
    label: () => h(RouterLink, { to: { name: "providerConfig" } }, { default: () => "供应商配置" }),
  },
  {
    key: "toolsConfig",
    icon: icon("tool"),
    label: () => h(RouterLink, { to: { name: "toolsConfig" } }, { default: () => "工具" }),
  },
];

/** 当前高亮项。只认这些已知路由名，其余情况不高亮，避免误标。 */
const activeKey = computed(() => {
  const name = route.name;
  return typeof name === "string" && menuOptions.some((o) => o.key === name) ? name : null;
});

function onSelect(key: string): void {
  void router.push({ name: key });
}
</script>
