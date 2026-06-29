<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSessionsStore } from "@/stores/sessions";

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
  <!-- 浅色主题：这套卡片运行在 naive-ui 的浅色外壳里，
       不能用 uno.config.ts 里那套暗色 token（bg-panel / text-fg），
       否则深色卡片配浅色标题落在白底上，标题会几乎看不见。 -->
  <div class="atri-session-new flex h-full items-center justify-center px-4">
    <div class="w-full max-w-[760px]">
      <h1
        class="atri-session-new-title mb-8 text-center text-[28px] leading-tight font-bold text-black"
      >
        今天想聊点什么?
      </h1>

      <div
        class="atri-session-card flex min-h-[98px] cursor-text flex-col justify-between rounded-[14px] border border-[#d9d9d9] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
        @click="focusInput"
      >
        <textarea
          ref="textarea"
          v-model="content"
          rows="1"
          placeholder="想问什么都可以"
          autocomplete="off"
          class="session-new-input w-full resize-none overflow-hidden bg-transparent px-[16px] pt-[13px] text-sm leading-[21px] text-black outline-none placeholder:text-[#707070]"
          @input="autogrow"
          @keydown.enter.exact.prevent="onCreate"
        ></textarea>

        <div class="flex shrink-0 items-center justify-between px-[14px] pt-1 pb-[8px]">
          <button
            class="input-config-toggle cursor-pointer rounded-full text-[#1e1e1e]"
            type="button"
            title="添加附件"
            aria-label="添加附件"
            @click="onAttach"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M6 1v10M1 6h10"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>

          <button
            class="send-btn grid h-7 w-7 cursor-pointer place-items-center rounded-full disabled:cursor-not-allowed"
            :class="canSubmit ? 'bg-[#4a9fd8]' : 'bg-[#96c7e3]'"
            type="button"
            :disabled="!canSubmit"
            :title="creating ? '创建中…' : '创建会话（Enter）'"
            aria-label="创建会话"
            @click="onCreate"
          >
            <svg
              v-if="!creating"
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M6.5 11V2M6.5 2 2.5 6M6.5 2l4 4"
                stroke="#ffffff"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span v-else class="text-[10px] leading-none text-white">…</span>
          </button>
        </div>
      </div>

      <p v-if="attachHint" class="atri-session-hint mt-3 text-center text-xs text-[#707070]">
        附件上传还没接后端，先把文字发过来吧。
      </p>
      <p v-if="error" class="atri-session-error mt-3 text-center text-xs text-[#d03050]">
        {{ error }}
      </p>
    </div>
  </div>
</template>
