<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { AdapterInfo } from "@/api/client.js";
import * as api from "@/api/client.js";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「接入平台」页的主体（`views/AdaptersView.vue` 挂载）。**只读** —— 这是全站唯一一个
 * 不能改配置的页面，原因写在这里而不是留给用户猜：`adapters.<id>.enabled` / `.profile`
 * 住在部署级的 `atri.config.json`，服务端今天只有 `GET /adapters`，没有写端点。
 * 等真有适配器实现时再补写路径。
 *
 * 列表里空是**常态**：这个仓库还没有任何适配器实现，所以「一张空表 + 一句为什么」
 * 比一片空白诚实得多。
 */
const adapters = ref<AdapterInfo[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);

onMounted(async () => {
  loading.value = true;
  try {
    adapters.value = (await api.listAdapters()).adapters;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

function tagsOf(adapter: AdapterInfo): { label: string; type: "success" | "default" | "error" }[] {
  // `enabled` 与 `bound` 是两件事：没关掉 ≠ 在收流量。两个都为真才是真的在跑。
  const out: { label: string; type: "success" | "default" | "error" }[] = [
    adapter.enabled ? { label: "已启用", type: "default" } : { label: "未启用", type: "default" },
  ];
  if (!adapter.profile) out.push({ label: "没绑配置", type: "error" });
  else if (adapter.bound) out.push({ label: `跑在「${adapter.profile}」`, type: "success" });
  else out.push({ label: `绑的「${adapter.profile}」当前不可用`, type: "error" });
  return out;
}
</script>

<template>
  <ConfigCard
    title="接入平台"
    hint="外部平台（QQ、Discord、webhook…）跑在哪份配置上。这一类此刻只读：配置在部署级的 atri.config.json 里。"
  >
    <n-alert v-if="error" type="error" class="mb-3" :show-icon="false">{{ error }}</n-alert>
    <n-spin :show="loading">
      <n-empty
        v-if="!loading && adapters.length === 0"
        description="还没有接入平台实现 —— 仓库里目前没有任何适配器，这一页是留给它的位置"
        size="small"
      />
      <ConfigItem
        v-for="adapter in adapters"
        :key="adapter.id"
        :label="adapter.name"
        :code="adapter.id"
        :hint="`绑定的配置：${adapter.profile ?? '未绑定'}。绑定不可用时它不会启动，也不会退回 default。`"
      >
        <template #control>
          <n-tag v-for="tag in tagsOf(adapter)" :key="tag.label" size="tiny" :type="tag.type">
            {{ tag.label }}
          </n-tag>
        </template>
      </ConfigItem>
    </n-spin>
    <template #footer>
      要改接入平台，请编辑 <code class="text-xs">atri.config.json</code> 的
      <code class="text-xs">adapters</code> 段；改动需要重启服务。
    </template>
  </ConfigCard>
</template>
