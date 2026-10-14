<script setup lang="ts">
import { computed } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「运行参数」分类：这一跑法自己的节奏。
 *
 * 单轮步数上限是**这一档**的（每个档可以不同）：它决定一条消息里最多跑几次工具，
 * 而不同用途的档（工作台 vs 闲聊）合理的步数本来不一样。默认 5、范围 1–50，
 * 越界在服务端是 400 而不是夹取 —— 所以这里的控件也把范围画出来。
 */
const draft = useProfileConfigStore();

const value = computed<number | null>({
  get: () => draft.draft?.maxToolSteps ?? null,
  set: (next) => {
    // `n-input-number` 清空时发 null：不把 null 写进草稿，否则保存会撞上 400
    //（服务端要求整数）。清空等于「这次不打算改」，草稿保持原值更接近意图。
    if (typeof next === "number") draft.setMaxSteps(next);
  },
});

const dirty = computed(() => draft.draft?.maxToolSteps !== draft.original?.maxToolSteps);
</script>

<template>
  <ConfigCard title="运行参数" hint="这一组是这一跑法自己的节奏，不涉及任何凭证。">
    <ConfigItem
      label="单轮工具步数上限"
      code="maxToolSteps"
      hint="一条消息里最多跑几步工具。到上限会停下并回一句中文说明。1–50，默认 5。"
      :dirty="dirty"
    >
      <template #control>
        <n-input-number
          :value="value"
          :min="1"
          :max="50"
          :step="1"
          size="small"
          class="w-[8rem]"
          aria-label="单轮工具步数上限"
          @update:value="(next: number | null) => (value = next)"
        />
      </template>
    </ConfigItem>
    <template #footer>
      引擎读的是**落盘后**的值：这里改了要点「保存」，下一条消息才按新步数走。
    </template>
  </ConfigCard>
</template>
