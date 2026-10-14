<script setup lang="ts">
import { computed } from "vue";
import { icon } from "@/components/shared/icons";
import type { Category } from "./categories";
import { GLOBAL_CATEGORIES, PROFILE_CATEGORIES } from "./categories";

/**
 * 左侧分类菜单：**分两组**（这一档 / 全局）。
 *
 * 分组不是排版偏好，而是本仓的一条真界：供应商里是密钥与端点（部署级，改一次每档生效），
 * 工具/插件/步数/档默认属于那一跑法。混成一个平铺列表，症状是有人以为「在这一档改了
 * 供应商，另一档不受影响」—— 而它立刻就生效到了所有档上。
 *
 * 窄屏变成一条横向可滚的 chip 行：bot 布局的侧栏在 ≤768px 已经收进抽屉，
 * 再竖着排一列分类会把内容区挤没（375 视口下连一个开关都放不下）。
 */
defineProps<{
  active: string;
  /** 搜索词非空时，把没有命中的分类标灰 —— 点进去会是空的。 */
  matched: Record<string, boolean>;
}>();
const emit = defineEmits<{ (e: "select", key: string): void }>();

const groups = computed(() => [
  { key: "profile", label: "本配置档", items: PROFILE_CATEGORIES },
  { key: "global", label: "全局", items: GLOBAL_CATEGORIES },
]);

function buttonClass(category: Category, active: string, matched: boolean): string[] {
  const isActive = category.key === active;
  return [
    "atri-category-item flex shrink-0 items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors",
    isActive
      ? "bg-primary-soft font-medium text-primary"
      : "text-ink-muted hover:bg-tint hover:text-ink",
    matched ? "" : "opacity-50",
  ].filter(Boolean) as string[];
}
</script>

<template>
  <nav
    class="atri-category-nav flex shrink-0 gap-1 overflow-x-auto border-b-1 border-line bg-surface p-2 sm:block sm:w-[13rem] sm:overflow-visible sm:border-b-0 sm:border-r-1 sm:p-3"
    aria-label="配置分类"
  >
    <div v-for="group in groups" :key="group.key" class="flex shrink-0 gap-1 sm:mb-4 sm:block">
      <div class="hidden px-3 pb-1 text-xs font-medium text-ink-faint sm:block">
        {{ group.label }}
      </div>
      <button
        v-for="category in group.items"
        :key="category.key"
        type="button"
        :class="buttonClass(category, active, matched[category.key] !== false)"
        :aria-current="category.key === active ? 'page' : undefined"
        :title="category.hint"
        @click="emit('select', category.key)"
      >
        <component :is="icon(category.icon)" />
        <span class="whitespace-nowrap">{{ category.label }}</span>
      </button>
    </div>
  </nav>
</template>
