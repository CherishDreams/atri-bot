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
  <div class="grid min-h-full place-items-center bg-canvas px-4 text-ink">
    <form class="surface-card w-full max-w-[360px] p-6" @submit.prevent="onSubmit">
      <h1 class="m-0 mb-1 text-lg text-ink">atri-bot</h1>
      <p class="m-0 mb-5 text-xs text-ink-muted">请登录以访问控制台</p>

      <label class="mb-1.5 block text-xs text-ink-muted" for="username">用户名</label>
      <input
        id="username"
        v-model="username"
        class="field-input mb-4"
        type="text"
        autocomplete="username"
        required
      />

      <label class="mb-1.5 block text-xs text-ink-muted" for="password">密码</label>
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
        class="w-full cursor-pointer rounded-md bg-primary px-3 py-2 text-sm font-medium text-surface transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"
        type="submit"
        :disabled="submitting || auth.loading"
      >
        {{ submitting || auth.loading ? "登录中…" : "登录" }}
      </button>
    </form>
  </div>
</template>
