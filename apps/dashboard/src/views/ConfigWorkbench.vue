<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { useProfile } from "@/composables/useProfile";
import { useProfileConfigStore } from "@/stores/profileConfig";
import { useProfilesStore } from "@/stores/profiles";
import CategoryNav from "@/components/config/CategoryNav.vue";
import ConfigToolbar from "@/components/config/ConfigToolbar.vue";
import ManageProfilesModal from "@/components/config/ManageProfilesModal.vue";
import SaveButton from "@/components/config/SaveButton.vue";
import UnsavedModal from "@/components/config/UnsavedModal.vue";
import DefaultModelPanel from "@/components/config/DefaultModelPanel.vue";
import RuntimePanel from "@/components/config/RuntimePanel.vue";
import ToolListPanel from "@/components/config/ToolListPanel.vue";
import { categoryOf, matches } from "@/components/config/categories";

/**
 * 配置文件页（`/config`，AstrBot 的「配置文件」）。
 *
 * 形状：顶部工具条（左上角是当前配置 + 切换；右侧搜索）→ 左侧分类菜单 →
 * 右侧这一类的配置项卡片 → 右下角浮动保存键。
 *
 * **这里只有本档的三类**（默认模型 / 工具 / 运行参数）。供应商与接入平台是
 * 部署级全局一份，各自是主导航里的整页 —— 见 `categories.ts` 里那段为什么不能合进来。
 *
 * ## 保存语义
 *
 * 页内编辑只改草稿（`stores/profileConfig.ts`），点「保存」才一次写回。**这是与仓库其余
 * 部分相反的**：供应商、插件页那些都是一改就发请求。差别不是随意的：
 * 那几样是「一次动作」，而这里是一组互相有关联的开关，用户需要能反悔着改完再一起确认。
 * 代价是必须把「还没保存」这件事做实 —— 脏点、保存键、离开拦截三处都要在，
 * 否则「改了但没生效」会没有任何症状。
 *
 * ## 为什么分类进 URL（`?cat=`）
 *
 * 与 `?profile=` 同一条理由：刷新、前进后退、贴给别人一条链接都该落在同一页。
 * 而**只改 `?cat=` 不会触发 `onBeforeRouteLeave`**（同一条 route record，vue-router
 * 不跑离开守卫），所以切分类不会被未保存弹窗打断 —— 那是刻意的，切分类不丢草稿。
 */
const route = useRoute();
const router = useRouter();
const { profile } = useProfile();
const draft = useProfileConfigStore();
const profiles = useProfilesStore();

const keyword = ref("");
const manageOpen = ref(false);
const unsavedOpen = ref(false);
/** 弹窗背后的意图：要去哪一份档 / 或要离开到哪个地址。二者至多一个。 */
const pendingProfile = ref<string | null>(null);
const pendingTarget = ref<string | null>(null);

const active = computed(() => categoryOf(route.query.cat));

/**
 * 上一版把供应商 / 接入平台当成工作台的「全局」分类；那时留下的链接（`?cat=providers`）
 * 现在各自是独立页。转过去而不是让 `categoryOf` 兜底到「默认模型」—— 后者会静默把人
 * 送到错的分类上。
 */
const LEGACY_CATEGORY_ROUTE: Record<string, string> = {
  providers: "providers",
  adapters: "adapters",
};
const legacyTarget = LEGACY_CATEGORY_ROUTE[String(route.query.cat ?? "")];
if (legacyTarget !== undefined) void router.replace({ name: legacyTarget });

const PANELS = {
  model: DefaultModelPanel,
  tools: ToolListPanel,
  runtime: RuntimePanel,
} as const;
const panel = computed(() => PANELS[active.value.key as keyof typeof PANELS]);

/**
 * 左菜单里哪些分类还有命中项。搜索对三类都生效，且与各面板自己的过滤用同一个
 * `matches()` —— 两处各写一遍的话，迟早出现「菜单灰着而点进去有结果」。
 */
const matched = computed<Record<string, boolean>>(() => {
  const k = keyword.value;
  const loaded = draft.loaded;
  return {
    model: matches(k, "默认模型", "对话模型", loaded?.defaultProviderId ?? ""),
    tools: (loaded?.tools ?? []).some((t) => matches(k, t.name, t.id, t.description)),
    runtime: matches(k, "运行参数", "maxToolSteps", "单轮工具步数"),
  };
});

/** 载入草稿。换档之后重来 —— 草稿属于上一份档这件事不能带过去。 */
watch(
  profile,
  (pid) => {
    if (pid !== null) void draft.load(pid);
  },
  { immediate: true },
);

function goCategory(key: string): void {
  // `replace`：切分类不是一步可回退的导航，留着它按一次后退只是回到上一个分类。
  void router.replace({ query: { ...route.query, cat: key } });
}

function goProfile(id: string): void {
  // 与路由守卫补 `?profile=` 用同一个动作：URL 是当前档的唯一真源。
  void router.replace({ query: { ...route.query, profile: id } });
}

async function save(): Promise<boolean> {
  if (profile.value === null) return false;
  const ok = await draft.save(profile.value);
  if (ok) {
    // 顶栏与档列表上的 `defaultProviderId` 也要跟着变，否则同一件事在界面上有两个答案。
    await profiles.refresh();
  }
  return ok;
}

function requestSwitch(id: string): void {
  if (id === profile.value) return;
  pendingProfile.value = id;
  if (!draft.dirty) {
    goProfile(id);
    pendingProfile.value = null;
    return;
  }
  unsavedOpen.value = true;
}

function resetPending(): void {
  pendingProfile.value = null;
  pendingTarget.value = null;
}

function proceed(): void {
  const target = pendingTarget.value;
  const next = pendingProfile.value;
  resetPending();
  unsavedOpen.value = false;
  if (target) void router.push(target);
  else if (next) goProfile(next);
}

async function onUnsavedSave(): Promise<void> {
  if (await save()) proceed();
}

function onUnsavedDiscard(): void {
  draft.discard();
  proceed();
}

function onUnsavedStay(): void {
  resetPending();
  unsavedOpen.value = false;
}

/**
 * 离开这一页（去控制台、去 chat…）时拦一道。
 *
 * **切档不会走到这里**：`?profile=` 变化仍是同一条 route record，vue-router 不跑
 * 离开守卫 —— 所以 `requestSwitch` 必须自己走同一个弹窗（AstrBot 那边也是这个形状）。
 */
onBeforeRouteLeave((to) => {
  if (!draft.dirty) return true;
  pendingTarget.value = to.fullPath;
  unsavedOpen.value = true;
  return false;
});
</script>

<template>
  <div class="atri-config-workbench relative flex h-full min-h-0 flex-col bg-canvas">
    <ConfigToolbar
      :current="profile"
      :dirty="draft.dirty"
      @switch="requestSwitch"
      @manage="manageOpen = true"
      @update:keyword="keyword = $event"
    />

    <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
      <CategoryNav :active="active.key" :matched="matched" @select="goCategory" />

      <!--
        `min-h-0` 是必需的：flex 子项默认 min-height:auto，内容一长就把这一列撑出容器，
        于是「右侧自己滚动」失效、整页跟着滚，浮动保存键也跟着跑。本仓在别处踩过同类。
      -->
      <main class="relative min-h-0 min-w-0 flex-1">
        <div class="h-full overflow-y-auto">
          <div class="mx-auto max-w-[58rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
            <header class="mb-5">
              <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">
                {{ active.label }}
              </h2>
              <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">{{ active.hint }}</p>
            </header>

            <n-alert
              v-if="draft.error"
              type="error"
              class="mb-4"
              :show-icon="false"
              closable
              @close="draft.clearError()"
            >
              {{ draft.error }}
            </n-alert>

            <n-spin :show="draft.loading">
              <n-empty
                v-if="!draft.loading && !draft.loaded"
                description="这一份配置当前不可用，原因见「管理配置」里的那一行"
              />
              <component :is="panel" v-else :keyword="keyword" />
            </n-spin>
          </div>
        </div>
      </main>
    </div>

    <!-- 三类都是「先改草稿、再统一保存」，所以保存键常驻。供应商那边是另一个页面、
         即时生效，不会让人在两套写入语义之间猜。 -->
    <save-button :dirty="draft.dirty" :saving="draft.saving" @save="save" />

    <unsaved-modal
      v-model:show="unsavedOpen"
      :saving="draft.saving"
      :error="draft.error"
      @save="onUnsavedSave"
      @discard="onUnsavedDiscard"
      @update:show="(v: boolean) => (v ? (unsavedOpen = true) : onUnsavedStay())"
    />
    <manage-profiles-modal v-model:show="manageOpen" />
  </div>
</template>
