<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { connect } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useProvidersStore } from "@/stores/providers";
import { useSessionsStore } from "@/stores/sessions";

const auth = useAuthStore();
const sessions = useSessionsStore();
const providers = useProvidersStore();
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

/**
 * 角色名本地化。线协议里的 `role` 是英文（`user`/`assistant`），
 * 直接渲染会在整片中文界面里露出两个英文单词；这里只改显示，
 * 判断分支仍然比对原始的 `m.role`。
 */
const ROLE_LABELS: Record<string, string> = { user: "用户", assistant: "助手" };
function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

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
  // 带上顶栏模型选择器选中的实例；没选就交给服务端按自己的默认选路。
  await sessions.send(text, providers.selection?.model);

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
        <p class="m-0 mb-3 text-sm text-ink-muted">
          {{ sessions.error ?? "会话不存在或已被删除" }}
        </p>
        <n-button size="small" @click="router.push({ name: 'chat-new' })">创建新会话</n-button>
      </div>
    </div>

    <template v-else>
      <div ref="scrollBox" class="scroll-y flex-1 px-4 py-3">
        <div class="mx-auto w-full max-w-[var(--atri-reading-w)]">
          <p v-if="sessions.log.length === 0" class="m-0 py-8 text-center text-xs text-ink-muted">
            还没有消息，说点什么吧。
          </p>

          <div
            v-for="m in sessions.log"
            :key="m.id"
            class="mb-3 flex flex-col"
            :class="m.role === 'user' ? 'items-end' : 'items-start'"
          >
            <span class="mb-1 text-xs text-ink-faint">{{ roleLabel(m.role) }}</span>
            <div
              class="max-w-[85%] rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap"
              :class="
                m.role === 'user'
                  ? 'bg-primary-soft text-ink'
                  : 'border-1 border-line bg-raised text-ink'
              "
            >
              {{ m.content }}
            </div>
          </div>

          <!-- 流式进行中给一行提示：首字虽已可见，但用户无从判断是「答完了」还是「还在想」。 -->
          <div v-if="sessions.streaming" class="flex flex-col items-start">
            <span class="mb-1 text-xs text-ink-faint">助手</span>
            <div
              class="rounded-lg border-1 border-line bg-raised px-3 py-2 text-sm text-ink-faint"
              aria-live="polite"
            >
              正在输入…
            </div>
          </div>
        </div>
      </div>

      <div v-if="sessions.error" class="px-4 pb-2 text-xs text-danger">{{ sessions.error }}</div>

      <form class="flex gap-2 border-t-1 border-line p-3" @submit.prevent="onSend">
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
