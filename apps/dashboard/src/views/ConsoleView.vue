<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";
import { connect } from "../api/client.js";
import { useAuthStore } from "../stores/auth.js";
import { useSessionsStore } from "../stores/sessions.js";
import { usePluginsStore } from "../stores/plugins.js";
import SessionList from "../components/SessionList.vue";
import Conversation from "../components/Conversation.vue";
import PluginPanel from "../components/PluginPanel.vue";

const auth = useAuthStore();
const sessions = useSessionsStore();
const plugins = usePluginsStore();
const router = useRouter();

async function onLogout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: "login" });
}

let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  // 先确认身份再拉数据：过期 Cookie 会被 401 拦下，避免无谓的失败请求。
  try {
    await auth.fetchMe();
  } catch {
    /* 忽略：交给守卫与后续请求处理 */
  }
  if (!auth.isAuthenticated) {
    await router.replace({ name: "login" });
    return;
  }

  unsubscribe = connect((frame) => {
    if (frame.type === "unauthorized") {
      auth.clear();
      void router.replace({ name: "login" });
      return;
    }
    // HTTP 响应与 WS 帧都会投递同一条助手消息，store.ingest 按 id 去重。
    if (frame.type === "message") sessions.ingest(frame.message);
  });

  await Promise.all([sessions.refresh(), plugins.refresh()]);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <!-- 桌面端保持原三栏 240/1fr/300；窄屏降级为单列堆叠，避免横向溢出。 -->
  <div
    class="grid h-full grid-cols-1 overflow-hidden bg-canvas text-ink lg:grid-cols-[240px_1fr_300px]"
  >
    <SessionList />

    <div class="flex min-w-0 flex-col">
      <header
        class="flex items-center justify-end gap-3 border-b-1 border-line px-4 py-2 text-ink-muted"
      >
        <span class="text-xs">{{ auth.user?.username }}</span>
        <button class="btn-ghost" type="button" title="退出登录" @click="onLogout">登出</button>
      </header>
      <Conversation class="min-h-0 flex-1" />
    </div>

    <PluginPanel />
  </div>
</template>
