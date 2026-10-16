import { defineStore } from "pinia";
import type { PluginInfo, PluginSettingField, PluginSettingsView } from "../api/generated/index.js";
import * as api from "../api/client.js";

/** 一个配置项的值。与 `_conf_schema.json` 支持的六种类型一一对应。 */
export type SettingValue = string | number | boolean;
type SettingValues = Record<string, SettingValue>;

/**
 * 把服务端给的「字段 + 生效值」摊成一张键值表。
 *
 * 草稿与基线都用同一种形状，diff 才有意义：两边都按 schema 的键来，
 * 不会出现「草稿多了一个 schema 里没有的键」这种只在界面里成立的状态。
 */
function valuesOf(fields: PluginSettingField[]): SettingValues {
  const values: SettingValues = {};
  for (const field of fields) values[field.key] = field.value;
  return values;
}

/** 只发改过的项：与配置工作台同一条 diff 语义，保存不会把读过的值再写一遍。 */
function changedEntries(
  original: SettingValues,
  draft: SettingValues,
): { key: string; value: SettingValue }[] {
  const entries: { key: string; value: SettingValue }[] = [];
  for (const [key, value] of Object.entries(draft)) {
    if (original[key] !== value) entries.push({ key, value });
  }
  return entries;
}

function applyView(view: PluginSettingsView): {
  fields: PluginSettingField[];
  original: SettingValues;
  draft: SettingValues;
  schemaError: string | null;
  configError: string | null;
} {
  const values = valuesOf(view.fields);
  return {
    fields: view.fields,
    original: values,
    draft: { ...values },
    schemaError: view.schemaError,
    configError: view.configError,
  };
}

/**
 * 插件配置抽屉的草稿。
 *
 * 与 `profileConfig` 同一种存在理由：路由说的是「哪个插件」，而没保存的编辑在哪都不存在。
 * 差别在于这里只有一张表单，保存是即时动作 —— 所以脏了要拦关闭，而不是拦整个页面离开。
 *
 * 草稿**不跨抽屉保留**：关闭即丢弃。插件配置的基线在服务端（`config.json`），
 * 留住一份看不见的草稿只会让人下次打开时分不清显示的是文件还是上次没保存的输入。
 */
export const usePluginSettingsStore = defineStore("pluginSettings", {
  state: () => ({
    profile: null as string | null,
    id: null as string | null,
    /** 保存响应里带回的插件状态；比打开抽屉时传入的那一份新（重载可能把 failed 变回 active）。 */
    plugin: null as PluginInfo | null,
    fields: [] as PluginSettingField[],
    original: {} as SettingValues,
    draft: {} as SettingValues,
    loading: false,
    saving: false,
    /** 读或存这一份配置失败的原因（请求本身失败，不是 schema/config 的内容问题）。 */
    error: null as string | null,
    schemaError: null as string | null,
    configError: null as string | null,
    /** 保存成功但插件重载失败的原因；与「保存失败」分开说。 */
    reloadError: null as string | null,
    /** 这一次打开后是否已经成功保存过（用于显示「已保存」）。 */
    saved: false,
  }),

  getters: {
    dirty: (state): boolean =>
      Object.keys(state.draft).some((key) => state.draft[key] !== state.original[key]),
  },

  actions: {
    async open(profile: string, id: string): Promise<void> {
      this.profile = profile;
      this.id = id;
      this.plugin = null;
      this.fields = [];
      this.original = {};
      this.draft = {};
      this.loading = true;
      this.saving = false;
      this.error = null;
      this.schemaError = null;
      this.configError = null;
      this.reloadError = null;
      this.saved = false;
      try {
        const { config } = await api.getPluginConfig(profile, id);
        // 抽屉可能在请求回来之前已经换了一个插件或关掉了。晚到的响应不能覆盖新状态。
        if (this.profile !== profile || this.id !== id) return;
        const applied = applyView(config);
        this.fields = applied.fields;
        this.original = applied.original;
        this.draft = applied.draft;
        this.schemaError = applied.schemaError;
        this.configError = applied.configError;
      } catch (err) {
        if (this.profile === profile && this.id === id) this.error = (err as Error).message;
      } finally {
        if (this.profile === profile && this.id === id) this.loading = false;
      }
    },

    set(key: string, value: SettingValue): void {
      if (!Object.hasOwn(this.draft, key)) return;
      this.draft = { ...this.draft, [key]: value };
      this.saved = false;
    },

    async save(profile: string): Promise<boolean> {
      const id = this.id;
      if (id === null || this.saving) return false;
      const entries = changedEntries(this.original, this.draft);
      if (entries.length === 0) return true;

      this.saving = true;
      this.error = null;
      this.saved = false;
      try {
        const result = await api.savePluginConfig(profile, id, entries);
        if (this.profile !== profile || this.id !== id) return true;
        this.plugin = result.plugin;
        const applied = applyView(result.config);
        this.fields = applied.fields;
        this.original = applied.original;
        this.draft = applied.draft;
        this.schemaError = applied.schemaError;
        this.configError = applied.configError;
        this.reloadError = result.reloadError;
        this.saved = true;
        return true;
      } catch (err) {
        if (this.profile === profile && this.id === id) this.error = (err as Error).message;
        return false;
      } finally {
        if (this.profile === profile && this.id === id) this.saving = false;
      }
    },

    clearError(): void {
      this.error = null;
    },

    reset(): void {
      this.profile = null;
      this.id = null;
      this.plugin = null;
      this.fields = [];
      this.original = {};
      this.draft = {};
      this.loading = false;
      this.saving = false;
      this.error = null;
      this.schemaError = null;
      this.configError = null;
      this.reloadError = null;
      this.saved = false;
    },
  },
});
