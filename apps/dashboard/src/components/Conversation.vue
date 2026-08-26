<script setup lang="ts">
import { nextTick, ref } from "vue";
import MessageList from "./shared/MessageList.vue";
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
const draft = ref("");
const scrollBox = ref<HTMLElement | null>(null);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = "";
  await sessions.send(text);
}

/**
 * 取更早的一页并钉回用户正在看的那条 —— 与 `views/chat/ChatSessionView.vue` 里那份
 * 逐字相同。两份各写是刻意的：本仓对提前抽象的态度写在 AGENTS.md 的测试一节，
 * 而这段只有 8 行、无分支、无状态，漂不出 bug；会漂出 bug 的是游标那 5 行，
 * 它已经在 store 里只有一份了。改一处记得改另一处。
 */
async function onLoadEarlier(): Promise<void> {
  const el = scrollBox.value;
  if (!el) return;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  const added = await sessions.loadEarlier();
  if (added === 0) return;
  await nextTick();
  el.scrollTop = el.scrollHeight - prevHeight + prevTop;
}
</script>

<template>
  <main class="flex min-w-0 flex-col">
    <div ref="scrollBox" class="flex-1 overflow-y-auto p-4">
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
        :has-more="sessions.hasMoreMessages"
        :loading-earlier="sessions.loadingEarlier"
        @load-earlier="onLoadEarlier"
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
