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

/** 距底部多少像素以内算「用户还在看最新内容」，超过就停止自动跟随。 */
const FOLLOW_THRESHOLD = 80;
/**
 * 是否贴着底部。用户往上翻看上文时，流式增量不该每来一段就把视图拽回底部。
 */
const stickToBottom = ref(true);

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

/**
 * 从创建页带过来、尚未发出的首句。
 *
 * 用普通 `let` 而不是 ref：它不参与渲染，也不该参与。放进 `draft` 会被输入框显示出来，
 * 而「输入框里有字」并不能当作「该自动发送」的依据——切换会话时 draft 不会被清，
 * 那样会把上一条没发出去的话又发一遍。
 */
let pendingFirst: string | null = null;

async function scrollToBottom(): Promise<void> {
  stickToBottom.value = true;
  await nextTick();
  const el = scrollBox.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 滚动条自己动的时候也要更新贴底状态，否则用户上滚后再也跟不上。 */
function onScroll(): void {
  const el = scrollBox.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
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

/**
 * 发送的唯一实现，手动与自动共用同一条路径。
 *
 * 刻意不写成 `onSend(text?: string)`：模板里是 `@submit.prevent="onSend"` 与
 * `@keydown.enter.exact.prevent="onSend"`，Vue 会把 Event 对象作为第一个实参传进来，
 * 可选参数签名会当场把一个 SubmitEvent 当成消息文本发出去。
 */
async function submitMessage(text: string): Promise<void> {
  const content = text.trim();
  if (!content || !sessions.active) return;

  draft.value = "";
  // 带上顶栏模型选择器选中的实例；没选就交给服务端按自己的默认选路。
  await sessions.send(content, providers.selection?.model);

  // 发送失败时把内容还回输入框，否则用户白打一遍字。
  // 条件是 draft 仍为空：用户在等回复期间又打了字，不能把人家的字覆盖掉。
  if (sessions.error && !draft.value) draft.value = content;
  await scrollToBottom();
}

/** 模板入口：发送输入框里的内容。 */
function onSend(): Promise<void> {
  return submitMessage(draft.value);
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
    pendingFirst = state.draft;
    const next = { ...state };
    delete next.draft;
    history.replaceState(next, "");
  }

  await load(sessionId.value);

  /*
   * 首句直接发出去，不再要求用户点第二次发送。
   *
   * 必须排在 load() 之后：load() 里的 sessions.open() 会整体替换 log，
   * 在那之前 push 的乐观气泡会被连锅端掉。
   *
   * 闸门是 status === "ready" 而不是 sessions.active 非空。open() 失败时会把
   * active 置 null，而 send() 开头是 `await ensureActive()`——它会新建一个
   * 标题为「首个会话」的会话并把消息发进去，URL 却还指着那个已经不存在的 id。
   *
   * 闩锁在任何 await 之前同步置空：send() 要等 ensureActive() 返回才把 sending
   * 置 true，拿它当防重入判断的话，用户此刻敲 Enter 就是两次上游调用、两条助手消息。
   */
  if (pendingFirst !== null) {
    const first = pendingFirst;
    pendingFirst = null;
    if (status.value === "ready") {
      await submitMessage(first);
    } else {
      // 会话没了也别把用户的话吞掉，退回输入框让他决定下一步。
      draft.value = first;
    }
  }
});

// 侧栏点其他会话时只变路由参数，组件不会重建，得手动跟着走。
watch(sessionId, (id) => {
  if (id) void load(id);
});

/*
 * 光 watch `log.length` 跟不上流式：appendDelta 改的是 content，条数不变，
 * 所以回复逐字往外蹦时视图一动不动。这里把「日志总字符数」也当度量，
 * 流式增量就能带动滚动；用户上滚离开底部后交给 stickToBottom 停住跟随。
 */
const logSize = computed(() => sessions.log.reduce((n, m) => n + m.content.length, 0));

watch([() => sessions.log.length, logSize], () => {
  if (stickToBottom.value) void scrollToBottom();
});

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
      <div ref="scrollBox" class="scroll-y flex-1 px-4 py-3" @scroll="onScroll">
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

            <!--
              三条分支互斥，必须留在同一条 v-if/v-else-if/v-else 链上：
              拆成两个独立 v-if 会让有内容的助手消息渲染两遍。

              1. 正在流、还没收到第一个 token 的助手草稿 —— 显示占位文案。
                 用 streamingId 精确判定，而不是「助手 + 内容为空」：后者会让
                 content 恰好为空的最终消息永远挂着「正在输入…」。
                 send() 先往 log 里 push 一条空 content 的草稿，以前这里既渲染
                 这个空气泡、又在其旁边单独挂一行「正在输入…」，两个东西占一个位置。
              2. 其余助手消息 —— 走 markdown。回复是模型写的、带格式的那一侧。
              3. 用户消息 —— 纯文本 + pre-wrap。把输入里的 `*` `_` 当强调符号解析
                 会排错版，而它本来就没有格式意图。

              助手气泡底色必须是 surface：MarkdownView 的行内代码与代码块用 raised，
              气泡也是 raised 的话代码记号就完全看不见。
            -->
            <div
              v-if="m.role !== 'user' && !m.content && sessions.streamingId === m.id"
              class="max-w-[85%] rounded-lg border-1 border-line bg-surface px-3 py-2 text-sm text-ink-faint"
              aria-live="polite"
            >
              正在输入…
            </div>
            <markdown-view
              v-else-if="m.role !== 'user'"
              :content="m.content"
              class="max-w-[85%] rounded-lg border-1 border-line bg-surface px-3 py-2 text-sm text-ink"
            />
            <div
              v-else
              class="max-w-[85%] rounded-lg bg-primary-soft px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink"
            >
              {{ m.content }}
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
