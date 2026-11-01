<template>
  <section class="page active" aria-label="实体与主题">
    <div class="page-head">
      <div>
        <p class="eyebrow">ENTITY &amp; COLLECTIONS / 内容视图</p>
        <h1>实体与主题</h1>
        <p>同一事实可以被多种视图引用。实体是稳定的索引，主题负责相关性；事实本身并不属于某一张百科页面。</p>
      </div>
      <span class="page-head-tag">{{ categories.length }} 个一级主题 · 实时读取</span>
    </div>

    <div class="segment">
      <button
        v-for="c in categories"
        :key="c.id"
        :class="{ selected: topicId === c.id }"
        @click="topicId = c.id"
      >
        {{ c.name }}
      </button>
    </div>

    <div class="panel proto-big-card" style="margin: 17px 0">
      <div class="proto-card-head">
        <div>
          <p class="eyebrow">COLLECTION / DYNAMIC VIEW</p>
          <h2 class="proto-topic-name">{{ topicName }}</h2>
          <p class="proto-small proto-muted">{{ topicDesc }}</p>
        </div>
        <ProtoChip text="实时档案" kind="blue" />
      </div>
      <div class="proto-stats-strip">
        <div>
          <b>{{ pad(entityTotal) }}</b>
          <span>关联实体</span>
        </div>
        <div>
          <b>{{ pad(factSum) }}</b>
          <span>已展示实体事实合计</span>
        </div>
        <div>
          <b>实时</b>
          <span>按需生成 · 非实体自身生产事实</span>
        </div>
      </div>
    </div>

    <!-- 搜索：实体多时按关键词定位（命中结果仍限定在当前主题内） -->
    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" :placeholder="`在「${topicName}」中搜索实体…`" aria-label="搜索实体" />
      </label>
      <button v-if="q.trim()" class="small-btn" @click="q = ''">清除</button>
    </div>

    <div class="section-head">
      <h2>该主题下的实体</h2>
      <span class="meta-note">
        {{ q.trim() ? `搜索「${q.trim()}」命中 ${entityTotal} 个` : '按事实数由多到少' }} ·
        已加载 {{ entities.length }} / {{ entityTotal }}
      </span>
    </div>
    <div v-if="loading" class="empty-block">加载中…</div>
    <div v-else-if="!entities.length" class="empty-block">
      {{ q.trim() ? '没有匹配的实体' : '该主题下暂无实体' }}
    </div>
    <template v-else>
      <div class="proto-entity-picker">
        <button
          v-for="e in entities"
          :key="e.id"
          class="proto-entity-pick"
          :class="{ selected: selectedId === e.id }"
          @click="selectEntity(e)"
        >
          <span>{{ e.name }}</span>
          <span class="proto-entity-pick-count">{{ e.factCount ?? 0 }}</span>
        </button>
      </div>
      <div class="load-more">
        <button v-if="hasMore" class="small-btn" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? '正在加载…' : `加载更多（已加载 ${entities.length} / ${entityTotal}）` }}
        </button>
        <span v-else>已加载全部 {{ entityTotal }} 个实体</span>
      </div>
    </template>

    <template v-if="selected">
      <div class="section-head">
        <h2>实体信息</h2>
        <span class="meta-note">实体为全局唯一，不属于语料域</span>
      </div>
      <div class="panel proto-big-card">
        <div class="proto-card-head">
          <h3 class="proto-big-title">{{ selected.name }}</h3>
          <ProtoChip :text="topicName" kind="blue" />
        </div>
        <div class="proto-field"><span class="proto-field-name">稳定标识</span><span class="proto-field-value proto-id">{{ selected.urn }}</span></div>
        <div class="proto-field"><span class="proto-field-name">首次来源语料域</span><span class="proto-field-value">{{ selected.datasetName || '—' }}</span></div>
        <div class="proto-field"><span class="proto-field-name">状态 / 修订</span><span class="proto-field-value">{{ selected.status }} · 修订 v{{ selected.revision }}</span></div>
        <div class="proto-field"><span class="proto-field-name">现行事实</span><span class="proto-field-value">{{ selected.factCount ?? 0 }} 条</span></div>
        <p v-if="detail?.lede" class="proto-narrative" style="margin-top: 12px">{{ detail.lede }}</p>
        <div v-if="detail?.aliases?.length" class="proto-field">
          <span class="proto-field-name">别名</span>
          <span class="proto-field-value">{{ detail.aliases.map((a) => a.alias).join('、') }}</span>
        </div>
        <a v-if="archiveHref" class="source-link" :href="archiveHref" target="_blank" rel="noopener">打开公开档案页 ↗</a>
      </div>

      <div class="section-head">
        <h2>事实列表</h2>
        <span class="meta-note">共 {{ facts.length }} 条 · 按维度维护</span>
      </div>
      <div v-if="factsLoading" class="empty-block">正在读取实体事实…</div>
      <div v-else-if="!facts.length" class="empty-block">该实体暂无事实记录</div>
      <div v-else class="proto-fact-list">
        <RealFactCard v-for="f in facts" :key="f.id" :fact="f" />
      </div>
    </template>

    <div class="proto-note-box" style="margin-top: 17px">
      主题页是事实组织视图：分类来自系统的一级实体类别，按需动态生成。如果某条新闻只是提到乐清、却与该主题无关，不会被归入其中。
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import ProtoChip from '@/demo/ProtoChip.vue';
import RealFactCard from '@/demo/RealFactCard.vue';
import { categoryApi, entityApi, factApi, type FactItem } from '@/api';
import { publicUrl } from '@/utils/publicUrl';
import type { CategoryNode, EntityDetail, EntityListItem } from '@/types';

/** 每页实体数（主题下实体可能上百：默认只展示第一批，按事实数降序，其余靠「加载更多」或搜索） */
const PAGE_SIZE = 20;
const loading = ref(true);
const loadingMore = ref(false);
const categories = ref<CategoryNode[]>([]);
const entities = ref<EntityListItem[]>([]);
const entityTotal = ref(0);
const topicId = ref<number | null>(null);
const page = ref(1);
/** 实体搜索关键词（在当前主题范围内过滤） */
const q = ref('');

const selectedId = ref<number | null>(null);
const selected = ref<EntityListItem | null>(null);
const detail = ref<EntityDetail | null>(null);
const facts = ref<FactItem[]>([]);
const factsLoading = ref(false);

const factSum = computed(() => entities.value.reduce((n, e) => n + (e.factCount ?? 0), 0));
const hasMore = computed(() => entities.value.length < entityTotal.value);

const topicName = computed(() => categories.value.find((c) => c.id === topicId.value)?.name ?? '—');
const topicDesc = computed(
  () => categories.value.find((c) => c.id === topicId.value)?.description || '该主题下按系统分类动态聚合实体与事实。',
);
const pad = (n: number) => String(n).padStart(2, '0');

const archiveHref = computed(() =>
  selected.value?.datasetCode && selected.value.slug
    ? publicUrl(`/archive/${selected.value.datasetCode}/${selected.value.slug}`)
    : '',
);

/** 事实多的实体排在前面，便于默认选中一个内容充实的实体；关键词在当前主题范围内过滤 */
const listParams = () => ({
  pageSize: PAGE_SIZE,
  categoryId: topicId.value ?? undefined,
  keyword: q.value.trim() || undefined,
  sort: 'factCount' as const,
  order: 'desc' as const,
});

/** 选中实体：拉取实体详情与该实体的现行事实，下方直接渲染（不用抽屉） */
async function selectEntity(e: EntityListItem) {
  selectedId.value = e.id;
  selected.value = e;
  detail.value = null;
  facts.value = [];
  factsLoading.value = true;
  try {
    const [d, f] = await Promise.all([
      entityApi.detail(e.id),
      // 只取现行事实：已被替代/归档的历史版本不显示在事实列表里
      factApi.list({ entityId: e.id, pageSize: 30, activeOnly: true }),
    ]);
    detail.value = d;
    facts.value = f.items;
  } catch {
    detail.value = null;
    facts.value = [];
  } finally {
    factsLoading.value = false;
  }
}

/** 实体列表刷新（topic 切换 / 关键词变化）：重置分页；关键词变化时不清空已选实体，避免下方内容闪掉 */
async function reloadEntities(resetSelection: boolean) {
  if (topicId.value == null) return;
  loading.value = true;
  page.value = 1;
  if (resetSelection) {
    selectedId.value = null;
    selected.value = null;
    detail.value = null;
    facts.value = [];
  }
  try {
    const res = await entityApi.list({ ...listParams(), page: 1 });
    entities.value = res.items;
    entityTotal.value = res.total;
    if (resetSelection) {
      const first = res.items.find((e) => (e.factCount ?? 0) > 0) ?? res.items[0];
      if (first) await selectEntity(first);
    }
  } catch {
    entities.value = [];
    entityTotal.value = 0;
  } finally {
    loading.value = false;
  }
}

const load = () => reloadEntities(true);

async function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const next = page.value + 1;
    const res = await entityApi.list({ ...listParams(), page: next });
    const seen = new Set(entities.value.map((e) => e.id));
    entities.value = [...entities.value, ...res.items.filter((e) => !seen.has(e.id))];
    entityTotal.value = res.total;
    page.value = next;
  } catch {
    // 保留已加载内容，再次点击「加载更多」可重试
  } finally {
    loadingMore.value = false;
  }
}

/** 关键词防抖：输入停下 300ms 后按当前主题范围重新拉第一页 */
let searchTimer: number | undefined;
watch(q, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void reloadEntities(false), 300);
});

watch(topicId, load);

onMounted(async () => {
  try {
    const res = await categoryApi.list({ tree: true });
    categories.value = (res.items as CategoryNode[]).filter((n) => n.parentId === null);
    topicId.value = categories.value[0]?.id ?? null;
  } catch {
    categories.value = [];
  }
});
</script>

<style scoped>
.load-more {
  display: flex;
  justify-content: center;
  padding: 14px 0 4px;
  color: #a4b2be;
  font-size: 12px;
}
/* 主题 tab 下的实体选择行：可点击高亮；不设内部滚动条，靠「加载更多」控制数量 */
.proto-entity-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 15px 16px;
  background: #fff;
  border: 1px solid #e3eaee;
  border-radius: 14px;
}
.proto-entity-pick {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  border: 1px solid #e3eaee;
  border-radius: 999px;
  background: #f6f9f8;
  color: #33525a;
  font-size: 13px;
  cursor: pointer;
  transition: 0.16s;
}
.proto-entity-pick:hover {
  border-color: #b3d0cb;
}
.proto-entity-pick.selected {
  background: #138577;
  border-color: #138577;
  color: #fff;
}
.proto-entity-pick-count {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(19, 133, 119, 0.12);
  color: #138577;
  font-size: 11px;
}
.proto-entity-pick.selected .proto-entity-pick-count {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}
</style>
