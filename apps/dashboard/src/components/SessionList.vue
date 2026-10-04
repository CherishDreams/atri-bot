<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();

async function onNew(): Promise<void> {
  await sessions.create();
}

/**
 * 切换会话必须走 open()，不能只把列表项塞进 active。
 *
 * `GET /sessions` 返回的是摘要视图：服务端 `#publicView` 刻意剥掉 messages、
 * 只留 messageCount（列表不该把全部历史拖下来）。所以点一下只是换了个 id、
 * 顺手把 log 清空，右侧永远是一片空白——历史得再发一次 `GET /sessions/:id` 才有。
 * open() 失败时自己吞掉异常并置 error，不会 reject，模板里直接调即可。
 */
function onSelect(id: string): void {
  void sessions.open(id);
}
</script>

<template>
  <aside class="flex flex-col gap-2 overflow-hidden border-r-1 border-line bg-surface p-3">
    <div class="flex items-center justify-between">
      <strong class="text-ink">atri-bot</strong>
      <button class="btn-ghost" type="button" title="新建会话" aria-label="新建会话" @click="onNew">
        +
      </button>
    </div>

    <!--
      列表是创建序（旧→新），而默认那一页是**最新**的 100 个，所以「更早的会话」拼在头部
      （见 store 的 `loadMoreSessions`），入口也就跟着放在列表上方 —— 与消息那边同一个方向。
      翻到顶（`hasMoreSessions` 为假）就整条从 DOM 消失，不是留在原地 disable。
    -->
    <button
      v-if="sessions.hasMoreSessions"
      class="cursor-pointer rounded-md border-1 border-line bg-raised px-2 py-1 text-xs text-ink-muted transition-colors hover:text-ink disabled:cursor-wait disabled:opacity-60"
      type="button"
      :disabled="sessions.loadingMoreSessions"
      @click="sessions.loadMoreSessions()"
    >
      {{ sessions.loadingMoreSessions ? "加载中…" : "加载更早的会话" }}
    </button>

    <ul class="m-0 flex-1 list-none overflow-y-auto p-0">
      <!--
        一个只能靠鼠标点中才能进入的列表，对键盘用户等于不存在（`<li @click>` 既不可聚焦、
        也不在读屏的可操作元素列表里）。这里补 `role=button` + `tabindex` + 回车/空格，
        而不是把整项换成 `<button>`：`.row-base` 的铺底与 `row-active` 都挂在这个 li 上，
        换标签会把这套行样式与 `aria-current` 的语义一起丢掉。
      -->
      <li
        v-for="s in sessions.sessions"
        :key="s.id"
        role="button"
        tabindex="0"
        class="row-base cursor-pointer px-2 py-1.5 text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="s.id === sessions.active?.id ? 'row-active' : ''"
        :aria-current="s.id === sessions.active?.id ? 'true' : undefined"
        :aria-label="`打开会话 ${s.title}`"
        @click="onSelect(s.id)"
        @keydown.enter.prevent="onSelect(s.id)"
        @keydown.space.prevent="onSelect(s.id)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>
