<script setup lang="ts">
import { ref, watch } from "vue";
import type { CommandInfo } from "@/api/generated/index.js";
import { listCommands } from "@/api/client";

/**
 * 已注册指令的只读清单（内置 + 这一档运行中的插件声明的）。
 *
 * 指令不做按档开关 —— 要关一条指令就去禁用提供它的插件 —— 所以这里没有开关，
 * 价值在「看得见谁注册了什么」：排查「敲了 /xxx 没反应」时，先看它在不在这张表里。
 * 注册表现读，插件重载/禁用后跟着 profile 的刷新重新拉。
 */
const props = defineProps<{ profile: string | null }>();

const commands = ref<CommandInfo[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function refresh(pid: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await listCommands(pid);
    commands.value = res.commands;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.profile,
  (pid) => {
    commands.value = [];
    if (pid !== null) void refresh(pid);
  },
  { immediate: true },
);

function permissionLabel(command: CommandInfo): string {
  return command.permission === "admin" ? "仅管理员" : "所有人";
}
</script>

<template>
  <section class="rounded-lg border border-line bg-surface px-4 py-4">
    <header class="mb-1 flex items-baseline justify-between gap-2">
      <h3 class="m-0 text-15px font-semibold text-ink">已注册指令</h3>
      <span class="text-12px text-ink-faint">{{ commands.length }} 条</span>
    </header>
    <p class="mt-0 mb-3 text-12px leading-relaxed text-ink-muted">
      在聊天里以「唤醒前缀 + 指令名」触发，回复不经过模型。指令随提供它的插件启停自动进退，
      要关闭一条指令就禁用那个插件。
    </p>

    <n-alert v-if="error" type="error" :show-icon="false" class="mb-3">
      指令清单读取失败：{{ error }}
    </n-alert>
    <n-spin v-else :show="loading" size="small">
      <n-empty v-if="commands.length === 0" size="small" description="还没有可用的指令" />
      <table v-else class="w-full border-collapse text-13px">
        <thead>
          <tr class="border-b border-line text-left text-12px text-ink-faint">
            <th class="py-1.5 pr-3 font-normal">指令</th>
            <th class="py-1.5 pr-3 font-normal">说明</th>
            <th class="py-1.5 pr-3 font-normal">权限</th>
            <th class="py-1.5 font-normal">来源</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="command in commands"
            :key="`${command.source}:${command.name}`"
            class="border-b border-line/60 last:border-b-0"
          >
            <td class="py-2 pr-3 align-top">
              <div class="font-medium text-ink">/{{ command.name }}</div>
              <div v-if="command.aliases.length > 0" class="text-12px text-ink-faint">
                别名：{{ command.aliases.map((alias) => `/${alias}`).join("、") }}
              </div>
              <div v-if="command.usage" class="text-12px text-ink-muted">
                用法：/{{ command.usage }}
              </div>
            </td>
            <td class="py-2 pr-3 align-top text-ink-muted">{{ command.description }}</td>
            <td class="py-2 pr-3 align-top">
              <n-tag
                size="small"
                :bordered="false"
                :type="command.permission === 'admin' ? 'warning' : 'default'"
              >
                {{ permissionLabel(command) }}
              </n-tag>
            </td>
            <td class="py-2 align-top text-12px text-ink-faint">
              {{ command.source === "builtin" ? "内置" : command.source }}
            </td>
          </tr>
        </tbody>
      </table>
    </n-spin>
  </section>
</template>
