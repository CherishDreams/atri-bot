<script setup lang="ts">
import { computed } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";

/**
 * 「技能」分类：这一档注入模型的任务手册勾选清单。
 *
 * 技能本体在「技能」页（部署级文件），这里只做引用 —— 与人格同一模式：
 * 全局内容资产 + 档里一根引用。勾选是**整体替换**语义（服务端如此），
 * 界面上每行一个开关，保存时整份 enabled 发出去。
 */
const draft = useProfileConfigStore();

const skills = computed(() => draft.loaded?.availableSkills ?? []);
/** 空说明的技能不给勾：目录注入没有说明就是噪音（服务端也把它当不可用）。 */
function usable(description: string): boolean {
  return description.trim() !== "";
}

function checked(id: string): boolean {
  return draft.draft?.skills.enabled.includes(id) ?? false;
}

function dirty(): boolean {
  if (draft.draft === null || draft.original === null) return false;
  const a = draft.draft.skills.enabled;
  const b = draft.original.skills.enabled;
  return a.length !== b.length || a.some((id, index) => b[index] !== id);
}
</script>

<template>
  <ConfigCard
    title="技能"
    hint="技能是按既定流程完成任务的操作手册。启用的技能只把「名字 + 说明」放进对话开头，模型按需读取全文（渐进式披露，不会一次吃满上下文）。"
  >
    <n-empty
      v-if="skills.length === 0"
      size="small"
      description="还没有可用的技能 —— 去主导航的「技能」页按说明安装一个"
    />
    <div v-else class="flex flex-col">
      <div
        v-for="skill in skills"
        :key="skill.id"
        class="flex items-start gap-3 border-b border-line/60 py-2.5 last:border-b-0"
      >
        <n-switch
          size="small"
          :value="checked(skill.id)"
          :disabled="!usable(skill.description)"
          :aria-label="`启用技能 ${skill.name}`"
          @update:value="(v: boolean) => draft.setSkill(skill.id, v)"
        />
        <div class="min-w-0">
          <div class="text-13px font-medium text-ink">
            {{ skill.name }}
            <span class="ml-1 text-12px text-ink-faint">{{ skill.id }}</span>
            <n-tag v-if="skill.source !== 'skills'" size="tiny" :bordered="false" class="ml-1">
              插件：{{ skill.source }}
            </n-tag>
          </div>
          <div class="text-12px leading-relaxed text-ink-muted">
            {{
              skill.description === ""
                ? "frontmatter 缺 description，补上才能启用"
                : skill.description
            }}
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <span v-if="dirty()" class="text-warning">有未保存的勾选改动。</span>
      <span v-else>保存后下一条消息生效：启用清单随档文件现读。</span>
    </template>
  </ConfigCard>
</template>
