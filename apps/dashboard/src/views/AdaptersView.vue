<script setup lang="ts">
import AdaptersPanel from "@/components/config/AdaptersPanel.vue";

/**
 * 接入平台页：新增、编辑、删除与启停平台实例。实例住在部署级的
 * `data/adapters.json`，与当前是哪一档无关。
 *
 * 与供应商同一条理由从工作台搬出来：它属于部署，不属于某一档的跑法。
 * 这里不再写页面级标题 —— 面板自己的卡片已经带着标题与实例状态。
 */
</script>

<template>
  <div class="atri-adapters-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-form p-4 sm:p-6">
      <adapters-panel />
    </div>
  </div>
</template>
