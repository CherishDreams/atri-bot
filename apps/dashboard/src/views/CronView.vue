<script setup lang="ts">
import CronPanel from "@/components/config/CronPanel.vue";

/**
 * 计划任务页：部署级调度。任务自己保存所用配置档与结果会话，不属于 URL 上的那份档，
 * 所以它是主导航「系统」组的一项。
 */
</script>

<template>
  <div class="atri-cron-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[68rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5">
        <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">计划任务</h2>
        <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
          cron 使用服务器本地时区（5 段：分 时 日 月 周）。到点后用指定配置档的人格、
          模型与工具跑一轮，结果写进任务自己的会话。
        </p>
      </header>
      <cron-panel keyword="" />
    </div>
  </div>
</template>
