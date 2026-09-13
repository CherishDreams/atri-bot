<script setup lang="ts">
import type { ProfileRecord } from "@atri/shared";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useProfilesStore } from "@/stores/profiles";
import { useProfile } from "@/composables/useProfile";

/**
 * 配置档页。
 *
 * 与另外三个作用域页面的关键差别：**这一页自己不选配置档**。它管的是「有哪些档」，
 * 所以不需要 `ProfileGate`，也不会因为没选档而挡住你新建第一份。
 *
 * 「下线」不是「删除」：服务端从不删配置文件，也不删 `profiles/<id>/plugins/`，
 * 页面上必须说清这一点，否则操作者会以为磁盘上的东西没了。
 */
const store = useProfilesStore();
const { profile: current } = useProfile();
const route = useRoute();
const router = useRouter();

const createVisible = ref(false);
const newId = ref("");
const newName = ref("");

onMounted(() => {
  void store.refresh();
});

/** 新建成功后把当前档切过去：留在原档会让人以为没建成。 */
async function onCreate(): Promise<void> {
  const id = newId.value.trim();
  if (!id) return;
  const created = await store.create(id, newName.value.trim() || undefined);
  if (created === null) return;
  createVisible.value = false;
  newId.value = "";
  newName.value = "";
  void router.replace({ query: { ...route.query, profile: created } });
}

function openCreate(): void {
  newId.value = "";
  newName.value = "";
  store.clearError();
  createVisible.value = true;
}

/** 重命名：改的是显示名，目录与 id 都不动（动了插件数据就跟丢了）。 */
const renameVisible = ref(false);
const renameTarget = ref<ProfileRecord | null>(null);
const renameValue = ref("");

function openRename(row: ProfileRecord): void {
  renameTarget.value = row;
  renameValue.value = row.name;
  renameVisible.value = true;
}

async function onRename(): Promise<void> {
  const target = renameTarget.value;
  const name = renameValue.value.trim();
  if (!target || !name) return;
  if (await store.rename(target.id, name)) renameVisible.value = false;
}

async function onReload(row: ProfileRecord): Promise<void> {
  await store.reload(row.id);
}

async function onRemove(row: ProfileRecord): Promise<void> {
  if (!(await store.remove(row.id))) return;
  // 下线的正是当前选中的那一份：留着这个 query 会让接下来的每个作用域请求拿到 404。
  if (current.value === row.id) {
    const rest = { ...route.query };
    delete rest.profile;
    void router.replace({ query: rest });
  }
}

/** 这一行的状态标签。`failed` 用 error 色，与 `ready` 必须一眼可分。 */
function tagType(row: ProfileRecord): "success" | "error" {
  return row.status === "ready" ? "success" : "error";
}
</script>

<template>
  <div class="atri-profiles-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-form p-6">
      <header class="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 class="m-0 text-2xl font-bold text-ink">配置档</h2>
          <p class="mt-2 mb-0 text-13px leading-relaxed text-ink-muted">
            一份配置档 = 一套「跑法」：模型、工具开关与插件启用清单各存一份，放在
            <code>data/profiles/&lt;id&gt;/config.json</code
            >。监听地址、口令、数据目录属于整个部署， 在
            <code>atri.config.json</code> 里，不在这里。
          </p>
        </div>
        <n-button type="primary" @click="openCreate">新建</n-button>
      </header>

      <p v-if="store.error" class="m-0 mb-3 text-13px text-danger">{{ store.error }}</p>

      <p v-if="!store.loading && store.profiles.length === 0" class="mb-4 text-13px text-ink-faint">
        还没有配置档。
      </p>

      <!-- 用自绘列表而不是 n-data-table 的 render 塞交互组件：自动导入的 naive-ui 组件
           属性**不受 vue-tsc 校验**，在 render 函数里把 `type` 写错只会静默不配色，
           `failed` 看着和 `ready` 一样 —— 而这正是这一页唯一要传达的差别。 -->
      <ul class="m-0 mt-4 flex list-none flex-col gap-2 p-0">
        <li
          v-for="row in store.profiles"
          :key="row.id"
          class="flex flex-wrap items-center gap-3 rounded-lg border-1 border-line bg-surface p-3"
        >
          <n-tag size="small" :type="tagType(row)">
            {{ row.status === "ready" ? "可用" : "加载失败" }}
          </n-tag>
          <span class="font-medium text-ink">{{ row.name }}</span>
          <span class="text-xs text-ink-faint">{{ row.id }}</span>
          <span v-if="row.error" class="min-w-0 flex-1 truncate text-xs text-danger">
            {{ row.error }}
          </span>
          <span v-else class="min-w-0 flex-1"></span>
          <n-button
            size="small"
            :type="current === row.id ? 'primary' : 'default'"
            @click="router.replace({ query: { ...route.query, profile: row.id } })"
          >
            {{ current === row.id ? "当前使用" : "切到这里" }}
          </n-button>
          <n-button size="small" @click="openRename(row)">重命名</n-button>
          <n-button size="small" @click="onReload(row)">重载</n-button>
          <!-- 下线必须二次确认：它会立刻让所有打这份档的请求变成 404。 -->
          <n-popconfirm positive-text="下线" negative-text="取消" @positive-click="onRemove(row)">
            <template #trigger>
              <n-button size="small" type="error" tertiary>下线</n-button>
            </template>
            下线配置档「{{ row.name }}」？它的配置文件与插件数据都会留在磁盘上。
          </n-popconfirm>
        </li>
      </ul>

      <p class="mt-5 mb-0 text-xs leading-relaxed text-ink-faint">
        框架从不删你的文件：「下线」只是把它从服务里摘掉，要真正清理请自己
        <code>rm -rf data/profiles/&lt;id&gt;</code>。
      </p>
    </div>

    <n-modal
      v-model:show="createVisible"
      preset="card"
      title="新建配置档"
      class="w-[32rem] max-w-[92vw]"
    >
      <n-form label-placement="top" @submit.prevent="onCreate">
        <n-form-item label="id（同时是目录名）">
          <n-input v-model:value="newId" placeholder="小写字母或数字开头，可含 . _ -，长 1–64" />
        </n-form-item>
        <n-form-item label="显示名（可留空）">
          <n-input v-model:value="newName" placeholder="留空则与 id 相同" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="createVisible = false">取消</n-button>
          <n-button type="primary" @click="onCreate">创建</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="renameVisible"
      preset="card"
      title="重命名"
      class="w-[28rem] max-w-[92vw]"
    >
      <n-input v-model:value="renameValue" placeholder="新的显示名" />
      <p class="mt-3 mb-0 text-xs text-ink-faint">
        只改显示名。id 与目录都不动 —— 目录一动，那份档的插件数据就跟丢了。
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="renameVisible = false">取消</n-button>
          <n-button type="primary" @click="onRename">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
