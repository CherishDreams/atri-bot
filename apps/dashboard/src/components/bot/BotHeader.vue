<script setup lang="ts">
import { RouterLink } from "vue-router";
import logoUrl from "@/assets/images/logo.png";
import ModelSelectMenu from "@/components/shared/ModelSelectMenu.vue";
import PlatformSwitch from "@/components/shared/PlatformSwitch.vue";
import ThemeToggle from "@/components/shared/ThemeToggle.vue";
import TopBarMenu from "@/components/shared/TopBarMenu.vue";

/**
 * bot 平台的顶栏。**刻意不复用 ChatHeader**：两者左侧内容本就不同
 * （这里放 logo，chat 那边放模型选择器），硬合成一个组件只会得到一堆
 * `v-if="isChat"`，两个平台的顶栏改动互相牵制。
 * 右侧控件与 chat 保持一致，因此抽成三个共用组件，而不是复制第二份实现。
 *
 * logo 用**原始整图**（2172×724），不裁不切。这张图内含大量透明留白
 * （实测不透明像素只落在 228–491 行、29–2142 列，真实图形 2114×264、宽高比 8.0），
 * 因此图片撑满顶栏高度时，可见图形约 22px 高并上下自然留白——留白本身就充当了内边距，
 * 裁图只会多出一份要跟着原图更新的派生资源。
 *
 * 宽高比 3.0 的整图在 60px 顶栏里宽约 180px，不会挤压右侧控件。
 */
</script>

<template>
  <header
    class="atri-bot-header flex h-[var(--atri-header-h)] w-full items-center gap-3 border-b-1 border-line px-4"
  >
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
      <ModelSelectMenu />
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
 * logo 在 60px 顶栏里固定占 177px，是顶栏里最宽的固定项；375px 视口下
 * 「logo 177 + 模型选择器 + 平台切换 107 + 汉堡 32」放不下，实测汉堡按钮
 * 被推到 right=382（视口 375）而**整颗移出屏幕**——不是变窄，是点不到。
 * 因此这里让 logo 在窄屏降一档，而不是继续挤右侧控件。
 *
 * 用 max-width 而非覆盖 height：图片的 h-full/w-auto 依赖交叉轴高度，
 * 改高度会让它在 60px 顶栏里重新居中并改变视觉大小，而收窄宽度只是
 * 让这张宽高比 3:1 的图整体等比缩小。
 */
@media (max-width: 480px) {
  .atri-bot-header .atri-logo {
    max-width: 64px;
  }
}

/**
 * 再窄一档就把 logo 整块收起。触发它的是一次实测：375/414/480 三档下模型名较长时
 * 「打开菜单」这颗按钮 `right` 超出视口 —— **不是变窄，是点不到**，
 * 而顶栏里最宽的可让位项就是这个 logo（模型选择器不能缩到看不见，
 * 平台切换按 AGENTS.md 的既有结论不许塞进汉堡菜单）。
 *
 * 收起它不丢功能：主页入口在汉堡里那一项「返回控制台」，而 logo 本来就是装饰图
 * （空 alt，链接自带 aria-label）。这条与上面那条同一个思路 —— 让装饰性宽度先让路，
 * 保住可达性，而不是去缩真正要点的控件。
 */
@media (max-width: 414px) {
  .atri-bot-header .atri-logo-link {
    display: none;
  }
}
</style>
