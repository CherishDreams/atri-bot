<script setup lang="ts">
import { icon } from "@/components/shared/icons";
import type { Category } from "./categories";
import { CATEGORIES } from "./categories";

/**
 * 左侧分类菜单：**一份平铺列表，只装本配置档的五类**。
 *
 * 人格库与计划任务不在这里，也不是「另一组」—— 它们是主导航里的独立整页：
 * 前者是全局内容资产，后者是部署级调度，都不属于某一份档。访问控制反过来，
 * 它的名单按档保存、绑定到这一档的适配器共用，所以留在这张表里。
 *
 * 窄屏变成一条**可换行**的横向 chip 行：bot 布局的侧栏在 ≤768px 已经收进抽屉，
 * 再竖着排一列分类会把内容区挤没（375 视口下连一个开关都放不下）。
 *
 * 这里曾经是 `overflow-x-auto` 的单行：几项合计超过视口宽，末尾 chip 落在屏幕外，
 * 而手机上没有任何滚动条提示 —— 等于点不到。现在一律换行，不做横向滚动。
 */
defineProps<{
  active: string;
  /** 搜索词非空时，把没有命中的分类标灰 —— 点进去会是空的。 */
  matched: Record<string, boolean>;
}>();
const emit = defineEmits<{ (e: "select", key: string): void }>();

/**
 * 一条分类的类名。
 *
 * `sm:w-full` 不是排版偏好，是**实测出来的必需**：竖排（sm 起）时按钮不会被撑开 ——
 * 1280 视口下侧栏内容宽 184px，条目的宽度若随文字走，选中底色就成了参差的药丸。
 * 横向 chip 行（<sm）**不能**加它：那里父级是 `flex` + `shrink-0`，`w-full` 会让
 * 每个 chip 各占满整行。
 *
 * `cursor-pointer`：`<button>` 在浏览器里默认是箭头（实测 `cursor: default`），
 * 本仓其余可点行（`row-base`）都显式写了它，这里漏了。
 */
function buttonClass(category: Category, active: string, matched: boolean): string[] {
  const isActive = category.key === active;
  return [
    "atri-category-item flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors sm:w-full sm:rounded-l-none sm:border-l-2 sm:px-3",
    isActive
      ? "bg-primary-soft font-medium text-primary sm:border-primary"
      : "text-ink-muted hover:bg-tint hover:text-ink sm:border-transparent",
    matched ? "" : "opacity-50",
  ].filter(Boolean) as string[];
}
</script>

<template>
  <nav
    class="atri-category-nav flex shrink-0 flex-wrap gap-1 border-b-1 border-line bg-surface p-2 sm:block sm:w-[13rem] sm:border-r-1 sm:border-b-0 sm:px-3 sm:py-4"
    aria-label="配置分类"
  >
    <button
      v-for="category in CATEGORIES"
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
  </nav>
</template>
