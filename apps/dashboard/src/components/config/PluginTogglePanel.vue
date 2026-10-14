<script setup lang="ts">
import { computed } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「插件」分类：这份档开不开某颗插件。
 *
 * 插件是**全局安装**的（`pluginDirs` 属于部署），这里改的只是「这份档要不要它」，
 * 所以界面必须说清 —— 否则会被读成「卸载」。启用会真的加载那颗插件，禁用会跑
 * `teardown()` 释放它，两者都由服务端在保存时逐颗执行。
 *
 * 三态与 AstrBot 的插件页同一套：`active` 运行中 / `disabled` 操作者关掉的 /
 * `failed` 上一次加载抛错了（目录还在，等一次重载）。`failed` 的那颗**不禁用开关**：
 * 再打开一次就是重试它，而藏起来会让人以为插件没了。
 */
const draft = useProfileConfigStore();
const plugins = computed(() => draft.loaded?.plugins ?? []);

/**
 * 标签说的是**此刻运行态**，开关说的是**草稿**，两者刻意分开：
 * 混在一起（比如「运行中（保存后）」）就没人分得清哪个是已经在跑的。
 */
function statusOf(status: string | undefined): { label: string; type: string } {
  if (status === "failed") return { label: "上次加载失败", type: "error" };
  if (status === "active") return { label: "运行中", type: "success" };
  return { label: "已关闭", type: "default" };
}

/** 上一次保存里这一颗没能生效的原因（只在那一批里出现，下一次保存会重算）。 */
function failureOf(id: string): string | null {
  return draft.failed.find((f) => f.id === id)?.error ?? null;
}
</script>

<template>
  <ConfigCard
    title="插件"
    hint="插件是全局安装的，这里只决定这份配置档开不开它 —— 关掉不等于卸载，代码与它的数据目录都还在。"
  >
    <n-empty v-if="plugins.length === 0" description="还没有安装任何插件" size="small" />
    <ConfigItem
      v-for="plugin in plugins"
      :key="plugin.id"
      :label="plugin.name"
      :code="`${plugin.id} · v${plugin.version}`"
      :hint="plugin.description"
      :dirty="draft.pluginDirty(plugin.id)"
    >
      <template #control>
        <div class="flex flex-col items-end gap-1">
          <div class="flex items-center gap-2">
            <n-tag size="tiny" :type="statusOf(plugin.status).type">
              {{ statusOf(plugin.status).label }}
            </n-tag>
            <n-switch
              :value="draft.pluginEnabled(plugin.id)"
              size="small"
              :aria-label="`启用 ${plugin.name}`"
              @update:value="(on: boolean) => draft.setPlugin(plugin.id, on)"
            />
          </div>
          <!-- 失败原因必须露出来，而且要说清是**上一次保存**没成，不是草稿错了：
               这两件事的下一步动作完全不同（一个去修插件，一个再点一次保存）。 -->
          <span v-if="failureOf(plugin.id)" class="text-xs text-danger">
            上次保存没能生效：{{ failureOf(plugin.id) }}
          </span>
          <span v-else-if="plugin.status === 'failed' && plugin.error" class="text-xs text-danger">
            {{ plugin.error }}
          </span>
        </div>
      </template>
    </ConfigItem>
  </ConfigCard>
</template>
