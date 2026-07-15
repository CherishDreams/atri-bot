<script setup lang="ts">
import { computed } from "vue";
import { useTheme } from "@/theme/mode";
import { icon } from "./icons.js";

/**
 * 顶栏的明暗切换。与平台切换、汉堡菜单并排，因此尺寸对齐 `--atri-control-h`
 * （32px，和汉堡按钮同一档），否则三个控件站在一起会高低不齐。
 *
 * 图标显示的是「点下去会变成什么」而不是「现在是什么」：
 * 深色态下画太阳，用户一眼就知道点完会转亮，这比画月亮更符合预期。
 */
const { scheme, toggle } = useTheme();

const isDark = computed(() => scheme.value === "dark");
const Icon = computed(() => icon(isDark.value ? "sun" : "moon"));
const label = computed(() => (isDark.value ? "切换到浅色主题" : "切换到深色主题"));
</script>

<template>
  <button
    class="grid h-[var(--atri-control-h)] w-[var(--atri-control-h)] cursor-pointer place-items-center rounded-md text-ink-muted transition-colors hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    type="button"
    :title="label"
    :aria-label="label"
    @click="toggle"
  >
    <component :is="Icon" />
  </button>
</template>
