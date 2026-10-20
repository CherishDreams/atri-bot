<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { PersonaInfo } from "@/api/client.js";
import * as api from "@/api/client.js";
import { icon } from "@/components/shared/icons";

/**
 * 人格配置页的主体：全局人格库。人格正文不跟配置档走，配置档只在配置文件页的
 * 「人格」分类里引用。面板由 `PersonasView` 挂在 `/personas`，不读 URL 上的档名。
 *
 * 写入是即时的（新建/编辑/删除各自发请求），与配置文件页的「草稿 + 一次保存」不同。
 */
const props = defineProps<{ keyword: string }>();

const personas = ref<PersonaInfo[]>([]);
const loading = ref(true);
const pageError = ref<string | null>(null);
const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const form = reactive({ id: "", name: "", description: "", systemPrompt: "" });
const PlusIcon = icon("plus");
const EditIcon = icon("settings");

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const visible = computed(() => {
  const needle = props.keyword.trim().toLowerCase();
  if (!needle) return personas.value;
  return personas.value.filter((persona) =>
    [persona.id, persona.name, persona.description, persona.systemPrompt]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  );
});

async function refresh(): Promise<void> {
  loading.value = true;
  pageError.value = null;
  try {
    personas.value = (await api.listPersonas()).personas;
  } catch (err) {
    pageError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

void refresh();

function openCreate(): void {
  editingId.value = null;
  form.id = "";
  form.name = "";
  form.description = "";
  form.systemPrompt = "";
  formError.value = null;
  modalOpen.value = true;
}

function openEdit(persona: PersonaInfo): void {
  editingId.value = persona.id;
  form.id = persona.id;
  form.name = persona.name;
  form.description = persona.description;
  form.systemPrompt = persona.systemPrompt;
  formError.value = null;
  modalOpen.value = true;
}

async function save(): Promise<void> {
  const name = form.name.trim();
  const systemPrompt = form.systemPrompt.trim();
  if (editingId.value === null && !ID_PATTERN.test(form.id.trim())) {
    formError.value = "人格 id 只能用小写字母/数字开头，且只含 a-z0-9._-，长度 1–64";
    return;
  }
  if (name === "") {
    formError.value = "请填写人格名称";
    return;
  }
  if (systemPrompt === "") {
    formError.value = "请填写人格提示词";
    return;
  }
  saving.value = true;
  formError.value = null;
  try {
    if (editingId.value === null) {
      await api.createPersona({
        id: form.id.trim(),
        name,
        description: form.description.trim(),
        systemPrompt,
      });
    } else {
      await api.updatePersona(editingId.value, {
        name,
        description: form.description.trim(),
        systemPrompt,
      });
    }
    modalOpen.value = false;
    await refresh();
  } catch (err) {
    formError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function remove(persona: PersonaInfo): Promise<void> {
  pageError.value = null;
  try {
    await api.deletePersona(persona.id);
    await refresh();
  } catch (err) {
    pageError.value = (err as Error).message;
  }
}
</script>

<template>
  <div class="atri-persona-manager-panel">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <p class="m-0 text-xs text-ink-faint">
        共
        {{ personas.length }}
        份人格。人格是全局资源，所有配置共用；每份配置只在「人格」分类里选用其中一个。
      </p>
      <n-button size="small" type="primary" @click="openCreate">
        <template #icon><component :is="PlusIcon" /></template>
        新建人格
      </n-button>
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

    <n-spin :show="loading">
      <n-empty v-if="!loading && personas.length === 0" description="还没有人格，先新建一个" />
      <n-empty v-else-if="visible.length === 0" description="没有匹配的人格" />
      <div v-else class="grid gap-4 lg:grid-cols-2">
        <article
          v-for="persona in visible"
          :key="persona.id"
          class="flex min-h-52 flex-col rounded-xl border-1 border-line bg-surface p-5 shadow-sm transition-colors hover:border-line-strong"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="m-0 truncate text-[15px] font-semibold text-ink">{{ persona.name }}</h3>
              <p class="mt-1 mb-0 truncate text-xs text-ink-faint">{{ persona.id }}</p>
            </div>
            <span
              v-if="persona.id === 'default'"
              class="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] text-primary"
            >
              默认
            </span>
          </div>
          <p class="mt-3 mb-0 max-h-10 overflow-hidden text-xs leading-relaxed text-ink-muted">
            {{ persona.description || "没有填写说明" }}
          </p>
          <p
            class="mt-3 mb-0 max-h-28 flex-1 overflow-hidden rounded-lg bg-raised px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-ink-muted"
          >
            {{ persona.systemPrompt }}
          </p>
          <div class="mt-4 flex items-center justify-end gap-2 border-t-1 border-line pt-3">
            <n-button size="small" quaternary @click="openEdit(persona)">
              <template #icon><component :is="EditIcon" /></template>
              编辑
            </n-button>
            <n-popconfirm
              positive-text="删除"
              negative-text="取消"
              @positive-click="remove(persona)"
            >
              <template #trigger>
                <n-button size="small" quaternary type="error">删除</n-button>
              </template>
              删除后不可恢复。仍被配置档引用时服务端会拒绝。
            </n-popconfirm>
          </div>
        </article>
      </div>
    </n-spin>

    <n-modal
      v-model:show="modalOpen"
      preset="card"
      :title="editingId === null ? '新建人格' : '编辑人格'"
      style="width: min(680px, calc(100vw - 32px))"
      :bordered="false"
    >
      <div class="flex flex-col gap-4">
        <n-form-item label="人格 id" :show-feedback="false">
          <n-input
            v-model:value="form.id"
            :disabled="editingId !== null"
            placeholder="例如 work、catgirl"
            maxlength="64"
          />
        </n-form-item>
        <p class="-mt-3 mb-0 text-xs text-ink-faint">
          只能用小写字母、数字与 . _ -；创建后不能改名（配置档引用的是这个 id）。
        </p>
        <n-form-item label="名称" :show-feedback="false">
          <n-input v-model:value="form.name" placeholder="给人格起个名字" maxlength="80" />
        </n-form-item>
        <n-form-item label="说明" :show-feedback="false">
          <n-input
            v-model:value="form.description"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 3 }"
            placeholder="这份人格适合什么场景（可空）"
          />
        </n-form-item>
        <n-form-item label="系统提示词" :show-feedback="false">
          <n-input
            v-model:value="form.systemPrompt"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 18 }"
            placeholder="告诉模型它是谁、怎么说话、能做什么"
          />
        </n-form-item>
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
