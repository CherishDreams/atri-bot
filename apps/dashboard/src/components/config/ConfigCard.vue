<script setup lang="ts">
/**
 * 一张配置分组卡片（AstrBot 的 `AstrBotConfigV4` 那一层）。
 *
 * 只做外壳：标题 + 一句说明 + 内容槽 + 可选的底部说明。**不读任何 store** ——
 * 卡片里放什么由各个面板决定，这样「更多配置」那种折叠、错误条、按钮组
 * 都不必挤进一个通用组件里长出 props 分支。
 */
defineProps<{
  title: string;
  /** 组级说明。AstrBot 里对应 `hint`：没有它，用户只会看到一排开关而不知道在开什么。 */
  hint?: string;
}>();
</script>

<template>
  <section
    class="mb-4 rounded-lg border-1 border-line bg-surface px-4 py-3 last:mb-0"
    aria-labelledby="card-title"
  >
    <header class="mb-3">
      <h3 id="card-title" class="m-0 text-base font-bold text-ink">{{ title }}</h3>
      <p v-if="hint" class="mt-1 mb-0 text-13px leading-relaxed text-ink-muted">{{ hint }}</p>
    </header>
    <slot />
    <footer v-if="$slots.footer" class="mt-3 border-t-1 border-line pt-3 text-xs text-ink-faint">
      <slot name="footer" />
    </footer>
  </section>
</template>
