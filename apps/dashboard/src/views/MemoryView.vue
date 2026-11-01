<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { MemoryEntry, MemoryItemView } from "@/api/generated/index.js";
import {
  deleteMemoryEntry,
  getMemoryOverview,
  listMemoryEntries,
  testMemoryRecall,
} from "@/api/client";
import { useProfile } from "@/composables/useProfile";

/**
 * 记忆实验室：召回测试、关键词共现图谱与记忆浏览。
 *
 * 召回测试走的是**真实注入的那条路**（当前生效的供应商），测出来的就是模型
 * 实际会看到的东西。浏览 / 图谱 / 删除只有内置方案支持（它们依赖内置存储的
 * 形状）；当前供应商是插件时页面如实标注，而不是显示一片空数据假装没数据。
 */
const { profile } = useProfile();

// --- 召回测试 ---------------------------------------------------------------
const query = ref("");
const recallItems = ref<MemoryItemView[] | null>(null);
const recallError = ref<string | null>(null);
const testing = ref(false);

async function runTest(): Promise<void> {
  if (profile.value === null || query.value.trim() === "") return;
  testing.value = true;
  recallError.value = null;
  recallItems.value = null;
  try {
    const res = await testMemoryRecall(profile.value, query.value, 10);
    recallItems.value = res.items;
    recallError.value = res.error;
  } catch (err) {
    recallError.value = err instanceof Error ? err.message : String(err);
  } finally {
    testing.value = false;
  }
}

// --- 总览与图谱 ---------------------------------------------------------------
interface KeywordNode {
  keyword: string;
  count: number;
  peers: { keyword: string; count: number }[];
}

const overviewSupported = ref<boolean | null>(null);
const total = ref(0);
const byKind = ref<Record<string, number>>({});
const keywords = ref<KeywordNode[]>([]);

async function refreshOverview(): Promise<void> {
  if (profile.value === null) return;
  try {
    const res = await getMemoryOverview(profile.value);
    overviewSupported.value = res.supported;
    if (res.supported === true) {
      // supported 为 true 时这些键必然在场（规格如此）；缺省兜底只为收窄生成类型。
      total.value = res.total ?? 0;
      byKind.value = res.byKind ?? {};
      keywords.value = res.keywords ?? [];
    }
  } catch (err) {
    recallError.value = err instanceof Error ? err.message : String(err);
  }
}

/** 图谱布局：节点按权重排在同心圆上（权重大的靠内），边连共现对。无依赖的手绘 SVG。 */
const NODES = 30;
const SIZE = 460;
const CENTER = SIZE / 2;
const R_MIN = 56;
const R_MAX = 205;

const graph = computed(() => {
  const list = keywords.value.slice(0, NODES);
  const maxCount = Math.max(1, ...list.map((node) => node.count));
  const inSet = new Set(list.map((node) => node.keyword));
  const radius = (count: number): number => R_MAX - (R_MAX - R_MIN) * (count / maxCount);
  const nodes = list.map((node, index) => {
    // 按权重从大到小排进由内向外的螺旋：内圈是大词。
    const angle = (index / Math.max(1, list.length)) * Math.PI * 2;
    const r = radius(node.count);
    return {
      ...node,
      x: CENTER + r * Math.cos(angle),
      y: CENTER + r * Math.sin(angle),
      r: 6 + 12 * (node.count / maxCount),
    };
  });
  const positions = new Map(nodes.map((node) => [node.keyword, node]));
  const edges: { x1: number; y1: number; x2: number; y2: number; w: number }[] = [];
  for (const node of nodes) {
    for (const peer of node.peers) {
      const target = positions.get(peer.keyword);
      if (target === undefined || !inSet.has(peer.keyword)) continue;
      // 每条边只画一次（keyword 字典序小的一侧）。
      if (node.keyword > peer.keyword) continue;
      edges.push({ x1: node.x, y1: node.y, x2: target.x, y2: target.y, w: peer.count });
    }
  }
  return { nodes, edges };
});

// --- 浏览 -------------------------------------------------------------------
type KindFilter = "all" | "interaction" | "fact" | "diary";
const kindFilter = ref<KindFilter>("all");
const entries = ref<MemoryEntry[]>([]);
const entriesLoading = ref(false);
const entriesError = ref<string | null>(null);
const deletingId = ref<string | null>(null);

const KIND_LABELS: Record<string, string> = {
  interaction: "交互",
  fact: "事实",
  diary: "日记",
};

async function refreshEntries(): Promise<void> {
  if (profile.value === null) return;
  entriesLoading.value = true;
  entriesError.value = null;
  try {
    const res = await listMemoryEntries(profile.value, {
      ...(kindFilter.value === "all" ? {} : { kind: kindFilter.value }),
      limit: 200,
    });
    entries.value = res.entries;
  } catch (err) {
    entriesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    entriesLoading.value = false;
  }
}

async function removeEntry(id: string): Promise<void> {
  if (profile.value === null) return;
  deletingId.value = id;
  try {
    await deleteMemoryEntry(profile.value, id);
    entries.value = entries.value.filter((entry) => entry.id !== id);
  } catch (err) {
    entriesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    deletingId.value = null;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshOverview(), refreshEntries()]);
}

onMounted(() => void refreshAll());
watch([profile, kindFilter], () => void refreshEntries());
watch(profile, () => void refreshOverview());
</script>

<template>
  <div class="h-full overflow-y-auto bg-canvas">
    <div class="mx-auto max-w-[58rem] px-5 pt-6 pb-24 sm:px-8 sm:pt-8">
      <header class="mb-5">
        <h2 class="m-0 text-[22px] font-semibold tracking-tight text-ink">记忆</h2>
        <p class="mt-1.5 mb-0 text-13px leading-relaxed text-ink-muted">
          召回测试与真实的注入走同一条路径 —— 测出来的就是模型每轮实际会看到的内容。
          浏览、图谱与删除只有内置方案支持；当前供应商由插件提供时页面会如实标注。
        </p>
      </header>

      <!-- 召回测试 -->
      <section class="mb-4 rounded-lg border border-line bg-surface px-4 py-4">
        <h3 class="m-0 mb-1 text-15px font-semibold text-ink">召回测试</h3>
        <p class="mt-0 mb-3 text-12px text-ink-muted">
          输入一句「用户会说的话」，看看会召回哪些记忆（按关键词命中 + 时间衰减排序）。
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <n-input
            v-model:value="query"
            size="small"
            class="min-w-[16rem] flex-1"
            placeholder="例如：小明喜欢什么"
            @keydown.enter="runTest"
          />
          <n-button type="primary" size="small" :loading="testing" @click="runTest">
            测试召回
          </n-button>
        </div>
        <n-alert v-if="recallError" type="warning" :show-icon="false" class="mt-3">
          {{ recallError }}
        </n-alert>
        <ul v-if="recallItems !== null && recallItems.length > 0" class="mb-0 mt-3 list-none p-0">
          <li
            v-for="(item, index) in recallItems"
            :key="item.id ?? index"
            class="border-b-1 border-line/60 py-2 last:border-b-0"
          >
            <div class="flex items-center gap-2 text-11px text-ink-faint">
              <span>{{ index + 1 }}</span>
              <n-tag v-if="item.kind" size="tiny" :bordered="false">
                {{ KIND_LABELS[item.kind] ?? item.kind }}
              </n-tag>
              <span v-if="item.occurredAt">{{ item.occurredAt.slice(0, 10) }}</span>
            </div>
            <p class="mb-0 mt-1 text-13px whitespace-pre-wrap text-ink">{{ item.content }}</p>
          </li>
        </ul>
        <p
          v-else-if="recallItems !== null && recallError === null"
          class="mb-0 mt-3 text-13px text-ink-muted"
        >
          没有召回任何记忆 —— 试一个与已有交互更相关的词，或先聊几句攒一些交互。
        </p>
      </section>

      <!-- 总览与图谱 -->
      <section class="mb-4 rounded-lg border border-line bg-surface px-4 py-4">
        <h3 class="m-0 mb-1 text-15px font-semibold text-ink">总览与图谱</h3>
        <p class="mt-0 mb-3 text-12px text-ink-muted">
          关键词是节点（越大 = 出现在越多记忆里），共现是边（同一条记忆里同时出现）。
        </p>
        <n-alert v-if="overviewSupported === false" type="info" :show-icon="false">
          当前记忆供应商由插件提供，浏览与图谱仅内置方案支持。
        </n-alert>
        <template v-else-if="overviewSupported === true">
          <div class="mb-3 flex flex-wrap gap-4 text-13px text-ink-muted">
            <span
              >共 <strong class="text-ink">{{ total }}</strong> 条</span
            >
            <span v-for="(count, kind) in byKind" :key="kind"
              >{{ KIND_LABELS[kind] ?? kind }} {{ count }}</span
            >
          </div>
          <div v-if="graph.nodes.length === 0" class="text-13px text-ink-muted">
            还没有足够的记忆画出图谱 —— 先聊几句或启用自动记录。
          </div>
          <svg
            v-else
            :viewBox="`0 0 ${SIZE} ${SIZE}`"
            class="w-full max-w-[560px]"
            role="img"
            aria-label="记忆关键词共现图谱"
          >
            <line
              v-for="(edge, index) in graph.edges"
              :key="`e${index}`"
              :x1="edge.x1"
              :y1="edge.y1"
              :x2="edge.x2"
              :y2="edge.y2"
              stroke="var(--atri-line)"
              :stroke-width="Math.min(3, 0.5 + edge.w * 0.4)"
            />
            <g v-for="node in graph.nodes" :key="node.keyword">
              <circle :cx="node.x" :cy="node.y" :r="node.r" fill="var(--atri-primary-soft)" />
              <text
                :x="node.x"
                :y="node.y + node.r + 11"
                text-anchor="middle"
                class="fill-ink text-[10px]"
              >
                {{ node.keyword }}
              </text>
            </g>
          </svg>
        </template>
      </section>

      <!-- 浏览 -->
      <section class="rounded-lg border border-line bg-surface px-4 py-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="m-0 text-15px font-semibold text-ink">浏览</h3>
          <n-radio-group v-model:value="kindFilter" size="small">
            <n-radio-button value="all">全部</n-radio-button>
            <n-radio-button value="interaction">交互</n-radio-button>
            <n-radio-button value="fact">事实</n-radio-button>
            <n-radio-button value="diary">日记</n-radio-button>
          </n-radio-group>
        </div>
        <n-alert v-if="entriesError" type="error" :show-icon="false" class="mb-3">
          {{ entriesError }}
        </n-alert>
        <n-spin :show="entriesLoading" size="small">
          <n-empty
            v-if="entries.length === 0 && !entriesLoading"
            size="small"
            description="没有记忆条目"
          />
          <ul v-else class="mb-0 list-none p-0">
            <li
              v-for="entry in entries"
              :key="entry.id"
              class="border-b-1 border-line/60 py-2.5 last:border-b-0"
            >
              <div class="flex items-center gap-2 text-11px text-ink-faint">
                <n-tag size="tiny" :bordered="false">
                  {{ KIND_LABELS[entry.kind] ?? entry.kind }}
                </n-tag>
                <span>{{ entry.createdAt.slice(0, 16).replace("T", " ") }}</span>
                <n-popconfirm class="ml-auto" @positive-click="removeEntry(entry.id)">
                  <template #trigger>
                    <n-button
                      quaternary
                      size="tiny"
                      type="error"
                      :loading="deletingId === entry.id"
                    >
                      删除
                    </n-button>
                  </template>
                  删除这条记忆？
                </n-popconfirm>
              </div>
              <p class="mb-0 mt-1 text-13px whitespace-pre-wrap text-ink">{{ entry.content }}</p>
            </li>
          </ul>
        </n-spin>
      </section>
    </div>
  </div>
</template>
