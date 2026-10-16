<template>
  <div class="atri-bot-navigation p-2">
    <n-menu :options="menuOptions" :value="activeKey" @update:value="onSelect" />
  </div>
</template>

<script setup lang="ts">
import type { MenuOption } from "naive-ui";
import { computed, h } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { icon, type IconName } from "@/components/shared/icons";
import { useProfile } from "@/composables/useProfile";

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
 *
 * **作用域化的那几项必须带上 `?profile=`**（与 `chat/Navigation.vue` 同一条理由）：
 * 当前档只存在于 URL 里，链接不带它，点一次侧栏就掉一次档 —— 症状是刚在工具页
 * 开了两个开关，点回控制台再点进来，守卫重新补了一份档（通常是 `default`），
 * 于是「我在 B 上改的」在界面上变成了「A 的配置」。
 *
 * `menuOptions` 因此是 computed 而不是常量：常量等于「setup 那一刻抓的 query」，
 * 而 profile 恰恰会在选完档的那一刻从 null 变成有值。
 */
const route = useRoute();
const router = useRouter();
const { profile } = useProfile();

/**
 * 不带 `?profile=` 的那几个：`providers` / `adapters` 在路由表上都标了 `noProfile` ——
 * 它们是部署级全局一份。给它们挂一个与页面无关的档名，等于在 URL 上谎称「这一页是按档的」。
 */
const PROFILE_ROUTES = new Set(["console", "config", "plugins"]);

function to(name: string) {
  // `profile.value` 在 `noProfile` 页面（配置 / 供应商 / 接入平台）上是 null。
  // 把 null 塞进 query 会被 vue-router 序列化成裸的 `?profile`（实测），虽然守卫
  // 随后会补成默认档，但那条 URL 本身是坏的；没有档名时干脆不带。
  return {
    name,
    ...(PROFILE_ROUTES.has(name) && profile.value !== null
      ? { query: { profile: profile.value } }
      : {}),
  };
}

const items: { key: string; label: string; icon: IconName }[] = [
  { key: "console", label: "控制台", icon: "console" },
  // 档级的默认模型 / 工具 / 运行参数在这页里；配置本身的增删在这一页左上角
  // 切换器的弹窗里，不单列一项。插件有自己的页面（见下一项）。
  { key: "config", label: "配置文件", icon: "settings" },
  // 插件页：每份档各有一套启用清单与配置值，所以链接要带 `?profile=`。
  { key: "plugins", label: "插件", icon: "plugin" },
  // 供应商与接入平台是**部署级**的整页，各自占一项 —— AstrBot 的「模型提供商」
  // 「平台配置」就在主导航里这个位置。它们不属于某一份配置，所以不带 `?profile=`。
  { key: "providers", label: "供应商", icon: "provider" },
  { key: "adapters", label: "接入平台", icon: "chat" },
];

const menuOptions = computed<MenuOption[]>(() =>
  items.map((item) => ({
    key: item.key,
    icon: icon(item.icon),
    label: () => h(RouterLink, { to: to(item.key) }, { default: () => item.label }),
  })),
);

/** 当前高亮项。只认这些已知路由名，其余情况不高亮，避免误标。 */
const activeKey = computed(() => {
  const name = route.name;
  return typeof name === "string" && items.some((o) => o.key === name) ? name : null;
});

/** 与链接共用 `to()`：两条出口算出同一个目标，才会出现「点了没跳对档」的分裂。 */
function onSelect(key: string): void {
  void router.push(to(key));
}
</script>
