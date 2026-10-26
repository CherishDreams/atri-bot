<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { McpServerInfo } from "@/api/generated/index.js";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  probeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
} from "@/api/client";

/**
 * MCP 服务器页（部署级，不随配置档）。
 *
 * 连接清单与工具桥接在这里维护；「这一档开哪些 MCP 工具」不在这里 —— 那是配置
 * 工作台的「工具」分类，与服务端同一份注册表。服务器的连接状态是现读的运行态：
 * 每次操作后整体刷新，而不是本地推算。
 */

interface DraftServer {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string;
  command: string;
  argsText: string;
  envText: string;
  headersText: string;
  enabled: boolean;
  timeoutMs: number | null;
}

const servers = ref<McpServerInfo[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const editingId = ref<string | null>(null); // null = 新建；字符串 = 编辑该台
const showForm = ref(false);
const saving = ref(false);

const draft = ref<DraftServer>(emptyDraft());

function emptyDraft(): DraftServer {
  return {
    id: "",
    name: "",
    transport: "http",
    url: "",
    command: "",
    argsText: "",
    envText: "",
    headersText: "",
    enabled: true,
    timeoutMs: null,
  };
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await listMcpServers();
    servers.value = res.servers;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void refresh());

const isStdio = computed(() => draft.value.transport === "stdio");

function openCreate(): void {
  editingId.value = null;
  draft.value = emptyDraft();
  showForm.value = true;
}

function openEdit(server: McpServerInfo): void {
  editingId.value = server.id;
  draft.value = {
    id: server.id,
    name: server.name === server.id ? "" : server.name,
    transport: server.transport as DraftServer["transport"],
    url: server.url ?? "",
    command: server.command ?? "",
    argsText: (server.args ?? []).join(" "),
    envText: toLines(server.env),
    headersText: toLines(server.headers),
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
  };
  showForm.value = true;
}

/** `KEY=VALUE` 每行一条 -> 映射。空行与没有 `=` 的行忽略。 */
function fromLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

function toLines(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

async function save(): Promise<void> {
  saving.value = true;
  actionError.value = null;
  const d = draft.value;
  const body: Record<string, unknown> = {
    id: d.id,
    name: d.name === "" ? undefined : d.name,
    transport: d.transport,
    enabled: d.enabled,
    ...(d.timeoutMs === null ? {} : { timeoutMs: d.timeoutMs }),
    ...(isStdio.value
      ? {
          command: d.command,
          args: d.argsText.trim() === "" ? [] : d.argsText.trim().split(/\s+/),
          ...(d.envText.trim() === "" ? {} : { env: fromLines(d.envText) }),
        }
      : {
          url: d.url,
          ...(d.headersText.trim() === "" ? {} : { headers: fromLines(d.headersText) }),
        }),
  };
  try {
    if (editingId.value === null) await createMcpServer(body);
    else await updateMcpServer(editingId.value, body);
    showForm.value = false;
    await refresh();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function runAction(id: string, action: () => Promise<unknown>): Promise<void> {
  actionError.value = null;
  try {
    await action();
    await refresh();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  }
}

const statusMeta: Record<
  string,
  { label: string; type: "success" | "error" | "warning" | "default" }
> = {
  connected: { label: "已连接", type: "success" },
  error: { label: "连接失败", type: "error" },
  disabled: { label: "已禁用", type: "default" },
  idle: { label: "未连接", type: "warning" },
};
</script>

<template>
  <div class="atri-mcp-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[58rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">MCP 服务器</h2>
          <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
            连接 Model Context Protocol 服务器，把它的工具挂进各配置档的工具清单
            （在配置文件页的「工具」分类里按档启用）。服务器是部署级的，改动立即生效。
          </p>
        </div>
        <n-button type="primary" size="small" class="ml-auto shrink-0" @click="openCreate">
          新增服务器
        </n-button>
      </header>

      <n-alert
        v-if="error"
        type="error"
        :show-icon="false"
        closable
        class="mb-4"
        @close="error = null"
      >
        读取失败：{{ error }}
      </n-alert>
      <n-alert
        v-if="actionError"
        type="error"
        :show-icon="false"
        closable
        class="mb-4"
        @close="actionError = null"
      >
        操作失败：{{ actionError }}
      </n-alert>

      <n-spin :show="loading">
        <n-empty
          v-if="servers.length === 0 && !loading"
          description="还没有 MCP 服务器 —— 点右上角「新增服务器」接入第一个"
        />
        <div v-else class="flex flex-col gap-3">
          <section
            v-for="server in servers"
            :key="server.id"
            class="rounded-lg border border-line bg-surface px-4 py-4"
          >
            <div class="flex flex-wrap items-center gap-2">
              <n-tag
                size="small"
                :bordered="false"
                :type="statusMeta[server.status]?.type ?? 'default'"
              >
                {{ statusMeta[server.status]?.label ?? server.status }}
              </n-tag>
              <h3 class="m-0 text-15px font-semibold text-ink">{{ server.name }}</h3>
              <n-tag size="small" :bordered="false">{{ server.transport }}</n-tag>
              <span class="text-12px text-ink-faint"> {{ server.tools.length }} 个工具 </span>
              <div class="ml-auto flex items-center gap-1">
                <n-button
                  quaternary
                  size="tiny"
                  @click="runAction(server.id, () => probeMcpServer(server.id))"
                >
                  测试连接
                </n-button>
                <n-button
                  quaternary
                  size="tiny"
                  @click="
                    runAction(server.id, () => setMcpServerEnabled(server.id, !server.enabled))
                  "
                >
                  {{ server.enabled ? "禁用" : "启用" }}
                </n-button>
                <n-button quaternary size="tiny" @click="openEdit(server)">编辑</n-button>
                <n-popconfirm
                  @positive-click="runAction(server.id, () => deleteMcpServer(server.id))"
                >
                  <template #trigger>
                    <n-button quaternary size="tiny" type="error">删除</n-button>
                  </template>
                  删除「{{ server.name }}」？它的工具会立即从所有配置档消失。
                </n-popconfirm>
              </div>
            </div>
            <p v-if="server.error" class="mb-0 mt-2 text-12px text-danger">
              {{ server.error }}
            </p>
            <p class="mb-0 mt-2 text-12px text-ink-faint">
              <template v-if="server.transport === 'stdio'">
                {{ server.command }} {{ (server.args ?? []).join(" ") }}
              </template>
              <template v-else>{{ server.url }}</template>
              <template v-if="server.headers && Object.keys(server.headers).length > 0">
                · {{ Object.keys(server.headers).length }} 个自定义请求头
              </template>
              <template v-if="server.env && Object.keys(server.env).length > 0">
                · {{ Object.keys(server.env).length }} 个环境变量
              </template>
            </p>
            <ul
              v-if="server.tools.length > 0"
              class="mb-0 mt-2 list-none p-0 text-12px text-ink-muted"
            >
              <li v-for="tool in server.tools" :key="tool.id" class="mt-0.5">
                <code class="text-ink">{{ tool.id }}</code> — {{ tool.description }}
              </li>
            </ul>
          </section>
        </div>
      </n-spin>
    </div>

    <n-modal
      v-model:show="showForm"
      preset="card"
      :title="editingId === null ? '新增 MCP 服务器' : `编辑 ${editingId}`"
      class="w-[min(560px,96vw)]"
    >
      <n-form label-placement="top" size="small">
        <n-form-item label="服务器 id" required>
          <n-input
            v-model:value="draft.id"
            :disabled="editingId !== null"
            placeholder="小写字母数字与 . _ -，例如 filesystem"
          />
        </n-form-item>
        <n-form-item label="显示名">
          <n-input v-model:value="draft.name" placeholder="缺省用 id" />
        </n-form-item>
        <n-form-item label="传输类型">
          <n-radio-group v-model:value="draft.transport">
            <n-radio value="http">Streamable HTTP</n-radio>
            <n-radio value="sse">SSE</n-radio>
            <n-radio value="stdio">stdio（本机子进程）</n-radio>
          </n-radio-group>
        </n-form-item>

        <template v-if="!isStdio">
          <n-form-item label="端点 URL" required>
            <n-input v-model:value="draft.url" placeholder="https://example.com/mcp" />
          </n-form-item>
          <n-form-item label="请求头（每行 KEY=VALUE，可放 token）">
            <n-input
              v-model:value="draft.headersText"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="Authorization=Bearer xxx"
            />
          </n-form-item>
        </template>
        <template v-else>
          <n-form-item label="命令" required>
            <n-input v-model:value="draft.command" placeholder="node / npx" />
          </n-form-item>
          <n-form-item label="参数（空格分隔）">
            <n-input
              v-model:value="draft.argsText"
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            />
          </n-form-item>
          <n-form-item label="环境变量（每行 KEY=VALUE）">
            <n-input
              v-model:value="draft.envText"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="API_KEY=xxx"
            />
          </n-form-item>
        </template>

        <n-form-item label="工具调用超时（毫秒）">
          <n-input-number
            v-model:value="draft.timeoutMs"
            :min="1000"
            :max="600000"
            :step="1000"
            class="w-[12rem]"
            placeholder="60000"
            clearable
          />
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="draft.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button size="small" @click="showForm = false">取消</n-button>
          <n-button type="primary" size="small" :loading="saving" @click="save"
            >保存并连接</n-button
          >
        </div>
      </template>
    </n-modal>
  </div>
</template>
