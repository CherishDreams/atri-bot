<script setup lang="ts">
import { computed, h } from "vue";
import type { HTMLAttributes, VNodeChild } from "vue";
import { useRouter } from "vue-router";
import type { DropdownDividerOption, DropdownOption } from "naive-ui";
import { useAuthStore } from "@/stores/auth";
import { icon } from "./icons.js";

/**
 * 顶栏右侧的汉堡菜单：bot 与 chat 两侧共用同一份菜单项与样式，
 * 只是各自顶栏的左侧内容不同（bot 放 logo，chat 放模型选择器）。
 *
 * 此处带 `onSelect` 的动作在两页都成立，所以不需要 fork 出两个菜单。
 * 已不再往这里加「平台切换」——那个控件是 PlatformSwitch，走顶栏可见位置，
 * 藏进菜单里等于让用户先点开才知道有 chat 平台。
 */
const router = useRouter();
const auth = useAuthStore();

/**
 * n-dropdown 的 options 实际类型是内部的 DropdownMixedOption，没有从顶层导出，
 * 这里用等价的联合类型表达。加菜单项时在数组上方追加即可。
 */
type MenuItem = DropdownOption | DropdownDividerOption;

const MenuIcon = icon("menu");

const menuItems = computed<MenuItem[]>(() => [
  { key: "console", label: "返回控制台", icon: icon("console") },
  { key: "new-session", label: "新建会话", icon: icon("plus") },
  // 退出登录单独分组：以后新增的普通功能都放上面，它会一直留在最后一段。
  { type: "divider", key: "divider-account" },
  { key: "logout", label: "退出登录", icon: icon("logout") },
]);

/**
 * 弹出层被 teleport 到 body，页面里不止一个 popover，
 * 给它一个专属类名，下面的全局样式才不会误伤别的下拉。
 */
function menuProps(): HTMLAttributes {
  return { class: "atri-topbar-dropdown" };
}

/*
 * 这里原本挂着一份组件级 `theme-overrides`（borderRadius / optionColorHover /
 * 以及嵌在 peers.Popover 下的三层阴影）。现在三者都上移到 theme/naive.ts，
 * 由全站统一给，本组件不再需要局部覆盖。
 * `peers.Popover` 那条结论（阴影必须挂在 peers 下，写顶层会被静默忽略）
 * 已经连同原因一起记在 naive.ts 的 Dropdown 段里。
 */

async function onSelect(key: string): Promise<void> {
  switch (key) {
    case "console":
      await router.push({ name: "console" });
      break;
    case "new-session":
      await router.push({ name: "chat-new" });
      break;
    case "logout":
      await auth.logout();
      await router.replace({ name: "login" });
      break;
  }
}
</script>

<template>
  <n-dropdown
    trigger="click"
    placement="bottom-end"
    :options="menuItems"
    :menu-props="menuProps"
    @select="onSelect"
  >
    <!-- n-dropdown 的触发元素是默认插槽，不是 #trigger 插槽
         （源码 Dropdown.mjs 里 trigger: normalizeSlot(() => this.$slots.default?.())）。
         写成 #trigger 会让默认插槽为空，整个按钮不渲染且控制台只报一句
         slot[trigger] should have exactly one child。 -->
    <button
      class="atri-topbar-menu grid h-[var(--atri-control-h)] w-[var(--atri-control-h)] cursor-pointer place-items-center rounded-md text-ink-muted transition-colors hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      type="button"
      aria-label="打开菜单"
      aria-haspopup="menu"
    >
      <component :is="MenuIcon" />
    </button>
  </n-dropdown>
</template>

<style>
/**
 * n-dropdown 会把菜单 teleport 到 body，scoped 样式打不到它，
 * 所以用 menuProps 打上的专属类名做全局作用域限定，避免影响其它弹出层。
 *
 * 剩下的每条都是**naive-ui 没有对应主题键**的东西，只能覆盖内部类：
 * 选项行自己的圆角（`Dropdown.borderRadius` 只管菜单外框）、
 * 行内 `::before` 的左右贴边、标签的左内边距、分隔线外边距、以及入场动画。
 * 圆角/悬停底色/阴影已经上移到 theme/naive.ts，这里不再重复。
 *
 * 保留的规则仍需注意选择器深度：naive-ui 用的是
 * `.n-dropdown-menu .n-dropdown-option .n-dropdown-option-body::before`（0,3,0），
 * 只写一层类名会静默失效（改不动外观，也不报错）。
 */
.atri-topbar-dropdown {
  min-width: 168px;
}

.atri-topbar-dropdown .n-dropdown-option .n-dropdown-option-body {
  border-radius: 6px;
}

.atri-topbar-dropdown .n-dropdown-option .n-dropdown-option-body::before {
  left: 0;
  right: 0;
  border-radius: 6px;
}

.atri-topbar-dropdown .n-dropdown-option .n-dropdown-option-body__label {
  padding-left: 0;
}

.atri-topbar-dropdown .n-dropdown-divider {
  margin: 4px 0;
}

/**
 * 入场动画：naive-ui 默认是 opacity/transform .15s 的淡入缩放（scale .85）。
 * 这里对齐 AstrBot 的观感——略慢一点、从右上角缩放入场，
 * 时长与缓动取自 Vuetify 的 dialog-transition（进场 225ms / cubic-bezier(0,0,.2,1)）。
 */
.atri-topbar-dropdown.popover-transition-enter-active {
  transition:
    opacity 225ms cubic-bezier(0, 0, 0.2, 1),
    transform 225ms cubic-bezier(0, 0, 0.2, 1);
}

.atri-topbar-dropdown.popover-transition-leave-active {
  transition:
    opacity 125ms cubic-bezier(0.4, 0, 1, 1),
    transform 125ms cubic-bezier(0.4, 0, 1, 1);
}

/**
 * 缩放起点：默认 .85 偏小、像「弹出来」；改成 .9 更接近 AstrBot 那种
 * 「从右上角展开」的克制感。变换原点由 placement="bottom-end" 决定，
 * 无需手写——实测落在菜单右上角（168px 0px，168 即 min-width）。
 */
.atri-topbar-dropdown.popover-transition-enter-from,
.atri-topbar-dropdown.popover-transition-leave-to {
  transform: scale(0.9);
}
</style>
