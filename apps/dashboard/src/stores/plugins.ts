import { defineStore } from "pinia";
import type { PluginInfo } from "../api/generated/index.js";
import * as api from "../api/client.js";

type PluginActions = { error: string | null; refresh: (profile: string) => Promise<void> };

/** 无论成败都刷新列表（旧版 finally 里也是这么做的）。 */
async function runAction(
  store: PluginActions,
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
    // 每个动作都**显式收 profile**，不从 store 里猜当前档：
    // 「在 B 页面上把 default 的插件关了」这种错只有在调用处可见才拦得住。
    async refresh(profile: string): Promise<void> {
      const { plugins } = await api.listPlugins(profile);
      this.plugins = plugins;
    },

    async reload(profile: string, id: string): Promise<void> {
      await runAction(this, profile, () => api.reloadPlugin(profile, id));
    },

    async unload(profile: string, id: string): Promise<void> {
      await runAction(this, profile, () => api.unloadPlugin(profile, id));
    },

    /** 切的是**这份配置档开不开它**；插件本身是全局安装的，这里不卸载代码。 */
    async setEnabled(profile: string, id: string, enabled: boolean): Promise<void> {
      await runAction(this, profile, () => api.setPluginEnabled(profile, id, enabled));
    },

    clearError(): void {
      this.error = null;
    },
  },
});
