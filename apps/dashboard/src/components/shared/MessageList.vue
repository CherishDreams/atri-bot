<script setup lang="ts">
import type { Message } from "@/api/generated/index.js";
import MessageBubble from "./MessageBubble.vue";

/**
 * 一串气泡，外加加载与空态。bot 控制台与 chat 会话页共用。
 *
 * 只负责「列表本身」，滚动容器留在调用方：会话页要拿 `ref` 操作 scrollTop
 * 做流式跟随，把滚动条封进这里就得再多一层 ref 透传，不划算。
 * ——「加载更早」的**按钮**在这里（它属于列表第一项），而**滚动锚定**在调用方
 *（只有它们知道自己的容器）。
 */
defineProps<{
  messages: Message[];
  /** 正在流式接收的消息 id，用来把空草稿渲染成「正在输入…」。 */
  streamingId?: string | null;
  loading?: boolean;
  emptyText?: string;
  /** 还有更早的消息可以翻。服务端 `nextCursor` 为 null 就是到顶了。 */
  hasMore?: boolean;
  /** 「加载更早」在途，按钮要禁用并改文案。 */
  loadingEarlier?: boolean;
}>();

const emit = defineEmits<{ (e: "loadEarlier"): void }>();
</script>

<template>
  <!--
    「还有更早的吗」(`hasMore`) 与「这一页正在来吗」(`loadingEarlier`) 是两个状态，
    合成一个就会出现「加载中但已经没有更多」这种说不清的中间态。
    翻到顶之后这条**从 DOM 消失**（`v-if`），而不是留在原地 disable。

    它必须排在下面那条 `v-if="loading"` 的链**之外**：放进链里会让加载中时按钮消失、
    加载完又出现，位置每次抖动，而它本来就是列表的第一项。

    用原生 <button> + 工具类而不是 `n-button`：自动导入的 naive-ui 组件属性**不受
    vue-tsc 校验**（本仓已因此漏过两个真 bug），而原生元素上 `disabled` 与文案
    都能在 DOM 里直接量到。
  -->
  <button
    v-if="hasMore"
    class="mb-2 mr-auto cursor-pointer rounded-md border-1 border-line bg-raised px-2.5 py-1 text-xs text-ink-muted transition-colors hover:text-ink disabled:cursor-wait disabled:opacity-60"
    type="button"
    :disabled="loadingEarlier"
    @click="emit('loadEarlier')"
  >
    {{ loadingEarlier ? "加载中…" : "加载更早的消息" }}
  </button>

  <p v-if="loading" class="m-0 py-8 text-center text-xs text-ink-muted">加载中…</p>
  <p v-else-if="messages.length === 0" class="m-0 py-8 text-center text-xs text-ink-muted">
    {{ emptyText ?? "还没有消息，说点什么吧。" }}
  </p>

  <message-bubble
    v-for="m in messages"
    :key="m.id"
    :data-msg-id="m.id"
    :role="m.role"
    :content="m.content"
    :tool-calls="m.toolCalls"
    :pending="m.id === streamingId && !m.content"
  />
</template>
