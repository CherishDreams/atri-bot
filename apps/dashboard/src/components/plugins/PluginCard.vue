<script setup lang="ts">
import { computed, ref } from "vue";
import type { PluginInfo } from "@/api/generated/index.js";
import { usePluginsStore } from "@/stores/plugins";

/**
 * 一张插件卡：是什么、现在什么状态、能对它做什么。
 *
 * 「重载 / 启用禁用 / 卸载」三个动作都直接打服务端并刷新列表，没有草稿；
 * 只有「配置」进抽屉，因为它有一组值需要先改完再一起保存。两种语义在界面上分开，
 * 不让人猜「点了这个按钮到底写没写盘」。
 */
const props = defineProps<{ plugin: PluginInfo; profile: string }>();
const emit = defineEmits<{ (e: "configure", plugin: PluginInfo): void }>();

const plugins = usePluginsStore();
const running = ref<"reload" | "toggle" | "unload" | null>(null);

const status = computed<"active" | "disabled" | "failed">(
  () => props.plugin.status ?? (props.plugin.enabled ? "active" : "disabled"),
);

const statusLabel = computed(() =>
  status.value === "active" ? "运行中" : status.value === "failed" ? "加载失败" : "已禁用",
);

const dotClass = computed(() =>
  status.value === "active"
    ? "bg-success"
    : status.value === "failed"
      ? "bg-danger"
      : "bg-ink-faint",
);

const statusClass = computed(() =>
  status.value === "active"
    ? "text-success"
    : status.value === "failed"
      ? "text-danger"
      : "text-ink-muted",
);

async function run(action: "reload" | "toggle" | "unload"): Promise<void> {
  if (running.value !== null) return;
  running.value = action;
  try {
    if (action === "reload") await plugins.reload(props.profile, props.plugin.id);
    else if (action === "unload") await plugins.unload(props.profile, props.plugin.id);
    else await plugins.setEnabled(props.profile, props.plugin.id, status.value !== "active");
  } finally {
    running.value = null;
  }
}
</script>

<template>
  <article
    class="atri-plugin-card flex flex-col gap-3 rounded-xl border-1 border-line bg-surface p-4 shadow-sm"
    :class="status === 'active' ? '' : 'opacity-80'"
  >
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <b class="truncate text-sm font-semibold text-ink">{{ plugin.name }}</b>
          <span class="text-xs text-ink-faint">v{{ plugin.version }}</span>
          <code class="rounded bg-tint px-1.5 py-0.5 text-xs text-ink-muted">{{ plugin.id }}</code>
        </div>
        <p v-if="plugin.description" class="mt-1.5 mb-0 text-xs leading-relaxed text-ink-muted">
          {{ plugin.description }}
        </p>
      </div>
      <span class="flex shrink-0 items-center gap-1.5 text-xs" :class="statusClass">
        <span class="h-1.5 w-1.5 rounded-full" :class="dotClass"></span>
        {{ statusLabel }}
      </span>
    </div>

    <!--
      失败原因只给操作者看：它可能带着插件目录的绝对路径。`ctx.plugins()` 的同伴视图
      刻意没有这个键，这一页是唯一该显示它的地方。
    -->
    <p
      v-if="status === 'failed' && plugin.error"
      class="m-0 rounded-lg border-1 border-danger/30 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger"
    >
      {{ plugin.error }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <n-button
        v-if="plugin.configurable"
        size="small"
        type="primary"
        secondary
        :disabled="running !== null"
        @click="emit('configure', plugin)"
      >
        配置
      </n-button>
      <span v-else class="text-xs text-ink-faint">没有配置项（缺少 _conf_schema.json）</span>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <n-button
          size="small"
          :loading="running === 'reload'"
          :disabled="running !== null && running !== 'reload'"
          @click="run('reload')"
        >
          重载
        </n-button>

        <!--
          失败记录上不给「启用」：`setEnabled(id, true)` 与「重载」是同一件事，
          而 `setEnabled(id, false)` 对 failed 是 no-op。留一个点了没反应的控件更糟。
        -->
        <n-button
          v-if="status !== 'failed'"
          size="small"
          :loading="running === 'toggle'"
          :disabled="running !== null && running !== 'toggle'"
          @click="run('toggle')"
        >
          {{ status === "active" ? "禁用" : "启用" }}
        </n-button>

        <n-button
          size="small"
          type="error"
          quaternary
          :loading="running === 'unload'"
          :disabled="running !== null && running !== 'unload'"
          @click="run('unload')"
        >
          卸载
        </n-button>
      </div>
    </div>
  </article>
</template>
