<script setup lang="ts">
import type { PluginSettingField } from "@/api/generated/index.js";
import type { SettingValue } from "@/stores/pluginSettings";
import ConfigItem from "@/components/config/ConfigItem.vue";

/**
 * `_conf_schema.json` 的六种类型 → 控件。
 *
 * 这里是**唯一的映射点**：服务端 v1 只接受这六种，别的类型在 schema 层就整份作废
 *（`schemaError`），所以不会出现「表单画了一个存不进去的控件」。新增类型要同时改
 * 服务端的 `PluginSettingType`、校验与这里，三处缺一处就会有一个说不清的分支。
 *
 * 控件宽度按抽屉的 520px 上限定：`sm` 断点以上 ConfigItem 是左右两栏，控件占 14rem
 * 仍然放得下；窄屏（含窄抽屉）会自动退成上下两段。
 */
const props = defineProps<{
  fields: PluginSettingField[];
  original: Record<string, SettingValue>;
  draft: Record<string, SettingValue>;
}>();

const emit = defineEmits<{ (e: "set", key: string, value: SettingValue): void }>();

function isDirty(key: string): boolean {
  return props.draft[key] !== props.original[key];
}

function asString(key: string, fallback: SettingValue): string {
  const value = props.draft[key];
  return typeof value === "string" ? value : String(fallback);
}

function asNumber(key: string, fallback: SettingValue): number {
  const value = props.draft[key];
  if (typeof value === "number") return value;
  return typeof fallback === "number" ? fallback : 0;
}

function asBool(key: string, fallback: SettingValue): boolean {
  const value = props.draft[key];
  return typeof value === "boolean" ? value : fallback === true;
}

function onText(key: string, value: string): void {
  emit("set", key, value);
}

/** `n-input-number` 清空时给的是 null；草稿只接受数字，忽略空输入而不是存一个非法值。 */
function onNumber(key: string, value: number | null): void {
  if (typeof value === "number") emit("set", key, value);
}

function onBool(key: string, value: boolean): void {
  emit("set", key, value);
}

function onSelect(key: string, value: string): void {
  emit("set", key, value);
}

function optionsOf(field: PluginSettingField): { label: string; value: string }[] {
  return (field.options ?? []).map((option) => ({ label: option, value: option }));
}
</script>

<template>
  <div class="atri-plugin-config-form">
    <ConfigItem
      v-for="field in fields"
      :key="field.key"
      :label="field.description"
      :code="field.key"
      :hint="field.hint"
      :dirty="isDirty(field.key)"
    >
      <template #control>
        <!--
          宽度写在**外层盒子**上，而不是直接写在 naive-ui 组件上。`n-input`（textarea）
          自己带 `width: 100%`，而 ConfigItem 的控件槽是 `shrink-0` + auto 宽：直接给组件
          `w-[14rem]` 会与那条 100% 打架，百分比相对一个由内容撑开的盒子形成循环，
          实测被压成 24px 并挤出抽屉。给外层一个确定宽度后，100% 才有解析基准。
        -->
        <div v-if="field.type === 'string'" class="w-[14rem]">
          <n-input
            :value="asString(field.key, field.default)"
            class="w-full"
            placeholder="请输入"
            clearable
            @update:value="(value: string) => onText(field.key, value)"
          />
        </div>

        <div v-else-if="field.type === 'text'" class="w-[14rem]">
          <n-input
            type="textarea"
            :value="asString(field.key, field.default)"
            :autosize="{ minRows: 3, maxRows: 8 }"
            class="w-full"
            placeholder="请输入"
            @update:value="(value: string) => onText(field.key, value)"
          />
        </div>

        <div v-else-if="field.type === 'int'" class="w-[10rem]">
          <n-input-number
            :value="asNumber(field.key, field.default)"
            :precision="0"
            :min="field.min"
            :max="field.max"
            class="w-full"
            @update:value="(value: number | null) => onNumber(field.key, value)"
          />
        </div>

        <div v-else-if="field.type === 'float'" class="w-[10rem]">
          <n-input-number
            :value="asNumber(field.key, field.default)"
            :min="field.min"
            :max="field.max"
            class="w-full"
            @update:value="(value: number | null) => onNumber(field.key, value)"
          />
        </div>

        <n-switch
          v-else-if="field.type === 'bool'"
          :value="asBool(field.key, field.default)"
          @update:value="(value: boolean) => onBool(field.key, value)"
        />

        <div v-else-if="field.type === 'select'" class="w-[10rem]">
          <n-select
            :value="asString(field.key, field.default)"
            :options="optionsOf(field)"
            class="w-full"
            placeholder="请选择"
            @update:value="(value: string) => onSelect(field.key, value)"
          />
        </div>
      </template>
    </ConfigItem>
  </div>
</template>
