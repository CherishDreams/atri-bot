<script setup lang="ts">
import { usePluginsStore } from "../stores/plugins.js";

const plugins = usePluginsStore();
/** 同 `Conversation.vue`：由闸门内的父层传入，切的是**这份配置档**开不开它。 */
const props = defineProps<{ profile: string }>();
</script>

<template>
  <section class="overflow-y-auto border-l-1 border-line bg-surface p-3">
    <h2 class="m-0 mb-3 px-1 text-13px font-semibold tracking-tight text-ink">插件</h2>

    <p v-if="plugins.error" class="m-0 mb-3 text-xs text-danger">操作失败: {{ plugins.error }}</p>

    <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
      <li
        v-for="p in plugins.plugins"
        :key="p.id"
        class="flex flex-col gap-2.5 rounded-xl border-1 border-line bg-surface p-3 shadow-sm"
        :class="p.status === 'active' ? '' : 'opacity-60'"
      >
        <div>
          <div class="flex items-center gap-1.5">
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="
                p.status === 'active'
                  ? 'bg-success'
                  : p.status === 'failed'
                    ? 'bg-danger'
                    : 'bg-ink-faint'
              "
            ></span>
            <b class="text-sm text-ink">{{ p.name }}</b>
            <span class="text-xs text-ink-faint">v{{ p.version }}</span>
          </div>
          <div class="mt-1 text-xs leading-relaxed text-ink-muted">{{ p.description ?? "" }}</div>
          <!--
            三档而不是「active / 其它」两档：`failed` 是上一次加载抛错了，它既没在运行、
            也不是操作者关掉的。把 failed 显示成「已禁用」是在说「你把它关了」，
            而真实情况是「它起不来」—— 用户会去点启用，然后什么都不发生。
          -->
          <div
            class="mt-1 text-xs"
            :class="
              p.status === 'active'
                ? 'text-success'
                : p.status === 'failed'
                  ? 'text-danger'
                  : 'text-ink-muted'
            "
          >
            {{ p.status === "active" ? "运行中" : p.status === "failed" ? "加载失败" : "已禁用" }}
          </div>
          <div v-if="p.status === 'failed'" class="mt-1 text-xs text-danger">
            {{ p.error }}
          </div>
        </div>

        <div class="flex gap-1.5">
          <button
            class="btn-ghost flex-1"
            type="button"
            @click="plugins.reload(props.profile, p.id)"
          >
            重载
          </button>
          <!--
            失败记录上不给「启用」按钮：`setEnabled(id, false)` 对 failed 是刻意 no-op
            （它没有运行期资源可释放，标成 disabled 只会把诊断藏起来），而 `setEnabled(id, true)`
            与「重载」是同一件事。留着这个按钮只会多一条点了没反应的控件。
          -->
          <button
            v-if="p.status !== 'failed'"
            class="btn-ghost flex-1"
            type="button"
            @click="plugins.setEnabled(props.profile, p.id, p.status !== 'active')"
          >
            {{ p.status === "active" ? "禁用" : "启用" }}
          </button>
          <button
            class="btn-ghost flex-1 text-danger"
            type="button"
            @click="plugins.unload(props.profile, p.id)"
          >
            卸载
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
