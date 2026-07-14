<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { icon } from "@/components/shared/icons";
import { useSessionsStore } from "@/stores/sessions";

/** 两个按钮的图标走命名表，不再在模板里各写一份 `<svg>`。 */
const AttachIcon = icon("plus");
const SendIcon = icon("arrowUp");

const router = useRouter();
const sessions = useSessionsStore();

const content = ref("");
const creating = ref(false);
const error = ref<string | null>(null);
const attachHint = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);

const canSubmit = computed(() => content.value.trim().length > 0 && !creating.value);

const TITLE_MAX = 24;
/** 输入区最多长到这么高，再多就在框内滚动，避免卡片把页面撑开。 */
const MAX_INPUT_HEIGHT = 200;

let hintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 用首句前 24 个字符当标题：再长侧栏就读不全了。
 * 这里刻意不做输入框让用户填标题——界面保持单行输入 + 两个按钮。
 */
function deriveTitle(): string {
  const firstLine = content.value.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return "新会话";
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
}

/**
 * 输入框随内容长高；先归零再按 scrollHeight 量，否则只会越量越大。
 *
 * textarea 上不能加 flex-1：flex-basis 会盖掉这里设的 height，
 * 卡片高度就永远停在 min-h 上，多行输入只会被内部滚动吃掉。
 * 高度在这里完全由 style.height 驱动，卡片的 min-h 负责空态下的最小尺寸。
 */
function autogrow(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

function focusInput(): void {
  textarea.value?.focus();
}

async function onCreate(): Promise<void> {
  if (!canSubmit.value) return;
  const text = content.value.trim();

  creating.value = true;
  error.value = null;
  try {
    const session = await sessions.create(deriveTitle());
    // 首句用 history state 传给会话页：query 会把聊天内容写进地址栏和浏览历史。
    await router.push({
      name: "chat-session",
      params: { sessionId: session.id },
      state: { draft: text },
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : "创建会话失败";
  } finally {
    creating.value = false;
  }
}

/** 后端只收文本，没有上传接口；点了就如实说明，不做假的上传界面。 */
function onAttach(): void {
  attachHint.value = true;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (attachHint.value = false), 4000);
}

watch(content, () => void nextTick(autogrow));

onBeforeUnmount(() => {
  if (hintTimer) clearTimeout(hintTimer);
});
</script>

<template>
  <!--
    颜色全部走语义 token（`bg-surface`/`text-ink`/…），它们随 `data-atri-theme` 翻转，
    所以这里不再需要「本页必须写死浅色」的那套特殊处理：卡片和外壳现在同属一个主题。
  -->
  <div class="flex h-full items-center justify-center bg-canvas px-4">
    <div class="w-full max-w-[var(--atri-reading-w)]">
      <h1 class="mb-8 text-center text-3xl font-bold text-ink">今天想聊点什么?</h1>

      <div
        class="surface-card flex min-h-24 cursor-text flex-col justify-between transition-colors focus-within:border-primary"
        @click="focusInput"
      >
        <textarea
          ref="textarea"
          v-model="content"
          rows="1"
          placeholder="想问什么都可以"
          autocomplete="off"
          class="w-full resize-none bg-transparent px-4 pt-3 text-sm leading-normal text-ink outline-none placeholder:text-ink-faint"
          @input="autogrow"
          @keydown.enter.exact.prevent="onCreate"
        ></textarea>

        <div class="flex shrink-0 items-center justify-between px-3.5 pt-1 pb-2">
          <button
            class="grid h-7 w-7 cursor-pointer place-items-center rounded-full text-ink-muted transition-colors hover:bg-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            type="button"
            title="添加附件"
            aria-label="添加附件"
            @click="onAttach"
          >
            <component :is="AttachIcon" />
          </button>

          <button
            class="grid h-7 w-7 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-not-allowed"
            :class="
              canSubmit
                ? 'bg-primary text-surface hover:bg-primary-hover'
                : 'bg-tint text-ink-faint'
            "
            type="button"
            :disabled="!canSubmit"
            :title="creating ? '创建中…' : '创建会话（Enter）'"
            aria-label="创建会话"
            @click="onCreate"
          >
            <component :is="SendIcon" v-if="!creating" />
            <span v-else class="text-xs leading-none">…</span>
          </button>
        </div>
      </div>

      <p v-if="attachHint" class="mt-3 text-center text-xs text-ink-muted">
        附件上传还没接后端，先把文字发过来吧。
      </p>
      <p v-if="error" class="mt-3 text-center text-xs text-danger">{{ error }}</p>
    </div>
  </div>
</template>
