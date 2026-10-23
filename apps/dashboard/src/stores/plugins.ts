import { defineStore } from "pinia";
import type { PluginInfo } from "../api/generated/index.js";
import * as api from "../api/client.js";

type PluginActions = { error: string | null; refresh: (profile: string) => Promise<void> };

/**
 * 列表请求的代际。快速切档时旧档的响应不能覆盖新档的插件清单 —— 那不只是显示错：
 * 插件 id 是全局安装的，随后按 URL 上的新档操作同名插件，会改到新档的状态。
 */
let refreshSeq = 0;

/**
 * 无论成败都刷新列表（旧版 finally 里也是这么做的）。
 *
 * 动作错误先收在局部量里，等刷新完再写回：`refresh` 成功时会把列表错误清掉，
 * 它不该顺手把「重载/卸载失败了」这句话一起抹掉。
 */
async function runAction(
  store: PluginActions,
  profile: string,
  op: () => Promise<unknown>,
): Promise<void> {
  store.error = null;
  let opError: string | null = null;
  try {
    await op();
  } catch (err) {
    opError = (err as Error).message;
  }
  await store.refresh(profile);
  store.error = opError ?? store.error;
}

/**
 * 插件面板状态。操作失败时把错误写进 `error`，由组件展示，
 * 不静默吞掉——与旧版 `alert(...)` 的可感知性等价。
 */
export const usePluginsStore = defineStore("plugins", {
  state: () => ({
    plugins: [] as PluginInfo[],
    error: null as string | null,
    /** 列表加载中（首屏、切档与动作之后的回读都走同一份状态）。 */
    loading: false,
  }),

  actions: {
    // 每个动作都**显式收 profile**，不从 store 里猜当前档：
    // 「在 B 页面上把 default 的插件关了」这种错只有在调用处可见才拦得住。
    async refresh(profile: string): Promise<void> {
      const seq = ++refreshSeq;
      this.loading = true;
      try {
        const { plugins } = await api.listPlugins(profile);
        if (seq !== refreshSeq) return;
        this.plugins = plugins;
        this.error = null;
      } catch (err) {
        if (seq !== refreshSeq) return;
        // 首屏与切档也会走这里：错误必须落到 `error` 上，而不是变成一条无人接住的
        // Promise rejection —— 那样页面只会停在空列表，看不出是「没装插件」还是「读失败」。
        // 列表同时清空：切到一份不可用的配置时，留着上一档的插件只会让人以为读成功了。
        this.plugins = [];
        this.error = (err as Error).message;
      } finally {
        // 旧档的响应晚到不能关掉新档请求的 loading。
        if (seq === refreshSeq) this.loading = false;
      }
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
