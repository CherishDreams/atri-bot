<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { AdapterActionResult, AdapterInfo, AdapterTemplate } from "@/api/client.js";
import * as api from "@/api/client.js";
import { icon } from "@/components/shared/icons";
import { useProfilesStore } from "@/stores/profiles";

/**
 * 「接入平台」页：AstrBot 形状的实例管理。
 *
 * 用户不再改 JSON：模板告诉我们这里能加哪些平台、每种平台要填什么；实例保存在
 * `data/adapters.json`，新增/删除/启停/编辑全部走这里的 API。服务端仍是权威：
 * 表单只做即时提示，字段合法性、id 冲突与启动失败都由 API 决定并回一句中文原因。
 */
const adapters = ref<AdapterInfo[]>([]);
const templates = ref<AdapterTemplate[]>([]);
const profiles = useProfilesStore();
const loading = ref(true);
const pageError = ref<string | null>(null);
const busyId = ref<string | null>(null);

const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const form = reactive({
  type: "",
  id: "",
  name: "",
  profile: "",
  enabled: true,
  settings: {} as Record<string, string>,
});

const ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const actionOpen = ref(false);
const actionAdapter = ref<AdapterInfo | null>(null);
const actionName = ref("");
const actionParams = ref("{}");
const actionResult = ref<AdapterActionResult | null>(null);
const actionRunning = ref(false);
const actionError = ref<string | null>(null);
const TerminalIcon = icon("terminal");
const EditIcon = icon("edit");
const TrashIcon = icon("trash");

const currentTemplate = computed<AdapterTemplate | null>(
  () => templates.value.find((template) => template.type === form.type) ?? null,
);
const typeOptions = computed(() =>
  templates.value.map((template) => ({ label: template.name, value: template.type })),
);
const profileOptions = computed(() =>
  profiles.profiles.map((profile) => ({
    label: profile.status === "ready" ? profile.name : `${profile.name}（不可用）`,
    value: profile.id,
    disabled: profile.status !== "ready",
  })),
);
const canAdd = computed(() => templates.value.length > 0 && profiles.usable.length > 0);

function defaultsOf(template: AdapterTemplate | null): Record<string, string> {
  return Object.fromEntries((template?.fields ?? []).map((field) => [field.key, field.default]));
}

/** 反向 WS 的 token 由页面生成，省得用户自己编一个弱口令。 */
function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 只有模板声明了 `generateToken` 才替用户生成 token。
 * SnowLuma 的 token 来自它自己的服务端，页面不能替它编一个。
 */
function defaultsWithToken(template: AdapterTemplate | null): Record<string, string> {
  const settings = defaultsOf(template);
  if (template?.generateToken === true && settings.token !== undefined && settings.token === "") {
    settings.token = randomToken();
  }
  return settings;
}

async function refresh(): Promise<void> {
  pageError.value = null;
  try {
    adapters.value = (await api.listAdapters()).adapters;
  } catch (err) {
    pageError.value = (err as Error).message;
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    const [templatesResult] = await Promise.all([
      api.listAdapterTemplates(),
      refresh(),
      profiles.profiles.length === 0 ? profiles.refresh() : Promise.resolve(),
    ]);
    templates.value = templatesResult.templates;
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

function openAdd(): void {
  const template = templates.value[0] ?? null;
  editingId.value = null;
  form.type = template?.type ?? "";
  form.id = template?.type ?? "";
  form.name = template?.name ?? "";
  form.profile = profiles.usable[0]?.id ?? "";
  form.enabled = true;
  form.settings = defaultsWithToken(template);
  formError.value = null;
  modalOpen.value = true;
}

async function openEdit(adapter: AdapterInfo): Promise<void> {
  busyId.value = adapter.id;
  pageError.value = null;
  try {
    const detail = await api.getAdapter(adapter.id);
    const template = templates.value.find((item) => item.type === detail.config.type) ?? null;
    editingId.value = adapter.id;
    form.type = detail.config.type;
    form.id = adapter.id;
    form.name = detail.config.name;
    form.profile = detail.config.profile;
    form.enabled = detail.config.enabled;
    const settings = defaultsOf(template);
    for (const entry of detail.config.settings) settings[entry.key] = entry.value;
    form.settings = settings;
    formError.value = null;
    modalOpen.value = true;
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}

function onTypeChange(type: string): void {
  if (editingId.value !== null) return;
  const template = templates.value.find((item) => item.type === type) ?? null;
  form.type = type;
  form.id = type;
  form.name = template?.name ?? "";
  form.settings = defaultsWithToken(template);
}

function settingsEntries(): { key: string; value: string }[] {
  const template = currentTemplate.value;
  return (template?.fields ?? []).map((field) => ({
    key: field.key,
    value: form.settings[field.key] ?? field.default,
  }));
}

async function save(): Promise<void> {
  if (currentTemplate.value === null) {
    formError.value = "没有选择适配器类型";
    return;
  }
  if (editingId.value === null && !ADAPTER_ID.test(form.id.trim())) {
    formError.value = "实例 id 只能用小写字母/数字开头，且只含 a-z0-9._-，长度 1–64";
    return;
  }
  if (form.profile === "") {
    formError.value = "必须选择一份配置";
    return;
  }
  for (const field of currentTemplate.value.fields) {
    if (field.required && (form.settings[field.key] ?? "").trim() === "") {
      formError.value = `请填写「${field.label}」`;
      return;
    }
  }

  saving.value = true;
  formError.value = null;
  try {
    const body = {
      name: form.name.trim(),
      enabled: form.enabled,
      profile: form.profile,
      settings: settingsEntries(),
    };
    const detail =
      editingId.value === null
        ? await api.createAdapter({ id: form.id.trim(), type: form.type, ...body })
        : await api.updateAdapter(editingId.value, body);
    modalOpen.value = false;
    await refresh();
    if (detail.adapter.error) pageError.value = `已保存，但启动失败：${detail.adapter.error}`;
  } catch (err) {
    formError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function toggle(adapter: AdapterInfo): Promise<void> {
  busyId.value = adapter.id;
  pageError.value = null;
  try {
    const detail = await api.setAdapterEnabled(adapter.id, !adapter.enabled);
    await refresh();
    if (detail.adapter.error) pageError.value = `已保存，但启动失败：${detail.adapter.error}`;
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}

async function remove(adapter: AdapterInfo): Promise<void> {
  busyId.value = adapter.id;
  pageError.value = null;
  try {
    await api.deleteAdapter(adapter.id);
    await refresh();
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}

function openAction(adapter: AdapterInfo): void {
  actionAdapter.value = adapter;
  actionName.value = "";
  actionParams.value = "{}";
  actionResult.value = null;
  actionError.value = null;
  actionOpen.value = true;
}

async function runAction(): Promise<void> {
  const adapter = actionAdapter.value;
  if (adapter === null) return;
  const name = actionName.value.trim();
  if (name === "") {
    actionError.value = "请填写 action";
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(actionParams.value.trim() === "" ? "{}" : actionParams.value);
  } catch (err) {
    actionError.value = `params 不是合法 JSON：${(err as Error).message}`;
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    actionError.value = "params 必须是一个 JSON 对象";
    return;
  }

  actionRunning.value = true;
  actionError.value = null;
  actionResult.value = null;
  try {
    actionResult.value = await api.callAdapterAction(
      adapter.id,
      name,
      parsed as Record<string, unknown>,
    );
  } catch (err) {
    actionError.value = (err as Error).message;
  } finally {
    actionRunning.value = false;
  }
}

function actionDataText(result: AdapterActionResult): string {
  if (result.data === undefined) return "（无 data）";
  try {
    return JSON.stringify(result.data, null, 2);
  } catch {
    return String(result.data);
  }
}

function statusTag(adapter: AdapterInfo): { label: string; type: "success" | "error" | "default" } {
  if (!adapter.enabled) return { label: "已禁用", type: "default" };
  if (adapter.running) return { label: "已启动", type: "success" };
  return { label: "未运行", type: "error" };
}

function typeLabel(type: string): string {
  return templates.value.find((template) => template.type === type)?.name ?? type;
}

function profileLabel(id: string | null): string {
  if (id === null) return "未绑定";
  return profiles.profiles.find((profile) => profile.id === id)?.name ?? id;
}
</script>

<template>
  <div class="atri-adapters-panel">
    <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">接入平台</h2>
        <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
          把 QQ、Discord、webhook 等外部平台接到这份部署上。添加后在网页里填参数即可，
          支持随时启停、编辑与删除。
        </p>
      </div>
      <n-button class="ml-auto shrink-0" type="primary" :disabled="!canAdd" @click="openAdd">
        添加接入平台
      </n-button>
    </header>

    <n-alert
      v-if="pageError"
      type="error"
      class="mb-4"
      :show-icon="false"
      closable
      @close="pageError = null"
    >
      {{ pageError }}
    </n-alert>
    <n-alert
      v-if="profiles.profiles.length > 0 && profiles.usable.length === 0"
      type="warning"
      class="mb-4"
      :show-icon="false"
    >
      当前没有可用的配置；先在「配置文件」页修好或创建一份，再添加接入平台。
    </n-alert>

    <n-spin :show="loading">
      <div
        v-if="!loading && adapters.length === 0"
        class="rounded-xl border-1 border-line bg-surface p-8"
      >
        <n-empty description="还没有接入平台。点击右上角「添加接入平台」开始。" size="small">
          <template #extra>
            <n-button v-if="canAdd" size="small" @click="openAdd">添加接入平台</n-button>
          </template>
        </n-empty>
      </div>
      <div v-else class="flex flex-col gap-3">
        <article
          v-for="adapter in adapters"
          :key="adapter.id"
          class="atri-adapter-card rounded-xl border-1 border-line bg-surface p-4 shadow-sm"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <b class="truncate text-sm font-semibold text-ink">{{ adapter.name }}</b>
                <code class="rounded bg-tint px-1.5 py-0.5 text-xs text-ink-muted">{{
                  adapter.id
                }}</code>
                <span class="text-xs text-ink-faint">类型：{{ typeLabel(adapter.type) }}</span>
              </div>
              <p class="mt-1 mb-0 text-xs text-ink-muted">
                配置：{{ profileLabel(adapter.profile) }}
                <template v-if="adapter.profile && !adapter.bound">（当前不可用）</template>
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-1.5">
              <n-tag :type="statusTag(adapter).type" size="tiny">{{
                statusTag(adapter).label
              }}</n-tag>
              <n-tag
                :type="adapter.profile === null ? 'default' : adapter.bound ? 'success' : 'error'"
                size="tiny"
              >
                {{
                  adapter.profile === null
                    ? "未绑定配置"
                    : adapter.bound
                      ? "配置可用"
                      : "配置不可用"
                }}
              </n-tag>
            </div>
          </div>

          <p
            v-if="adapter.error"
            class="mt-2 mb-0 rounded-lg border-1 border-danger/30 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger"
          >
            启动失败：{{ adapter.error }}
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <n-button
              size="small"
              :loading="busyId === adapter.id"
              :disabled="busyId !== null && busyId !== adapter.id"
              @click="toggle(adapter)"
            >
              {{ adapter.enabled ? "禁用" : "启用" }}
            </n-button>
            <n-button
              size="small"
              quaternary
              :aria-label="`调试 ${adapter.name} 的原始动作`"
              :title="`调试 ${adapter.name} 的原始动作`"
              @click="openAction(adapter)"
            >
              <template #icon><component :is="TerminalIcon" /></template>
            </n-button>
            <n-button
              size="small"
              quaternary
              :disabled="busyId !== null"
              :aria-label="`编辑 ${adapter.name}`"
              :title="`编辑 ${adapter.name}`"
              @click="openEdit(adapter)"
            >
              <template #icon><component :is="EditIcon" /></template>
            </n-button>
            <n-popconfirm
              positive-text="删除"
              negative-text="取消"
              @positive-click="remove(adapter)"
            >
              <template #trigger>
                <n-button
                  size="small"
                  type="error"
                  quaternary
                  :disabled="busyId !== null"
                  :aria-label="`删除 ${adapter.name}`"
                  :title="`删除 ${adapter.name}`"
                >
                  <template #icon><component :is="TrashIcon" /></template>
                </n-button>
              </template>
              删除后这个平台的配置会从 data/adapters.json 移除；QQ
              登录态与日志不会被删掉。确定删除吗？
            </n-popconfirm>
          </div>
        </article>
      </div>
    </n-spin>

    <p class="mt-4 mb-0 text-xs leading-relaxed text-ink-faint">
      实例配置保存在 <code class="text-xs">data/adapters.json</code>，每个实例的会话映射在
      <code class="text-xs">data/adapters/&lt;id&gt;/</code>。不同平台的连接方向与 token
      来源不同，添加或编辑时看表单下方的提示。
    </p>

    <n-modal
      v-model:show="actionOpen"
      preset="card"
      :title="actionAdapter ? `调试动作 · ${actionAdapter.name}` : '调试动作'"
      class="w-[min(720px,94vw)]"
    >
      <div class="flex flex-col gap-3">
        <n-alert type="warning" :show-icon="false">
          动作名与参数会原样转发到接入平台，可能改变账号或群状态；框架不校验参数含义。
        </n-alert>
        <n-form-item label="action" :show-feedback="false">
          <n-input
            v-model:value="actionName"
            placeholder="例如 get_group_list、get_friend_list、delete_msg"
          />
        </n-form-item>
        <n-form-item label="params（JSON 对象）" :show-feedback="false">
          <n-input
            v-model:value="actionParams"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 12 }"
            placeholder="{}"
          />
        </n-form-item>
        <n-alert v-if="actionError" type="error" :show-icon="false">{{ actionError }}</n-alert>
        <div v-if="actionResult" class="rounded-lg border-1 border-line bg-raised p-3">
          <div class="mb-2 flex items-center gap-2 text-xs">
            <n-tag :type="actionResult.ok ? 'success' : 'error'" size="tiny">
              {{ actionResult.ok ? "成功" : "失败" }}
            </n-tag>
            <span class="text-ink-faint">{{ actionResult.action }}</span>
          </div>
          <p v-if="actionResult.error" class="m-0 text-xs text-danger">{{ actionResult.error }}</p>
          <pre
            v-else
            class="m-0 max-h-[16rem] overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-muted"
            >{{ actionDataText(actionResult) }}</pre>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="actionOpen = false">关闭</n-button>
          <n-button type="primary" :loading="actionRunning" @click="runAction">执行</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId === null ? '添加接入平台' : '编辑接入平台'"
      class="w-[min(560px,92vw)]"
      :mask-closable="!saving"
      :close-on-esc="!saving"
    >
      <n-form label-placement="top">
        <n-form-item label="类型">
          <n-select
            :value="form.type"
            :options="typeOptions"
            :disabled="editingId !== null"
            @update:value="onTypeChange"
          />
        </n-form-item>
        <n-form-item label="实例 id">
          <n-input
            v-model:value="form.id"
            :disabled="editingId !== null"
            placeholder="例如 napcat"
          />
          <template #feedback>
            <span class="text-xs text-ink-faint">
              小写字母/数字开头，只含 a-z0-9._-，用于区分多个账号；保存后不可修改。
            </span>
          </template>
        </n-form-item>
        <n-form-item label="显示名">
          <n-input v-model:value="form.name" placeholder="例如 QQ 主号" />
        </n-form-item>
        <n-form-item label="配置">
          <n-select
            v-model:value="form.profile"
            :options="profileOptions"
            placeholder="选择一份可用配置"
          />
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="form.enabled" />
        </n-form-item>
        <n-form-item
          v-for="field in currentTemplate?.fields ?? []"
          :key="field.key"
          :label="field.label"
        >
          <n-input
            v-if="field.type === 'text'"
            v-model:value="form.settings[field.key]"
            :placeholder="field.placeholder"
          />
          <n-input
            v-else
            v-model:value="form.settings[field.key]"
            type="password"
            show-password-on="click"
            :placeholder="field.placeholder"
          />
          <template #feedback>
            <span v-if="field.hint" class="text-xs text-ink-faint">{{ field.hint }}</span>
          </template>
        </n-form-item>
        <n-alert
          v-if="currentTemplate?.setupHint"
          type="info"
          :show-icon="false"
          class="mb-2 text-xs"
        >
          {{ currentTemplate.setupHint }}
        </n-alert>
      </n-form>

      <n-alert v-if="formError" type="error" :show-icon="false" class="mt-2">
        {{ formError }}
      </n-alert>

      <template #footer>
        <div class="flex w-full items-center justify-end gap-2">
          <n-button :disabled="saving" @click="modalOpen = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
