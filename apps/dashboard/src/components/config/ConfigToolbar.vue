<script setup lang="ts">
import { ref } from "vue";
import { icon } from "@/components/shared/icons";
import ProfileSwitcher from "./ProfileSwitcher.vue";

/**
 * 工作台顶部工具条：左边「改的是哪一份档」，右边搜索（AstrBot 的 `config-toolbar`）。
 *
 * 搜索框默认收起：常驻一个输入框会占掉顶栏最值钱的那段宽度（375 视口下档名与搜索框
 * 加在一起会互相挤），而它每天用不了几次。
 */
const props = defineProps<{ current: string | null; dirty: boolean }>();
const emit = defineEmits<{
  (e: "switch", id: string): void;
  (e: "manage"): void;
  (e: "update:keyword", value: string): void;
}>();

const keyword = ref("");
const searchOpen = ref(false);
const SearchIcon = icon("search");

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value && keyword.value !== "") {
    keyword.value = "";
    emit("update:keyword", "");
  }
}

function onInput(value: string): void {
  keyword.value = value;
  emit("update:keyword", value);
}
</script>

<template>
  <div
    class="atri-config-toolbar flex min-h-[3.5rem] items-center gap-3 border-b-1 border-line bg-surface px-4 py-2"
  >
    <ProfileSwitcher
      :current="props.current"
      :dirty="props.dirty"
      @switch="(id) => emit('switch', id)"
      @manage="emit('manage')"
    />
    <span class="hidden text-ink-faint md:block">/</span>
    <span class="hidden text-13px font-medium text-ink-muted md:block">配置文件</span>

    <div class="ml-auto flex items-center gap-1">
      <n-input
        v-if="searchOpen"
        :value="keyword"
        size="small"
        clearable
        placeholder="搜索当前分类"
        class="w-[9rem] sm:w-[13rem]"
        @update:value="onInput"
      />
      <n-button
        quaternary
        size="small"
        :aria-label="searchOpen ? '收起搜索' : '搜索配置项'"
        :title="searchOpen ? '收起搜索' : '搜索配置项'"
        @click="toggleSearch"
      >
        <template #icon><component :is="SearchIcon" /></template>
      </n-button>
    </div>
  </div>
</template>
