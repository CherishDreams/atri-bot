<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { connect, listAdapterConversations, type LiveStatus } from "../api/client.js";
import type { AdapterConversationGroup } from "../api/generated/index.js";
import { useAuthStore } from "../stores/auth.js";
import { useSessionsStore } from "../stores/sessions.js";
import MessageList from "../components/shared/MessageList.vue";
import ProfilePicker from "../components/shared/ProfilePicker.vue";
import { useProfile } from "../composables/useProfile";

/**
 * 平台会话页：适配器（QQ 等）上发生过的对话，按平台分组展示。
 *
 * 与聊天平台（/chat）是两个读者、两个页面（AstrBot 的「平台消息」与 WebChat
 * 同一条分界）：这里**只读** —— 平台会话的回复要经适配器发回平台，直接在这个
 * 视图里"回复"既绕过了引擎的工具循环，也不会出现在会话历史里，是两头都说谎的
 * 形状；要跟机器人对话去聊天页。
 */
const auth = useAuthStore();
const sessions = useSessionsStore();
const router = useRouter();
const { profile } = useProfile();

interface Group extends AdapterConversationGroup {
  /** 折叠状态按 adapterId 记。 */
  collapsed: boolean;
}

const groups = ref<Group[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedSessionId = ref<string | null>(null);
const selectedLabel = ref<string>("");
/** 展开某条会话的消息用同一份 store（open 加载、WS/HTTP 去重照旧）。 */
const detailLoading = ref(false);

const selectedGroup = computed(() =>
  groups.value.find((group) =>
    group.conversations.some((c) => c.sessionId === selectedSessionId.value),
  ),
);

async function onLogout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: "login" });
}

async function refresh(): Promise<void> {
  if (profile.value === null) return;
  loading.value = true;
  error.value = null;
  try {
    const res = await listAdapterConversations(profile.value);
    groups.value = res.groups.map((group) => ({ ...group, collapsed: false }));
    // 当前选中的会话被删掉（映射重建）时清掉选择。
    if (
      selectedSessionId.value !== null &&
      !groups.value.some((group) =>
        group.conversations.some((c) => c.sessionId === selectedSessionId.value),
      )
    ) {
      selectedSessionId.value = null;
      selectedLabel.value = "";
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function openConversation(
  group: Group,
  conversation: Group["conversations"][number],
): Promise<void> {
  selectedSessionId.value = conversation.sessionId;
  selectedLabel.value = `${group.name} · ${conversation.title}`;
  detailLoading.value = true;
  try {
    await sessions.open(conversation.sessionId);
  } finally {
    detailLoading.value = false;
  }
}

let unsubscribe: (() => void) | null = null;
const live = ref<LiveStatus>("open");

onMounted(async () => {
  try {
    await auth.fetchMe();
  } catch {
    /* 忽略：交给守卫与后续请求处理 */
  }
  if (!auth.isAuthenticated) {
    await router.replace({ name: "login" });
    return;
  }
  unsubscribe = connect(
    (frame) => {
      if (frame.type === "unauthorized") {
        auth.clear();
        void router.replace({ name: "login" });
        return;
      }
      // 平台会话也在广播链上：打开着的会话实时 ingest（按 id 去重）。
      if (frame.type === "message") sessions.ingest(frame.message);
    },
    (next) => {
      live.value = next;
    },
  );
  await refresh();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

watch(profile, () => {
  selectedSessionId.value = null;
  selectedLabel.value = "";
  void refresh();
});

function kindLabel(kind: string): string {
  return kind === "group" ? "群聊" : "私聊";
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toTimeString().slice(0, 5)
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 5)}`;
}
</script>

<template>
  <div v-if="profile === null" class="h-full overflow-y-auto bg-canvas">
    <ProfilePicker />
  </div>
  <div
    v-else
    class="grid h-full grid-cols-1 grid-rows-[repeat(2,minmax(0,1fr))] overflow-hidden bg-canvas text-ink lg:grid-cols-[260px_1fr] lg:grid-rows-[minmax(0,1fr)]"
  >
    <!-- 左栏：按适配器分组的平台会话 -->
    <aside class="flex min-h-0 flex-col border-r-1 border-line bg-surface lg:border-r-0">
      <header class="flex items-center justify-between border-b-1 border-line px-3 py-2">
        <h2 class="m-0 text-13px font-semibold text-ink">平台会话</h2>
        <button class="btn-ghost" type="button" title="刷新" @click="refresh">刷新</button>
      </header>
      <p
        v-if="live !== 'open'"
        role="status"
        class="m-0 border-b-1 border-line bg-tint px-3 py-1 text-xs text-warning"
      >
        {{ live === "retrying" ? "实时连接已断开，正在重连…" : "实时连接已关闭" }}
      </p>
      <n-alert v-if="error" type="error" :show-icon="false" class="ma-2" @close="error = null">
        {{ error }}
      </n-alert>
      <n-spin :show="loading" size="small" class="min-h-0 flex-1 overflow-y-auto">
        <n-empty
          v-if="groups.length === 0 && !loading"
          size="small"
          class="mt-8"
          description="还没有平台会话 —— 绑定适配器并收到消息后出现在这里"
        />
        <section v-for="group in groups" :key="group.adapterId" class="border-b-1 border-line">
          <button
            class="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-2 text-left"
            type="button"
            @click="group.collapsed = !group.collapsed"
          >
            <span class="text-12px font-semibold text-ink">{{ group.name }}</span>
            <span class="text-11px text-ink-faint">{{ group.conversations.length }}</span>
            <span class="ml-auto text-11px text-ink-faint">{{ group.collapsed ? "▸" : "▾" }}</span>
          </button>
          <ul v-if="!group.collapsed" class="m-0 list-none p-0">
            <li v-for="conversation in group.conversations" :key="conversation.sessionId">
              <button
                class="w-full cursor-pointer border-none bg-transparent px-3 py-2 text-left"
                :class="
                  conversation.sessionId === selectedSessionId ? 'bg-tint' : 'hover:bg-tint/50'
                "
                type="button"
                @click="openConversation(group, conversation)"
              >
                <div class="flex items-baseline gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-13px text-ink">
                    {{ conversation.title }}
                  </span>
                  <span class="text-11px text-ink-faint">
                    {{ timeLabel(conversation.updatedAt) }}
                  </span>
                </div>
                <div class="text-11px text-ink-faint">
                  {{ kindLabel(conversation.kind) }} · {{ conversation.externalId }} ·
                  {{ conversation.messageCount }} 条
                </div>
              </button>
            </li>
          </ul>
        </section>
      </n-spin>
    </aside>

    <!-- 右栏：只读的消息视图 -->
    <div class="flex min-w-0 flex-col">
      <header
        class="flex items-center justify-between gap-3 border-b-1 border-line px-4 py-2 text-ink-muted"
      >
        <span class="min-w-0 truncate text-13px text-ink">
          {{ selectedSessionId === null ? "选择左侧一条平台会话查看" : selectedLabel }}
          <n-tag v-if="selectedSessionId !== null" size="tiny" :bordered="false" class="ml-1">
            只读
          </n-tag>
        </span>
        <span class="flex shrink-0 items-center gap-3 text-xs">
          <span>{{ auth.user?.username }}</span>
          <button class="btn-ghost" type="button" title="退出登录" @click="onLogout">登出</button>
        </span>
      </header>
      <n-spin :show="detailLoading" class="min-h-0 flex-1 overflow-y-auto">
        <n-empty
          v-if="selectedSessionId === null"
          class="mt-12"
          description="平台会话是适配器上真实发生过的对话；要跟机器人对话，去聊天平台"
        />
        <template v-else>
          <MessageList :messages="sessions.log" empty-text="这个会话还没有消息" class="px-4 py-3" />
        </template>
      </n-spin>
    </div>
  </div>
</template>
