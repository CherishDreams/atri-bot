<script setup lang="ts">
import ChatHeader from "@/components/chat/ChatHeader.vue";
import Navigation from "@/components/chat/Navigation.vue";
import { layout } from "@/theme/tokens";
</script>

<template>
  <n-layout has-sider position="absolute">
    <!-- 与 bot 侧同一档宽度与同一条分隔线：两边切换时侧栏不会突然变宽变窄。 -->
    <n-layout-sider bordered :width="layout.navW">
      <navigation />
    </n-layout-sider>
    <n-layout>
      <n-layout-header position="absolute">
        <chat-header />
      </n-layout-header>
      <!-- 偏移量取自 --atri-header-h，与 ChatHeader 的高度是同一个来源。 -->
      <n-layout position="absolute" class="top-[var(--atri-header-h)]!">
        <n-layout-content class="h-full">
          <router-view />
        </n-layout-content>
      </n-layout>
    </n-layout>
  </n-layout>
</template>
