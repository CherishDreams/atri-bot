<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { PluginInfo } from "@/api/generated/index.js";
import { useProfile } from "@/composables/useProfile";
import { usePluginsStore } from "@/stores/plugins";
import { usePluginSettingsStore } from "@/stores/pluginSettings";
import { useProfilesStore } from "@/stores/profiles";
import ProfileSwitcher from "@/components/config/ProfileSwitcher.vue";
import PluginCard from "@/components/plugins/PluginCard.vue";
import PluginConfigDrawer from "@/components/plugins/PluginConfigDrawer.vue";

/**
 * 插件页：已安装的插件、它们在这份配置里的启用状态，以及 schema 驱动的配置。
 *
 * 页壳与「接入平台」同形：整页自己滚动，内容列限宽。
 *
 * **配置切换就在这一页**：插件启停与插件配置都按配置档隔离，切完还要去别的页面
 * 才能换一份配置，等于让用户走一条没有必要的往返。切换器复用配置工作台那一个，
 * 所以「当前是哪一份、哪些不可用」只有一处实现。
 *
 * 与工作台不同，这里没有页面级草稿，唯一会丢的是抽屉里未保存的那几个值：
 * 抽屉脏时不允许切配置，先保存或关掉抽屉再切。这是本页唯一的拦截，且只说这一件事。
 */
const route = useRoute();
const router = useRouter();
const { profile } = useProfile();
const plugins = usePluginsStore();
const settings = usePluginSettingsStore();
const profiles = useProfilesStore();

const drawerOpen = ref(false);
const editing = ref<PluginInfo | null>(null);
const switchError = ref<string | null>(null);

const drawerDirty = computed(() => drawerOpen.value && settings.dirty);

function openConfig(plugin: PluginInfo): void {
  editing.value = plugin;
  drawerOpen.value = true;
}

function clearSwitchError(): void {
  switchError.value = null;
}

function switchProfile(id: string): void {
  if (id === profile.value) return;
  if (drawerDirty.value) {
    switchError.value = "插件配置还有未保存的改动，请先保存或关闭配置抽屉，再切换配置。";
    return;
  }
  switchError.value = null;
  void router.replace({ query: { ...route.query, profile: id } });
}

/** 配置本身的增删仍在工作台：这里只负责把用户送到管理入口。 */
function manageProfiles(): void {
  if (drawerDirty.value) {
    switchError.value = "插件配置还有未保存的改动，请先保存或关闭配置抽屉，再管理配置。";
    return;
  }
  switchError.value = null;
  void router.push({
    name: "config",
    query: profile.value === null ? {} : { profile: profile.value },
  });
}

watch(drawerDirty, (dirty) => {
  if (!dirty) switchError.value = null;
});

watch(
  profile,
  (pid) => {
    // 换配置时抽屉里那份草稿属于上一份配置：关掉并清空，不能让它跟着 URL 一起漂。
    drawerOpen.value = false;
    editing.value = null;
    switchError.value = null;
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

        <div class="ml-auto flex shrink-0 items-center">
          <ProfileSwitcher
            :current="profile"
            :dirty="drawerDirty"
            @switch="switchProfile"
            @manage="manageProfiles"
          />
        </div>
      </header>

      <n-alert
        v-if="switchError"
        type="warning"
        class="mb-4"
        :show-icon="false"
        closable
        @close="clearSwitchError"
      >
        {{ switchError }}
      </n-alert>

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
