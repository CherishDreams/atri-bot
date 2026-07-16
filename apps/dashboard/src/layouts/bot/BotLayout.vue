<script setup lang="ts">
import BotHeader from "@/components/bot/BotHeader.vue";
import BotNavigation from "@/components/bot/BotNavigation.vue";
import { layout } from "@/theme/tokens";
</script>

<template>
  <n-layout position="absolute">
    <!--
      bot 平台的顶栏是自己的一份实现（BotHeader），不再复用聊天页的 ChatHeader。
      两个平台的左侧本就不同——这里要 logo，聊天页要模型选择器——合成一个组件
      只能靠 isChat 分支，等于把两边的改动绑在一起。右侧控件仍共用三个组件。
    -->
    <n-layout-header class="h-[var(--atri-header-h)]">
      <bot-header />
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
      <n-layout-sider bordered :width="layout.navW">
        <bot-navigation />
      </n-layout-sider>
      <n-layout-content class="h-full">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>
