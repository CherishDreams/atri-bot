<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ProfileRecord } from "@atri/shared";
import { useProfilesStore } from "../../stores/profiles";

/**
 * 还没选配置档时的选择器。
 *
 * 它**不替用户选一个**（连「只有一个候选就自动选中」也不做）：API 对缺 `profile` 一律 400，
 * 界面要是自己猜，就会出现「页面上是绿勾、请求其实一条都没落盘」。宁可让用户多点一次。
 *
 * 写回路由而不是存本地：当前配置档只能有一个真源，而它必须是可分享、可刷新、
 * 可前进后退的那一个。
 */
const route = useRoute();
const router = useRouter();
const profiles = useProfilesStore();

onMounted(() => {
  if (profiles.profiles.length === 0) void profiles.refresh();
});

function pick(value: string): void {
  void router.replace({ query: { ...route.query, profile: value } });
}
</script>

<template>
  <div class="mx-auto mt-16 w-full max-w-[420px] px-4">
    <h2 class="m-0 text-16px font-semibold text-ink">先选一份配置档</h2>
    <p class="mt-2 mb-4 text-13px leading-relaxed text-ink-muted">
      模型、工具与插件开关都按配置档各存一份。这里选的只影响这一份，不会改动其它配置档。
    </p>
    <n-select
      :value="null"
      :options="
        profiles.usable.map((p: ProfileRecord) => ({
          label: p.name === p.id ? p.id : `${p.name}（${p.id}）`,
          value: p.id,
        }))
      "
      :loading="profiles.loading"
      placeholder="选择配置档"
      consistent-menu-width
      @update:value="pick"
    />
    <p v-if="profiles.error" class="mt-3 text-13px text-danger">{{ profiles.error }}</p>
    <p
      v-else-if="!profiles.loading && profiles.usable.length === 0"
      class="mt-3 text-13px text-ink-faint"
    >
      还没有可用的配置档，去「配置档」页新建一份。
    </p>
  </div>
</template>
