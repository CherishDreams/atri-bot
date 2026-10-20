<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AdapterInfo } from "@/api/client.js";
import * as api from "@/api/client.js";
import { useProfile } from "@/composables/useProfile";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";
import { matches } from "./categories";

/**
 * 「访问控制」分类：**这一档**的白名单与管理员名单。
 *
 * 名单属于配置档，不属于适配器实例：绑定到这一档的所有平台共用它，换一档就是
 * 另一张。所以编辑只改草稿，和本档其他分类一起点保存；保存后绑定适配器的
 * 下一条消息立刻按新名单判断，不需要重启长连接。
 *
 * 下方列出绑定到本档的接入平台，是为了让「这张名单对谁生效」在界面上有个答案 ——
 * 否则用户只能从「接入平台」页的那一列反推。
 */
const props = defineProps<{ keyword: string }>();

const draft = useProfileConfigStore();
const { profile } = useProfile();
const adapters = ref<AdapterInfo[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const boundAdapters = computed(() => {
  const pid = profile.value;
  if (pid === null) return [];
  return adapters.value.filter((adapter) => adapter.profile === pid);
});

const visibleAdapters = computed(() =>
  boundAdapters.value.filter((adapter) =>
    matches(props.keyword, adapter.name, adapter.id, adapter.type),
  ),
);

onMounted(async () => {
  try {
    adapters.value = (await api.listAdapters()).adapters;
  } catch (err) {
    loadError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

const whitelistEnabled = computed<boolean>({
  get: () => draft.draft?.access.whitelistEnabled ?? false,
  set: (next) => draft.setAccessWhitelist(next),
});
const allowedIds = computed<string[]>({
  get: () => draft.draft?.access.allowedIds ?? [],
  set: (next) => draft.setAccessAllowedIds(next),
});
const adminIds = computed<string[]>({
  get: () => draft.draft?.access.adminIds ?? [],
  set: (next) => draft.setAccessAdminIds(next),
});

const whitelistDirty = computed(
  () => draft.draft?.access.whitelistEnabled !== draft.original?.access.whitelistEnabled,
);
const allowedDirty = computed(() => {
  const before = draft.original?.access.allowedIds ?? [];
  const after = draft.draft?.access.allowedIds ?? [];
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
});
const adminDirty = computed(() => {
  const before = draft.original?.access.adminIds ?? [];
  const after = draft.draft?.access.adminIds ?? [];
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
});
</script>

<template>
  <div class="atri-access-panel">
    <ConfigCard
      title="准入控制"
      hint="白名单按私聊发送人 id 或群 id 判断，管理员始终越过白名单。名单按配置档保存，绑定到本档的平台共用。"
    >
      <ConfigItem
        label="启用白名单"
        hint="关闭时所有人可用；开启后名单外的消息会在进入引擎前被丢弃。"
        :dirty="whitelistDirty"
      >
        <template #control>
          <n-switch v-model:value="whitelistEnabled" size="small" />
        </template>
      </ConfigItem>

      <div class="border-t-1 border-line py-3.5">
        <div class="flex items-center gap-2">
          <span class="font-medium text-ink">白名单</span>
          <span
            v-if="allowedDirty"
            class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
            title="这一项改过，还没保存"
          ></span>
        </div>
        <p class="mt-1 mb-2 text-xs leading-relaxed text-ink-muted">
          每行一个 id：私聊填用户 id，群聊填群 id。管理员会自动越过这一张表。
        </p>
        <n-dynamic-tags v-model:value="allowedIds" :max="500" :disabled="!whitelistEnabled" />
      </div>

      <div class="border-t-1 border-line py-3.5">
        <div class="flex items-center gap-2">
          <span class="font-medium text-ink">管理员名单</span>
          <span
            v-if="adminDirty"
            class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
            title="这一项改过，还没保存"
          ></span>
        </div>
        <p class="mt-1 mb-2 text-xs leading-relaxed text-ink-muted">
          管理员用户 id。管理员始终越过白名单，可在白名单误配时救回访问。
        </p>
        <n-dynamic-tags v-model:value="adminIds" :max="100" />
      </div>

      <template #footer>
        名单写在本档的
        <code>config.json</code>
        里；点「保存」后，绑定到这一档的适配器下一条消息立即按新名单判断。
      </template>
    </ConfigCard>

    <ConfigCard
      title="绑定到本档的接入平台"
      hint="这些实例共用上面那张名单；它们的平台坐标（用户 id / 群 id）因此也共用同一套判断。"
    >
      <n-alert v-if="loadError" type="error" :show-icon="false" class="mb-3">
        {{ loadError }}
      </n-alert>
      <n-spin :show="loading">
        <n-empty
          v-if="!loading && visibleAdapters.length === 0"
          :description="
            boundAdapters.length === 0 ? '还没有接入平台绑定到这一档' : '没有匹配的接入平台'
          "
        >
          <template v-if="boundAdapters.length === 0" #extra>
            <router-link
              :to="{ name: 'adapters' }"
              class="text-sm text-primary hover:text-primary-hover"
            >
              去「接入平台」页添加或绑定
            </router-link>
          </template>
        </n-empty>
        <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
          <li
            v-for="adapter in visibleAdapters"
            :key="adapter.id"
            class="flex flex-wrap items-center gap-2 rounded-lg bg-raised px-3 py-2.5"
          >
            <span class="font-medium text-ink">{{ adapter.name }}</span>
            <code class="text-xs text-ink-faint">{{ adapter.id }}</code>
            <span class="text-xs text-ink-muted">{{ adapter.type }}</span>
            <span
              class="ml-auto text-[11px]"
              :class="adapter.running ? 'text-success' : 'text-ink-faint'"
            >
              {{ adapter.running ? "运行中" : adapter.bound ? "已绑定，未运行" : "配置档不可用" }}
            </span>
          </li>
        </ul>
      </n-spin>
    </ConfigCard>
  </div>
</template>
