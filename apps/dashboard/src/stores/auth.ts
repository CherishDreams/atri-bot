import { defineStore } from "pinia";
import type { AuthUser } from "@atri/shared";
import { ApiClient, UnauthorizedError } from "../api/client.js";

const api = new ApiClient();

/**
 * 登录态。令牌本身只存在于 HttpOnly Cookie 中，
 * 这里仅缓存「当前是谁」以及是否需要登录，方便路由守卫与顶栏展示。
 */
export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null as AuthUser | null,
    expiresAt: null as string | null,
    loading: false,
  }),

  getters: {
    isAuthenticated: (state): boolean => state.user !== null,
  },

  actions: {
    /** 公开接口：服务端是否启用了鉴权。 */
    async fetchStatus(): Promise<boolean> {
      const { required } = await api.authStatus();
      return required;
    },

    /** 确认当前 Cookie 是否仍有效；失效时静默置空，不抛出。 */
    async fetchMe(): Promise<AuthUser | null> {
      try {
        const { user, expiresAt } = await api.me();
        this.user = user;
        this.expiresAt = expiresAt;
        return user;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          this.user = null;
          this.expiresAt = null;
          return null;
        }
        throw err;
      }
    },

    async login(username: string, password: string): Promise<AuthUser> {
      this.loading = true;
      try {
        const { user, expiresAt } = await api.login(username, password);
        this.user = user;
        this.expiresAt = expiresAt;
        return user;
      } finally {
        this.loading = false;
      }
    },

    async logout(): Promise<void> {
      try {
        await api.logout();
      } finally {
        this.user = null;
        this.expiresAt = null;
      }
    },

    /** WebSocket 收到 unauthorized 帧时调用，只清本地状态。 */
    clear(): void {
      this.user = null;
      this.expiresAt = null;
    },
  },
});
