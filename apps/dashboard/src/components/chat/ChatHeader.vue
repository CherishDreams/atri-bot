<script setup lang="ts">
import { computed, h } from "vue";
import type { HTMLAttributes, VNodeChild } from "vue";
import { useRouter } from "vue-router";
import type { DropdownDividerOption, DropdownOption } from "naive-ui";
import { useAuthStore } from "@/stores/auth";
import ModelSelectMenu from "../shared/ModelSelectMenu.vue";

const router = useRouter();
const auth = useAuthStore();

/**
 * n-dropdown 的 options 实际类型是内部的 DropdownMixedOption，没有从顶层导出，
 * 这里用等价的联合类型表达。加菜单项时在数组上方追加即可。
 */
type MenuItem = DropdownOption | DropdownDividerOption;

/** 16×16 线性图标，统一 1.5px 描边，与顶栏汉堡按钮同一套风格。 */
function icon(path: string): () => VNodeChild {
  return () =>
    h(
      "svg",
      {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
      },
      [
        h("path", {
          d: path,
          stroke: "currentColor",
          "stroke-width": 1.5,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      ],
    );
}

const menuItems = computed<MenuItem[]>(() => [
  {
    key: "console",
    label: "返回控制台",
    icon: icon("M6.5 8h7M10 4.5 13.5 8 10 11.5M2.5 2.5h4v11h-4z"),
  },
  { key: "new-session", label: "新建会话", icon: icon("M8 3v10M3 8h10") },
  // 退出登录单独分组：以后新增的普通功能都放上面，它会一直留在最后一段。
  { type: "divider", key: "divider-account" },
  {
    key: "logout",
    label: "退出登录",
    icon: icon("M6 2.5H3.5v11H6M10 5.5 12.5 8 10 10.5M12.5 8H6.5"),
  },
]);

/**
 * 弹出层被 teleport 到 body，页面里不止一个 popover，
 * 给它一个专属类名，下面的全局样式才不会误伤别的下拉。
 */
function menuProps(): HTMLAttributes {
  return { class: "atri-chat-header-dropdown" };
}

/**
 * 圆角与悬停底色走主题变量，比覆盖内部类更稳。
 *
 * 阴影必须嵌在 peers.Popover 下：Dropdown 主题把 Popover 声明为 peer，
 * use-theme 取的是 selfOverrides.peers（源码 _mixins/use-theme.mjs 里
 * peerOverrides: merge({}, builtinOverrides.peers, globalPeersOverrides, peersOverrides)），
 * 写成顶层 Popover 会被静默忽略、阴影仍是默认值。
 * 这组值取自 Vuetify 的 elevation-8 三层阴影，比 naive-ui 默认更实。
 */
const dropdownThemeOverrides = {
  borderRadius: "8px",
  optionColorHover: "rgba(0, 0, 0, 0.08)",
  peers: {
    Popover: {
      boxShadow:
        "0 5px 5px -3px rgba(0, 0, 0, 0.2), 0 8px 10px 1px rgba(0, 0, 0, 0.14), 0 3px 14px 2px rgba(0, 0, 0, 0.12)",
    },
  },
};

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
  <!-- 高度与 ChatLayout 里给内容区留的 top 偏移共用 --atri-header-h，
       避免两处各写一个 60px、改一处就错位。 -->
  <header
    class="atri-chat-header flex h-[var(--atri-header-h)] w-full items-center justify-between border-b-1 border-[#ccc] px-4"
  >
    <ModelSelectMenu />

    <n-dropdown
      trigger="click"
      placement="bottom-end"
      :options="menuItems"
      :menu-props="menuProps"
      :theme-overrides="dropdownThemeOverrides"
      @select="onSelect"
    >
      <!-- n-dropdown 的触发元素是默认插槽，不是 #trigger 插槽
           （源码 Dropdown.mjs 里 trigger: normalizeSlot(() => this.$slots.default?.())）。
           写成 #trigger 会让默认插槽为空，整个按钮不渲染且控制台只报一句
           slot[trigger] should have exactly one child。 -->
      <button
        class="atri-chat-header-menu grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-[#333] hover:bg-[#f5f5f5]"
        type="button"
        aria-label="打开菜单"
        aria-haspopup="menu"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 4h12M2 8h12M2 12h12"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </n-dropdown>
  </header>
</template>

<style>
/**
 * n-dropdown 会把菜单 teleport 到 body，scoped 样式打不到它，
 * 所以用 menuProps 打上的专属类名做全局作用域限定，避免影响其它弹出层。
 *
 * 这里的每条规则都要压过 naive-ui 自带的同名规则，所以选择器深度比看上去更啰嗦：
 *   .n-dropdown-menu:not(.n-dropdown-menu--scrollable) { padding: var(--n-padding) }   是 (0,2,0)
 *   .n-dropdown-menu .n-dropdown-option .n-dropdown-option-body::before                 是 (0,3,0)
 * 只写一层类名会静默失效（改不动外观，也不报错）。
 */
.atri-chat-header-dropdown.n-dropdown-menu:not(.n-dropdown-menu--scrollable) {
  padding: 4px;
  min-width: 168px;
}

.atri-chat-header-dropdown .n-dropdown-option .n-dropdown-option-body {
  border-radius: 6px;
}

.atri-chat-header-dropdown .n-dropdown-option .n-dropdown-option-body::before {
  left: 0;
  right: 0;
  border-radius: 6px;
}

.atri-chat-header-dropdown .n-dropdown-option .n-dropdown-option-body__label {
  padding-left: 0;
}

.atri-chat-header-dropdown .n-dropdown-divider {
  margin: 4px 0;
}

/**
 * 入场动画：naive-ui 默认是 opacity/transform .15s 的淡入缩放（scale .85）。
 * 这里对齐 AstrBot 的观感——略慢一点、从右上角缩放入场，
 * 时长与缓动取自 Vuetify 的 dialog-transition（进场 225ms / cubic-bezier(0,0,.2,1)）。
 */
.atri-chat-header-dropdown.popover-transition-enter-active {
  transition:
    opacity 225ms cubic-bezier(0, 0, 0.2, 1),
    transform 225ms cubic-bezier(0, 0, 0.2, 1);
}

.atri-chat-header-dropdown.popover-transition-leave-active {
  transition:
    opacity 125ms cubic-bezier(0.4, 0, 1, 1),
    transform 125ms cubic-bezier(0.4, 0, 1, 1);
}

/**
 * 缩放起点：默认 .85 偏小、像「弹出来」；改成 .9 更接近 AstrBot 那种
 * 「从右上角展开」的克制感。变换原点由 placement="bottom-end" 决定，
 * 无需手写——实测落在菜单右上角（168px 0px，168 即 min-width）。
 */
.atri-chat-header-dropdown.popover-transition-enter-from,
.atri-chat-header-dropdown.popover-transition-leave-to {
  transform: scale(0.9);
}
</style>
