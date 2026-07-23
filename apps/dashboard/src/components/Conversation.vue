<script setup lang="ts">
import { ref } from "vue";
import MessageList from "./shared/MessageList.vue";
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
const draft = ref("");

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
      <!--
        与 chat 会话页共用同一套气泡。以前这页是「角色名 + 一行正文」的纯文本流，
        整屏同色同缩进，只能靠「用户 / 助手」四个字辨别发送方。

        loading 传 sessions.loading：切会话要再发一次 GET /sessions/:id 才有历史，
        那个值一直被 open() 设值却无人读。
      -->
      <message-list
        :messages="sessions.log"
        :streaming-id="sessions.streamingId"
        :loading="sessions.loading"
      />
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
