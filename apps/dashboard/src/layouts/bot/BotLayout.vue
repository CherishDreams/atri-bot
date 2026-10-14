<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import BotHeader from "@/components/bot/BotHeader.vue";
import BotNavigation from "@/components/bot/BotNavigation.vue";
import { layout } from "@/theme/tokens";

/**
 * ≤768px 时侧栏收进抽屉，由顶栏的汉堡打开（`ChatLayout` 在同一个断点收起侧栏，
 * 两处一致）。不这么做的话，375 视口下 232px 的侧栏会把内容区压到 143px ——
 * 配置工作台在里面还有一层分类菜单，那点宽度连一个开关都放不下。
 *
 * 导航之后自动收起：`?profile=` 与 `?cat=` 的变化都算一次导航，抽屉留着会盖住刚打开的内容，
 * 看起来像「点了没反应」。
 */
const route = useRoute();
const navOpen = ref(false);
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false;
  },
);
</script>

<template>
  <n-layout position="absolute">
    <!--
      bot 平台的顶栏是自己的一份实现（BotHeader），不再复用聊天页的 ChatHeader。
      两个平台的左侧本就不同——这里要 logo，聊天页要模型选择器——合成一个组件
      只能靠 isChat 分支，等于把两边的改动绑在一起。右侧控件仍共用三个组件。
    -->
    <n-layout-header class="h-[var(--atri-header-h)]">
      <bot-header @toggle-nav="navOpen = !navOpen" />
    </n-layout-header>

    <!--
      侧栏与内容区自己绝对定位，并让开顶栏高度：绝对定位的 top/left/right/bottom
      同时生效，高度不再依赖父级是不是 flex 容器。

      这里曾经写成 `position="absolute h-full"`，是个静默失效的坑：position 只接受
      "absolute" | "static"，多写的部分会整个拼进类名（`n-layout--absolute h-full-positioned`），
      既不匹配任何 naive-ui 规则、也不生成 h-full 工具类，于是元素退回 static，
      高度塌成内容高度——实测内容区只有 139px，而视口高 800px。
      注意外层 n-layout 从来不是 flex 容器（flex 只在 has-sider 时给滚动容器加上），
      所以内层若保持 static，`flex: auto` 也不会有任何效果。
    -->
    <n-layout has-sider position="absolute" class="top-[var(--atri-header-h)]!">
      <!--
        分隔线走 naive-ui 的 `bordered` + Layout.siderBorderColor，而不是在 UnoCSS 里
        补一个 `border-r border-#ccc`：naive-ui 把 `--n-*` 写成元素内联样式，
        工具类和它的胜负取决于类出现顺序而不是特异性，手写那条迟早会输。
      -->
      <n-layout-sider bordered :width="layout.navW" class="atri-bot-sider">
        <bot-navigation />
      </n-layout-sider>
      <n-layout-content class="h-full">
        <router-view />
      </n-layout-content>
    </n-layout>

    <!-- 抽屉里的导航与侧栏是同一个组件：两个入口共用一份菜单，否则迟早只剩一边更新。 -->
    <n-drawer v-model:show="navOpen" placement="left" :width="layout.navW">
      <n-drawer-content body-content-style="padding: 0;">
        <bot-navigation />
      </n-drawer-content>
    </n-drawer>
  </n-layout>
</template>

<style scoped>
/**
 * 断点比 `ChatLayout` 那条**少一像素**，不是笔误：汉堡按钮用 `md:hidden`
 *（≥768px 隐藏），而这条若写成 `max-width: 768px`，768 那一档就同时满足
 * 「侧栏隐藏」与「汉堡隐藏」—— 导航彻底消失。浏览器实测就是这么撞上的。
 * 767 与 768 之间没有别的断点，所以这样切刚好把两者接上。
 */
@media (max-width: 767px) {
  .atri-bot-sider {
    display: none;
  }
}
</style>
