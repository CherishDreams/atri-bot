<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import { useProvidersStore } from "@/stores/providers";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「默认模型」分类。
 *
 * 这里选的是**全局清单里的一个实例**，写进这一档自己的文件（`defaultProvider`）。
 * 与 chat 顶栏那个选择器是同一个键、同一个端点，两处显示同源（都来自服务端回读）。
 */
const draft = useProfileConfigStore();
const providers = useProvidersStore();

onMounted(() => {
  // 清单是全局一份，进这一页拉一次就够；已经拉过就不必再打一次。
  if (providers.providers.length === 0) void providers.init();
});

const options = computed(() => {
  const list = providers.choices.map((c) => ({
    label: `${c.model} · ${c.source}${c.isDefault ? "（全局默认）" : ""}`,
    value: c.providerId,
  }));
  // 草稿指向的实例已经不在清单里（被删/被禁/没加载成功）时，把它原样留在选项里：
  // 否则 n-select 会静默显示成第一个选项，而用户以为默认被换了 —— 那是一次看不见的改动。
  const current = draft.draft?.defaultProviderId;
  if (current && !providers.choices.some((c) => c.providerId === current)) {
    list.unshift({ label: `${current}（清单里已没有）`, value: current });
  }
  return [{ label: "跟随全局默认", value: "" }, ...list];
});

const value = computed<string>({
  get: () => draft.draft?.defaultProviderId ?? "",
  set: (next) => draft.setDefaultProvider(next === "" ? null : next),
});

const dirty = computed(() => draft.draft?.defaultProviderId !== draft.original?.defaultProviderId);

const globalDefault = computed(() => providers.choices.find((c) => c.isDefault)?.model ?? null);
</script>

<template>
  <ConfigCard
    title="默认模型"
    hint="这一档发消息时不带 model 就打到它。清单是全局的（供应商那一组），这里只选一个。"
  >
    <ConfigItem
      label="对话模型"
      hint="「跟随全局默认」表示这一档没有自己的默认，用供应商页那个全局默认。"
      :dirty="dirty"
    >
      <template #control>
        <n-select
          v-model:value="value"
          :options="options"
          size="small"
          class="w-full sm:w-[20rem]"
          aria-label="这一档的默认模型"
        />
      </template>
    </ConfigItem>
    <template #footer>
      当前生效：{{
        draft.draft?.defaultProviderId
          ? (providers.choices.find((c) => c.providerId === draft.draft?.defaultProviderId)
              ?.model ?? draft.draft?.defaultProviderId)
          : (globalDefault ?? "回声兜底（还没有可用的供应商）")
      }}<template v-if="dirty"> —— 改过了，保存后生效</template>
    </template>
  </ConfigCard>
</template>
