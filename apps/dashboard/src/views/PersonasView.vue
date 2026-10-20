<script setup lang="ts">
import PersonaManagerPanel from "@/components/config/PersonaManagerPanel.vue";

/**
 * 人格配置页：全局人格库。人格正文不跟配置档走，配置档只在「配置文件 → 人格」
 * 里引用。它是主导航「个性化配置」组的一项，不属于某一份档。
 */
</script>

<template>
  <div class="atri-personas-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[68rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5">
        <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">人格配置</h2>
        <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
          人格是可复用的全局人设。在「配置文件 → 人格」里为每份配置选用一个； 提示词每轮作为 system
          消息注入，不写进会话历史。
        </p>
      </header>
      <persona-manager-panel keyword="" />
    </div>
  </div>
</template>
