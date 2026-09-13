import { defineStore } from "pinia";
import type { ToolInfo } from "../api/generated/index.js";
import * as api from "../api/client.js";

/**
 * 工具开关状态。
 *
 * 写完之后**必须回读一次列表**再信这份状态：`enabled` 的真源是**这份配置档的**
 * 配置文件（`data/profiles/<id>/config.json`），而服务端是每次现读文件的（见 `core/tool/store.ts`），
 * 本地猜测「应该已经生效了」会把一个失败的写入显示成成功。
 *
 * 辅助函数写在模块级而不是 store 的私有方法：Pinia 会把 actions 挂到另一个
 * 对象上执行，`this.#helper()` 在那个对象上取不到，会直接抛 TypeError。
 */
async function applyToggle(
  store: { tools: ToolInfo[]; error: string | null; refresh: (profile: string) => Promise<void> },
  profile: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  store.error = null;
  try {
    await api.setToolEnabled(profile, id, enabled);
  } catch (err) {
    store.error = (err as Error).message;
  }
  try {
    await store.refresh(profile);
  } catch (err) {
    store.error ??= (err as Error).message;
  }
}

export const useToolsStore = defineStore("tools", {
  state: () => ({
    tools: [] as ToolInfo[],
    loading: false,
    error: null as string | null,
  }),

  getters: {
    /**
     * 已启用的颗数。只用于界面上的「已启用 N / 共 M」，
     * 判据是 `enabled === true` —— 不要写成 `!== false`，那是适配器的默认启用语义，
     * 两者在这一层是相反的设计（能力授予不该默认发生）。
     */
    enabledCount: (state): number => state.tools.filter((tool) => tool.enabled === true).length,
  },

  actions: {
    async refresh(profile: string): Promise<void> {
      this.loading = true;
      try {
        const { tools } = await api.listTools(profile);
        this.tools = tools;
      } finally {
        this.loading = false;
      }
    },

    async setEnabled(profile: string, id: string, enabled: boolean): Promise<void> {
      await applyToggle(this, profile, id, enabled);
    },

    clearError(): void {
      this.error = null;
    },
  },
});
