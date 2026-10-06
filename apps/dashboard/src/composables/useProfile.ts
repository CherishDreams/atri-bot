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
 * 可能为 `null`，而 null 是**有意义的**：没有任何一份可用配置档（首次启动前把它们全删了、
 * 或全部读坏了）。此时界面渲染 `ProfilePicker`，而不是画一片空白。
 *
 * 「进来先让人选一次」这件事以前是靠 null 直接落在选择器上的，现在由路由守卫先把
 * `?profile=` 补上（`default` 优先，否则第一份 `ready`，见 `router/index.ts`）。
 * 补的是**URL**而不是服务端行为：API 仍然拒绝猜（缺 profile 一律 400），
 * 所以「界面显示绿勾而请求其实没落盘」这条老路依旧走不通 —— 那才是当初「UI 也不许猜」
 * 真正要防的东西，而不是「用户多点一次」这个代价本身。
 */
export function useProfile() {
  const route = useRoute();
  const profile = computed<string | null>(() => {
    const raw = route.query.profile;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  });
  return { profile };
}
