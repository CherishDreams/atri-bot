<script setup lang="ts">
import { ref } from "vue";
import MarkdownView from "./shared/MarkdownView.vue";
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
const draft = ref("");

/** 与 ChatSessionView 同一套显示名；线协议里的 role 是英文。 */
const ROLE_LABELS: Record<string, string> = { user: "用户", assistant: "助手" };
function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = "";
  await sessions.send(text);
}
</script>

<template>
  <main class="flex min-w-0 flex-col">
    <div class="flex-1 overflow-y-auto p-4">
      <div v-for="m in sessions.log" :key="m.id" class="mb-3">
        <b :class="m.role === 'user' ? 'text-primary' : 'text-success'">{{ roleLabel(m.role) }}</b>
        <!--
          助手侧走 markdown，与 ChatSessionView 用的是同一个组件：
          两处若不一致，同一条回复在 bot 和 chat 两个平台会长得不一样。

          内容一律另起一行。原来写成 `</b>: {{ content }}`，那个冒号兼作分隔符；
          换成元素之后 Vue 的空白压缩会把行间的空白吃掉，用户消息实测连成
          「用户用 markdown …」。所以用户侧也从 inline 的 span 改成块级 div。
        -->
        <markdown-view v-if="m.role !== 'user'" :content="m.content" class="mt-1" />
        <div v-else class="mt-1 break-words whitespace-pre-wrap">{{ m.content }}</div>
      </div>
    </div>

    <form class="flex gap-2 border-t-1 border-line p-3" @submit.prevent="onSend">
      <input
        v-model="draft"
        class="min-w-0 flex-1 rounded-md border-1 border-line bg-raised px-2.5 py-2 text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary"
        placeholder="输入消息…"
        autocomplete="off"
      />
      <button
        class="cursor-pointer rounded-md bg-primary px-3.5 py-2 text-surface transition-colors hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
        type="submit"
        :disabled="sessions.sending"
      >
        发送
      </button>
    </form>
  </main>
</template>
