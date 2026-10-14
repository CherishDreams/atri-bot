<script setup lang="ts">
/**
 * 右下角的浮动保存键（AstrBot 那个固定在主内容区右下角的按钮）。
 *
 * 它同时是**脏状态最显眼的那一处**：干净的页面上它写着「已保存」且按不动 ——
 * 这一条比任何提示语都直接，用户不必去猜「我刚才那个开关到底生效没有」。
 * 放在工作台内部（`absolute`）而不是 `fixed`：bot 布局的内容区有自己的边界，
 * `fixed` 会飘到侧栏上面去。
 */
defineProps<{ dirty: boolean; saving: boolean }>();
const emit = defineEmits<{ (e: "save"): void }>();
</script>

<template>
  <div class="pointer-events-none absolute right-4 bottom-4 z-10 flex items-center gap-2">
    <span
      v-if="dirty"
      class="pointer-events-auto rounded bg-surface px-2 py-1 text-xs text-ink-muted shadow"
    >
      有未保存的改动
    </span>
    <n-button
      class="pointer-events-auto"
      type="primary"
      :loading="saving"
      :disabled="!dirty || saving"
      @click="emit('save')"
    >
      {{ saving ? "保存中…" : dirty ? "保存" : "已保存" }}
    </n-button>
  </div>
</template>
