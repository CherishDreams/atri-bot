<script setup lang="ts">
import ModelSelectMenu from "@/components/shared/ModelSelectMenu.vue";
import PlatformSwitch from "@/components/shared/PlatformSwitch.vue";
import ThemeToggle from "@/components/shared/ThemeToggle.vue";
import TopBarMenu from "@/components/shared/TopBarMenu.vue";

/**
 * chat 平台的顶栏。左侧是模型选择器（选哪个模型回答），右侧是平台切换与汉堡菜单，
 * 与 bot 顶栏的右半部分完全一致——所以那三个控件都抽成了共用组件。
 *
 * 与 BotHeader 的分工：这个组件负责「chat 侧的顶栏长什么样」，
 * BotHeader 负责「bot 侧的顶栏长什么样」，二者不互相引用也不含 isChat 分支。
 * 曾经把 BotHeader 做成复用本组件，结果是 bot 侧顶栏左边也跟着显示模型选择器，
 * 既丢了 logo 又表达不出两个平台的区别。
 */
</script>

<template>
  <header
    class="atri-chat-header flex h-[var(--atri-header-h)] w-full items-center justify-between border-b-1 border-line px-4"
  >
    <ModelSelectMenu />

    <div class="flex items-center gap-3">
      <ThemeToggle />
      <PlatformSwitch />
      <TopBarMenu />
    </div>
  </header>
</template>
