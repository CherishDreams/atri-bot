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
  <!--
    桌面端保持原三栏 240/1fr/300；窄屏降级为单列堆叠，避免横向溢出。

    grid-rows 的 minmax(0,1fr) 不能省。隐式行默认是 auto，行高会被最高的那个
    item 的内容撑开；容器虽有 h-full + overflow-hidden，行却不受容器高度约束，
    于是超出部分直接被裁掉——实测 1280x420 视口下行高 1056px 而容器只有 360px。
    更隐蔽的是 overflow-hidden 的容器仍能接受程序滚动，所以 scrollTop 设得进去、
    用户却没有滚动条也滚不动，内容彻底不可达。
    下界必须是 0：`1fr` 等价于 `minmax(auto,1fr)`，auto 仍会被内容顶开。
    窄屏是 1 列 3 行，所以三行都要封。
  -->
  <div
    class="grid h-full grid-cols-1 grid-rows-[repeat(3,minmax(0,1fr))] overflow-hidden bg-canvas text-ink lg:grid-cols-[240px_1fr_300px] lg:grid-rows-[minmax(0,1fr)]"
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
