<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { CronJobInfo } from "@/api/client.js";
import * as api from "@/api/client.js";
import { useProfilesStore } from "@/stores/profiles";
import { icon } from "@/components/shared/icons";

/**
 * 计划任务页的主体：AstrBot 计划任务的本仓版本。
 *
 * 面板由 `CronView` 挂在 `/cron`。任务是部署级资源（`data/cron.json`），任务自己保存
 * 所用的配置档，所以 URL 上那份档不参与调度。
 *
 * 到点后按指定配置档跑一轮 prompt，结果写进任务自己的内部会话；
 * 不在本轮做“主动发送到 QQ”，避免调度器绕过平台侧寻址与权限。
 */
const props = defineProps<{ keyword: string }>();

const jobs = ref<CronJobInfo[]>([]);
const loading = ref(true);
const pageError = ref<string | null>(null);
const notice = ref<string | null>(null);
const busyId = ref<string | null>(null);
const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const profiles = useProfilesStore();
const form = reactive({
  name: "",
  cron: "0 9 * * *",
  prompt: "",
  profile: "",
  enabled: true,
});
const PlusIcon = icon("plus");
const PlayIcon = icon("play");
const EditIcon = icon("edit");
const TrashIcon = icon("trash");

const presets = [
  { label: "每天 09:00", value: "0 9 * * *" },
  { label: "每天 20:00", value: "0 20 * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每周一 09:00", value: "0 9 * * 1" },
];

const profileOptions = computed(() =>
  profiles.profiles.map((profile) => ({
    label: profile.status === "ready" ? profile.name : `${profile.name}（不可用）`,
    value: profile.id,
    disabled: profile.status !== "ready",
  })),
);

const visible = computed(() => {
  const needle = props.keyword.trim().toLowerCase();
  if (!needle) return jobs.value;
  return jobs.value.filter((job) =>
    [job.name, job.cron, job.prompt, job.profile].join("\n").toLowerCase().includes(needle),
  );
});

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function statusOf(job: CronJobInfo): { label: string; cls: string } {
  if (job.running) return { label: "执行中", cls: "text-info" };
  if (job.lastStatus === "success") return { label: "上次成功", cls: "text-success" };
  if (job.lastStatus === "error") return { label: "上次失败", cls: "text-danger" };
  return { label: "还没跑过", cls: "text-ink-faint" };
}

async function refresh(): Promise<void> {
  pageError.value = null;
  try {
    jobs.value = (await api.listCronJobs()).jobs;
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

void Promise.all([
  profiles.profiles.length === 0 ? profiles.refresh() : Promise.resolve(),
  refresh(),
]);

function openCreate(): void {
  editingId.value = null;
  form.name = "";
  form.cron = "0 9 * * *";
  form.prompt = "";
  form.profile = profiles.usable[0]?.id ?? "";
  form.enabled = true;
  formError.value = null;
  modalOpen.value = true;
}

function openEdit(job: CronJobInfo): void {
  editingId.value = job.id;
  form.name = job.name;
  form.cron = job.cron;
  form.prompt = job.prompt;
  form.profile = job.profile;
  form.enabled = job.enabled;
  formError.value = null;
  modalOpen.value = true;
}

async function save(): Promise<void> {
  if (form.name.trim() === "") {
    formError.value = "请填写任务名称";
    return;
  }
  if (form.cron.trim().split(/\s+/).length !== 5) {
    formError.value = "cron 必须是 5 段：分 时 日 月 周，例如 0 9 * * *";
    return;
  }
  if (form.prompt.trim() === "") {
    formError.value = "请填写提示词";
    return;
  }
  if (form.profile === "") {
    formError.value = "请选择一份配置档";
    return;
  }
  saving.value = true;
  formError.value = null;
  const body = {
    name: form.name.trim(),
    cron: form.cron.trim(),
    prompt: form.prompt.trim(),
    profile: form.profile,
    enabled: form.enabled,
  };
  try {
    if (editingId.value === null) await api.createCronJob(body);
    else await api.updateCronJob(editingId.value, body);
    modalOpen.value = false;
    await refresh();
  } catch (err) {
    formError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function toggle(job: CronJobInfo): Promise<void> {
  busyId.value = job.id;
  pageError.value = null;
  try {
    await api.updateCronJob(job.id, { enabled: !job.enabled });
    await refresh();
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}

async function run(job: CronJobInfo): Promise<void> {
  busyId.value = job.id;
  pageError.value = null;
  notice.value = null;
  const before = job.lastRunAt;
  try {
    await api.runCronJob(job.id);
    notice.value = `任务「${job.name}」已开始执行，结果会写进它的会话。`;
    // 不阻塞接口等待模型；这里短轮询几次，让「上次结果」尽快变成新值。
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refresh();
      const current = jobs.value.find((item) => item.id === job.id);
      if (current && current.lastRunAt !== before) break;
    }
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}

async function remove(job: CronJobInfo): Promise<void> {
  busyId.value = job.id;
  pageError.value = null;
  try {
    await api.deleteCronJob(job.id);
    await refresh();
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="atri-cron-panel">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <p class="m-0 text-xs text-ink-faint">
        共 {{ jobs.length }} 个任务。按服务器本地时区调度，结果写进各自任务的内置会话。
      </p>
      <div class="flex items-center gap-2">
        <n-button size="small" quaternary :loading="loading" @click="refresh">刷新</n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon><component :is="PlusIcon" /></template>
          新建任务
        </n-button>
      </div>
    </div>

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
      v-if="notice"
      type="success"
      class="mb-4"
      :show-icon="false"
      closable
      @close="notice = null"
    >
      {{ notice }}
    </n-alert>

    <n-spin :show="loading">
      <n-empty
        v-if="!loading && jobs.length === 0"
        description="还没有计划任务。新建一个，让机器人按时做点事。"
      />
      <n-empty v-else-if="visible.length === 0" description="没有匹配的计划任务" />
      <div v-else class="flex flex-col gap-3">
        <article
          v-for="job in visible"
          :key="job.id"
          class="rounded-xl border-1 border-line bg-surface p-5 shadow-sm"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="m-0 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
                {{ job.name }}
                <span class="rounded bg-tint px-2 py-0.5 text-[11px] font-normal text-ink-muted">
                  {{ job.cron }}
                </span>
                <span class="text-[11px] font-normal" :class="statusOf(job).cls">
                  {{ statusOf(job).label }}
                </span>
              </h3>
              <p class="mt-1.5 mb-0 text-xs text-ink-muted">
                配置 {{ job.profile }} · 下次 {{ formatTime(job.nextRunAt) }} · 上次
                {{ formatTime(job.lastRunAt) }}
              </p>
            </div>
            <n-switch
              :value="job.enabled"
              :loading="busyId === job.id"
              size="small"
              @update:value="toggle(job)"
            />
          </div>

          <p
            class="mt-3 mb-0 max-h-20 overflow-hidden rounded-lg bg-raised px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-ink-muted"
          >
            {{ job.prompt }}
          </p>
          <p v-if="job.lastError" class="mt-2 mb-0 text-xs text-danger">
            上次失败：{{ job.lastError }}
          </p>

          <div
            class="mt-4 flex flex-wrap items-center justify-end gap-2 border-t-1 border-line pt-3"
          >
            <router-link
              v-if="job.sessionId"
              :to="{ name: 'chat-session', params: { sessionId: job.sessionId } }"
              class="mr-auto text-xs text-primary hover:text-primary-hover"
            >
              打开结果会话
            </router-link>
            <n-button
              size="small"
              quaternary
              :loading="busyId === job.id"
              :aria-label="`立即执行 ${job.name}`"
              :title="`立即执行 ${job.name}`"
              @click="run(job)"
            >
              <template #icon><component :is="PlayIcon" /></template>
            </n-button>
            <n-button
              size="small"
              quaternary
              :aria-label="`编辑 ${job.name}`"
              :title="`编辑 ${job.name}`"
              @click="openEdit(job)"
            >
              <template #icon><component :is="EditIcon" /></template>
            </n-button>
            <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="remove(job)">
              <template #trigger>
                <n-button
                  size="small"
                  quaternary
                  type="error"
                  :aria-label="`删除 ${job.name}`"
                  :title="`删除 ${job.name}`"
                >
                  <template #icon><component :is="TrashIcon" /></template>
                </n-button>
              </template>
              删除计划任务不会删除它已经产生的会话。
            </n-popconfirm>
          </div>
        </article>
      </div>
    </n-spin>

    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId === null ? '新建计划任务' : '编辑计划任务'"
      style="width: min(700px, calc(100vw - 32px))"
      :bordered="false"
    >
      <div class="flex flex-col gap-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <n-form-item label="任务名称" :show-feedback="false">
            <n-input v-model:value="form.name" placeholder="例如：每日早报" maxlength="80" />
          </n-form-item>
          <n-form-item label="配置档" :show-feedback="false">
            <n-select v-model:value="form.profile" :options="profileOptions" />
          </n-form-item>
        </div>

        <n-form-item label="cron（分 时 日 月 周，本地时区）" :show-feedback="false">
          <n-input v-model:value="form.cron" placeholder="0 9 * * *" />
        </n-form-item>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="preset in presets"
            :key="preset.value"
            type="button"
            class="cursor-pointer rounded-md border-1 border-line bg-raised px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
            @click="form.cron = preset.value"
          >
            {{ preset.label }}
          </button>
        </div>

        <n-form-item label="提示词" :show-feedback="false">
          <n-input
            v-model:value="form.prompt"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 14 }"
            placeholder="例如：整理今天需要关注的事项，给出三条最重要的。"
          />
        </n-form-item>

        <div class="flex items-center justify-between rounded-lg bg-raised px-3.5 py-3">
          <div>
            <p class="m-0 text-sm font-medium text-ink">启用</p>
            <p class="mt-1 mb-0 text-xs text-ink-muted">
              关闭后不会按 cron 自动触发，但仍可立即执行。
            </p>
          </div>
          <n-switch v-model:value="form.enabled" />
        </div>

        <n-alert v-if="formError" type="error" :show-icon="false">{{ formError }}</n-alert>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button :disabled="saving" @click="modalOpen = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
