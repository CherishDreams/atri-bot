<script setup lang="ts">
import { computed } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「工具」分类：这一档开哪些工具。
 *
 * 目录与说明来自 `GET /profiles/{id}/config` 的 `tools`（与 `GET /tools` 同一份计算），
 * 所以这里不再抄一遍名称/描述；开关改动只落在草稿里，按「保存」才写回档文件。
 */
const draft = useProfileConfigStore();
const tools = computed(() => draft.loaded?.tools ?? []);
const enabledCount = computed(() => tools.value.filter((t) => draft.toolEnabled(t.id)).length);
</script>

<template>
  <ConfigCard
    title="工具"
    hint="工具是能力授予：默认全部关闭，开一颗就是让模型多一件它能做的事。改动在点「保存」后写进这一档的文件。"
  >
    <n-empty v-if="tools.length === 0" description="没有注册任何工具" size="small" />
    <ConfigItem
      v-for="tool in tools"
      :key="tool.id"
      :label="tool.name"
      :code="tool.id"
      :hint="tool.description"
      :dirty="draft.toolDirty(tool.id)"
    >
      <template #control>
        <n-tag size="tiny" :type="draft.toolEnabled(tool.id) ? 'success' : 'default'">
          {{ draft.toolEnabled(tool.id) ? "已启用" : "已禁用" }}
        </n-tag>
        <!-- 判据是 `=== true`（服务端 `ToolConfigStore` 那条）：没写、写歪都算禁用。
             这里不必再判一次 —— 草稿的初始值就是服务端算出来的结果。 -->
        <n-switch
          :value="draft.toolEnabled(tool.id)"
          size="small"
          :aria-label="`启用 ${tool.name}`"
          @update:value="(on: boolean) => draft.setTool(tool.id, on)"
        />
      </template>
    </ConfigItem>
    <template #footer> 已启用 {{ enabledCount }} / {{ tools.length }} </template>
  </ConfigCard>
</template>
