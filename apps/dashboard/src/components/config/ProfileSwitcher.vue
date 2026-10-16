<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProfileRecord } from "@atri/shared";
import { useProfilesStore } from "@/stores/profiles";
import { icon } from "@/components/shared/icons";

/**
 * 左上角的配置档切换器（AstrBot 的 `ConfigProfileMenu`）。
 *
 * 按钮上显示**当前档的显示名** —— 这是用户进来的第一眼要知道的事：这一页改的是谁。
 * 它不存「当前档」：值从 URL 推出来（`useProfile`），点选之后由父组件改 query，
 * 于是刷新、前进后退、深链四条入口一致。
 *
 * 用 `n-popover` + 自绘列表而不是 `n-dropdown`：后者要给每个选项套 render 函数，
 * 把「选中打勾」和「失败档不可选」塞进 `render` 里，而自动导入的 naive-ui 组件属性
 * **不受 vue-tsc 校验**（属性名写错只会静默不生效）；并且这里需要一个搜索框 ——
 * `n-dropdown` 的触发元素是默认插槽，塞输入框会把点击触发搅乱。
 */
const props = defineProps<{
  current: string | null;
  /** 当前这份档有没保存的改动：切换要由父组件拦一道。 */
  dirty: boolean;
}>();
const emit = defineEmits<{
  (e: "switch", id: string): void;
  (e: "manage"): void;
}>();

const profiles = useProfilesStore();
const open = ref(false);
const keyword = ref("");
const CheckIcon = icon("check");
const ChevronIcon = icon("chevronDown");

watch(open, (v) => {
  if (v) keyword.value = "";
});

const currentName = computed(() => {
  const row = profiles.profiles.find((p) => p.id === props.current);
  return row?.name ?? props.current ?? "选择配置";
});

const filtered = computed<ProfileRecord[]>(() => {
  const needle = keyword.value.trim().toLowerCase();
  if (!needle) return profiles.profiles;
  return profiles.profiles.filter(
    (p) => p.name.toLowerCase().includes(needle) || p.id.includes(needle),
  );
});

function pick(row: ProfileRecord): void {
  if (row.id === props.current) {
    open.value = false;
    return;
  }
  open.value = false;
  emit("switch", row.id);
}

function manage(): void {
  open.value = false;
  emit("manage");
}
</script>

<template>
  <n-popover v-model:show="open" trigger="click" placement="bottom-start" raw>
    <div class="rounded-lg border-1 border-line bg-surface p-2 shadow-lg">
      <n-input
        v-if="profiles.profiles.length > 5"
        v-model:value="keyword"
        size="small"
        clearable
        placeholder="搜索配置"
      />
      <div class="mt-1 max-h-[16rem] overflow-y-auto">
        <button
          v-for="row in filtered"
          :key="row.id"
          type="button"
          class="row-base flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="row.status !== 'ready'"
          :aria-current="row.id === current ? 'true' : undefined"
          @click="pick(row)"
        >
          <span class="min-w-0">
            <span class="block truncate text-sm text-ink">{{ row.name }}</span>
            <span class="block truncate text-xs text-ink-faint">
              {{ row.id }}<template v-if="row.status !== 'ready'"> · 加载失败，不可切换</template>
            </span>
          </span>
          <span v-if="row.id === current" class="shrink-0 text-primary">
            <component :is="CheckIcon" />
          </span>
        </button>
        <p v-if="filtered.length === 0" class="px-2 py-3 text-sm text-ink-muted">没有匹配的配置</p>
      </div>
      <n-divider class="my-2!" />
      <button
        type="button"
        class="row-base flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        @click="manage"
      >
        <component :is="icon('settings')" />
        管理配置…
      </button>
    </div>

    <template #trigger>
      <button
        type="button"
        class="atri-profile-switcher flex min-w-0 max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-lg border-1 border-line bg-raised px-2 py-1.5 text-left transition-colors hover:bg-tint"
        :title="dirty ? '有未保存的改动' : `当前配置：${currentName}`"
      >
        <!-- 脏点：切换器是「我改的是谁」的锚点，未保存时它也得能看出来。 -->
        <span v-if="dirty" class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"></span>
        <span class="truncate text-sm font-bold text-ink">{{ currentName }}</span>
        <span class="shrink-0 text-ink-faint"><component :is="ChevronIcon" /></span>
      </button>
    </template>
  </n-popover>
</template>
