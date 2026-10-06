<template>
  <n-popover
    v-model:show="visible"
    trigger="click"
    placement="bottom"
    animated
    class="model-select-menu"
  >
    <div class="model-select-menu-container w-[20rem]">
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

      <div class="max-h-[18rem] overflow-y-auto">
        <button
          type="button"
          class="row-base flex w-full items-center justify-between gap-2 px-2 py-1 text-left"
          @click="choose(null)"
        >
          <span>默认模型</span>
          <!-- 图标工厂是无函数组件，class 传不进去（会被 props 忽略），
               所以外层套一个 span 上色——svg 用的是 currentColor，跟着继承。 -->
          <span v-if="providers.selection === null" class="shrink-0 text-primary">
            <component :is="CheckIcon" />
          </span>
        </button>

        <div v-if="filtered.length === 0" class="px-2 py-3 text-sm text-ink-muted">
          <span v-if="providers.choices.length === 0">
            还没有可用的模型，先去「供应商配置」添加并启用
          </span>
          <span v-else>没有匹配的模型</span>
        </div>

        <button
          v-for="choice in filtered"
          :key="choice.providerId"
          type="button"
          class="row-base flex w-full items-center justify-between gap-2 px-2 py-1 text-left"
          @click="choose(choice)"
        >
          <span class="min-w-0">
            <span class="block truncate">{{ choice.model }}</span>
            <span class="block truncate text-xs text-ink-faint">
              {{ choice.source }} · {{ choice.type }}
            </span>
          </span>
          <span v-if="providers.selection?.model === choice.model" class="shrink-0 text-primary">
            <component :is="CheckIcon" />
          </span>
        </button>
      </div>
    </div>

    <template #trigger>
      <!--
        模型名必须**可截断**：这个触发器原先没有宽度上限，窄屏下被压成 34×84 ——
        文字换行撑出 84px 高，把 60px 的顶栏上下顶穿（`--atri-header-h` 是它自己的高度，
        容器不会跟着长）。`min-w-0` + `max-w-[…]` + `truncate` 三条是一套，缺一条就退回
        「要么不换行要么还是撑高」；箭头 `shrink-0`，否则它先被压扁。
      -->
      <n-text
        strong
        class="model-active flex min-w-0 cursor-pointer select-none items-center gap-1"
      >
        <span
          class="active-model max-w-[8rem] truncate max-[480px]:max-w-[5rem] md:max-w-[16rem]"
          >{{ providers.activeModel }}</span
        >
        <span class="shrink-0 text-ink-faint"><component :is="ChevronIcon" /></span>
      </n-text>
    </template>
  </n-popover>
</template>

<script setup lang="ts">
import { useProvidersStore, type ModelChoice } from "@/stores/providers";
import { useProfile } from "@/composables/useProfile";
import type { SelectOption } from "naive-ui";
import { computed, ref, watch } from "vue";
import { icon } from "./icons.js";

const CheckIcon = icon("check");
const ChevronIcon = icon("chevronDown");

const providers = useProvidersStore();
// 这个下拉只在配置档闸门**之内**渲染（顶栏跟着页面走），所以 null 只可能是直接深链进来、
// 还没选档的那一刻 —— 那种时候它既不初始化也不写选择，而不是替用户猜一份档。
const { profile } = useProfile();

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
  if (profile.value !== null) void providers.init(profile.value);
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
  // 记的是**实例 id**，不是模型名：`ProviderRegistry.#resolveFor` 的第一级选路按实例 id，
  // 而模型名不再跨配置档唯一（两份档都可以有 deepseek-chat）。
  if (profile.value === null) return;
  providers.selectModel(profile.value, choice?.providerId ?? null, choice?.model ?? null);
  visible.value = false;
}

/*
 * 顶栏上就显示着当前模型名，所以得有数据，不能等用户点开才拉。
 *
 * 用 `watch(profile, …, { immediate: true })` 而不是 `onMounted`：chat 侧的配置档闸门
 * （`ChatLayout` 里的 `ProfileGate`）在没选档时先渲染选择器，用户选完那一刻 profile 才从
 * null 变成有值 —— 只挂 onMounted 的话，这一处会在 profile 仍为 null 时白跑一次，
 * 顶栏随后一直空着，要等用户点开下拉才刷新。
 */
watch(
  profile,
  (pid) => {
    if (pid !== null) void providers.init(pid);
  },
  { immediate: true },
);
</script>
