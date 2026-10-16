<script setup lang="ts">
import ProvidersPanel from "@/components/config/ProvidersPanel.vue";

/**
 * 供应商页：部署级全局一份（`data/providers.json`），与当前是哪一档无关。
 *
 * 它原先挂在配置工作台的「全局」分组里，现在独立成主导航的一项 —— AstrBot 的
 * 「模型提供商」就是这个位置。留在工作台里的症状是：左上角写着当前档名，
 * 而这一页改的东西立刻对所有档生效，两者在界面上分不开。
 *
 * 不给内边距：供应商面板是自成一体的两栏工作台（自己管理滚动与选中），
 * 外面再套一层会把两份滚动条并排画出来。
 */
</script>

<template>
  <div class="atri-providers-view h-full">
    <providers-panel />
  </div>
</template>
