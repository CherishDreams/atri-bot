import { defineStore } from "pinia";
import type { ProviderInfo, ProviderSource } from "../api/generated/index.js";
import * as api from "../api/client.js";

/**
 * 当前选中的模型，持久化在 localStorage 里，**按配置档各存一份**。
 *
 * 存在浏览器而不是配置档文件：这是**这个浏览器**的偏好，不是服务端配置。
 * 键里必须带配置档 id：模型名不再跨配置档唯一（两份档都可以有 deepseek-chat），
 * 共用一条键 means 在 A 选中的名字落到 B 上会指向另一个模型，而选择器上看不出差别。
 */
const SELECTION_PREFIX = "atri.selectedModel";

/** 选择项：`providerId` 是**实例 id**，发往服务端时用的是它（见 `selection` 的注释）。 */
interface Selection {
  providerId: string;
  model: string;
  sourceId: string;
}

/** 可选的 provider 实现类型。与 `store.js` 的 `PROVIDER_TYPES` 保持一致。 */
export const PROVIDER_TYPES = [
  { label: "OpenAI 兼容", value: "openai" },
  { label: "Anthropic", value: "anthropic" },
] as const;

/** 表单字段集合，也就是 UI 上「基本设置」里可编辑的那些。 */
export interface SourceDraft {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** 超时字段的边界，与服务端 `store.js` 的 MIN/MAX_TIMEOUT_MS 对齐。 */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** 模型选择器里的一项：把 provider 实例压平成可比较的一行。 */
export interface ModelChoice {
  providerId: string;
  model: string;
  source: string;
  type: string;
}

function readSelection(profile: string): Selection | null {
  try {
    const raw = localStorage.getItem(`${SELECTION_PREFIX}.${profile}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { providerId?: unknown; model?: unknown; sourceId?: unknown };
    // 旧键（不带配置档后缀、也没有 providerId）里的选择**不迁**：它在多档下已经说不清
    // 指的是哪一份，猜一个比回到默认更坏。留在原地，用户重选一次即可。
    if (
      typeof parsed.providerId !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.sourceId !== "string"
    ) {
      return null;
    }
    return {
      providerId: parsed.providerId,
      model: parsed.model,
      sourceId: parsed.sourceId,
    };
  } catch {
    // localStorage 可能被禁用或存着脏数据；选择失效只是退回默认，不该让页面炸掉。
    return null;
  }
}

function writeSelection(profile: string, value: Selection | null): void {
  const key = `${SELECTION_PREFIX}.${profile}`;
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* 存不下就算了，本次会话内的选择仍然有效 */
  }
}

/** 由一条 provider 配置算出选择器里的一行；缺 model 的条目没有可选目标。 */
function toChoice(entry: ProviderInfo): ModelChoice | null {
  if (!entry.model) return null;
  return {
    providerId: entry.id,
    model: entry.model,
    source: entry.source ?? entry.id,
    type: entry.type ?? "openai",
  };
}

/**
 * 可选模型：配置里写了**并且**真的加载成功、还处于启用状态。
 *
 * `loaded === false` 必须过滤掉——那种条目在配置里存在但运行时不认，
 * 选它发消息只会拿到一个上游错误。
 *
 * 写成模块级函数而不是让 `activeModel` 去读 `choices` getter：Pinia 的
 * getter 之间互相引用要靠 `this`，而带参数的 getter 拿不到 `this` 的类型，
 * 只能靠断言硬撑；共用一个纯函数更省事也更准。
 */
function usableChoices(providers: ProviderInfo[]): ModelChoice[] {
  return providers
    .filter((p) => p.enabled !== false && p.loaded !== false)
    .map(toChoice)
    .filter((c): c is ModelChoice => c !== null);
}

/**
 * 模型 provider 配置与当前选择。
 *
 * 写操作统一走 `runAction`：失败把原因记在 `error` 上由页面展示，
 * 然后**无论成败都重新拉一次列表**——服务端可能在部分成功后仍报错
 * （例如删源时发现还有引用者），不刷新就会留下一个与后端不符的界面。
 */
type ProviderActions = {
  error: string | null;
  refresh: (profile: string) => Promise<void>;
};

async function runAction(
  store: ProviderActions,
  profile: string,
  op: () => Promise<unknown>,
): Promise<void> {
  store.error = null;
  try {
    await op();
  } catch (err) {
    store.error = (err as Error).message;
  } finally {
    try {
      await store.refresh(profile);
    } catch (err) {
      store.error ??= (err as Error).message;
    }
  }
}

export const useProvidersStore = defineStore("providers", {
  state: () => ({
    sources: [] as ProviderSource[],
    providers: [] as ProviderInfo[],
    /** 配置页左栏当前选中的源。 */
    selectedSourceId: null as string | null,
    /** 拉取到的可用模型（未过滤，由页面按搜索词筛）。 */
    availableModels: [] as string[],
    loadingModels: false,
    saving: false,
    /** 模型选择器的当前选择；`model` 为空表示「用服务端默认」。 */
    /**
     * 此刻选中的模型。`providerId` 才是发往服务端的那一个：
     * `ProviderRegistry.#resolveFor` 的第一级选路按**实例 id**，而 `model` 只是第二级
     * （本地列出的模型名）。发 model 今天也能工作，但两份配置档有同名模型时它会静默走错，
     * 而 `model` 与 `sourceId` 留着是为了在选择器里显示得下、并能在实例消失后判失效。
     */
    selection: null as Selection | null,
    error: null as string | null,
  }),

  getters: {
    selectedSource(state): ProviderSource | null {
      return state.sources.find((s) => s.id === state.selectedSourceId) ?? null;
    },

    /** 引用了某个源的 provider，用于删除前的提示。 */
    providersOfSource: (state) => (sourceId: string) =>
      state.providers.filter((p) => (p.source ?? p.id) === sourceId),

    /**
     * 选择器可选的模型：配置里写了**并且**真的加载成功、还处于启用状态。
     *
     * `loaded === false` 必须过滤掉——那种条目在配置里存在但运行时不认，
     * 选它发消息只会拿到一个上游错误。
     */
    choices(state): ModelChoice[] {
      return usableChoices(state.providers);
    },

    /** 选择器上显示的名字；没选或选的条目已消失时显示「默认模型」。 */
    activeModel(state): string {
      const model = state.selection?.model ?? "";
      if (!model) return "默认模型";
      return usableChoices(state.providers).some((c) => c.model === model) ? model : "默认模型";
    },
  },

  actions: {
    async refresh(profile: string): Promise<void> {
      const [{ sources }, { providers }] = await Promise.all([
        api.listProviderSources(profile),
        api.listProviders(profile),
      ]);
      this.sources = sources;
      this.providers = providers;

      // 选中的源被删掉后，左栏不能停在一个不存在的 id 上；首次加载（或刷新页面）
      // 时也要挑一个，否则左栏列着源、右栏却说「还没有可编辑的供应商源」。
      if (!this.selectedSourceId || !sources.some((s) => s.id === this.selectedSourceId)) {
        this.selectedSourceId = sources[0]?.id ?? null;
      }

      // 选择失效（实例被删、被禁用、或加载失败）时清掉，免得一直显示一个用不了的模型。
      // 按 providerId 判而不是按 model 名判：后者在两份档之间不唯一，而这一份的列表里
      // 名字相同、id 不同的两个实例会被读成同一个。
      if (
        this.selection &&
        !this.choices.some((c) => c.providerId === this.selection?.providerId)
      ) {
        this.selectModel(profile, null, null);
      }
    },

    /** 首次进入页面：读回**这一份配置档**的上次选择，并拉一次配置。 */
    async init(profile: string): Promise<void> {
      this.selection = readSelection(profile);
      try {
        await this.refresh(profile);
      } catch (err) {
        this.error = (err as Error).message;
      }
    },

    selectSource(id: string | null): void {
      this.selectedSourceId = id;
      // 换了源，上一批可用模型就不适用了。
      this.availableModels = [];
    },

    async createSource(profile: string, input: Partial<SourceDraft> = {}): Promise<string | null> {
      this.error = null;
      try {
        const { source } = await api.createProviderSource(profile, {
          id: input.id ?? "",
          type: input.type ?? "openai",
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          timeoutMs: input.timeoutMs,
        });
        // 顺序不能反：selectedSourceId 的 watcher 要从 sources 里找到这一条
        // 才肯重建草稿，先选中再刷新会让它在还看不到新源时就跑掉，
        // 于是表单停在空草稿上，之后每次保存都提交给 `/provider-sources/`。
        await this.refresh(profile);
        this.selectedSourceId = source.id;
        this.availableModels = [];
        return source.id;
      } catch (err) {
        this.error = (err as Error).message;
        return null;
      }
    },

    /** 保存一个源的改动。只提交给出的字段，未出现的不动。 */
    async saveSource(profile: string, id: string, patch: Partial<SourceDraft>): Promise<boolean> {
      this.saving = true;
      this.error = null;
      try {
        // 不提交 id：源 id 创建后只读（避免 AstrBot 那种「改名要重写全部引用者」
        // 的复杂度），改它只会被服务端当成未知字段。
        const { id: _ignored, ...rest } = patch;
        await api.updateProviderSource(profile, id, rest);
        await this.refresh(profile);
        return true;
      } catch (err) {
        this.error = (err as Error).message;
        return false;
      } finally {
        this.saving = false;
      }
    },

    async removeSource(profile: string, id: string, cascade = false): Promise<void> {
      await runAction(this, profile, () => api.deleteProviderSource(profile, id, cascade));
    },

    /**
     * 拉取上游模型列表。
     *
     * 打的是**已保存的**配置，所以调用方（页面的按钮）在源有未保存改动时
     * 要先 `saveSource()`——否则会用一个半成品凭据去问上游，
     * 拿到「密钥无效」还以为是密钥真错了。
     */
    async fetchModels(profile: string, id: string): Promise<void> {
      this.loadingModels = true;
      this.error = null;
      try {
        const { models } = await api.fetchProviderModels(profile, id);
        this.availableModels = models;
      } catch (err) {
        this.availableModels = [];
        this.error = (err as Error).message;
      } finally {
        this.loadingModels = false;
      }
    },

    /** 把一个模型挂到当前源上。 */
    async addModel(profile: string, model: string): Promise<boolean> {
      const source = this.selectedSourceId;
      if (!source) {
        this.error = "请先选择一个供应商源";
        return false;
      }
      const trimmed = model.trim();
      if (!trimmed) {
        this.error = "模型 ID 不能为空";
        return false;
      }

      let ok = false;
      await runAction(this, profile, async () => {
        await api.createProvider(profile, {
          // provider id 用「源/模型」拼出来，天然唯一且能一眼看出归属，
          // 这也正是 AstrBot 的生成规则。
          id: `${source}/${trimmed}`.replace(/[^A-Za-z0-9._-]/g, "-"),
          source,
          model: trimmed,
          name: trimmed,
        });
        ok = true;
      });
      return ok;
    },

    async removeModel(profile: string, id: string): Promise<void> {
      await runAction(this, profile, () => api.deleteProvider(profile, id));
    },

    async setModelEnabled(profile: string, id: string, enabled: boolean): Promise<void> {
      await runAction(this, profile, () => api.updateProvider(profile, id, { enabled }));
    },

    async setDefaultModel(profile: string, id: string): Promise<void> {
      await runAction(this, profile, () => api.updateProvider(profile, id, { default: true }));
    },

    /** 记下模型选择（`providerId` 为空即回到默认），并按配置档持久化。 */
    selectModel(profile: string, providerId: string | null, modelId: string | null): void {
      if (!providerId || !modelId) {
        this.selection = null;
        writeSelection(profile, null);
        return;
      }
      const choice = this.choices.find((c) => c.providerId === providerId);
      if (!choice) {
        // 选了这一份档的列表里没有的实例：不写，也不猜。
        this.selection = null;
        writeSelection(profile, null);
        return;
      }
      this.selection = {
        providerId: choice.providerId,
        model: choice.model,
        sourceId: choice.source,
      };
      writeSelection(profile, this.selection);
    },

    clearError(): void {
      this.error = null;
    },
  },
});
