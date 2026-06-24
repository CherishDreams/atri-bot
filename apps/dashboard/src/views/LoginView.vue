<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
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
  <div class="grid min-h-full place-items-center bg-bg px-4 text-fg">
    <form
      class="w-full max-w-[360px] rounded-xl border border-[#2b3040] bg-panel p-6 shadow-lg"
      @submit.prevent="onSubmit"
    >
      <h1 class="m-0 mb-1 text-lg text-fg">atri-bot</h1>
      <p class="m-0 mb-5 text-xs text-muted">请登录以访问控制台</p>

      <label class="mb-3 block text-xs text-muted" for="username">用户名</label>
      <input
        id="username"
        v-model="username"
        class="mb-4 w-full rounded-lg border border-[#2b3040] bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        type="text"
        autocomplete="username"
        required
      />

      <label class="mb-3 block text-xs text-muted" for="password">密码</label>
      <input
        id="password"
        v-model="password"
        class="mb-4 w-full rounded-lg border border-[#2b3040] bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        type="password"
        autocomplete="current-password"
        required
      />

      <p v-if="error" class="m-0 mb-3 text-xs text-danger">{{ error }}</p>

      <button
        class="w-full rounded-lg border border-[#2b3040] bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
        type="submit"
        :disabled="submitting || auth.loading"
      >
        {{ submitting || auth.loading ? "登录中…" : "登录" }}
      </button>
    </form>
  </div>
</template>
