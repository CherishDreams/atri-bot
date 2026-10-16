<script setup lang="ts">
import { computed, watch } from "vue";
import type { PluginInfo } from "@/api/generated/index.js";
import { icon } from "@/components/shared/icons";
import { usePluginSettingsStore } from "@/stores/pluginSettings";
import PluginConfigForm from "./PluginConfigForm.vue";

/**
 * 单个插件的配置抽屉。
 *
 * 宽度取 `min(520px, 100vw)`：520px 够放下「标签 + 14rem 控件」的左右两栏，
 * 而窄屏上不写死 520 会横向溢出 —— `100vw` 那一半就是给它的。
 *
 * 脏时不许点遮罩、按 ESC，关闭键换成 `n-popconfirm`：这是 AstrBot 配置抽屉的同一条
 * 保护。**只拦关闭，不拦页面跳转** —— 切配置只发生在配置文件页，这一页没有第二份
 * 未保存拦截；离开浏览器历史时组件卸载，草稿跟着消失是明确的代价（不写 localStorage）。
 */
const props = defineProps<{
  show: boolean;
  profile: string | null;
  plugin: PluginInfo | null;
}>();
const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (e: "saved"): void;
}>();

const settings = usePluginSettingsStore();
const CloseIcon = icon("close");
const current = computed(() => settings.plugin ?? props.plugin);

watch(
  () => [props.show, props.profile, props.plugin?.id] as const,
  ([show, profile, id]) => {
    if (show && profile !== null && id !== undefined) void settings.open(profile, id);
  },
  { immediate: true },
);

function requestClose(): void {
  emit("update:show", false);
}

/** 兜底：遮罩与 ESC 已经按脏状态禁用，这里再挡一次程序性的关闭。 */
function onShowChange(value: boolean): void {
  if (!value && settings.dirty) return;
  emit("update:show", value);
}

async function save(): Promise<void> {
  if (props.profile === null) return;
  if (await settings.save(props.profile)) emit("saved");
}
</script>

<template>
  <n-drawer
    :show="show"
    placement="right"
    width="min(520px, 100vw)"
    :closable="false"
    :mask-closable="!settings.dirty"
    :close-on-esc="!settings.dirty"
    @update:show="onShowChange"
    @after-leave="settings.reset()"
  >
    <n-drawer-content body-content-style="padding-top: 0;">
      <template #header>
        <div class="flex w-full min-w-0 items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="m-0 truncate text-[15px] font-semibold text-ink">插件配置</h3>
            <p class="mt-0.5 mb-0 truncate text-xs text-ink-muted">
              {{ current?.name ?? "" }}
              <code v-if="current" class="text-ink-faint">{{ current.id }}</code>
            </p>
          </div>

          <n-popconfirm
            v-if="settings.dirty"
            positive-text="关闭"
            negative-text="取消"
            @positive-click="requestClose"
          >
            <template #trigger>
              <n-button quaternary circle size="small" aria-label="关闭配置">
                <template #icon><component :is="CloseIcon" /></template>
              </n-button>
            </template>
            有未保存的改动，关闭后会丢弃。确定关闭吗？
          </n-popconfirm>
          <n-button
            v-else
            quaternary
            circle
            size="small"
            aria-label="关闭配置"
            @click="requestClose"
          >
            <template #icon><component :is="CloseIcon" /></template>
          </n-button>
        </div>
      </template>

      <div class="flex flex-col gap-3 pb-2">
        <n-alert
          v-if="settings.error"
          type="error"
          :show-icon="false"
          closable
          @close="settings.clearError()"
        >
          {{ settings.error }}
        </n-alert>

        <n-alert v-if="settings.schemaError" type="warning" :show-icon="false">
          <code class="text-xs">_conf_schema.json</code> 有误，暂时没有可编辑的表单：
          {{ settings.schemaError }}
        </n-alert>

        <n-alert v-if="settings.configError" type="warning" :show-icon="false">
          {{ settings.configError }}
        </n-alert>

        <n-alert v-if="settings.reloadError" type="error" :show-icon="false">
          配置已保存，但插件重载失败：{{ settings.reloadError }}
        </n-alert>
        <n-alert v-else-if="settings.saved" type="success" :show-icon="false">
          已保存{{ current?.status === "active" ? "，插件已按新配置重载" : "" }}
        </n-alert>

        <n-alert v-if="current?.status === 'disabled'" type="info" :show-icon="false">
          这个插件在当前配置里被禁用了：保存只写文件，启用之后才会生效。
        </n-alert>
        <n-alert
          v-else-if="current?.status === 'failed' && current.error"
          type="error"
          :show-icon="false"
        >
          插件当前加载失败：{{ current.error }}
        </n-alert>

        <n-spin :show="settings.loading">
          <PluginConfigForm
            v-if="settings.fields.length > 0"
            :fields="settings.fields"
            :original="settings.original"
            :draft="settings.draft"
            @set="(key, value) => settings.set(key, value)"
          />
          <n-empty
            v-else-if="!settings.loading && !settings.schemaError"
            description="这个插件没有声明任何配置项"
          />
        </n-spin>
      </div>

      <template #footer>
        <div class="flex w-full items-center justify-between gap-3">
          <span class="text-xs text-ink-faint">
            {{ settings.dirty ? "有未保存的改动" : "改动会写进这份配置的插件目录" }}
          </span>
          <div class="flex items-center gap-2">
            <n-button v-if="!settings.dirty" size="small" @click="requestClose"> 关闭 </n-button>
            <n-button
              size="small"
              type="primary"
              :loading="settings.saving"
              :disabled="!settings.dirty || settings.schemaError !== null || settings.loading"
              @click="save"
            >
              保存
            </n-button>
          </div>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>
