import { defineStore } from "pinia";
import type { PluginInfo } from "@atri/shared";
import { ApiClient } from "../api/client.js";

const api = new ApiClient();

type PluginActions = { error: string | null; refresh: () => Promise<void> };

/** 无论成败都刷新列表（旧版 finally 里也是这么做的）。 */
async function runAction(store: PluginActions, op: () => Promise<unknown>): Promise<void> {
  store.error = null;
  try {
    await op();
  } catch (err) {
    store.error = (err as Error).message;
  } finally {
    try {
      await store.refresh();
    } catch (err) {
      store.error ??= (err as Error).message;
    }
  }
}

/**
 * 插件面板状态。操作失败时把错误写进 `error`，由组件展示，
 * 不静默吞掉——与旧版 `alert(...)` 的可感知性等价。
 */
export const usePluginsStore = defineStore("plugins", {
  state: () => ({
    plugins: [] as PluginInfo[],
    error: null as string | null,
  }),

  actions: {
    async refresh(): Promise<void> {
      const { plugins } = await api.listPlugins();
      this.plugins = plugins;
    },

    async reload(id: string): Promise<void> {
      await runAction(this, () => api.reloadPlugin(id));
    },

    async unload(id: string): Promise<void> {
      await runAction(this, () => api.unloadPlugin(id));
    },

    async setEnabled(id: string, enabled: boolean): Promise<void> {
      await runAction(this, () => api.setPluginEnabled(id, enabled));
    },

    clearError(): void {
      this.error = null;
    },
  },
});
