<script setup lang="ts">
import type { Message } from "@/api/generated/index.js";
import MessageBubble from "./MessageBubble.vue";

/**
 * 一串气泡，外加加载与空态。bot 控制台与 chat 会话页共用。
 *
 * 只负责「列表本身」，滚动容器留在调用方：会话页要拿 `ref` 操作 scrollTop
 * 做流式跟随，把滚动条封进这里就得再多一层 ref 透传，不划算。
 */
defineProps<{
  messages: Message[];
  /** 正在流式接收的消息 id，用来把空草稿渲染成「正在输入…」。 */
  streamingId?: string | null;
  loading?: boolean;
  emptyText?: string;
}>();
</script>

<template>
  <!-- 历史较长时不给反馈，点击看起来像没生效。 -->
  <p v-if="loading" class="m-0 py-8 text-center text-xs text-ink-muted">加载中…</p>
  <p v-else-if="messages.length === 0" class="m-0 py-8 text-center text-xs text-ink-muted">
    {{ emptyText ?? "还没有消息，说点什么吧。" }}
  </p>

  <message-bubble
    v-for="m in messages"
    :key="m.id"
    :role="m.role"
    :content="m.content"
    :pending="m.id === streamingId && !m.content"
  />
</template>
