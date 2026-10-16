<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import logoUrl from "@/assets/images/logo.png";
import { useAuthStore } from "../stores/auth.js";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const submitting = ref(false);

/** 只有站内绝对路径才接受，避免开放重定向。 */
function resolveRedirect(): string {
  const target = route.query.redirect;
  if (typeof target === "string" && target.startsWith("/")) return target;
  return "/";
}

async function onSubmit(): Promise<void> {
  error.value = null;
  submitting.value = true;
  try {
    await auth.login(username.value, password.value);
    await router.replace(resolveRedirect());
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!--
    背景用一层极淡的主色径向光晕把视线收到卡片上，而不是铺满整屏的白。
    光晕只出现在浅色主题下也成立：primary 变量深浅两套都有值，不写死 hex。
  -->
  <div class="login-stage grid min-h-full place-items-center bg-canvas px-4 py-10 text-ink">
    <div class="w-full max-w-[400px]">
      <form
        class="rounded-2xl border-1 border-line bg-surface p-7 shadow-lg sm:p-8"
        @submit.prevent="onSubmit"
      >
        <img :src="logoUrl" alt="atri-bot" class="mb-6 h-8 w-auto" />
        <h1 class="m-0 text-xl font-semibold tracking-tight text-ink">登录控制台</h1>
        <p class="mt-1 mb-7 text-13px text-ink-muted">使用管理员账号继续。</p>

        <label class="mb-1.5 block text-xs font-medium text-ink-muted" for="username">
          用户名
        </label>
        <input
          id="username"
          v-model="username"
          class="field-input mb-4"
          type="text"
          autocomplete="username"
          required
        />

        <label class="mb-1.5 block text-xs font-medium text-ink-muted" for="password"> 密码 </label>
        <input
          id="password"
          v-model="password"
          class="field-input mb-4"
          type="password"
          autocomplete="current-password"
          required
        />

        <p v-if="error" class="m-0 mb-3 text-xs text-danger">{{ error }}</p>

        <button
          class="mt-2 h-10 w-full cursor-pointer rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-primary-pressed disabled:cursor-wait disabled:opacity-60"
          type="submit"
          :disabled="submitting || auth.loading"
        >
          {{ submitting || auth.loading ? "登录中…" : "登录" }}
        </button>
      </form>
      <p class="mt-4 text-center text-xs text-ink-faint">
        凭据只保存在服务端，浏览器只持有 HttpOnly Cookie。
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-stage {
  background-image: radial-gradient(
    60rem 32rem at 50% -12rem,
    var(--atri-primary-soft),
    transparent 70%
  );
}
</style>
