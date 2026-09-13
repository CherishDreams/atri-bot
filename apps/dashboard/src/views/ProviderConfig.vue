<template>
  <div class="atri-provider-config relative h-full w-full">
    <ProfileGate v-slot="{ profile: pid }">
      <n-layout has-sider position="absolute">
        <n-layout-sider bordered :width="layout.navW">
          <div class="flex items-center justify-between px-4 py-3">
            <h2 class="text-lg font-bold text-ink">供应商源</h2>
            <n-button text type="primary" @click="openCreate">添加供应商</n-button>
          </div>

          <div class="flex flex-col gap-2 px-4 pb-4">
            <div
              v-for="source in providers.sources"
              :key="source.id"
              class="source-row group relative"
              @click="requestSelect(source.id)"
            >
              <provider-card
                :provider="source"
                :active="source.id === providers.selectedSourceId"
              />
              <button
                type="button"
                class="absolute right-2 top-2 hidden cursor-pointer rounded px-1 text-xs text-ink-faint group-hover:block hover:bg-tint hover:text-danger"
                :aria-label="`删除 ${source.id}`"
                @click.stop="askRemoveSource(pid, source.id)"
              >
                删除
              </button>
            </div>

            <n-empty
              v-if="providers.sources.length === 0"
              description="还没有配置供应商源"
              size="small"
            />
          </div>
        </n-layout-sider>

        <n-layout-content class="h-full overflow-auto">
          <div v-if="!providers.selectedSource" class="p-8">
            <n-empty description="左侧还没有可编辑的供应商源，点「添加供应商」开始" />
          </div>

          <div v-else class="mx-auto max-w-form p-6">
            <div class="mb-4 flex items-end justify-between gap-4">
              <div class="min-w-0">
                <h3 class="truncate text-2xl font-bold text-ink">
                  {{ providers.selectedSource.id }}
                </h3>
                <p class="truncate text-sm text-ink-muted">
                  {{ providers.selectedSource.baseUrl || "默认地址" }}
                </p>
              </div>
              <n-button
                type="primary"
                :disabled="!dirty"
                :loading="providers.saving"
                @click="saveDraft(pid)"
              >
                保存配置
              </n-button>
            </div>

            <!-- 服务端错误就地展示：写操作失败的原因（id 冲突、还有引用者…）
               只有服务端知道，弹个 alert 之后就没法回看了。 -->
            <n-alert
              v-if="providers.error"
              class="mb-4"
              type="error"
              closable
              @close="providers.clearError()"
            >
              {{ providers.error }}
            </n-alert>

            <n-card class="mb-4" size="small" title="设置">
              <n-form label-placement="top">
                <n-form-item
                  label="ID"
                  :feedback="'供应商源唯一 ID（不是模型 ID），创建后不可修改'"
                >
                  <n-input :value="draft.id" disabled />
                </n-form-item>

                <n-form-item label="名称">
                  <n-input v-model:value="draft.name" placeholder="显示用名称" />
                </n-form-item>

                <n-form-item label="实现类型">
                  <n-select v-model:value="draft.type" :options="typeOptions" />
                </n-form-item>

                <n-form-item label="Base URL">
                  <n-input
                    v-model:value="draft.baseUrl"
                    placeholder="留空用默认地址，如 https://api.deepseek.com/v1"
                  />
                </n-form-item>

                <!-- 明文显示是有意为之（与 AstrBot 一致）：这是管理员自己的配置页，
                   掩码只会让人没法核对到底填进去的是什么。 -->
                <n-form-item label="API Key" :feedback="'明文显示；留空则不发鉴权头'">
                  <n-input v-model:value="draft.apiKey" placeholder="sk-..." />
                </n-form-item>

                <n-form-item label="超时时间（毫秒）">
                  <n-input-number
                    v-model:value="draft.timeoutMs"
                    :min="MIN_TIMEOUT_MS"
                    :max="MAX_TIMEOUT_MS"
                    :step="1000"
                    class="w-full"
                  />
                </n-form-item>
              </n-form>
            </n-card>

            <n-card class="mb-4" size="small">
              <template #header>
                <div class="flex items-center justify-between">
                  <span>可用模型</span>
                  <div class="flex gap-2">
                    <n-button size="small" @click="openCustomModel">自定义模型</n-button>
                    <n-button
                      size="small"
                      type="primary"
                      :loading="providers.loadingModels"
                      @click="onFetchModels(pid)"
                    >
                      {{ dirty ? "保存并获取模型列表" : "获取模型列表" }}
                    </n-button>
                  </div>
                </div>
              </template>

              <n-spin :show="providers.loadingModels">
                <div
                  v-if="providers.availableModels.length === 0"
                  class="py-2 text-sm text-ink-muted"
                >
                  点「获取模型列表」从上游拉取；该网关没有 /models 接口时用「自定义模型」手填。
                </div>
                <div v-else class="flex flex-col">
                  <div class="mb-2 text-sm text-ink-muted">
                    共 {{ providers.availableModels.length }} 个，点击即可添加
                  </div>
                  <!--
                  封顶高度 + 内部滚动：OpenAI 兼容网关的 /models 动辄几百条，
                  不封顶的话这张卡片会把整页撑到看不见下面的「已配置的模型」。

                  shrink-0 是必需的，不是保险。这个容器同时是 flex flex-col，
                  列里的子项默认 flex-shrink: 1；本该挡住压缩的自动最小尺寸
                  （min-height: auto）被 truncate 带来的 overflow:hidden 归零了，
                  于是 143 个按钮被等比压进 288px，只剩 py-1 的上下 padding——
                  实测每项正好 8px、文字全被截掉。
                -->
                  <div class="flex max-h-[18rem] flex-col overflow-y-auto">
                    <button
                      v-for="model in providers.availableModels"
                      :key="model"
                      type="button"
                      class="row-base shrink-0 truncate px-2 py-1 text-left text-sm"
                      @click="providers.addModel(pid, model)"
                    >
                      {{ model }}
                    </button>
                  </div>
                </div>
              </n-spin>
            </n-card>

            <n-card size="small" :title="`已配置的模型（${modelsOfSource.length}）`">
              <div v-if="modelsOfSource.length === 0" class="py-2 text-sm text-ink-muted">
                暂无已配置的模型，点击上方的「获取模型列表」添加
              </div>
              <div v-else class="flex flex-col gap-2">
                <div
                  v-for="entry in modelsOfSource"
                  :key="entry.id"
                  class="flex items-center gap-3 rounded-lg border-1 border-line px-3 py-2"
                >
                  <n-switch
                    :value="entry.enabled !== false"
                    size="small"
                    @update:value="(on: boolean) => providers.setModelEnabled(pid, entry.id, on)"
                  />
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium">
                      {{ entry.model ?? entry.id }}
                      <n-tag v-if="entry.default" class="ml-2" size="tiny" type="success"
                        >默认</n-tag
                      >
                      <n-tag v-if="entry.loaded === false" class="ml-2" size="tiny" type="error">
                        加载失败
                      </n-tag>
                    </div>
                    <div class="truncate text-xs text-ink-muted">{{ entry.id }}</div>
                    <!-- 加载失败的原因必须露出来：只显示一个红标签，用户不知道去改哪里。 -->
                    <div v-if="entry.error" class="mt-1 text-xs text-danger">
                      {{ entry.error }}
                    </div>
                  </div>
                  <n-button
                    v-if="!entry.default"
                    text
                    size="small"
                    @click="providers.setDefaultModel(pid, entry.id)"
                  >
                    设为默认
                  </n-button>
                  <n-button text size="small" @click="providers.removeModel(pid, entry.id)"
                    >删除</n-button
                  >
                </div>
              </div>
            </n-card>
          </div>
        </n-layout-content>
      </n-layout>

      <!-- 新增源。id 由前端预生成一个不冲突的建议值，改不改都行，但要过服务端校验。
         宽度只由 `w-[32rem]` 决定：原先同时写着 `class="max-w-lg"`（=32rem=512px）
         和 `:style="{ width: '520px' }"`，后者永远被前者钳住，等于白写。
         `max-w-[92vw]` 保证窄屏不溢出。 -->
      <n-modal
        v-model:show="createVisible"
        preset="card"
        title="添加供应商源"
        class="w-[32rem] max-w-[92vw]"
      >
        <n-form label-placement="top">
          <n-form-item label="ID">
            <n-input v-model:value="createForm.id" placeholder="字母、数字、点、下划线、连字符" />
          </n-form-item>
          <n-form-item label="实现类型">
            <n-select v-model:value="createForm.type" :options="typeOptions" />
          </n-form-item>
          <n-form-item label="Base URL">
            <n-input v-model:value="createForm.baseUrl" placeholder="留空用默认地址" />
          </n-form-item>
          <n-form-item label="API Key">
            <n-input v-model:value="createForm.apiKey" placeholder="sk-..." />
          </n-form-item>
        </n-form>
        <template #footer>
          <div class="flex justify-end gap-2">
            <n-button @click="createVisible = false">取消</n-button>
            <n-button type="primary" @click="onCreate">创建</n-button>
          </div>
        </template>
      </n-modal>

      <!-- 手填模型：上游没有 /models 或列表里没有目标模型时的唯一入口。 -->
      <n-modal v-model:show="customVisible" preset="card" title="添加自定义模型" class="max-w-md">
        <n-input
          v-model:value="customModel"
          placeholder="模型 ID，如 gpt-4.1-mini"
          @keyup.enter="onAddCustom"
        />
        <template #footer>
          <div class="flex justify-end gap-2">
            <n-button @click="customVisible = false">取消</n-button>
            <n-button type="primary" @click="onAddCustom">添加</n-button>
          </div>
        </template>
      </n-modal>

      <!-- 丢弃未保存改动 / 级联删除的确认。用 n-modal 而不是 useDialog：
         后者要求祖先里挂 n-dialog-provider，多一层装配只为弹个确认框不值。 -->
      <n-modal v-model:show="confirmVisible" preset="card" title="请确认" class="max-w-md">
        <p>{{ confirmText }}</p>
        <template #footer>
          <div class="flex justify-end gap-2">
            <n-button @click="confirmVisible = false">取消</n-button>
            <n-button type="primary" @click="runConfirm">确定</n-button>
          </div>
        </template>
      </n-modal>
    </ProfileGate>
  </div>
</template>

<script setup lang="ts">
import ProviderCard from "@/components/provider/ProviderCard.vue";
import ProfileGate from "@/components/shared/ProfileGate.vue";
import { useProfile } from "@/composables/useProfile";
import {
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PROVIDER_TYPES,
  useProvidersStore,
} from "@/stores/providers";
import { layout } from "@/theme/tokens";
import { computed, onMounted, reactive, ref, watch } from "vue";

const providers = useProvidersStore();
/** 页面级闸门提供的当前档；插槽里的 `pid` 与它是同一个值，这里给 onMounted / watch 用。 */
const { profile } = useProfile();

const typeOptions = PROVIDER_TYPES.map((t) => ({ label: t.label, value: t.value }));

/** 表单草稿。与服务端返回的那份比对来判断「有没有改动」。 */
const draft = reactive({
  id: "",
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  timeoutMs: 120_000,
});

/**
 * 只在**选中的源变了**的时候重建草稿，不在每次 refresh 后重建。
 *
 * `refresh()` 会在删模型等操作后被调用；如果那时重建草稿，用户在表单里
 * 正编着的东西会被无声抹掉。而保存后草稿本就等于已保存的值，不重建也没差别。
 */
watch(
  () => providers.selectedSourceId,
  (id) => {
    const source = providers.sources.find((s) => s.id === id);
    if (!source) return;
    Object.assign(draft, {
      id: source.id,
      name: source.name ?? "",
      type: source.type,
      baseUrl: source.baseUrl ?? "",
      apiKey: source.apiKey ?? "",
      timeoutMs: source.timeoutMs,
    });
  },
  { immediate: true },
);

const dirty = computed(() => {
  const source = providers.selectedSource;
  if (!source) return false;
  return (
    draft.name !== (source.name ?? "") ||
    draft.type !== source.type ||
    draft.baseUrl !== (source.baseUrl ?? "") ||
    draft.apiKey !== (source.apiKey ?? "") ||
    draft.timeoutMs !== source.timeoutMs
  );
});

const modelsOfSource = computed(() => providers.providersOfSource(draft.id));

async function saveDraft(pid: string): Promise<boolean> {
  return providers.saveSource(pid, draft.id, {
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    timeoutMs: draft.timeoutMs,
  });
}

/**
 * 获取模型列表。
 *
 * 有未保存改动时先存再取：那个请求打的是**服务端已保存**的凭据，
 * 拿没落盘的密钥去问上游，只会得到一句「密钥无效」，而人是看不出所以然的。
 */
async function onFetchModels(pid: string): Promise<void> {
  if (dirty.value && !(await saveDraft(pid))) return;
  await providers.fetchModels(pid, draft.id);
}

// --- 新增源 -----------------------------------------------------------------

const createVisible = ref(false);
const createForm = reactive({ id: "", type: "openai", baseUrl: "", apiKey: "" });

/** 生成一个不与现有源冲突的建议 id；服务端仍会独立校验一次。 */
function suggestSourceId(): string {
  const taken = new Set(providers.sources.map((s) => s.id));
  if (!taken.has("source")) return "source";
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `source${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `source-${Date.now()}`;
}

function openCreate(): void {
  createForm.id = suggestSourceId();
  createForm.type = "openai";
  createForm.baseUrl = "";
  createForm.apiKey = "";
  providers.clearError();
  createVisible.value = true;
}

async function onCreate(): Promise<void> {
  if (profile.value === null) return;
  const id = await providers.createSource(profile.value, { ...createForm });
  if (id) createVisible.value = false;
}

// --- 自定义模型 -------------------------------------------------------------

const customVisible = ref(false);
const customModel = ref("");

function openCustomModel(): void {
  customModel.value = "";
  customVisible.value = true;
}

async function onAddCustom(): Promise<void> {
  if (profile.value === null) return;
  if (await providers.addModel(profile.value, customModel.value)) customVisible.value = false;
}

// --- 确认框 -----------------------------------------------------------------

const confirmVisible = ref(false);
const confirmText = ref("");
let confirmAction: (() => void | Promise<void>) | null = null;

function ask(text: string, action: () => void | Promise<void>): void {
  confirmText.value = text;
  confirmAction = action;
  confirmVisible.value = true;
}

async function runConfirm(): Promise<void> {
  confirmVisible.value = false;
  await confirmAction?.();
  confirmAction = null;
}

/** 切换源：有未保存改动先问一句，否则输入会被静静丢掉。 */
function requestSelect(id: string): void {
  if (id === providers.selectedSourceId) return;
  if (!dirty.value) {
    providers.selectSource(id);
    return;
  }
  ask("当前配置有未保存的改动，切换后会被丢弃。确定继续吗？", () => providers.selectSource(id));
}

/**
 * 删除源。若还有模型引用了它，服务端会拒绝并列出引用者；
 * 这里先自己问一次「要不要一并删掉」，省一轮「被拒 → 再删一次」。
 */
function askRemoveSource(pid: string, id: string): void {
  const refs = providers.providersOfSource(id);
  if (refs.length === 0) {
    ask(`确定删除供应商源「${id}」吗？`, () => providers.removeSource(pid, id));
    return;
  }
  ask(
    `供应商源「${id}」正被 ${refs.length} 个模型引用：${refs.map((r) => r.id).join("、")}。连带删除这些模型吗？`,
    () => providers.removeSource(pid, id, true),
  );
}

/**
 * 换档 = 换一套源与模型。左栏选中的源与草稿**必须一起清掉**：
 * 它们在语义上属于上一份配置档，留着就会把「在 A 里编辑的草稿」保存进 B。
 */
function loadProfile(pid: string): void {
  providers.selectedSourceId = null;
  void providers.init(pid);
}

onMounted(() => {
  if (profile.value !== null) loadProfile(profile.value);
});
// 从顶栏的配置档切换（改 query）也要重载，否则页面停在上一份档的源与模型上，
// 而下一次的保存会写进新档 —— 那正是「界面在 A、写进 B」的形状。
watch(profile, (p) => {
  if (p !== null) loadProfile(p);
});
</script>
