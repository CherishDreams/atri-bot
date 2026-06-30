<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { connect } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";

const auth = useAuthStore();
const sessions = useSessionsStore();
const route = useRoute();
const router = useRouter();

const draft = ref("");
const scrollBox = ref<HTMLElement | null>(null);

/**
 * 本页自己的加载态。不能直接用 sessions.loading：组件挂载的瞬间它还是 false，
 * 而 active 尚未填充，页面会先闪一下「会话不存在」再跳出内容。
 */
const status = ref<"loading" | "ready" | "missing">("loading");

const sessionId = computed(() => String(route.params.sessionId ?? ""));
const canSend = computed(() => draft.value.trim().length > 0 && !sessions.sending);

let unsubscribe: (() => void) | null = null;

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scrollBox.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function load(id: string): Promise<void> {
  if (!id) {
    status.value = "missing";
    return;
  }
  status.value = "loading";
  const opened = await sessions.open(id);
  status.value = opened ? "ready" : "missing";
  await scrollToBottom();
}

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !sessions.active) return;

  draft.value = "";
  await sessions.send(text);

  // 发送失败时把内容还回输入框，否则用户白打一遍字。
  if (sessions.error && !draft.value) draft.value = text;
  await scrollToBottom();
}

onMounted(async () => {
  // 进入页面先确认身份：Cookie 可能已过期，否则会白跑一次请求。
  try {
    await auth.fetchMe();
  } catch {
    /* 忽略：由下面的 401 分支统一处理 */
  }
  if (!auth.isAuthenticated) {
    await router.replace({ name: "login", query: { redirect: route.fullPath } });
    return;
  }

  unsubscribe = connect((frame) => {
    if (frame.type === "unauthorized") {
      auth.clear();
      void router.replace({ name: "login", query: { redirect: route.fullPath } });
      return;
    }
    // 助手回复同时会经 HTTP 响应回来，store.ingest 按 id 去重。
    if (frame.type === "message") sessions.ingest(frame.message);
  });

  // 列表为空时补一次，侧栏才好显示会话名。
  if (sessions.sessions.length === 0) {
    await sessions.refresh().catch(() => undefined);
  }

  // 从创建页带过来的首句：走 history state 而非 query，内容不进地址栏。
  // 读完就把这个键摘掉（保留 router 自己的 state 键），
  // 否则刷新页面会把已经发出去的那句话又填回输入框。
  const state = history.state as Record<string, unknown> | null;
  if (state && typeof state.draft === "string") {
    draft.value = state.draft;
    const next = { ...state };
    delete next.draft;
    history.replaceState(next, "");
  }

  await load(sessionId.value);
});

// 侧栏点其他会话时只变路由参数，组件不会重建，得手动跟着走。
watch(sessionId, (id) => {
  if (id) void load(id);
});

watch(
  () => sessions.log.length,
  () => void scrollToBottom(),
);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <div class="atri-chat-session flex h-full min-h-0 flex-col">
    <div v-if="status === 'loading'" class="grid flex-1 place-items-center">
      <n-spin size="medium" />
    </div>

    <div v-else-if="status === 'missing'" class="grid flex-1 place-items-center px-4 text-center">
      <div>
        <p class="m-0 mb-3 text-sm text-muted">
          {{ sessions.error ?? "会话不存在或已被删除" }}
        </p>
        <n-button size="small" @click="router.push({ name: 'chat-new' })">创建新会话</n-button>
      </div>
    </div>

    <template v-else>
      <div ref="scrollBox" class="flex-1 overflow-y-auto px-4 py-3">
        <p v-if="sessions.log.length === 0" class="m-0 py-8 text-center text-xs text-muted">
          还没有消息，说点什么吧。
        </p>

        <div
          v-for="m in sessions.log"
          :key="m.id"
          class="mb-3 flex flex-col"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
        >
          <span class="mb-1 text-xs text-muted">{{ m.role }}</span>
          <div
            class="max-w-[80%] rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap"
            :class="
              m.role === 'user'
                ? 'bg-[#222836] text-fg'
                : 'border border-[#2b3040] bg-panel text-fg'
            "
          >
            {{ m.content }}
          </div>
        </div>
      </div>

      <div v-if="sessions.error" class="px-4 pb-2 text-xs text-danger">{{ sessions.error }}</div>

      <form class="edge-line flex gap-2 border-t p-3" @submit.prevent="onSend">
        <n-input
          v-model:value="draft"
          type="textarea"
          placeholder="输入消息…（Enter 发送，Shift + Enter 换行）"
          :autosize="{ minRows: 1, maxRows: 6 }"
          :disabled="sessions.sending"
          @keydown.enter.exact.prevent="onSend"
        />
        <n-button
          type="primary"
          attr-type="submit"
          :disabled="!canSend"
          :loading="sessions.sending"
        >
          发送
        </n-button>
      </form>
    </template>
  </div>
</template>
