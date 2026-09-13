<script setup lang="ts">
import { useProfile } from "../../composables/useProfile";
import ProfilePicker from "./ProfilePicker.vue";

/**
 * 作用域页面的闸门：没选配置档时渲染选择器，选了才渲染内容。
 *
 * 存在的理由是不让「没选档」退化成一片空白 —— 那与「加载失败但没有错误文案」在
 * 界面上长得一样。内容通过**具名作用域插槽**拿到那个非 null 的 `profile`，
 * 于是页面内部不需要再对 null 做一层判断。
 */
const { profile } = useProfile();
</script>

<template>
  <ProfilePicker v-if="profile === null" />
  <slot v-else :profile="profile" />
</template>
