<template>
  <div
    class="provider-card flex w-full cursor-pointer select-none items-center gap-3 rounded-lg border-1 border-line px-3 py-2 transition-colors hover:bg-tint"
    :class="active ? 'border-line-strong bg-primary-soft' : ''"
  >
    <!--
      这里曾是一个空的 `.provider-icon` 占位 div——留一个谁也不填的盒子，
      结果就是每行左边空一块。图标是要按厂商分发的（AstrBot 引了 jsDelivr 的
      logo 集），本项目不引外部资源，所以直接省掉，用类型标签顶替。
    -->
    <n-tag
      :bordered="false"
      size="small"
      :type="provider.type === 'anthropic' ? 'warning' : 'info'"
    >
      {{ provider.type ?? "openai" }}
    </n-tag>
    <div class="flex min-w-0 flex-col">
      <div class="provider-name truncate font-bold">{{ provider.name || provider.id }}</div>
      <!-- 第二行原本也渲染 provider.name，两行一模一样等于白占一行 -->
      <div class="provider-baseurl truncate text-xs text-ink-muted">
        {{ provider.baseUrl || "默认地址" }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProviderSource } from "@/api/generated/index.js";
import type { PropType } from "vue";

defineProps({
  provider: {
    type: Object as PropType<ProviderSource>,
    required: true,
  },
  active: {
    type: Boolean,
    default: false,
  },
});
</script>
