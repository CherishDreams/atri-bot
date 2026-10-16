<script setup lang="ts">
import { icon } from "@/components/shared/icons";

/**
 * 右下角的浮动保存键（AstrBot 那个固定在主内容区右下角的按钮）。
 *
 * 它同时是**脏状态最显眼的那一处**：干净的页面上它是一枚「已保存」的灰字条，
 * 而不是一颗禁用变淡的主按钮 —— 后者在深色底上对比度太低，读起来像坏了。
 * 放在工作台内部（`absolute`）而不是 `fixed`：bot 布局的内容区有自己的边界，
 * `fixed` 会飘到侧栏上面去。
 */
defineProps<{ dirty: boolean; saving: boolean }>();
const emit = defineEmits<{ (e: "save"): void }>();
const CheckIcon = icon("check");
</script>

<template>
  <div class="pointer-events-none absolute right-4 bottom-4 z-10 flex items-center gap-2">
    <span
      v-if="dirty"
      class="pointer-events-auto rounded-lg border-1 border-line bg-surface px-2 py-1 text-xs text-ink-muted shadow-sm"
    >
      有未保存的改动
    </span>
    <n-button
      v-if="dirty"
      class="pointer-events-auto shadow-md"
      type="primary"
      :loading="saving"
      :disabled="saving"
      @click="emit('save')"
    >
      {{ saving ? "保存中…" : "保存" }}
    </n-button>
    <span
      v-else
      class="inline-flex items-center gap-1.5 rounded-lg border-1 border-line bg-surface px-3 py-1.5 text-xs text-ink-faint shadow-sm"
    >
      <component :is="CheckIcon" />
      已保存
    </span>
  </div>
</template>
