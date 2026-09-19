<script setup lang="ts">
import ChatHeader from "@/components/chat/ChatHeader.vue";
import Navigation from "@/components/chat/Navigation.vue";
import ProfileGate from "@/components/shared/ProfileGate.vue";
import { layout } from "@/theme/tokens";
</script>

<template>
  <n-layout has-sider position="absolute">
    <!-- 与 bot 侧同一档宽度与同一条分隔线：两边切换时侧栏不会突然变宽变窄。 -->
    <n-layout-sider class="atri-chat-sider" bordered :width="layout.navW">
      <navigation />
    </n-layout-sider>
    <n-layout>
      <n-layout-header position="absolute">
        <chat-header />
      </n-layout-header>
      <!-- 偏移量取自 --atri-header-h，与 ChatHeader 的高度是同一个来源。 -->
      <n-layout position="absolute" class="top-[var(--atri-header-h)]!">
        <n-layout-content class="h-full">
          <!--
            闸门放在布局而不是各页自己加：这一份档同时决定顶栏模型选择器有没有数据、
            以及发消息能不能发出去。留在页面里判「null 就早退」得到的就是本次要修的那个形态 ——
            用户点了发送、打的字没了、请求一条没发、界面上什么都没有。
            现在没选档看到的是选择器（ProfileGate 的理由：不让「没选档」退化成一片空白）。
          -->
          <profile-gate>
            <router-view />
          </profile-gate>
        </n-layout-content>
      </n-layout>
    </n-layout>
  </n-layout>
</template>

<style scoped>
/**
 * 窄屏整块收起侧栏，而不是让它继续吃掉那一段宽度。
 *
 * 375 视口下侧栏按 `layout.navW` 吃掉 232px，顶栏只剩 143px（再减去自身 16×2 内边距是 111px），
 * 实测「Bot|Chat」按钮 right=437、汉堡 right=481 —— 两颗都**完全在屏幕外**（点不到，不是变窄）。菜单里那两项也各有归宿：
 * 「创建会话」在顶栏汉堡里已经有，「模型配置」本来就点不动（没有链接也没有 onSelect）。
 * 所以这里断掉侧栏，把宽度还给顶栏，而不是去缩右侧控件的尺寸。
 */
@media (max-width: 768px) {
  .atri-chat-sider {
    display: none;
  }
}
</style>
