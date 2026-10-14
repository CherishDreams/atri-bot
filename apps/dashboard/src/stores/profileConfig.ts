import { defineStore } from "pinia";
import type { ProfileConfig, ProfileConfigPatch } from "../api/client.js";
import * as api from "../api/client.js";

/**
 * 一份配置档的**草稿**：配置工作台里正在编辑、但还没落盘的那套值。
 *
 * ## 为什么允许存在这样一份本地状态
 *
 * AGENTS.md 那条「状态若能从路由推出，就不要存本地」在这里仍然成立 —— 路由说的是
 * 「哪一份档、哪一类」，而**没保存的编辑在哪儿都不存在**：不在 URL（那是给分享用的，
 * 不是给撤销用的），也不在服务端（那就是已保存）。所以这不是第二个真源，
 * 而是一份明知会过期的工作副本。
 *
 * 刻意**不写 `localStorage`**：草稿存在的意义就是被丢掉（离开时有拦截，要么存要么弃），
 * 而跨刷新留住它只会让人以为「关页面等于没丢」。上一版把模型选择放在浏览器里，
 * 得到的正是「换台机器行为不一样，而没有任何文件写着它」。
 *
 * ## 为什么是 diff 而不是整档
 *
 * `patch()` 只发真的改过的键。整档替换会让「另一个标签页刚改过、这一页拿着旧草稿保存」
 * 变成一次静默回滚；diff 把这种回滚的范围限制在**用户真的动过的那几项**上。
 * 服务端的档文件里还躺着我们不认识的键（用户手写的段落），diff 也让它们不会被带进请求。
 */

/** 草稿里可编辑的那几项。目录（名称、说明）不在这里 —— 那些永远来自服务端。 */
interface Draft {
  defaultProviderId: string | null;
  maxToolSteps: number;
  /** 工具 id -> 是否启用。 */
  tools: Record<string, boolean>;
  /** 插件 id -> 是否启用。 */
  plugins: Record<string, boolean>;
}

function draftOf(config: ProfileConfig): Draft {
  return {
    defaultProviderId: config.defaultProviderId,
    maxToolSteps: config.maxToolSteps,
    tools: Object.fromEntries(config.tools.map((t) => [t.id, t.enabled])),
    plugins: Object.fromEntries(config.plugins.map((p) => [p.id, p.enabled])),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 深拷贝草稿。**不用 `structuredClone`**：Pinia 的 state 是响应式 Proxy，而
 * `structuredClone` 对它是 `DataCloneError` —— 更糟的是这个异常在 Vue 的事件处理器里
 * 会被吞成一条 `console.error`，症状是「点放弃没反应、切页也切不走」（脏标记没被清，
 * 路由守卫继续拦），而界面上没有任何错误。实测就是这么坏的。
 * 这份结构只有字符串、数字与两层 Record，手写拷贝比引入依赖可靠。
 */
function copyDraft(draft: Draft): Draft {
  return {
    defaultProviderId: draft.defaultProviderId,
    maxToolSteps: draft.maxToolSteps,
    tools: { ...draft.tools },
    plugins: { ...draft.plugins },
  };
}

/** 开关段只发变了的项：`{current_time: true}` 而不是整张表。 */
function diffToggles(
  before: Record<string, boolean>,
  after: Record<string, boolean>,
): Record<string, { enabled: boolean }> | undefined {
  const out: Record<string, { enabled: boolean }> = {};
  for (const [id, enabled] of Object.entries(after)) {
    if (before[id] !== undefined && before[id] !== enabled) out[id] = { enabled };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function patchOf(original: Draft, draft: Draft): ProfileConfigPatch {
  const patch: ProfileConfigPatch = {};
  if (original.defaultProviderId !== draft.defaultProviderId) {
    patch.defaultProvider = draft.defaultProviderId;
  }
  if (original.maxToolSteps !== draft.maxToolSteps) patch.maxToolSteps = draft.maxToolSteps;
  const tools = diffToggles(original.tools, draft.tools);
  if (tools) patch.tools = tools;
  const plugins = diffToggles(original.plugins, draft.plugins);
  if (plugins) patch.plugins = plugins;
  return patch;
}

export const useProfileConfigStore = defineStore("profileConfig", {
  state: () => ({
    /** 这份草稿属于哪一份档。与路由不一致时（切档未重载）一切从 `load()` 重新开始。 */
    profileId: null as string | null,
    /** 服务端读回的那一份：工具与插件的目录（名称、说明）都从这里取。 */
    loaded: null as ProfileConfig | null,
    draft: null as Draft | null,
    original: null as Draft | null,
    loading: false,
    saving: false,
    error: null as string | null,
    /**
     * 上一次保存里**没能生效**的插件项。
     *
     * 它不是错误码而是部分生效的清单：同一批里其他改动已经落盘了，所以界面必须既显示
     * 「这些成功了」又点名「这一颗没成」，而不是回一个绿勾让人以为全好了。
     */
    failed: [] as { id: string; error: string }[],
  }),

  getters: {
    dirty(state): boolean {
      if (!state.draft || !state.original) return false;
      return !sameDraft(state.draft, state.original);
    },

    /** 待发送的 diff。界面用它决定「保存」键要不要亮。 */
    patch(state): ProfileConfigPatch {
      if (!state.draft || !state.original) return {};
      return patchOf(state.original, state.draft);
    },

    /** 某颗工具在草稿里的开关（目录里没有这颗时为 `false`，与工具默认关闭一致）。 */
    toolEnabled:
      (state) =>
      (id: string): boolean =>
        state.draft?.tools[id] ?? false,
    pluginEnabled:
      (state) =>
      (id: string): boolean =>
        state.draft?.plugins[id] ?? false,

    /**
     * 单项脏标记。整页只有一个「保存」键时，用户必须能看出**是哪几项**没落盘 ——
     * 否则「保存」亮着而改动藏在别的分类里，那是另一种静默。
     */
    toolDirty:
      (state) =>
      (id: string): boolean =>
        state.draft !== null &&
        state.original !== null &&
        state.draft.tools[id] !== state.original.tools[id],
    pluginDirty:
      (state) =>
      (id: string): boolean =>
        state.draft !== null &&
        state.original !== null &&
        state.draft.plugins[id] !== state.original.plugins[id],
  },

  actions: {
    async load(profileId: string): Promise<boolean> {
      this.loading = true;
      this.error = null;
      try {
        const config = await api.getProfileConfig(profileId);
        this.profileId = profileId;
        this.loaded = config;
        this.draft = draftOf(config);
        this.original = draftOf(config);
        this.failed = [];
        return true;
      } catch (err) {
        this.error = (err as Error).message;
        return false;
      } finally {
        this.loading = false;
      }
    },

    setDefaultProvider(providerId: string | null): void {
      if (this.draft) this.draft.defaultProviderId = providerId;
    },

    setMaxSteps(steps: number): void {
      if (this.draft) this.draft.maxToolSteps = steps;
    },

    setTool(id: string, enabled: boolean): void {
      if (this.draft) this.draft.tools = { ...this.draft.tools, [id]: enabled };
    },

    setPlugin(id: string, enabled: boolean): void {
      if (this.draft) this.draft.plugins = { ...this.draft.plugins, [id]: enabled };
    },

    /** 丢掉草稿：只在「确认放弃未保存改动」之后调用，所以它必须显式存在。 */
    discard(): void {
      if (this.original) this.draft = copyDraft(this.original);
      this.error = null;
    },

    /**
     * 保存这批 diff。
     *
     * 成功后一律以**服务端回读的那一份**为准（`config` 字段），不拿草稿去覆盖状态：
     * 「绿勾 = 已落盘」靠的是回读，而不是「我发出去的东西应该就是现在的值」这个假设。
     */
    async save(profileId: string): Promise<boolean> {
      if (!this.draft || !this.original) return false;
      const patch = patchOf(this.original, this.draft);
      if (Object.keys(patch).length === 0) return true;
      this.saving = true;
      this.error = null;
      try {
        const { config, failed } = await api.saveProfileConfig(profileId, patch);
        this.loaded = config;
        this.draft = draftOf(config);
        this.original = draftOf(config);
        this.profileId = config.id;
        this.failed = failed ?? [];
        return true;
      } catch (err) {
        this.error = (err as Error).message;
        return false;
      } finally {
        this.saving = false;
      }
    },

    clearError(): void {
      this.error = null;
      this.failed = [];
    },
  },
});
