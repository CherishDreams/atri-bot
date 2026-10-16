<script setup lang="ts">
import type { ProfileRecord } from "@atri/shared";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useProfilesStore } from "@/stores/profiles";
import { useProfile } from "@/composables/useProfile";

/**
 * 配置的列表与其管理动作（新建 / 切到这里 / 删除）。
 *
 * 它现在只挂在「配置文件」页左上角切换器的「管理配置」弹窗里（`ManageProfilesModal`）——
 * 配置的增删不单独占一页。
 *
 * 与另外几个面板的关键差别：**这一块自己不选配置**。它管的是「有哪些」，
 * 所以不套 `ProfileGate`，也不会因为没选而挡住你新建第一份。
 *
 * 「删除」是真的删：`DELETE /profiles/{id}` 会连同 `profiles/<id>/` 整个目录
 * （`config.json` 与插件数据）一起移除，不可恢复。所以二次确认必须写明这一点，
 * 并保留服务端的 409 —— 那一份还占着会话时不能删。
 *
 * **创建后不能改名**：`id` 是目录名，显示名在新建表单里一次写死。改名的入口与端点
 * 都已删除 —— 一个「只改显示名」的动作在这里换不来什么，却让「id 与名字不一致」多一种来源。
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

async function onRemove(row: ProfileRecord): Promise<void> {
  if (!(await store.remove(row.id))) return;
  // 删掉的正是当前选中的那一份：留着这个 query 会让接下来的每个作用域请求拿到 404。
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
  <div class="atri-profile-list">
    <div class="mb-3 flex items-end justify-between gap-3">
      <p class="m-0 text-13px text-ink-muted">
        一份配置 = 一套「跑法」：工具开关、插件启用清单与默认模型各存一份，放在
        <code>data/profiles/&lt;id&gt;/config.json</code>。监听地址、口令、数据目录属于整个 部署，在
        <code>atri.config.json</code> 里；供应商也是全局一份，在 <code>data/providers.json</code>。
      </p>
      <n-button type="primary" @click="openCreate">新建</n-button>
    </div>

    <p v-if="store.error" class="m-0 mb-3 text-13px text-danger">{{ store.error }}</p>

    <p v-if="!store.loading && store.profiles.length === 0" class="mb-4 text-13px text-ink-faint">
      还没有配置。
    </p>

    <!-- 用自绘列表而不是 n-data-table 的 render 塞交互组件：自动导入的 naive-ui 组件
         属性**不受 vue-tsc 校验**，在 render 函数里把 `type` 写错只会静默不配色，
         `failed` 看着和 `ready` 一样 —— 而这正是这一页唯一要传达的差别。 -->
    <ul class="m-0 mt-4 flex list-none flex-col gap-2 p-0">
      <li
        v-for="row in store.profiles"
        :key="row.id"
        class="flex flex-wrap items-center gap-3 rounded-xl border-1 border-line bg-surface p-3.5 shadow-sm transition-shadow hover:shadow-md"
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
        <!-- 删除必须二次确认：它会连同目录一起删掉（不可恢复），并让所有打这份配置的请求变成 404。 -->
        <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="onRemove(row)">
          <template #trigger>
            <n-button size="small" type="error" tertiary>删除</n-button>
          </template>
          删除配置「{{ row.name }}」？它的配置文件与插件数据会被一起删掉，不可恢复。
        </n-popconfirm>
      </li>
    </ul>

    <p class="mt-5 mb-0 text-xs leading-relaxed text-ink-faint">
      删除会连同 <code>data/profiles/&lt;id&gt;/</code> 整个目录一起移除（含插件数据），不可恢复。
      它还占着某个会话时服务端会拒绝，等那一轮对话结束后再来。
    </p>

    <n-modal
      v-model:show="createVisible"
      preset="card"
      title="新建配置"
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
  </div>
</template>
