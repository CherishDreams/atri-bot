<script setup lang="ts">
import BotNavigation from "@/components/bot/BotNavigation.vue";
import ChatHeader from "@/components/chat/ChatHeader.vue";
</script>

<template>
  <n-layout position="absolute">
    <!--
      顶栏复用聊天页的 ChatHeader（模型选择 + 汉堡菜单/登出），两处只维护一套实现。
      高度与下面内容区的 top 偏移共用 --atri-header-h，改一处即两处同步。
    -->
    <n-layout-header class="h-[var(--atri-header-h)]">
      <chat-header />
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
      <n-layout-sider class="border-r border-#ccc">
        <bot-navigation />
      </n-layout-sider>
      <n-layout-content class="h-full">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>
