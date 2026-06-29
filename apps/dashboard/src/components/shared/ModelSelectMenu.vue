<template>
  <n-popover trigger="click" placement="bottom" animated class="model-select-menu">
    <div class="model-select-menu-container w-80" v-if="isModelSelectMenuVisible">
      <n-grid cols="24" item-responsive>
        <n-grid-item :span="6">
          <n-select
            v-model:value="activeModelSource"
            :options="modelSource"
            :consistent-menu-width="false"
          >
          </n-select>
        </n-grid-item>
        <n-grid-item :span="18">
          <n-input></n-input>
        </n-grid-item>
      </n-grid>
    </div>
    <template #trigger>
      <n-text strong class="model-active" @click="isModelSelectMenuVisible = true">
        <span class="active-model">
          {{ activeModel }}
        </span>
        <span class="meta-icon">↓</span>
      </n-text>
    </template>
  </n-popover>
</template>
<script setup lang="ts">
import type { SelectOption } from "naive-ui";
import { ref } from "vue";

const activeModel = ref("默认模型");

const isModelSelectMenuVisible = ref(false);

const activeModelSource = ref("all");
const modelSource = ref<SelectOption[]>([
  {
    label: "所有源",
    value: "all",
  },
]);
</script>
