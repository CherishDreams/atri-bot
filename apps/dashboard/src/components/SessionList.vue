<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();

async function onNew(): Promise<void> {
  await sessions.create();
}
</script>

<template>
  <aside class="flex flex-col gap-2 overflow-hidden border-r-1 border-line bg-surface p-3">
    <div class="flex items-center justify-between">
      <strong class="text-ink">atri-bot</strong>
      <button class="btn-ghost" type="button" title="新建会话" aria-label="新建会话" @click="onNew">
        +
      </button>
    </div>

    <ul class="m-0 flex-1 list-none overflow-y-auto p-0">
      <li
        v-for="s in sessions.sessions"
        :key="s.id"
        class="row-base cursor-pointer px-2 py-1.5 text-ink-muted hover:text-ink"
        :class="s.id === sessions.active?.id ? 'row-active' : ''"
        @click="sessions.select(s)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>
