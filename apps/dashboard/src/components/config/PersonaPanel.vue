<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { PersonaInfo } from "@/api/client.js";
import * as api from "@/api/client.js";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「人格」分类：只选这一档引用哪一份人格。
 * 人格正文是全局资源，增删改在主导航的「人格配置」页；这里保存的是档文件里的 `personaId`。
 */
const draft = useProfileConfigStore();
const personas = ref<PersonaInfo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    personas.value = (await api.listPersonas()).personas;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

const options = computed(() => {
  const list = personas.value.map((persona) => ({
    label: persona.name,
    value: persona.id,
  }));
  const current = draft.draft?.personaId;
  if (current && !personas.value.some((persona) => persona.id === current)) {
    list.unshift({ label: `${current}（人格库里已没有）`, value: current });
  }
  return [{ label: "不使用人格", value: "" }, ...list];
});

const value = computed<string>({
  get: () => draft.draft?.personaId ?? "",
  set: (next) => draft.setPersona(next === "" ? null : next),
});

const dirty = computed(() => draft.draft?.personaId !== draft.original?.personaId);
const selected = computed(
  () => personas.value.find((persona) => persona.id === draft.draft?.personaId) ?? null,
);
</script>

<template>
  <ConfigCard
    title="人格"
    hint="人格是全局资源：同一份人设可以被多份配置引用。这里选的是这一档用哪一个。"
  >
    <n-alert v-if="error" type="error" class="mb-3" :show-icon="false">{{ error }}</n-alert>
    <n-spin :show="loading">
      <ConfigItem
        label="使用人格"
        hint="人格提示作为 system 消息注入每一轮，不会出现在会话历史里；保存后下一次消息立即生效。"
        :dirty="dirty"
      >
        <template #control>
          <n-select
            v-model:value="value"
            :options="options"
            size="small"
            class="w-full sm:w-[20rem]"
            aria-label="这一档使用的人格"
          />
        </template>
      </ConfigItem>
    </n-spin>

    <div v-if="selected" class="mt-1 rounded-lg border-1 border-line bg-raised px-3.5 py-3">
      <p class="m-0 text-xs font-medium text-ink">{{ selected.name }}</p>
      <p v-if="selected.description" class="mt-1 mb-0 text-xs text-ink-muted">
        {{ selected.description }}
      </p>
      <p
        class="mt-2 mb-0 max-h-20 overflow-hidden text-xs leading-relaxed whitespace-pre-wrap text-ink-faint"
      >
        {{ selected.systemPrompt }}
      </p>
    </div>

    <template #footer>
      想新建或修改人格内容？
      <router-link :to="{ name: 'personas' }" class="text-primary hover:text-primary-hover">
        前往「人格配置」
      </router-link>
      <template v-if="dirty"> —— 这里的选择保存后生效</template>
    </template>
  </ConfigCard>
</template>
