<template>
  <section class="page active" aria-label="城市事实目录">
    <div class="page-head">
      <div>
        <p class="eyebrow">CITY FACT REGISTRY</p>
        <h1>城市事实目录</h1>
        <p>统一实体 ID、事实状态、时间版本与证据链，为外部知识服务提供稳定锚点。</p>
      </div>
      <span class="page-head-tag">{{ total }} 个实体 · 实时读取</span>
    </div>
    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" placeholder="搜索城市实体、类别或 ID..." aria-label="搜索城市事实" />
      </label>
      <div class="segment">
        <button :class="{ selected: filter === 0 }" @click="filter = 0">全部类别</button>
        <button v-for="c in categories" :key="c.id" :class="{ selected: filter === c.id }" @click="filter = c.id">
          {{ c.name }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="empty-block">加载中…</div>
    <div v-else-if="!entities.length" class="empty-block">当前筛选没有实体</div>
    <template v-else>
      <div class="entity-grid">
        <button v-for="(e, i) in entities" :key="e.id" class="entity-card" @click="openEntity(e)">
          <span class="entity-index">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="entity-type">{{ rootName(e.categoryId) }}</span>
          <h3>{{ e.name }}</h3>
          <p>事实 {{ e.factCount ?? 0 }} 条 · 状态 {{ e.status }} · 修订 v{{ e.revision }}</p>
          <div class="entity-bottom">
            <span>{{ e.urn }}</span>
            <b>查看事实 ↗</b>
          </div>
        </button>
      </div>
      <div class="load-more">
        <span v-if="loadingMore">正在加载更多…</span>
        <span v-else-if="hasMore">下拉自动加载更多（已加载 {{ entities.length }} / {{ total }}）</span>
        <span v-else>已加载全部 {{ total }} 个实体</span>
      </div>
    </template>

    <DemoDrawer :open="drawer.open" :eyebrow="drawer.eyebrow" :title="drawer.title" @close="drawer.open = false">
      <div v-if="detailLoading" class="empty-block">正在读取实体档案…</div>
      <div v-else v-html="drawer.html"></div>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import { esc } from '@/demo/demoUi';
import { categoryApi, entityApi, factApi } from '@/api';
import { publicUrl } from '@/utils/publicUrl';
import type { CategoryNode, EntityListItem } from '@/types';

const PAGE_SIZE = 30;
const loading = ref(true);
const loadingMore = ref(false);
const detailLoading = ref(false);
const entities = ref<EntityListItem[]>([]);
const categories = ref<CategoryNode[]>([]);
const total = ref(0);
const q = ref('');
const filter = ref(0);
const page = ref(1);
/** 已加载条数 < 总数，说明还有下一页 */
const hasMore = computed(() => entities.value.length < total.value);

// 任意分类 id -> 其一级分类名称（用于卡片展示）
const rootNameById = new Map<number, string>();
const rootName = (categoryId: number | null | undefined) =>
  (categoryId != null ? rootNameById.get(categoryId) : undefined) || '未分类';

const drawer = reactive({ open: false, eyebrow: '', title: '', html: '' });

/** 列表查询参数（首次与翻页共用） */
const listParams = () => ({
  pageSize: PAGE_SIZE,
  keyword: q.value.trim() || undefined,
  categoryId: filter.value || undefined,
});

/** 首次进入 / 筛选变化：回到第 1 页并替换列表 */
const load = async () => {
  loading.value = true;
  page.value = 1;
  try {
    const res = await entityApi.list({ ...listParams(), page: 1 });
    entities.value = res.items;
    total.value = res.total;
  } catch {
    entities.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
};

/** 下拉加载下一页，追加到列表末尾 */
const loadMore = async () => {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const next = page.value + 1;
    const res = await entityApi.list({ ...listParams(), page: next });
    const seen = new Set(entities.value.map((e) => e.id));
    entities.value = [...entities.value, ...res.items.filter((e) => !seen.has(e.id))];
    total.value = res.total;
    page.value = next;
  } catch {
    // 加载失败保留已加载内容，再次滚动可重试
  } finally {
    loadingMore.value = false;
  }
};

/** 滚动到接近底部时自动加载下一页 */
const onScroll = () => {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  const doc = document.documentElement;
  if (window.innerHeight + window.scrollY >= doc.scrollHeight - 400) void loadMore();
};

let timer: number | undefined;
watch(q, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(load, 300);
});
watch(filter, load);

const statusLabel = (s: string) => ({ published: '已发布', draft: '草稿', archived: '已归档' })[s] || s;

async function openEntity(e: EntityListItem) {
  drawer.eyebrow = 'FACT REGISTRY / ENTITY';
  drawer.title = e.name;
  drawer.html = '';
  drawer.open = true;
  detailLoading.value = true;
  try {
    const [detail, factRes] = await Promise.all([
      entityApi.detail(e.id),
      factApi.list({ entityId: e.id, pageSize: 20 }),
    ]);
    const facts = factRes.items;
    const archiveUrl = e.datasetCode && e.slug ? publicUrl(`/archive/${e.datasetCode}/${e.slug}`) : '';
    drawer.html = `
      <div class="drawer-stat">
        <span class="tag gray">${esc(e.urn)}</span>
        <span class="tag blue">${esc(e.datasetName || '—')}</span>
        <span class="tag ${e.status === 'published' ? 'green' : 'orange'}">${esc(statusLabel(e.status))}</span>
      </div>
      <p class="drawer-desc">${esc(detail.lede || '（暂无实体简介）')}</p>
      <div class="drawer-subhead">实体事实 · 共 ${facts.length} 条</div>
      ${
        facts.length
          ? facts
              .map(
                (f) => `<div class="drawer-fact"><h4>${esc(f.dimension)}</h4><p>${esc(f.statement)}</p>
                  <div class="drawer-fact-meta"><span class="tag ${factStatusColor(f.status)}">${esc(f.status)}</span><span class="tag gray">v${esc(f.version)}</span><span class="tag gray">模型置信度（非可信度）${esc(f.confidence)}</span></div>
                  ${f.evidences?.[0]?.quote ? `<small class="source-link">${esc(f.evidences[0].quote).slice(0, 160)}</small>` : ''}</div>`,
              )
              .join('')
          : '<div class="empty-block">该实体暂无事实记录</div>'
      }
      <div class="drawer-subhead">别名</div>
      <div class="drawer-fact-meta">${(detail.aliases || []).map((a) => `<span class="tag gray">${esc(a.alias)}</span>`).join('') || '<span class="tag gray">无</span>'}</div>
      ${archiveUrl ? `<div class="drawer-subhead">公开档案页</div><a class="source-link" target="_blank" rel="noopener" href="${esc(archiveUrl)}">打开档案页 ↗</a>` : ''}
      <div class="fact-route">实体为全局唯一，不属于语料域；仅通过首次来源语料域记录溯源。</div>`;
  } catch {
    drawer.html = '<div class="empty-block">实体档案读取失败</div>';
  } finally {
    detailLoading.value = false;
  }
}

const factStatusColor = (s: string) =>
  ({ active: 'green', review: 'orange', superseded: 'gray', disputed: 'orange', retired: 'gray' })[s] || 'gray';

onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true });
  try {
    const res = await categoryApi.list({ tree: true });
    const nodes = res.items as CategoryNode[];
    // 仅取一级分类作为筛选项
    categories.value = nodes.filter((n) => n.parentId === null);
    // 建立 任意分类 id -> 一级分类名称 的映射
    const walk = (node: CategoryNode, topName: string) => {
      rootNameById.set(node.id, topName);
      (node.children ?? []).forEach((child) => walk(child, topName));
    };
    nodes.forEach((n) => walk(n, n.name));
  } catch {
    categories.value = [];
  }
  await load();
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
});
</script>

<style scoped>
.load-more {
  display: flex;
  justify-content: center;
  padding: 18px 0 4px;
  color: #a4b2be;
  font-size: 12px;
}
</style>
