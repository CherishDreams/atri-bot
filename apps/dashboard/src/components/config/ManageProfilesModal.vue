<script setup lang="ts">
import ProfileList from "./ProfileList.vue";

/**
 * 「管理配置档」弹窗 —— AstrBot 档下拉底部那条「管理配置」的对应物。
 *
 * 里面就是 `ProfileList`，与 `/profiles` 页**同一份实现**（新建 / 切到这里 / 重命名 /
 * 重载 / 下线）。共用的理由不是省代码：这五个动作的二次确认与失败配色只该有一处真源，
 * 两处各写一份的话，迟早有一处忘了二次确认。
 */
defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: "update:show", value: boolean): void }>();
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="管理配置档"
    class="w-[46rem] max-w-[94vw]"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <profile-list />
  </n-modal>
</template>
