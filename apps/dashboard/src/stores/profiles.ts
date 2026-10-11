import { defineStore } from "pinia";
import type { ProfileRecord } from "@atri/shared";
import * as api from "../api/client.js";

/**
 * 配置档列表。
 *
 * **这里只存列表**，不存「当前选中的那一个」：当前配置档是路由的一部分
 *（见 `composables/useProfile.ts`），存第二份就会有两个真源，而它的后果是写进哪个文件。
 */
export const useProfilesStore = defineStore("profiles", {
  state: () => ({
    profiles: [] as ProfileRecord[],
    loading: false,
    /** 拉取或操作失败时给组件展示的中文说明；口令与绝对路径都不在里面。 */
    error: null as string | null,
  }),

  getters: {
    /**
     * 可选的配置档。**`failed` 的那一份也在列表里**（操作者要能看见它坏了以及为什么），
     * 但它不该被当成可用项：任何带它的 `?profile=` 都会拿到 503。
     */
    usable: (state): ProfileRecord[] => state.profiles.filter((p) => p.status === "ready"),

    /**
     * 某一档的默认 provider 实例 id；不知道是哪一份、或那一份还没在列表里时为 `null`
     *（也就是「用全局默认」）。
     *
     * 从列表里现取，不另存一份「当前档的默认」：那样就有两个地方要说这件事，
     * 而其中一个必然过期。
     */
    defaultProviderOf:
      (state) =>
      (profileId: string | null): string | null =>
        profileId === null
          ? null
          : (state.profiles.find((p) => p.id === profileId)?.defaultProviderId ?? null),
  },

  actions: {
    async refresh(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const { profiles } = await api.listProfiles();
        this.profiles = profiles;
      } catch (err) {
        this.error = (err as Error).message;
      } finally {
        this.loading = false;
      }
    },

    /**
     * 建一份配置档。成功时返回它的 id，让调用方把界面切过去 ——
     * 「建完却还停在原档」是会被读成「没建成」的那类反馈缺失。
     */
    async create(id: string, name?: string): Promise<string | null> {
      this.error = null;
      try {
        const { profile } = await api.createProfile(id, name);
        await this.refresh();
        return profile.id;
      } catch (err) {
        this.error = (err as Error).message;
        return null;
      }
    },

    async rename(id: string, name: string): Promise<boolean> {
      return this.run(() => api.renameProfile(id, name));
    },

    /**
     * 改这一档默认用的 provider 实例（`null` = 取消档级默认，回到全局那一个）。
     *
     * 与 `rename` 同一类写：动的都是这份档文件里的一个键，而清单本身在别处
     *（`providers.json`，全局一份）。成功后一律重读列表 —— `defaultProviderId`
     * 是服务端算出来的，本地猜不得，也**不能**先染上绿色再等回读：那一瞬间的绿
     * 就是「界面说成功了而磁盘上不是」。
     */
    async setDefaultProvider(id: string, providerId: string | null): Promise<boolean> {
      return this.run(() => api.setDefaultProvider(id, providerId));
    },

    async reload(id: string): Promise<boolean> {
      return this.run(() => api.reloadProfile(id));
    },

    /**
     * 下线一份配置档。服务端**不删它的文件，也不删它的插件数据目录**，
     * 所以措辞是「下线」而不是「删除」——界面写成删除会让人以为磁盘上的东西没了。
     */
    async remove(id: string): Promise<boolean> {
      return this.run(() => api.deleteProfile(id));
    },

    /** 操作后一律重读列表：`status` 是服务端算出来的，本地猜不得。 */
    async run(op: () => Promise<unknown>): Promise<boolean> {
      this.error = null;
      try {
        await op();
      } catch (err) {
        this.error = (err as Error).message;
        return false;
      }
      try {
        await this.refresh();
      } catch (err) {
        this.error ??= (err as Error).message;
      }
      return true;
    },

    clearError(): void {
      this.error = null;
    },
  },
});
