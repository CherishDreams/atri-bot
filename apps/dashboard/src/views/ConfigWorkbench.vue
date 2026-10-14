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
import AdaptersPanel from "@/components/config/AdaptersPanel.vue";
import DefaultModelPanel from "@/components/config/DefaultModelPanel.vue";
import PluginTogglePanel from "@/components/config/PluginTogglePanel.vue";
import ProvidersPanel from "@/components/config/ProvidersPanel.vue";
import RuntimePanel from "@/components/config/RuntimePanel.vue";
import ToolListPanel from "@/components/config/ToolListPanel.vue";
import { categoryOf, matches } from "@/components/config/categories";

/**
 * 配置工作台（AstrBot 的「配置文件」页）。
 *
 * 形状：顶部工具条（左上角是当前配置档 + 切换；右侧搜索）→ 左侧分类菜单（分「本配置档」
 * 与「全局」两组）→ 右侧这一类的配置项卡片 → 右下角浮动保存键。
 *
 * ## 保存语义
 *
 * 页内编辑只改草稿（`stores/profileConfig.ts`），点「保存」才一次写回。**这是与仓库其余
 * 部分相反的**：供应商、插件重载、档重命名那些都是一改就发请求。差别不是随意的：
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

const PANELS = {
  model: DefaultModelPanel,
  tools: ToolListPanel,
  plugins: PluginTogglePanel,
  runtime: RuntimePanel,
  providers: ProvidersPanel,
  adapters: AdaptersPanel,
} as const;
const panel = computed(() => PANELS[active.value.key as keyof typeof PANELS]);

/**
 * 左菜单里哪些分类还有命中项。搜索**只作用于「本配置档」那组**（全局那两页是完整
 * 工作台 / 只读表，不做行级过滤），所以它们永远算命中 —— 否则搜索时菜单会把它们灰掉，
 * 而点进去明明有内容。
 */
const matched = computed<Record<string, boolean>>(() => {
  const k = keyword.value;
  const loaded = draft.loaded;
  return {
    model: matches(k, "默认模型", "对话模型", loaded?.defaultProviderId ?? ""),
    tools: (loaded?.tools ?? []).some((t) => matches(k, t.name, t.id, t.description)),
    plugins: (loaded?.plugins ?? []).some((p) => matches(k, p.name, p.id, p.description)),
    runtime: matches(k, "运行参数", "maxToolSteps", "单轮工具步数"),
    providers: true,
    adapters: true,
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
    // 插件启停可能真的加载/卸载了一颗，运行态栏也跟着刷新。
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
        <!-- 供应商是完整的两栏工作台（自己管理滚动与选中），不给它套页面内边距，
             否则两层滚动条并排出现。 -->
        <div v-if="active.key === 'providers'" class="h-full">
          <providers-panel />
        </div>

        <div v-else class="h-full overflow-y-auto">
          <div class="mx-auto max-w-[56rem] p-4 pb-20 sm:p-6 sm:pb-20">
            <header class="mb-4">
              <h2 class="m-0 text-xl font-bold text-ink">{{ active.label }}</h2>
              <p class="mt-1 mb-0 text-13px leading-relaxed text-ink-muted">{{ active.hint }}</p>
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
            <!-- 上一次保存里没生效的项：同一批的其他改动已经落盘了，所以这里是
                 「警告」而不是「错误」—— 但它必须露出来，否则用户以为全好了。 -->
            <n-alert
              v-if="draft.failed.length > 0"
              type="warning"
              class="mb-4"
              :show-icon="false"
              closable
              @close="draft.failed = []"
            >
              这些插件没能生效（同一批里其他改动已经保存）：
              <span v-for="f in draft.failed" :key="f.id" class="mr-2">
                {{ f.id }}（{{ f.error }}）
              </span>
            </n-alert>

            <n-spin :show="draft.loading">
              <n-empty
                v-if="!draft.loading && !draft.loaded"
                description="这一份配置档当前不可用，原因见「配置档」页"
              />
              <component
                :is="panel"
                v-else
                v-bind="active.scope === 'profile' ? { keyword } : {}"
              />
            </n-spin>
          </div>
        </div>
      </main>
    </div>

    <!-- 全局分类的写是即时的（供应商自己那些按钮），所以浮动保存键只在档级分类上出现：
         否则用户会以为供应商那边的改动也要按它。 -->
    <save-button
      v-if="active.scope === 'profile'"
      :dirty="draft.dirty"
      :saving="draft.saving"
      @save="save"
    />

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
