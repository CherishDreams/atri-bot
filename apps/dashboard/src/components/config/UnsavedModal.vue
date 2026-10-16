<script setup lang="ts">
/**
 * 「有未保存的改动」那一次确认：保存并离开 / 放弃并离开 / 留在本页。
 *
 * 三条出口都必须有，而且措辞要说清后果：
 * - 保存失败时**不跳转**，把服务端的中文原因留在弹窗里 —— 否则「点了保存、页面走了、
 *   其实没写进去」是最坏的一种。
 * - 「放弃」是唯一会丢东西的出口，所以它排在中间而不是最右（最右是默认焦点位）。
 * - 点遮罩或按 Esc **不关**：这条弹窗的全部意义就是逼出一个明确选择，
 *   而被误触关掉等于默认「留下」，用户可以接受，但那一刻的沉默更像什么都没发生。
 */
defineProps<{ show: boolean; saving: boolean; error: string | null }>();
const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (e: "save"): void;
  (e: "discard"): void;
}>();
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="有未保存的改动"
    class="w-[30rem] max-w-[92vw]"
    :mask-closable="false"
    :close-on-esc="false"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p class="m-0 text-sm leading-relaxed text-ink-muted">
      这一份配置里有改动还没写进文件。离开之后这些改动会丢；想让它们生效，先保存。
    </p>
    <n-alert v-if="error" type="error" class="mt-3" :show-icon="false">
      {{ error }}
    </n-alert>
    <template #footer>
      <div class="flex flex-wrap justify-end gap-2">
        <n-button @click="emit('update:show', false)">留在本页</n-button>
        <n-button type="warning" tertiary @click="emit('discard')">放弃并离开</n-button>
        <n-button type="primary" :loading="saving" @click="emit('save')">保存并离开</n-button>
      </div>
    </template>
  </n-modal>
</template>
