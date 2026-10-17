<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { connect, type LiveStatus } from "../api/client.js";
import { useAuthStore } from "../stores/auth.js";
import { useSessionsStore } from "../stores/sessions.js";
import SessionList from "../components/SessionList.vue";
import Conversation from "../components/Conversation.vue";
import ProfilePicker from "../components/shared/ProfilePicker.vue";
import { useProfile } from "../composables/useProfile";

const auth = useAuthStore();
const sessions = useSessionsStore();
const router = useRouter();
const { profile } = useProfile();

async function onLogout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: "login" });
}

let unsubscribe: (() => void) | null = null;
/** 实时推送的连接状态；断线要在这页说出来（`ChatSessionView` 同一个理由）。 */
const live = ref<LiveStatus>("open");

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

  unsubscribe = connect(
    (frame) => {
      if (frame.type === "unauthorized") {
        auth.clear();
        void router.replace({ name: "login" });
        return;
      }
      // HTTP 响应与 WS 帧都会投递同一条助手消息，store.ingest 按 id 去重。
      if (frame.type === "message") sessions.ingest(frame.message);
    },
    (next) => {
      live.value = next;
    },
  );

  await sessions.refresh();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <!--
    桌面端两栏 240/1fr；窄屏降级为单列堆叠，避免横向溢出。
    插件不在这一页：启停与配置都只在 `/plugins` 页，控制台保持会话工作区两栏。

    grid-rows 的 minmax(0,1fr) 不能省。隐式行默认是 auto，行高会被最高的那个
    item 的内容撑开；容器虽有 h-full + overflow-hidden，行却不受容器高度约束，
    于是超出部分直接被裁掉——实测 1280x420 视口下行高 1056px 而容器只有 360px。
    更隐蔽的是 overflow-hidden 的容器仍能接受程序滚动，所以 scrollTop 设得进去、
    用户却没有滚动条也滚不动，内容彻底不可达。
    下界必须是 0：`1fr` 等价于 `minmax(auto,1fr)`，auto 仍会被内容顶开。
    窄屏是 1 列 2 行，所以两行都要封。
  -->
  <!-- 没选配置档时整页换成选择器：会话列表在这里拿不到有意义的状态，
       画出来只会是一列空会话，与「加载失败」在界面上分不开。 -->
  <div v-if="profile === null" class="h-full overflow-y-auto bg-canvas">
    <ProfilePicker />
  </div>
  <div
    v-else
    class="grid h-full grid-cols-1 grid-rows-[repeat(2,minmax(0,1fr))] overflow-hidden bg-canvas text-ink lg:grid-cols-[240px_1fr] lg:grid-rows-[minmax(0,1fr)]"
  >
    <SessionList />

    <div class="flex min-w-0 flex-col">
      <!-- 服务端重启过一次，这一页就会「看着正常但不再收消息」。
           不说出来，用户唯一的线索是别人都在动而自己不。 -->
      <p
        v-if="live !== 'open'"
        role="status"
        class="m-0 border-b-1 border-line bg-tint px-4 py-1.5 text-xs text-warning"
      >
        {{ live === "retrying" ? "实时连接已断开，正在重连…" : "实时连接已关闭" }}
      </p>
      <header
        class="flex items-center justify-end gap-3 border-b-1 border-line px-4 py-2 text-ink-muted"
      >
        <span class="text-xs">{{ auth.user?.username }}</span>
        <button class="btn-ghost" type="button" title="退出登录" @click="onLogout">登出</button>
      </header>
      <Conversation class="min-h-0 flex-1" :profile="profile" />
    </div>
  </div>
</template>
