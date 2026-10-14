<script setup lang="ts">
import ProvidersPanel from "@/components/config/ProvidersPanel.vue";

/**
 * 供应商配置页的**壳**。主体（两栏工作台与两个弹窗）在
 * `components/config/ProvidersPanel.vue`，因为它同时是配置工作台里「供应商」那一分类的面板。
 *
 * 这一条路由在下一提交里会变成 redirect（`/config?cat=providers`）；壳保留到现在，
 * 是为了让这次搬动本身不改变任何行为。
 */
</script>

<template>
  <div class="atri-provider-page h-full w-full">
    <providers-panel />
  </div>
</template>
