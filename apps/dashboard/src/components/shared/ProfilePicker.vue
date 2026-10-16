<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ProfileRecord } from "@atri/shared";
import { useProfilesStore } from "../../stores/profiles";
import ManageProfilesModal from "@/components/config/ManageProfilesModal.vue";

/**
 * 还没选配置时的选择器。
 *
 * 这个组件**自己不选档** —— 自动补 `?profile=` 发生在路由守卫里（`router/index.ts`，
 * `default` 优先、否则第一份 `ready`），到这里还看得到它，说明**一份可用的都没有**。
 *
 * 职责分开是有理由的：守卫负责「有档就别烦人」，这里负责「没档时说清为什么并给出入口」。
 * 两者都不猜服务端 —— API 对缺 `profile` 一律 400，猜出来的档会让界面在一次 400 上显示绿勾。
 *
 * 空态里那个「管理配置」不是装饰：配置不单独占一页，切换器弹窗又只在「配置文件」页里，
 * 一份都没有时这里就是**唯一**能新建的入口。
 *
 * 写回路由而不是存本地：当前配置只能有一个真源，而它必须是可分享、可刷新、
 * 可前进后退的那一个。
 */
const route = useRoute();
const router = useRouter();
const profiles = useProfilesStore();
const manageOpen = ref(false);

onMounted(() => {
  if (profiles.profiles.length === 0) void profiles.refresh();
});

function pick(value: string): void {
  void router.replace({ query: { ...route.query, profile: value } });
}
</script>

<template>
  <div class="mx-auto mt-16 w-full max-w-[420px] px-4">
    <div class="rounded-2xl border-1 border-line bg-surface p-6 shadow-sm">
      <h2 class="m-0 text-[15px] font-semibold tracking-tight text-ink">先选一份配置</h2>
      <p class="mt-1.5 mb-4 text-13px leading-relaxed text-ink-muted">
        模型、工具与插件开关都按配置各存一份。这里选的只影响这一份，不会改动其它配置。
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
        placeholder="选择配置"
        consistent-menu-width
        @update:value="pick"
      />
      <p v-if="profiles.error" class="mt-3 text-13px text-danger">{{ profiles.error }}</p>
      <div v-else-if="!profiles.loading && profiles.usable.length === 0" class="mt-3">
        <p class="m-0 text-13px text-ink-faint">还没有可用的配置。</p>
        <n-button class="mt-2" size="small" type="primary" @click="manageOpen = true">
          管理配置
        </n-button>
      </div>

      <manage-profiles-modal v-model:show="manageOpen" />
    </div>
  </div>
</template>
