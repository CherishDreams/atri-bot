<script setup lang="ts">
import ChatHeader from "@/components/chat/ChatHeader.vue";
import Navigation from "@/components/chat/Navigation.vue";
</script>

<template>
  <n-layout has-sider position="absolute">
    <n-layout-sider>
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
