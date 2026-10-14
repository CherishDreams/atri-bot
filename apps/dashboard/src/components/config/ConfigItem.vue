<script setup lang="ts">
/**
 * 一行配置项：左边「名称 + 说明」，右边控件（AstrBot 的 `config-row` 那一层）。
 *
 * 窄屏**刻意改成上下两段**而不是继续并排：bot 布局的侧栏固定 232px
 * （`theme/tokens.ts` 的 `navW`），375 视口下内容列只剩 143px —— 三个子项并排会把
 * 卡片压成一条 95×875 的东西（`views/ToolsView.vue` 里记着这次实测）。
 *
 * 控件放在 `#control` 槽里而不是收成一个 `v-model`：这一行的控件种类不止一种
 *（开关、下拉、数字、只读标签），而「草稿 vs 已生效」的语义各面板自己清楚。
 */
defineProps<{
  label: string;
  /** 项级说明。工具与插件用它承载服务端返回的 `description`，不另抄一份。 */
  hint?: string;
  /** 磁盘上那个真实的键（工具 id / provider 实例 id 等），等宽显示以便对照配置文件。 */
  code?: string;
  /** 这一项相对「已生效值」是否被改过（草稿与磁盘不同）。 */
  dirty?: boolean;
}>();
</script>

<template>
  <div
    class="flex flex-col gap-2 border-t-1 border-line py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:gap-3"
  >
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate font-medium text-ink">{{ label }}</span>
        <!-- 脏标记不是装饰：整页只有一个「保存」键时，用户必须能看出**哪几项**还没落盘，
             否则「保存」按钮亮着而改动藏在别的分类里，那是另一种形式的静默。 -->
        <span
          v-if="dirty"
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          title="这一项改过，还没保存"
        ></span>
      </div>
      <div v-if="code" class="truncate text-xs text-ink-faint">{{ code }}</div>
      <p v-if="hint" class="mt-1 mb-0 text-xs leading-relaxed text-ink-muted">{{ hint }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="control" />
    </div>
  </div>
</template>
