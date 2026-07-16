<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

/**
 * bot / chat 平台切换。两处顶栏共用，因此切换逻辑只写一份。
 *
 * 高亮**不存本地状态**，而是从当前路由推出来：写成一个 ref 会立刻出现
 * 「停在 chat 但按钮显示 bot」这类不一致——刷新页面、浏览器前进后退、
 * 或直接粘贴地址进入 /chat/:id 时，本地状态都不会跟着走。
 * AstrBot 的 VerticalHeader 里 `currentMode` 也是 computed（get 读 isChatPath），
 * 只是它把「上次去过的路由」存在 sessionStorage 里。
 *
 * 那个「记住上次」的行为这里不做：本项目的 bot 侧只有控制台与供应商配置两页，
 * chat 侧的会话 id 本来就在地址里，来回切换的收益不值得多一份跨页状态。
 * 切回 bot 一律回控制台，是当前唯一稳定存在的 bot 落地页。
 */
const route = useRoute();
const router = useRouter();

const isChat = computed(() => route.path === "/chat" || route.path.startsWith("/chat/"));

const mode = computed({
  get: () => (isChat.value ? "chat" : "bot"),
  set: (next: string | number | boolean | null) => {
    if (next === "chat") void router.push({ name: "chat-new" });
    else if (next === "bot") void router.push({ name: "console" });
  },
});
</script>

<template>
  <!-- n-radio-group + n-radio-button 是 naive-ui 里最接近 AstrBot 那个
       v-btn-toggle 的控件：连体按钮、选中项描边高亮。
       size="small" 是为了压在 60px 顶栏里不显笨重。
       高度与字号不再由本组件的 `<style>` 用 `:deep(.n-radio-button)` 抬到 32px——
       那只是为了和汉堡按钮对齐的补丁，现在两处共用 `theme/tokens.ts` 的
       `layout.controlH`，由 theme/naive.ts 的 `Radio.buttonHeightSmall` 统一给出。 -->
  <n-radio-group v-model:value="mode" name="atri-platform" size="small" class="atri-mode-switch">
    <n-radio-button value="bot">Bot</n-radio-button>
    <n-radio-button value="chat">Chat</n-radio-button>
  </n-radio-group>
</template>
