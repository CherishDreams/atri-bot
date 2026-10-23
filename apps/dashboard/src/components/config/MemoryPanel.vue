<script setup lang="ts">
import { computed } from "vue";
import type { MemoryConfig } from "@/api/generated/index.js";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「记忆」分类：长期记忆的开关与方案选择。
 *
 * 这是「可替换组件」的配置口：`memory.provider` 指向内置实现或某个插件声明的
 * 记忆供应商。服务端一次请求只选一个 provider、缺失不降级 —— 所以下拉框只列
 * 此刻真的可选项（`memoryProviders`），选中「缺失的方案」这个状态在界面上不存在。
 */
const draft = useProfileConfigStore();

const providerOptions = computed(() =>
  (draft.loaded?.memoryProviders ?? ["builtin"]).map((id) => ({
    label: id === "builtin" ? "内置（关键词 + 时间衰减）" : `插件：${id}`,
    value: id,
  })),
);

function itemDirty(key: keyof MemoryConfig): boolean {
  return (
    draft.draft !== null &&
    draft.original !== null &&
    draft.draft.memory[key] !== draft.original.memory[key]
  );
}

const topK = computed<number | null>({
  get: () => draft.draft?.memory.topK ?? null,
  set: (next) => {
    // 清空等于「这次不改」：null 写进草稿会让保存撞上 400（服务端要求 1–10 整数）。
    if (typeof next === "number") draft.setMemoryTopK(next);
  },
});
</script>

<template>
  <ConfigCard
    title="记忆"
    hint="长期记忆让机器人能记得跨会话的事情。方案可替换：内置实现不够用时，装一个提供记忆模块的插件，回到这里切换。"
  >
    <ConfigItem
      label="启用记忆"
      code="memory.enabled"
      hint="关闭后不再注入历史记忆，也不再自动记录新的交互。"
      :dirty="itemDirty('enabled')"
    >
      <template #control>
        <n-switch
          :value="draft.draft?.memory.enabled ?? false"
          aria-label="启用记忆"
          @update:value="(v: boolean) => draft.setMemoryEnabled(v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="记忆方案"
      code="memory.provider"
      hint="内置方案把记忆存在本地会话库里，按关键词召回；插件方案由插件自决存储与检索方式。"
      :dirty="itemDirty('provider')"
    >
      <template #control>
        <n-select
          :value="draft.draft?.memory.provider ?? 'builtin'"
          :options="providerOptions"
          size="small"
          class="w-[16rem]"
          aria-label="记忆方案"
          @update:value="(v: string) => draft.setMemoryProvider(v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="每轮注入条数"
      code="memory.topK"
      hint="每轮对话最多召回几条相关记忆放进上下文。1–10，默认 3。"
      :dirty="itemDirty('topK')"
    >
      <template #control>
        <n-input-number
          :value="topK"
          :min="1"
          :max="10"
          :step="1"
          size="small"
          class="w-[8rem]"
          aria-label="每轮注入条数"
          @update:value="(next: number | null) => (topK = next)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="自动记录交互"
      code="memory.autoRecord"
      hint="每轮对话后把「用户说了什么、机器人答了什么」存为一条记忆。模型也可以用 memory_write 工具显式记事实（在工具分类里开启）。"
      :dirty="itemDirty('autoRecord')"
    >
      <template #control>
        <n-switch
          :value="draft.draft?.memory.autoRecord ?? false"
          aria-label="自动记录交互"
          @update:value="(v: boolean) => draft.setMemoryAutoRecord(v)"
        />
      </template>
    </ConfigItem>

    <template #footer>
      记忆与对话历史是两回事：历史完整存在会话库里，只在本会话内；记忆是按关键词检索的
      长期事实，跨会话生效。改完要点「保存」，下一条消息才按新设置走。
    </template>
  </ConfigCard>
</template>
