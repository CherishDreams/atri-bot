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
        <b :class="m.role === 'user' ? 'text-primary' : 'text-success'">{{ m.role }}</b
        >: {{ m.content }}
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
