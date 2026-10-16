<script setup lang="ts">
import { nextTick, ref } from "vue";
import MessageList from "./shared/MessageList.vue";
import { captureAnchor } from "./shared/scrollAnchor.js";
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
/**
 * 由 `ConsoleView` 在配置档闸门**之内**传入，所以它一定是非 null 的字符串。
 * 不在组件里 `useProfile()`：那会让「没选档」在这里变成一个只能靠猜的静默分支。
 */
const props = defineProps<{ profile: string }>();
const draft = ref("");
const scrollBox = ref<HTMLElement | null>(null);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  draft.value = "";
  await sessions.send(props.profile, text);
}

/**
 * 取更早的一页并钉回用户正在看的那条 —— 与 `views/chat/ChatSessionView.vue` 里那份相同。
 * 锚定的量法（比同一个元素的前后位移，不比 scrollHeight）与它为什么不能各写一份，
 * 都写在 `components/shared/scrollAnchor.ts` 的注释里。
 */
async function onLoadEarlier(): Promise<void> {
  const el = scrollBox.value;
  if (!el) return;
  const restore = captureAnchor(el);
  const added = await sessions.loadEarlier();
  if (added === 0) return;
  await nextTick();
  restore();
}
</script>

<template>
  <main class="flex min-w-0 flex-col bg-canvas">
    <div ref="scrollBox" class="flex-1 overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[46rem] flex-col px-4 py-5 sm:px-6">
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
          :earlier-blocked="sessions.sending"
          @load-earlier="onLoadEarlier"
        />
      </div>
    </div>

    <!--
      store 的失败都汇到 `sessions.error` 这一处（打开会话、加载更早的消息、加载更早的会话
      都是「自己吞掉异常并置 error」，见 store 的 `open()`）。这一页以前没有这个出口，
      所以分页失败在 bot 控制台上是**什么都不显示**的 —— 与 chat 会话页那处同一形式。
    -->
    <div v-if="sessions.error" class="px-4 pb-2 text-xs text-danger">{{ sessions.error }}</div>

    <form class="border-t-1 border-line bg-surface px-4 py-3" @submit.prevent="onSend">
      <div class="mx-auto flex w-full max-w-[46rem] gap-2">
        <input
          v-model="draft"
          class="h-10 min-w-0 flex-1 rounded-lg border-1 border-line-strong bg-raised px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-ring"
          placeholder="输入消息…"
          autocomplete="off"
        />
        <button
          class="h-10 cursor-pointer rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover active:bg-primary-pressed disabled:cursor-wait disabled:opacity-60"
          type="submit"
          :disabled="sessions.sending"
        >
          发送
        </button>
      </div>
    </form>
  </main>
</template>
