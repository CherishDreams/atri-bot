<script setup lang="ts">
import { RouterLink } from "vue-router";
import logoUrl from "@/assets/images/logo.png";
import { icon } from "@/components/shared/icons";
import PlatformSwitch from "@/components/shared/PlatformSwitch.vue";
import ThemeToggle from "@/components/shared/ThemeToggle.vue";
import TopBarMenu from "@/components/shared/TopBarMenu.vue";

/**
 * bot 平台的顶栏。**刻意不复用 ChatHeader**：两者内容本就不同
 * （这里放 logo，chat 那边放模型选择器），硬合成一个组件只会得到一堆
 * `v-if="isChat"`，两个平台的顶栏改动互相牵制。
 *
 * **这一侧没有模型选择器**（以前有）。判据不是审美而是「它在这儿不做事」：
 * bot 侧发消息走 `components/Conversation.vue` 的 `send(profile, text)`，
 * 根本不传 model，所以那颗选择器对 bot 平台没有任何行为影响，
 * 只是占掉顶栏 128px 的一个装饰 —— 而「这一档用哪个模型」在 chat 侧才是需要随手调的事。
 * 其余三个控件（主题、平台切换、汉堡）与 chat 共用同一批组件。
 *
 * logo 用**原始整图**（2172×724），不裁不切。这张图内含大量透明留白
 * （实测不透明像素只落在 228–491 行、29–2142 列，真实图形 2114×264、宽高比 8.0），
 * 因此图片撑满顶栏高度时，可见图形约 22px 高并上下自然留白——留白本身就充当了内边距，
 * 裁图只会多出一份要跟着原图更新的派生资源。
 *
 * 宽高比 3.0 的整图在 60px 顶栏里宽约 180px，不会挤压右侧控件。
 *
 * ≤768px 多一颗汉堡：侧栏在那个断点收进抽屉（`BotLayout`），没有它就再也到不了
 * 「控制台 / 配置 / 配置档」。它放在 logo 之前，与 AstrBot 的顶栏同一位置。
 */
const emit = defineEmits<{ (e: "toggle-nav"): void }>();
const MenuIcon = icon("menu");
</script>

<template>
  <header
    class="atri-bot-header flex h-[var(--atri-header-h)] w-full items-center gap-3 border-b-1 border-line px-4"
  >
    <!-- 只在窄屏出现（`md:hidden`：≥768px 隐藏）。侧栏那时已经收进抽屉。 -->
    <button
      type="button"
      class="atri-nav-toggle -ml-1 shrink-0 cursor-pointer rounded p-1.5 text-ink-muted hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
      aria-label="打开导航"
      @click="emit('toggle-nav')"
    >
      <component :is="MenuIcon" />
    </button>

    <!-- 点 logo 回控制台：这是 bot 平台的主页。
         `self-stretch` 不能省：顶栏是 items-center 的 flex 容器，
         直接子项的高度是内容撑出来的（auto），此时图片的 h-full（height:100%）
         会因为父高不确定而解析成 auto，logo 缩回原始 724px 那套内部尺寸，
         表现为顶栏被撑高或图片位置异常。先让链接占满交叉轴高度，百分比高度才有确定基准。 -->
    <RouterLink
      to="/"
      class="atri-logo-link flex shrink-0 self-stretch items-center"
      aria-label="返回控制台"
    >
      <!-- 链接已有可读名称，图片按装饰处理（空 alt），避免读屏把名称念两遍。 -->
      <img :src="logoUrl" alt="" class="atri-logo h-full w-auto" />
    </RouterLink>

    <div class="ml-auto flex items-center gap-3">
      <ThemeToggle />
      <PlatformSwitch />
      <TopBarMenu />
    </div>
  </header>
</template>

<style scoped>
/**
 * 窄屏收窄 logo。
 *
 * logo 在这 60px 顶栏里按原图宽高比固定占约 177px，是最宽的固定项；375px 视口下
 * 「logo 177 + 平台切换 107 + 主题 32 + 汉堡 32 + 三处 gap 36 + 左右内边距 32」放不下，
 * 汉堡按钮会被推到自己的 `right` 超出视口 —— 不是变窄，是**点不到**，而它是
 * 「返回控制台 / 新建会话 / 退出登录」的唯一入口。所以让装饰性宽度先让路。
 *
 * 用 max-width 而非覆盖 height：图片的 h-full/w-auto 依赖交叉轴高度，改高度会让它在
 * 60px 顶栏里重新居中并改变视觉大小，而收窄宽度只是让这张宽高比 3:1 的图整体等比缩小。
 *
 * 这里以前还有一条 `max-width: 414px` 把整个 logo 收起，那是给模型选择器腾地方的
 * （它的判据里算着 128px 的选择器宽度）；选择器已从本侧顶栏移除，那条规则随之删掉，
 * 现在 375 档也留得下 logo。
 */
@media (max-width: 480px) {
  .atri-bot-header .atri-logo {
    max-width: 96px;
  }
}
</style>
