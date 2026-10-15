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
 * 窄屏变成一条**可换行**的横向 chip 行：bot 布局的侧栏在 ≤768px 已经收进抽屉，
 * 再竖着排一列分类会把内容区挤没（375 视口下连一个开关都放不下）。
 *
 * 这里曾经是 `overflow-x-auto` 的单行：六项合计约 558px，375 视口下「供应商」「接入端」
 * 两个 chip 落在屏幕外，而手机上没有可见的滚动条提示 —— 等于点不到。改成换行后
 * 两组各占一行（组标签在窄屏本就隐藏），代价是多出约 20px 高。
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

/**
 * 一条分类的类名。
 *
 * `sm:w-full` 不是排版偏好，是**实测出来的必需**：竖排（sm 起）时按钮不会被撑开 ——
 * 1280 视口下侧栏内容宽 184px，条目只有 74–100px，长短随文字走，选中底色也就成了
 * 一小块参差的药丸（「菜单长度不一」）。横向 chip 行（<sm）**不能**加它：
 * 那里父级是 `flex` + `shrink-0`，`w-full` 会让每个 chip 各占满整行。
 *
 * 窄屏的 `px-2` 也是量出来的：`px-3` 时四个档级 chip 合计 360px，而 375 视口的内宽
 * 只有 359px —— 差 1px 就换行，会单独掉下来一个「运行参数」。
 *
 * `cursor-pointer`：`<button>` 在浏览器里默认是箭头（实测 `cursor: default`），
 * 本仓其余可点行（`row-base`）都显式写了它，这里漏了。
 */
function buttonClass(category: Category, active: string, matched: boolean): string[] {
  const isActive = category.key === active;
  return [
    "atri-category-item flex shrink-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors sm:w-full sm:px-3",
    isActive
      ? "bg-primary-soft font-medium text-primary"
      : "text-ink-muted hover:bg-tint hover:text-ink",
    matched ? "" : "opacity-50",
  ].filter(Boolean) as string[];
}
</script>

<template>
  <nav
    class="atri-category-nav flex shrink-0 flex-wrap gap-1 border-b-1 border-line bg-surface p-2 sm:block sm:w-[13rem] sm:border-b-0 sm:border-r-1 sm:p-3"
    aria-label="配置分类"
  >
    <div
      v-for="group in groups"
      :key="group.key"
      class="flex w-full flex-wrap gap-1 sm:mb-4 sm:block"
    >
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
