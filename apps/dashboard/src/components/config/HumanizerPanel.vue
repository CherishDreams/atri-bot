<script setup lang="ts">
import { computed } from "vue";
import { useProfileConfigStore } from "@/stores/profileConfig";
import ConfigCard from "./ConfigCard.vue";
import ConfigItem from "./ConfigItem.vue";

/**
 * 「拟人化」分类：怎么收消息、怎么发出去。
 *
 * 全部是**被动**的对话行为调节（主动消息的开关也在这里，但它默认关闭）。
 * 生效范围刻意分两半并在文案里说清：防抖/分段/去机器味只影响**平台路径**
 * （控制台是 Markdown 渲染器，剥标记反而毁排版），时间感知只影响报头。
 */
const draft = useProfileConfigStore();

function leafDirty(path: string): boolean {
  if (draft.draft === null || draft.original === null) return false;
  const read = (source: typeof draft.draft): unknown => {
    const segments = path.split(".");
    let current: unknown = source;
    for (const segment of segments) {
      current = (current as Record<string, unknown>)[segment] ?? null;
    }
    return current;
  };
  return JSON.stringify(read(draft.draft)) !== JSON.stringify(read(draft.original));
}

const wakePrefix = computed<string>({
  get: () => draft.draft?.wakePrefix ?? "/",
  set: (next) => draft.setWakePrefix(next.trim()),
});

// n-time-picker 的值是时间戳（毫秒），档文件里存的是 "HH:MM" 字符串，两边各做一次换算。
// 基准日期随意：只有「同一天内的时间差」是有意义的部分。
const BASE_DAY = new Date(2000, 0, 1).getTime();

function hhmmToTimestamp(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return BASE_DAY + Number(m[1]) * 3600_000 + Number(m[2]) * 60_000;
}

function timestampToHhmm(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const sleepStart = computed<number | null>({
  get: () => hhmmToTimestamp(draft.draft?.humanizer.schedule.sleepStart),
  set: (next) => draft.setHumanizerSchedule({ sleepStart: timestampToHhmm(next) }),
});

const sleepEnd = computed<number | null>({
  get: () => hhmmToTimestamp(draft.draft?.humanizer.schedule.sleepEnd),
  set: (next) => draft.setHumanizerSchedule({ sleepEnd: timestampToHhmm(next) }),
});
</script>

<template>
  <ConfigCard
    title="拟人化"
    hint="这些开关调节「怎么收消息、怎么发出去」。防抖、智能分段与去机器味只影响发送到平台的消息；时间感知只影响注入模型的上下文。"
  >
    <ConfigItem
      label="群聊唤醒前缀"
      code="wakePrefix"
      hint="群聊消息必须以它开头才被处理，也是指令的匹配前缀；私聊不设门槛。留空关闭门槛（此时指令仍按 / 识别）。"
      :dirty="leafDirty('wakePrefix')"
    >
      <template #control>
        <n-input
          :value="wakePrefix"
          size="small"
          class="w-[8rem]"
          placeholder="/"
          aria-label="群聊唤醒前缀"
          @update:value="(v: string) => (wakePrefix = v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="连续输入防抖"
      code="humanizer.debounceSeconds"
      hint="对方还在打字时逐条回复既吵又不合常理：这个沉默窗口（秒）内的多条消息会合并成一轮再回复。0 = 关闭。"
      :dirty="leafDirty('humanizer.debounceSeconds')"
    >
      <template #control>
        <n-input-number
          :value="draft.draft?.humanizer.debounceSeconds ?? 0"
          :min="0"
          :max="300"
          :step="1"
          size="small"
          class="w-[8rem]"
          aria-label="防抖秒数"
          @update:value="(v: number | null) => draft.setHumanizer('debounceSeconds', v ?? 0)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="智能分段"
      code="humanizer.smartChunk"
      hint="发送到平台前按句子分段：短句各成一条消息，更像人；关闭则按平台长度上限硬切。"
      :dirty="leafDirty('humanizer.smartChunk')"
    >
      <template #control>
        <n-switch
          :value="draft.draft?.humanizer.smartChunk ?? true"
          aria-label="智能分段"
          @update:value="(v: boolean) => draft.setHumanizer('smartChunk', v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="去机器味"
      code="humanizer.stripMarkdown"
      hint="发送前剥掉 **、#、` 等 markdown 标记（IM 里它们看着像机器）。控制台不受影响。"
      :dirty="leafDirty('humanizer.stripMarkdown')"
    >
      <template #control>
        <n-switch
          :value="draft.draft?.humanizer.stripMarkdown ?? false"
          aria-label="去机器味"
          @update:value="(v: boolean) => draft.setHumanizer('stripMarkdown', v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="时间感知"
      code="humanizer.timeAwareness"
      hint="每轮告诉模型现在几点、按作息处于什么状态 —— 深夜说早安是最刺眼的穿帮。"
      :dirty="leafDirty('humanizer.timeAwareness')"
    >
      <template #control>
        <n-switch
          :value="draft.draft?.humanizer.timeAwareness ?? true"
          aria-label="时间感知"
          @update:value="(v: boolean) => draft.setHumanizer('timeAwareness', v)"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="入睡 / 起床"
      code="humanizer.schedule"
      hint="作息日程（服务器本地时区）。时间感知与主动消息都按它判断此刻的状态；留空表示不睡觉。"
      :dirty="leafDirty('humanizer.schedule')"
    >
      <template #control>
        <div class="flex items-center gap-1">
          <n-time-picker
            v-model:value="sleepStart"
            format="HH:mm"
            size="small"
            class="w-[6.5rem]"
            placeholder="不睡觉"
            aria-label="入睡时间"
          />
          <span class="text-ink-faint">–</span>
          <n-time-picker
            v-model:value="sleepEnd"
            format="HH:mm"
            size="small"
            class="w-[6.5rem]"
            aria-label="起床时间"
          />
        </div>
      </template>
    </ConfigItem>

    <ConfigItem
      label="午休时长"
      code="humanizer.schedule.napMinutes"
      hint="从 13:00 起的午休分钟数；0 = 不午休。"
      :dirty="leafDirty('humanizer.schedule.napMinutes')"
    >
      <template #control>
        <n-input-number
          :value="draft.draft?.humanizer.schedule.napMinutes ?? 0"
          :min="0"
          :max="240"
          :step="5"
          size="small"
          class="w-[8rem]"
          aria-label="午休分钟"
          @update:value="(v: number | null) => draft.setHumanizerSchedule({ napMinutes: v ?? 0 })"
        />
      </template>
    </ConfigItem>

    <ConfigItem
      label="日记与记忆巩固"
      code="humanizer.diary.enabled"
      hint="每天到点把当天的互动记录交给模型提炼成一篇日记与几条事实，写回记忆 —— 交互原文是糙的，提炼后的才好召回。"
      :dirty="leafDirty('humanizer.diary.enabled')"
    >
      <template #control>
        <div class="flex items-center gap-2">
          <n-switch
            :value="draft.draft?.humanizer.diary.enabled ?? true"
            aria-label="日记巩固"
            @update:value="(v: boolean) => draft.setHumanizerDiary({ enabled: v })"
          />
          <n-input-number
            :value="draft.draft?.humanizer.diary.hour ?? 22"
            :min="0"
            :max="23"
            :step="1"
            size="small"
            class="w-[7rem]"
            aria-label="日记时间"
            @update:value="(v: number | null) => draft.setHumanizerDiary({ hour: v ?? 22 })"
          />
          <span class="text-12px text-ink-faint">点起写</span>
        </div>
      </template>
    </ConfigItem>

    <template #footer>
      改完要点「保存」：防抖与分段对下一条平台消息生效，时间感知对下一轮对话生效，
      日记在每天设定的小时之后由后台任务写一次。
    </template>
  </ConfigCard>
</template>
