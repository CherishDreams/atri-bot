<script setup lang="ts">
import { computed } from "vue";
import type { Role } from "@/api/generated/index.js";
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
  /** 这条还是没有内容的流式草稿 —— 显示占位而不是一个空气泡。 */
  pending?: boolean;
}>();

const isUser = computed(() => props.role === "user");

/**
 * 线协议里的 role 是英文（`user` / `assistant`），直接显示会在整片中文界面里
 * 露出两个英文单词。`system` / `tool` 目前没有对应的气泡分支，落到原始值，
 * 将来接上时在这里补名字即可。
 */
const ROLE_LABELS: Partial<Record<Role, string>> = { user: "用户", assistant: "助手" };
const label = computed(() => ROLE_LABELS[props.role] ?? props.role);
</script>

<template>
  <div class="mb-3 flex flex-col" :class="isUser ? 'items-end' : 'items-start'">
    <span class="mb-1 text-xs text-ink-faint">{{ label }}</span>

    <!--
      三条分支必须留在同一条 v-if / v-else-if / v-else 链上：
      拆成两个独立 v-if 会让有内容的助手消息渲染两遍。

      send() 会先往 log 里 push 一条空 content 的助手草稿。以前这里既渲染那个
      空气泡、又在旁边单独挂一行「正在输入…」，两个东西占一个位置；现在合并成一条，
      并且只认 pending（由 streamingId 精确判定），否则 content 恰好为空的
      最终消息会永远挂着「正在输入…」。
    -->
    <div
      v-if="pending"
      class="max-w-[85%] rounded-lg border-1 border-line bg-surface px-3 py-2 text-sm text-ink-faint"
      aria-live="polite"
    >
      正在输入…
    </div>
    <!--
      助手气泡底色必须是 surface：MarkdownView 里的行内代码与代码块用 raised，
      气泡也是 raised 的话代码记号就完全看不见。
    -->
    <markdown-view
      v-else-if="!isUser"
      :content="content"
      class="max-w-[85%] rounded-lg border-1 border-line bg-surface px-3 py-2 text-sm text-ink"
    />
    <!-- 用户侧保持纯文本 + pre-wrap：把输入里的 * 与 _ 当强调符号解析会排错版。 -->
    <div
      v-else
      class="max-w-[85%] rounded-lg bg-primary-soft px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink"
    >
      {{ content }}
    </div>
  </div>
</template>
