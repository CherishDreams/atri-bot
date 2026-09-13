<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useToolsStore } from "../stores/tools.js";
import { useProfile } from "../composables/useProfile";
import ProfileGate from "../components/shared/ProfileGate.vue";

const tools = useToolsStore();
const { profile } = useProfile();

/** 换档就要重读：工具开关是**每份配置档**的，留着上一份的列表会把禁用显示成启用。 */
function load(p: string): void {
  void tools.refresh(p).catch((err: unknown) => {
    tools.error = err instanceof Error ? err.message : "工具列表加载失败";
  });
}

onMounted(() => {
  if (profile.value !== null) load(profile.value);
});
watch(profile, (p) => {
  if (p !== null) load(p);
});
</script>

<template>
  <div class="atri-tools-view h-full overflow-y-auto bg-canvas">
    <ProfileGate v-slot="{ profile: pid }">
      <div class="mx-auto max-w-form p-6">
        <header class="mb-5">
          <h2 class="m-0 text-2xl font-bold text-ink">工具</h2>
          <!-- 这段说明不是装饰：默认关闭是「反直觉」的那一半，
             不写出来，用户会以为坏了，而不是「还没开」。 -->
          <p class="mt-1 m-0 text-sm text-ink-muted">
            工具默认<b class="text-ink">全部关闭</b>。在这里启用会写进
            <code class="text-xs">atri.config.json</code>
            的 <code class="text-xs">tools</code> 段，不需要重启就会生效。
          </p>
        </header>

        <n-alert v-if="tools.error" class="mb-4" type="error" closable @close="tools.clearError()">
          {{ tools.error }}
        </n-alert>

        <n-spin :show="tools.loading">
          <n-empty
            v-if="!tools.loading && tools.tools.length === 0"
            description="没有注册任何工具"
            size="small"
          />

          <ul v-else class="m-0 flex list-none flex-col gap-2.5 p-0">
            <li
              v-for="tool in tools.tools"
              :key="tool.id"
              class="flex flex-col gap-2 rounded-lg border-1 border-line bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
            >
              <!--
              开关与状态标签同一行、且始终排在文字之前：bot 布局的侧栏是固定 232px
              （`theme/tokens.ts` 的 `navW`），375 视口下内容列只剩 143px——
              三个子项并排会把这张卡片压成 95×875 的一条，实测如此。
              窄屏改成上下两段后，卡片宽度回到 143、高度回到可读的范围。
            -->
              <div class="flex shrink-0 items-center gap-2">
                <!--
                判据是 `=== true`，与 ProviderConfig 里那几处 `!== false` 相反，
                这不是笔误也不该被「统一」：适配器没写就启用（最坏是少听一个端口），
                工具没写就启用等于一次升级静默给模型新增能力。真源在服务端
                （core/tool/store.ts 每次现读文件），这里只是把它读出来的结果画出来。
              -->
                <n-switch
                  :value="tool.enabled === true"
                  size="small"
                  :aria-label="`启用 ${tool.name}`"
                  @update:value="(on: boolean) => tools.setEnabled(pid, tool.id, on)"
                />
                <n-tag size="tiny" :type="tool.enabled === true ? 'success' : 'default'">
                  {{ tool.enabled === true ? "已启用" : "已禁用" }}
                </n-tag>
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium text-ink">{{ tool.name }}</div>
                <div class="truncate text-xs text-ink-faint">{{ tool.id }}</div>
                <div class="mt-1 text-xs text-ink-muted">{{ tool.description }}</div>
              </div>
            </li>
          </ul>
        </n-spin>

        <p class="mt-5 mb-0 text-xs text-ink-faint">
          已启用 {{ tools.enabledCount }} / {{ tools.tools.length }}
        </p>
      </div>
    </ProfileGate>
  </div>
</template>
