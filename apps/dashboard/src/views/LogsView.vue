<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useLogsStore } from "@/stores/logs";

/**
 * 日志页：最近 500 行 + SSE 实时追加。
 *
 * 「实时滚动」不是无条件把滚动条拽到底：用户往回翻看时强行拉回底部，等于让人
 * 永远读不了上一屏。判据是**此刻是否停在底部** —— 在底部就跟着新日志走，翻上去就
 * 停住并露出「回到最新」。这也是浏览器控制台、`docker logs -f` 一类工具的共同做法。
 *
 * 过滤与清空都只作用于**当前页面**：服务端缓冲区与续传水位由 store 保留，
 * 清空之后新日志继续出现，重连也不会把刚清掉的行拉回来。
 */
const logs = useLogsStore();

const LEVEL_OPTIONS = [
  { value: "debug", label: "调试" },
  { value: "info", label: "信息" },
  { value: "warn", label: "警告" },
  { value: "error", label: "错误" },
];

const levels = ref<string[]>(LEVEL_OPTIONS.map((option) => option.value));
const visible = computed(() => logs.entries.filter((entry) => levels.value.includes(entry.level)));

const scrollEl = ref<HTMLElement | null>(null);
const follow = ref(true);

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  // 24px 的余量：行高取整、缩放与最后一行的边框都会让 scrollTop 差一两像素。
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
}

function jumpToLatest(): void {
  follow.value = true;
  void scrollToBottom();
}

function clear(): void {
  logs.clear();
  follow.value = true;
}

watch(
  () => visible.value.at(-1)?.id ?? 0,
  () => {
    if (follow.value) void scrollToBottom();
  },
);

onMounted(() => {
  void logs.start();
});

onBeforeUnmount(() => {
  logs.stop();
});

const connectionText = computed(() => {
  switch (logs.connection) {
    case "open":
      return "实时";
    case "retrying":
      return "重连中…";
    case "closed":
      return "已断开";
    default:
      return "连接中…";
  }
});

const connectionClass = computed(() =>
  logs.connection === "open"
    ? "text-success"
    : logs.connection === "closed"
      ? "text-danger"
      : "text-warning",
);

const connectionDot = computed(() =>
  logs.connection === "open"
    ? "bg-success"
    : logs.connection === "closed"
      ? "bg-danger"
      : "bg-warning",
);

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatTitle(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function levelClass(level: string): string {
  switch (level) {
    case "error":
      return "text-danger";
    case "warn":
      return "text-warning";
    case "debug":
      return "text-ink-faint";
    default:
      return "text-info";
  }
}
</script>

<template>
  <div class="atri-logs-view relative flex h-full min-h-0 flex-col bg-canvas">
    <header class="border-b-1 border-line bg-surface px-4 py-3 sm:px-6">
      <div class="mx-auto flex w-full max-w-[80rem] flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">日志</h2>
          <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
            服务端最近 500 行日志，实时推送。日志只存在内存里，服务重启即清空；这里显示的是当前
            <code class="text-xs">ATRI_LOG_LEVEL</code> 下的输出。
          </p>
        </div>
        <span class="ml-auto flex shrink-0 items-center gap-1.5 text-xs" :class="connectionClass">
          <span class="h-1.5 w-1.5 rounded-full" :class="connectionDot"></span>
          {{ connectionText }}
        </span>
      </div>
    </header>

    <div class="border-b-1 border-line bg-surface px-4 py-2 sm:px-6">
      <div class="mx-auto flex w-full max-w-[80rem] flex-wrap items-center gap-3">
        <n-checkbox-group v-model:value="levels" size="small">
          <n-checkbox
            v-for="option in LEVEL_OPTIONS"
            :key="option.value"
            :value="option.value"
            :label="option.label"
          />
        </n-checkbox-group>
        <span class="text-xs text-ink-faint"
          >{{ visible.length }} / {{ logs.entries.length }} 条</span
        >
        <div class="ml-auto flex items-center gap-2">
          <n-button size="small" quaternary title="只清空当前页面，不删除服务端日志" @click="clear">
            清空显示
          </n-button>
        </div>
      </div>
    </div>

    <div
      v-if="logs.error"
      class="border-b-1 border-line bg-warning/10 px-4 py-2 text-xs leading-relaxed text-warning sm:px-6"
    >
      <div class="mx-auto flex w-full max-w-[80rem] flex-wrap items-center gap-2">
        <span>{{ logs.error }}</span>
        <n-button v-if="logs.connection === 'closed'" size="tiny" @click="logs.retry()">
          重试
        </n-button>
      </div>
    </div>

    <div ref="scrollEl" class="atri-logs-scroll min-h-0 flex-1 overflow-y-auto" @scroll="onScroll">
      <div class="mx-auto w-full max-w-[80rem] px-3 py-3 sm:px-6">
        <n-empty v-if="visible.length === 0" description="当前过滤条件下没有日志" />
        <div v-else class="overflow-hidden rounded-lg border-1 border-line bg-surface">
          <div
            v-for="entry in visible"
            :key="entry.id"
            class="atri-log-line grid grid-cols-[auto_2.5rem_minmax(0,1fr)] items-start gap-2 border-b-1 border-line/60 px-3 py-1.5 font-mono text-xs last:border-b-0 hover:bg-tint/30"
          >
            <span class="text-ink-faint" :title="formatTitle(entry.time)">
              {{ formatTime(entry.time) }}
            </span>
            <span class="uppercase" :class="levelClass(entry.level)">{{ entry.level }}</span>
            <span class="min-w-0 whitespace-pre-wrap break-words text-ink">{{
              entry.message
            }}</span>
          </div>
        </div>
      </div>
    </div>

    <button
      v-if="!follow && visible.length > 0"
      type="button"
      class="btn-ghost absolute right-4 bottom-4 z-10 shadow-md"
      @click="jumpToLatest"
    >
      回到最新 ↓
    </button>
  </div>
</template>
