<script setup lang="ts">
import ProfileList from "@/components/config/ProfileList.vue";

/**
 * 配置档页：外壳（标题 + 居中宽度）+ `ProfileList`。
 *
 * 列表与管理动作都在 `components/config/ProfileList.vue` 里，因为配置工作台的
 * 「管理配置档」弹窗要共用同一份实现 —— 那一处见 `ConfigWorkbench`。
 */
</script>

<template>
  <div class="atri-profiles-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-form p-6">
      <h2 class="m-0 text-2xl font-bold text-ink">配置档</h2>
      <div class="mt-5">
        <profile-list />
      </div>
    </div>
  </div>
</template>
