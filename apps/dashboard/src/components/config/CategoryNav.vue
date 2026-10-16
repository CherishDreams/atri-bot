<script setup lang="ts">
import { icon } from "@/components/shared/icons";
import type { Category } from "./categories";
import { CATEGORIES } from "./categories";

/**
 * 左侧分类菜单：**一份平铺列表**，只装本配置档的三类。
 *
 * 供应商与接入平台不在这里，也不是「另一组」—— 它们是部署级全局一份，各自是主导航里的
 * 整页。曾经把两者塞进本菜单的「全局」分组，症状是左上角写着当前档名，而那一项改的
 * 东西立刻影响所有档；分组标签挡不住这种误读，只有「它不在这一页」能挡住。
 *
 * 窄屏变成一条**可换行**的横向 chip 行：bot 布局的侧栏在 ≤768px 已经收进抽屉，
 * 再竖着排一列分类会把内容区挤没（375 视口下连一个开关都放不下）。
 *
 * 这里曾经是 `overflow-x-auto` 的单行：六项合计约 558px，375 视口下末尾两个 chip
 * 落在屏幕外，而手机上没有任何滚动条提示 —— 等于点不到。改成换行后按顺序折成两行。
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
 * 1280 视口下侧栏内容宽 184px，条目只有 74–100px，长短随文字走，选中底色也就成了
 * 一小块参差的药丸（「菜单长度不一」）。横向 chip 行（<sm）**不能**加它：
 * 那里父级是 `flex` + `shrink-0`，`w-full` 会让每个 chip 各占满整行。
 *
 * 窄屏的 `px-2` 是上一版量出来的：四个档级 chip 在 `px-3` 下合计 360px，而 375 视口
 * 的内宽只有 359px —— 差 1px 就换行，会单独掉下来一个「运行参数」。插件分类搬到
 * `/plugins` 之后只剩三个 chip，余量更宽了，但内边距不跟着放大：留着它是为了下次
 * 再加分类时不必先撞一次换行。
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
    class="atri-category-nav flex shrink-0 flex-wrap gap-1 border-b-1 border-line bg-surface p-2 sm:block sm:w-[13rem] sm:border-b-0 sm:border-r-1 sm:px-3 sm:py-4"
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
