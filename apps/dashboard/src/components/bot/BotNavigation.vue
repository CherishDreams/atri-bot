<template>
  <div class="atri-bot-navigation p-2">
    <n-menu :options="menuOptions" :value="activeKey" @update:value="onSelect" />
  </div>
</template>

<script setup lang="ts">
import type { MenuOption } from "naive-ui";
import { computed, h } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { icon, type IconName } from "@/components/shared/icons";
import { useProfile } from "@/composables/useProfile";

/**
 * 导航项用 RouterLink 渲染，而不是绑点击事件手动 push：
 * 前者产出真实的 <a href>，中键/右键「在新标签页打开」与状态栏预览都正常。
 *
 * `key` 直接取路由名，当前项高亮由 `activeKey` 据此算出——两者同一个来源，
 * 不会出现「点了菜单但高亮停在别处」。
 *
 * 原来第二项传了 `params: { lang: "zh-CN" }`，但 providerConfig 的路径里
 * 并没有 `:lang` 段，这类多余参数在 vue-router 里只会招来警告（URL 里看不到它，
 * 也不会被路由消费），因此一并去掉。
 *
 * **作用域化的那几项必须带上 `?profile=`**（与 `chat/Navigation.vue` 同一条理由）：
 * 当前档只存在于 URL 里，链接不带它，点一次侧栏就掉一次档 —— 症状是刚在工具页
 * 开了两个开关，点回控制台再点进来，守卫重新补了一份档（通常是 `default`），
 * 于是「我在 B 上改的」在界面上变成了「A 的配置」。
 *
 * `menuOptions` 因此是 computed 而不是常量：常量等于「setup 那一刻抓的 query」，
 * 而 profile 恰恰会在选完档的那一刻从 null 变成有值。
 */
const route = useRoute();
const router = useRouter();
const { profile } = useProfile();

/**
 * 不带 `?profile=` 的那几个：`personas` / `providers` / `adapters` / `cron` / `logs`
 * 在路由表上都标了 `noProfile` —— 它们是部署级或进程级的一份。给它们挂一个与页面
 * 无关的档名，等于在 URL 上谎称「这一页是按档的」。
 */
const PROFILE_ROUTES = new Set(["console", "config", "plugins", "memory"]);

function to(name: string) {
  // `profile.value` 在 `noProfile` 页面（人格配置 / 供应商 / 接入平台 / 计划任务 / 日志）
  // 上是 null。把 null 塞进 query 会被 vue-router 序列化成裸的 `?profile`（实测），
  // 虽然守卫随后会补成默认档，但那条 URL 本身是坏的；没有档名时干脆不带。
  return {
    name,
    ...(PROFILE_ROUTES.has(name) && profile.value !== null
      ? { query: { profile: profile.value } }
      : {}),
  };
}

interface NavItem {
  key: string;
  label: string;
  icon: IconName;
}

/**
 * 分组侧栏对齐 AstrBot：它把「运行 / 配置 / 扩展」分开，而不是一条平铺的菜单。
 * 这里的判据同样是**作用域**：运行只放控制台；个性化配置是档级与内容资产；
 * 接入与扩展是外部能力；系统是部署级调度与进程诊断。
 *
 * 「个性化配置」放配置文件、人格配置与插件：三者都回答「这台 bot 怎么跑」。
 * 人格库是全局内容资产、配置档只存引用，所以它是同级的一项，而不是配置文件页里
 * 的一个分类；插件按档启用，也放在这一组。计划任务写部署级 cron，不跟档走，
 * 所以放在「系统」而不是配置文件页。
 */
const GROUPS: { key: string; label: string; items: NavItem[] }[] = [
  {
    key: "group-run",
    label: "运行",
    // 平台会话页：适配器上的真实对话，只读（要跟机器人对话去聊天平台）。
    items: [{ key: "console", label: "平台会话", icon: "console" }],
  },
  {
    key: "group-personal",
    label: "个性化配置",
    items: [
      // 本档五类在配置文件页；配置本身的增删在左上角切换器的「管理配置」弹窗里。
      { key: "config", label: "配置文件", icon: "settings" },
      // 人格库是全局资源；配置档只在配置文件页的「人格」分类里选用。
      { key: "personas", label: "人格配置", icon: "persona" },
      // 记忆实验室是档级的：召回测试/图谱/浏览都针对当前档的记忆供应商。
      { key: "memory", label: "记忆", icon: "memory" },
      // 技能库是部署级内容资产（data/skills/），与人格同类：独立整页，档里只做引用。
      { key: "skills", label: "技能", icon: "tool" },
      // 插件页：每份档各有一套启用清单与配置值，所以链接要带 `?profile=`。
      { key: "plugins", label: "插件", icon: "plugin" },
    ],
  },
  {
    key: "group-extend",
    label: "接入与扩展",
    items: [
      {
        key: "providers",
        label: "供应商",
        icon: "provider",
      },
      { key: "adapters", label: "接入平台", icon: "chat" },
      { key: "mcp", label: "MCP", icon: "layers" },
    ],
  },
  {
    key: "group-system",
    label: "系统",
    items: [
      // 计划任务写部署级 cron.json，任务自己保存所用配置档，不跟 URL 上的档走。
      { key: "cron", label: "计划任务", icon: "clock" },
      { key: "logs", label: "日志", icon: "logs" },
    ],
  },
];

const items = GROUPS.flatMap((group) => group.items);

const menuOptions = computed<MenuOption[]>(() =>
  GROUPS.map((group) => ({
    type: "group" as const,
    key: group.key,
    label: group.label,
    children: group.items.map((item) => ({
      key: item.key,
      icon: icon(item.icon),
      label: () => h(RouterLink, { to: to(item.key) }, { default: () => item.label }),
    })),
  })),
);

/** 当前高亮项。只认这些已知路由名，其余情况不高亮，避免误标。 */
const activeKey = computed(() => {
  const name = route.name;
  return typeof name === "string" && items.some((o) => o.key === name) ? name : null;
});

/** 与链接共用 `to()`：两条出口算出同一个目标，才会出现「点了没跳对档」的分裂。 */
function onSelect(key: string): void {
  void router.push(to(key));
}
</script>
