<script setup lang="ts">
import { usePluginsStore } from "../stores/plugins.js";

const plugins = usePluginsStore();
</script>

<template>
  <section class="edge-line overflow-y-auto border-l bg-panel p-3">
    <h2 class="m-0 mb-3 text-sm text-fg">插件</h2>

    <p v-if="plugins.error" class="m-0 mb-3 text-xs text-danger">操作失败: {{ plugins.error }}</p>

    <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
      <li
        v-for="p in plugins.plugins"
        :key="p.id"
        class="flex flex-col gap-2 rounded-lg border border-[#2b3040] p-2.5"
        :class="p.status === 'active' ? '' : 'opacity-55'"
      >
        <div>
          <b class="text-fg">{{ p.name }}</b>
          <span class="ml-1 text-xs text-muted">v{{ p.version }}</span>
          <div class="mt-0.5 text-xs text-muted">{{ p.description ?? "" }}</div>
          <div
            class="mt-1 text-xs"
            :class="p.status === 'active' ? 'text-[#5ed6a4]' : 'text-muted'"
          >
            {{ p.status === "active" ? "运行中" : "已禁用" }}
          </div>
        </div>

        <div class="flex gap-1.5">
          <button class="btn-ghost flex-1" type="button" @click="plugins.reload(p.id)">重载</button>
          <button
            class="btn-ghost flex-1"
            type="button"
            @click="plugins.setEnabled(p.id, p.status !== 'active')"
          >
            {{ p.status === "active" ? "禁用" : "启用" }}
          </button>
          <button class="btn-ghost flex-1 text-danger" type="button" @click="plugins.unload(p.id)">
            卸载
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
