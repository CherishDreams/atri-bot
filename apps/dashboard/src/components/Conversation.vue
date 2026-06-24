<script setup lang="ts">
import { ref } from "vue";
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
      <div v-for="m in sessions.log" :key="m.id" class="mb-2 break-words whitespace-pre-wrap">
        <b :class="m.role === 'user' ? 'text-accent' : 'text-[#5ed6a4]'">{{ m.role }}</b
        >: {{ m.content }}
      </div>
    </div>

    <form class="edge-line flex gap-2 border-t p-3" @submit.prevent="onSend">
      <input
        v-model="draft"
        class="flex-1 rounded-lg border border-[#2b3040] bg-panel px-2.5 py-2 text-fg outline-none"
        placeholder="输入消息…"
        autocomplete="off"
      />
      <button
        class="rounded-lg border border-[#2b3040] bg-accent px-3.5 py-2 text-white disabled:opacity-60"
        type="submit"
        :disabled="sessions.sending"
      >
        发送
      </button>
    </form>
  </main>
</template>
