<script setup lang="ts">
import { computed } from "vue";
import { RouterView } from "vue-router";
import { useTheme } from "@/theme/mode";
import { themeOf, themeOverrides } from "@/theme/naive";

/**
 * 主题在这里只做一件事：把 `scheme` 同时交给 naive-ui（`:theme` + `:theme-overrides`）。
 * UnoCSS 那边走的是 `data-atri-theme` 属性选择器（theme/mode.ts 负责写），
 * 两条通道读的是同一个 computed，所以不会错位。
 *
 * provider 的顺序照 `createDiscreteApi` 的组合顺序来
 * （loading-bar → message → dialog → notification → modal），
 * 这样「对话框里再弹提示」这类嵌套才拿得到上层的注入。
 * 挂这几个 provider 不是为了用 toast：`vite.config.ts` 早就 auto-import 了
 * `useMessage/useDialog/...`，而 naive-ui 在缺 provider 时是**直接抛错**
 * （`message/src/use-message.mjs` → `_utils/naive/warn.mjs`），
 * 之前只是没人调用，所以这个崩溃点一直埋着没响。
 */
const { scheme } = useTheme();

const theme = computed(() => themeOf[scheme.value]);
const overrides = computed(() => themeOverrides[scheme.value]);
</script>

<template>
  <!--
    `class="h-full"` 不能省：n-config-provider 不是 renderless 的，它会真的渲染出
    一个 `<div class="n-config-provider">` 插在 #app 和页面之间。
    `html, body, #app { height: 100% }`（src/uno.css）到此断掉，
    页面里的 `min-h-full` 于是按内容高度解析——表现就是登录页的背景色只盖住卡片那一截，
    下面整片留白。四个 provider 是 renderless 的，不需要各自再补。
  -->
  <n-config-provider class="h-full" :theme="theme" :theme-overrides="overrides">
    <n-loading-bar-provider>
      <n-message-provider>
        <n-dialog-provider>
          <n-notification-provider>
            <!-- 整屏一层（登录 ↔ 平台壳）同样走 out-in：底下两层布局各自还有自己的页面级过渡。 -->
            <RouterView v-slot="{ Component }">
              <Transition name="page" mode="out-in">
                <component :is="Component" />
              </Transition>
            </RouterView>
          </n-notification-provider>
        </n-dialog-provider>
      </n-message-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>
