<script setup lang="ts">
import AdaptersPanel from "@/components/config/AdaptersPanel.vue";

/**
 * 接入平台页：外部平台跑在哪份配置上。**只读** —— 配置住在部署级的
 * `atri.config.json`，服务端今天只有 `GET /adapters`。
 *
 * 与供应商同一条理由从工作台搬出来：它属于部署，不属于某一档的跑法。
 * 这里不再写页面级标题 —— 面板自己的卡片已经带着标题与那句「为什么只读」。
 */
</script>

<template>
  <div class="atri-adapters-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-form p-4 sm:p-6">
      <adapters-panel />
    </div>
  </div>
</template>
