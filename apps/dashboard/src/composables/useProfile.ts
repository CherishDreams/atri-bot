import { computed } from "vue";
import { useRoute } from "vue-router";

/**
 * 当前配置档 = 路由上的 `?profile=`，**只读，不另存一份**。
 *
 * 为什么不存成本地 ref（也不存 localStorage）：AGENTS.md 的「状态能从路由推出就不要存本地」。
 * 存了就会出现「停在 /tools 而当前配置档是别的页留下的那一个」——刷新、前进后退、
 * 直接粘贴深链，三种入口都不会跟着走。而这个状态的后果是**写进哪份配置文件**，
 * 显示错档不是外观问题。
 *
 * 可能为 `null`，而 null 是**有意义的**：还没选过配置档。此时界面要渲染选择器而不是
 * 替用户挑一个 —— API 拒绝猜（缺 profile 一律 400），UI 也不许猜，否则界面会在一次
 * 400 上显示绿勾，而那份改动根本没落盘。
 */
export function useProfile() {
  const route = useRoute();
  const profile = computed<string | null>(() => {
    const raw = route.query.profile;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  });
  return { profile };
}
