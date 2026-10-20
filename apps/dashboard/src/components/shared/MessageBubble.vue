<script setup lang="ts">
import { computed } from "vue";
import type { MessageImage, Role, ToolCall } from "@/api/generated/index.js";
import MarkdownView from "./MarkdownView.vue";

/**
 * 单条消息的气泡。bot 控制台与 chat 会话页共用同一个组件——
 * 两处各写一份的话，同一条回复在两个平台会长得不一样（之前就是这样）。
 *
 * 三个维度共同标识发送方，任一单独看都够认：
 * 靠右 / 靠左的对齐、蓝色浅铺 vs 描边底色、以及气泡上方的角色名。
 */
const props = defineProps<{
  role: Role;
  content: string;
  /** 用户消息附带的图片。服务端存的是 base64，模板里换成 data URI。 */
  images?: MessageImage[];
  /** 这条还是没有内容的流式草稿 —— 显示占位而不是一个空气泡。 */
  pending?: boolean;
  /** 助手在这一轮要求执行的工具调用（`role === "assistant"` 时才可能有）。 */
  toolCalls?: ToolCall[];
}>();

const isUser = computed(() => props.role === "user");
const isTool = computed(() => props.role === "tool");
const imageSources = computed(() =>
  (props.images ?? []).map((image) => `data:${image.mediaType};base64,${image.data}`),
);

/**
 * 线协议里的 role 是英文（`user` / `assistant` / `tool`），直接显示会在整片中文界面里
 * 露出英文单词。`system` 目前没有对应的气泡分支，落到原始值，将来接上时在这里补名字即可。
 */
const ROLE_LABELS: Partial<Record<Role, string>> = {
  user: "用户",
  assistant: "助手",
  tool: "工具结果",
};
const label = computed(() => ROLE_LABELS[props.role] ?? props.role);
</script>

<template>
  <div class="mb-4 flex flex-col" :class="isUser ? 'items-end' : 'items-start'">
    <span class="mb-1 px-1 text-[11px] font-medium text-ink-faint">{{ label }}</span>

    <!--
      四条分支必须留在同一条 v-if / v-else-if / v-else 链上：
      拆成两个独立 v-if 会让有内容的助手消息渲染两遍。

      send() 会先往 log 里 push 一条空 content 的助手草稿。以前这里既渲染那个
      空气泡、又在旁边单独挂一行「正在输入…」，两个东西占一个位置；现在合并成一条，
      并且只认 pending（由 streamingId 精确判定），否则 content 恰好为空的
      最终消息会永远挂着「正在输入…」。
    -->
    <div
      v-if="pending"
      class="max-w-[85%] rounded-2xl rounded-bl-md border-1 border-line bg-surface px-3.5 py-2.5 text-sm text-ink-faint shadow-sm"
      aria-live="polite"
    >
      正在输入…
    </div>
    <!--
      工具结果**不走 MarkdownView**：它常常是一大坨 JSON，渲染成 markdown 既慢又难读
      （还会把结果里的 `*`、`_` 当强调符号排错版）。等宽 + 封顶滚动，读得清也撑不爆页面。
    -->
    <pre
      v-else-if="isTool"
      class="m-0 max-h-40 max-w-[85%] overflow-auto rounded-xl border-1 border-line bg-raised px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-muted"
      >{{ content }}</pre>
    <!-- 用户侧保持纯文本 + pre-wrap：把输入里的 * 与 _ 当强调符号解析会排错版。 -->
    <div
      v-else-if="isUser"
      class="flex max-w-[85%] flex-col gap-2 rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm break-words text-on-primary shadow-sm"
    >
      <!-- 图片与正文各占一段：纯图片消息的 content 为空，不能因此画出一个空气泡。 -->
      <img
        v-for="(src, index) in imageSources"
        :key="index"
        :src="src"
        :alt="`用户发送的图片 ${index + 1}`"
        data-message-image
        loading="lazy"
        class="max-h-72 max-w-full self-start rounded-lg object-contain"
      />
      <span v-if="content" class="whitespace-pre-wrap">{{ content }}</span>
    </div>
    <!--
      助手侧：正文仍是 markdown（底色必须是 surface —— 行内代码用 raised，
      气泡也是 raised 的话代码记号就完全看不见），工具调用另挂一条紧凑条块。
      纯工具调用那一轮的正文是空的，此时只画条块，不留一个空气泡。
    -->
    <div v-else class="flex max-w-[85%] flex-col gap-2">
      <markdown-view
        v-if="content"
        :content="content"
        class="rounded-2xl rounded-bl-md border-1 border-line bg-surface px-3.5 py-2.5 text-sm text-ink shadow-sm"
      />
      <div
        v-for="call in toolCalls ?? []"
        :key="call.id"
        class="rounded-xl border-1 border-line bg-surface px-3 py-2 shadow-sm"
      >
        <span class="text-xs font-medium text-ink">调用工具 {{ call.name }}</span>
        <pre
          class="m-0 mt-1 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-ink-muted"
          >{{ call.arguments || "{}" }}</pre>
      </div>
    </div>
  </div>
</template>
