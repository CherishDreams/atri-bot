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

    <ul class="m-0 flex-1 list-none overflow-y-auto p-0">
      <li
        v-for="s in sessions.sessions"
        :key="s.id"
        class="row-base cursor-pointer px-2 py-1.5 text-ink-muted hover:text-ink"
        :class="s.id === sessions.active?.id ? 'row-active' : ''"
        @click="onSelect(s.id)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>
