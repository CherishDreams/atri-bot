<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { PluginInfo } from "@/api/generated/index.js";
import { useProfile } from "@/composables/useProfile";
import { usePluginsStore } from "@/stores/plugins";
import { useProfilesStore } from "@/stores/profiles";
import PluginCard from "@/components/plugins/PluginCard.vue";
import PluginConfigDrawer from "@/components/plugins/PluginConfigDrawer.vue";

/**
 * 插件页：已安装的插件、它们在这份配置里的启用状态，以及 schema 驱动的配置。
 *
 * 页壳与「接入平台」同形：整页自己滚动，内容列限宽。**切配置仍只在配置文件页做** ——
 * 这里只给一条去那边的链接，不在这里再养一份切档与未保存拦截。
 */
const { profile } = useProfile();
const plugins = usePluginsStore();
const profiles = useProfilesStore();

const drawerOpen = ref(false);
const editing = ref<PluginInfo | null>(null);

const currentName = computed(
  () =>
    profiles.profiles.find((p) => p.id === profile.value)?.name ?? profile.value ?? "未选择配置",
);

const configTarget = computed(() =>
  profile.value === null
    ? { name: "config" }
    : { name: "config", query: { profile: profile.value } },
);

function openConfig(plugin: PluginInfo): void {
  editing.value = plugin;
  drawerOpen.value = true;
}

watch(
  profile,
  (pid) => {
    // 换配置时抽屉里那份草稿属于上一份配置：关掉并清空，不能让它跟着 URL 一起漂。
    drawerOpen.value = false;
    editing.value = null;
    if (pid !== null) void plugins.refresh(pid);
  },
  { immediate: true },
);

async function refreshAfterSave(): Promise<void> {
  if (profile.value !== null) await plugins.refresh(profile.value);
}

// 顶栏的配置名来自 `GET /profiles`。深链进入时守卫通常已经拉过，这里兜住「列表为空」的刷新。
if (profiles.profiles.length === 0 && !profiles.loading) void profiles.refresh();
</script>

<template>
  <div class="atri-plugins-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[58rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">插件</h2>
          <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
            已安装的插件与它们在这份配置里的启用状态。带
            <code class="text-xs">_conf_schema.json</code>
            的插件可以直接在这里配置，保存后自动重载。
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>
            当前配置：<b class="text-ink">{{ currentName }}</b>
          </span>
          <RouterLink
            :to="configTarget"
            class="cursor-pointer rounded text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            去配置文件页切换
          </RouterLink>
        </div>
      </header>

      <n-alert
        v-if="plugins.error"
        type="error"
        class="mb-4"
        :show-icon="false"
        closable
        @close="plugins.clearError()"
      >
        操作失败：{{ plugins.error }}
      </n-alert>

      <n-empty
        v-if="profile === null"
        description="没有可用的配置，先去「配置文件」页创建或修复一份"
      />

      <n-spin v-else :show="plugins.loading">
        <n-empty
          v-if="!plugins.loading && plugins.plugins.length === 0"
          description="插件目录里还没有插件 —— 把插件放到部署级 pluginDirs 指向的位置后重启服务"
        />
        <div v-else class="flex flex-col gap-3">
          <PluginCard
            v-for="plugin in plugins.plugins"
            :key="plugin.id"
            :plugin="plugin"
            :profile="profile"
            @configure="openConfig"
          />
        </div>
      </n-spin>
    </div>

    <PluginConfigDrawer
      v-model:show="drawerOpen"
      :profile="profile"
      :plugin="editing"
      @saved="refreshAfterSave"
    />
  </div>
</template>
