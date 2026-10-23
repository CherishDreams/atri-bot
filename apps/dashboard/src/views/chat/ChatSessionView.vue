<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { connect, type LiveStatus } from "@/api/client";
import { captureAnchor } from "@/components/shared/scrollAnchor";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";
import { useProfile } from "@/composables/useProfile";

const auth = useAuthStore();
const sessions = useSessionsStore();
/** 发消息是作用域化的：这一轮用哪一套模型与工具，由路由上的那一份档决定。 */
const { profile } = useProfile();
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

let unsubscribe: (() => void) | null = null;
/**
 * 详情加载的代际。store 里已经挡了一次，这里再挡一次是因为 `status` 是本页自己的状态：
 * 旧 `load()` 晚回来把新会话的 `status` 改成 missing/ready，页面仍会闪错。
 */
let loadSeq = 0;
/** 实时推送的连接状态。断线只在这页说一次，不做「已连接」的常态提示。 */
const live = ref<LiveStatus>("open");

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

/**
 * 取更早的一页，并把视图钉回用户正在看的那条。
 *
 * 这里刻意**不**动 `stickToBottom`：用户既然看得见顶部那颗按钮，说明他已经上滚离开底部
 *（`onScroll` 早把它置成 false），此时任何「自动跟到底」都是错的。
 *
 * 锚定的量法与「为什么不能记 scrollTop / scrollHeight」写在 `shared/scrollAnchor.ts`。
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

async function load(id: string): Promise<void> {
  const seq = ++loadSeq;
  if (!id) {
    status.value = "missing";
    return;
  }
  status.value = "loading";
  const opened = await sessions.open(id);
  if (seq !== loadSeq) return;
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

  // 没选配置档就发不出去：发消息是作用域化的，服务端对缺 profile 一律 400。
  // 这道判据必须排在清 draft **之前**。放在后面得到的是最坏的那种失败：点了发送、
  // 打的字没了、请求一条没发、连错误文案都不出现（实测输入框清空而 [data-msg-id] 仍是 0）。
  if (profile.value === null) return;

  draft.value = "";
  // **不带 model**：用哪个模型是这一档的属性（档文件里的 `defaultProvider`），
  // 由该档的引擎在 `model` 缺省时填。以前这里带的是浏览器 localStorage 里那份选择，
  // 于是「同一条消息在两台浏览器上是两个模型」——那是配置，不是偏好，见提交正文。
  await sessions.send(profile.value, content);

  // 发送失败时把内容还回输入框，否则用户白打一遍字。
  // 条件是 draft 仍为空：用户在等回复期间又打了字，不能把人家的字覆盖掉。
  if (sessions.error && !draft.value) draft.value = content;
  await scrollToBottom();
}

/** 会话打不开时，把首句带回创建页，至少不丢用户刚打的字。 */
async function continueInNewSession(): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  sessions.stageNewSessionDraft(text);
  draft.value = "";
  await router.push({
    name: "chat-new",
    query: profile.value === null ? {} : { profile: profile.value },
  });
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

  unsubscribe = connect(
    (frame) => {
      if (frame.type === "unauthorized") {
        auth.clear();
        void router.replace({ name: "login", query: { redirect: route.fullPath } });
        return;
      }
      // 助手回复同时会经 HTTP 响应回来，store.ingest 按 id 去重。
      if (frame.type === "message") sessions.ingest(frame.message);
    },
    (next) => {
      live.value = next;
    },
  );

  // 列表为空时补一次，侧栏才好显示会话名。
  if (sessions.sessions.length === 0) {
    await sessions.refresh().catch(() => undefined);
  }

  // 从创建页带过来的首句：走 store，不走 query（聊天内容不该进地址栏和浏览历史）。
  // 取走即清空 —— 一次挂载只消费一次；带着 id 去取，挡的是「创建与落地之间点了别的会话」。
  pendingFirst = sessions.takeFirstMessage(sessionId.value);

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
  // 离开这一页要取消在途的那轮流（`send()` 传的 signal 由 store 持有）。
  // 不取消的后果有两层：这一页没了而流还在写 store；以及 `sending` 挂着 true,
  // 于是**别的会话**的发送按钮也跟着被禁 —— 它判的是全局那一个。
  sessions.abortStream();
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
        <p v-if="draft" class="m-0 mb-3 text-sm text-ink">尚未发送：{{ draft }}</p>
        <n-button
          v-if="draft"
          size="small"
          type="primary"
          class="mr-2"
          @click="continueInNewSession"
        >
          带着这句话去创建
        </n-button>
        <n-button size="small" @click="router.push({ name: 'chat-new' })">创建新会话</n-button>
      </div>
    </div>

    <template v-else>
      <div ref="scrollBox" class="scroll-y flex-1 px-4 py-5 sm:px-6" @scroll="onScroll">
        <div class="mx-auto w-full max-w-[var(--atri-reading-w)]">
          <!--
            气泡本体在 shared/MessageList 里，与 bot 控制台共用同一套渲染：
            两处各写一份的话，同一条消息在两个平台会长得不一样。
            对齐、底色、角色名三个维度怎么标识发送方、三条分支为什么要留在
            同一条 v-if 链上，都记在 MessageBubble 里。
          -->
          <message-list
            :messages="sessions.log"
            :streaming-id="sessions.streamingId"
            :has-more="sessions.hasMoreMessages"
            :loading-earlier="sessions.loadingEarlier"
            :earlier-blocked="sessions.sending"
            @load-earlier="onLoadEarlier"
          />
        </div>
      </div>

      <div v-if="sessions.error" class="px-4 pb-2 text-xs text-danger">{{ sessions.error }}</div>

      <!-- 断了要说出来。以前这里什么都不显示：服务端重启之后页面看着一切正常,
           只是再也收不到消息, 而用户唯一的线索是「别人都在动而我不懂为什么不动」。 -->
      <div v-if="live !== 'open'" class="px-4 pb-2 text-xs text-warning" role="status">
        {{ live === "retrying" ? "实时连接已断开，正在重连…" : "实时连接已关闭" }}
      </div>

      <form class="border-t-1 border-line bg-surface px-4 py-3 sm:px-6" @submit.prevent="onSend">
        <div class="mx-auto flex w-full max-w-[var(--atri-reading-w)] gap-2">
          <n-input
            v-model:value="draft"
            class="min-w-0 flex-1"
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
        </div>
      </form>
    </template>
  </div>
</template>
