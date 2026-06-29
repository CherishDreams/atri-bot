<script setup lang="ts">
import { RouterView } from "vue-router";

import { NConfigProvider, type GlobalThemeOverrides } from "naive-ui";

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#000000",
  },
  Button: {
    textColor: "#000000",
  },
};
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <RouterView />
  </n-config-provider>
</template>
