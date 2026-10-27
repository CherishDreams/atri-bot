<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { SkillInfo } from "@/api/generated/index.js";
import { getSkill, listSkills } from "@/api/client";

/**
 * 技能页（部署级，不随配置档）。
 *
 * 技能是文件资源：装一个技能 = 把 `<技能名>/SKILL.md` 放进 data/skills/（或随插件
 * 目录分发），删 = 删目录。这一页只读 —— 列目录、看全文，以及说明「怎么装」。
 * 「这一档启用哪些」在配置工作台的「技能」分类。
 */
const skills = ref<SkillInfo[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const viewing = ref<SkillInfo | null>(null);
const content = ref<string | null>(null);
const contentLoading = ref(false);

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await listSkills();
    skills.value = res.skills;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void refresh());

const sourceLabel = computed(
  () => (skill: SkillInfo) => (skill.source === "skills" ? "部署级" : `插件：${skill.source}`),
);

async function open(skill: SkillInfo): Promise<void> {
  viewing.value = skill;
  content.value = null;
  contentLoading.value = true;
  try {
    const res = await getSkill(skill.id);
    content.value = res.content;
  } catch (err) {
    content.value = `读取失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    contentLoading.value = false;
  }
}
</script>

<template>
  <div class="atri-skills-view h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[58rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5">
        <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">技能</h2>
        <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
          技能是给模型用的「任务操作手册」（一个文件夹 +
          <code class="text-xs">SKILL.md</code>）。装一个技能：把
          <code class="text-xs">data/skills/&lt;技能名&gt;/SKILL.md</code> 放好即可（frontmatter 写
          name 与
          description），也可以随插件目录分发。某一份配置要不要用它在配置文件页的「技能」分类里勾选。
        </p>
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

      <n-spin :show="loading">
        <n-empty
          v-if="skills.length === 0 && !loading"
          description="还没有安装任何技能 —— 按上面的说明放一个 SKILL.md 进 data/skills/ 即可"
        />
        <div v-else class="flex flex-col gap-3">
          <section
            v-for="skill in skills"
            :key="skill.id"
            class="rounded-lg border border-line bg-surface px-4 py-4"
          >
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="m-0 text-15px font-semibold text-ink">{{ skill.name }}</h3>
              <n-tag size="small" :bordered="false">{{ sourceLabel(skill) }}</n-tag>
              <n-button quaternary size="tiny" class="ml-auto" @click="open(skill)"
                >查看全文</n-button
              >
            </div>
            <p class="mb-0 mt-1.5 text-13px text-ink-muted">
              {{
                skill.description === "" ? "（frontmatter 里没有 description）" : skill.description
              }}
            </p>
            <p class="mb-0 mt-1 text-12px text-ink-faint">id: {{ skill.id }}</p>
          </section>
        </div>
      </n-spin>
    </div>

    <n-modal
      :show="viewing !== null"
      preset="card"
      :title="viewing?.name ?? ''"
      class="w-[min(680px,96vw)]"
      @update:show="(show: boolean) => (viewing = show ? viewing : null)"
    >
      <n-spin :show="contentLoading">
        <pre
          class="m-0 max-h-[60vh] overflow-auto rounded-md bg-raised p-3 text-12px leading-relaxed whitespace-pre-wrap text-ink"
          >{{ content ?? "加载中…" }}</pre>
      </n-spin>
    </n-modal>
  </div>
</template>
