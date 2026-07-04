<template>
  <n-popover
    v-model:show="visible"
    trigger="click"
    placement="bottom"
    animated
    class="model-select-menu"
  >
    <div class="model-select-menu-container w-80">
      <n-grid cols="24" item-responsive>
        <n-grid-item :span="8">
          <n-select
            v-model:value="sourceFilter"
            :options="sourceOptions"
            :consistent-menu-width="false"
          />
        </n-grid-item>
        <n-grid-item :span="16">
          <n-input v-model:value="keyword" clearable placeholder="搜索模型" />
        </n-grid-item>
      </n-grid>
      <n-divider class="my-2!" />

      <div class="max-h-72 overflow-auto">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left hover:bg-#00000010"
          @click="choose(null)"
        >
          <span>默认模型</span>
          <span v-if="providers.selection === null">✓</span>
        </button>

        <div v-if="filtered.length === 0" class="px-2 py-3 text-sm text-#888">
          <span v-if="providers.choices.length === 0">
            还没有可用的模型，先去「供应商配置」添加并启用
          </span>
          <span v-else>没有匹配的模型</span>
        </div>

        <button
          v-for="choice in filtered"
          :key="choice.providerId"
          type="button"
          class="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left hover:bg-#00000010"
          @click="choose(choice)"
        >
          <span class="min-w-0">
            <span class="block truncate">{{ choice.model }}</span>
            <span class="block truncate text-xs text-#999">
              {{ choice.source }} · {{ choice.type }}
            </span>
          </span>
          <span v-if="providers.selection?.model === choice.model">✓</span>
        </button>
      </div>
    </div>

    <template #trigger>
      <n-text strong class="model-active cursor-pointer select-none">
        <span class="active-model">{{ providers.activeModel }}</span>
        <span class="meta-icon">↓</span>
      </n-text>
    </template>
  </n-popover>
</template>

<script setup lang="ts">
import { useProvidersStore, type ModelChoice } from "@/stores/providers";
import type { SelectOption } from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";

const providers = useProvidersStore();

const visible = ref(false);
const keyword = ref("");
const sourceFilter = ref("all");

/**
 * 每次打开都重拉一次配置。
 *
 * 模型列表可能在别的标签页或另一个人的会话里被改过；这个下拉是发消息前的
 * 最后一道选择，拿一份过期列表比多一次 GET 更糟。
 */
watch(visible, (open) => {
  if (!open) return;
  keyword.value = "";
  sourceFilter.value = "all";
  void providers.init();
});

const sourceOptions = computed<SelectOption[]>(() => {
  const ids = [...new Set(providers.choices.map((c) => c.source))].toSorted();
  return [{ label: "所有源", value: "all" }, ...ids.map((id) => ({ label: id, value: id }))];
});

const filtered = computed<ModelChoice[]>(() => {
  const needle = keyword.value.trim().toLowerCase();
  return providers.choices.filter((c) => {
    if (sourceFilter.value !== "all" && c.source !== sourceFilter.value) return false;
    if (!needle) return true;
    return c.model.toLowerCase().includes(needle) || c.source.toLowerCase().includes(needle);
  });
});

function choose(choice: ModelChoice | null): void {
  providers.selectModel(choice?.model ?? null, choice?.source ?? null);
  visible.value = false;
}

// 顶栏上就显示着当前模型名，所以挂载时就得有数据，不能等用户点开才拉。
onMounted(() => {
  void providers.init();
});
</script>
