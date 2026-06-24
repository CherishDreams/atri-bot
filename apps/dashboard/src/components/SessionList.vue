<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();

async function onNew(): Promise<void> {
  await sessions.create();
}
</script>

<template>
  <aside class="edge-line flex flex-col gap-2 overflow-hidden border-r bg-panel p-3">
    <div class="flex items-center justify-between">
      <strong class="text-fg">atri-bot</strong>
      <button class="btn-ghost" type="button" title="新建会话" @click="onNew">+</button>
    </div>

    <ul class="m-0 flex-1 list-none overflow-y-auto p-0">
      <li
        v-for="s in sessions.sessions"
        :key="s.id"
        class="cursor-pointer rounded-md px-2 py-1.5 text-muted hover:bg-[#222836] hover:text-fg"
        :class="s.id === sessions.active?.id ? 'bg-[#222836] text-fg' : ''"
        @click="sessions.select(s)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>
