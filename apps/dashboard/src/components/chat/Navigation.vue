<template>
  <div class="atri-navigation-mobile" v-if="!isMobile">
    <n-menu :options="menuOptions" />
  </div>
</template>
<script lang="ts" setup>
import type { MenuOption } from "naive-ui";
import { h } from "vue";
import { RouterLink } from "vue-router";

defineProps({
  isMobile: {
    type: Boolean,
    default: false,
  },
});
const menuOptions: MenuOption[] = [
  {
    label: "模型配置",
    key: "model-config",
  },
  {
    label: () =>
      h(
        RouterLink,
        {
          to: {
            name: "chat-new",
            params: {
              lang: "zh-CN",
            },
          },
        },
        { default: () => "创建会话" },
      ),
    key: "create-session",
  },
];
</script>
<style lang="scss" scoped></style>
