<template>
  <section class="page active" aria-label="实时新闻流">
    <div class="page-head">
      <div>
        <p class="eyebrow">EVENT DISTRIBUTION</p>
        <h1>实时新闻流</h1>
        <p>新闻发布即触发 Fast Lane；涉及城市实体的内容同时进入 Fact Lane。以下为生产线已入库的新闻记录。</p>
      </div>
      <span class="page-head-tag">生产记录 {{ total }} 条</span>
    </div>
    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" placeholder="搜索标题、记录 ID、来源..." aria-label="搜索新闻事件" />
      </label>
      <div class="segment">
        <button v-for="f in filters" :key="f.key" :class="{ selected: filter === f.key }" @click="filter = f.key">
          {{ f.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="empty-block">加载中…</div>
    <div v-else-if="!filtered.length" class="empty-block">没有匹配的新闻事件</div>
    <div v-else class="news-list-full">
      <article
        v-for="r in filtered"
        :key="r.id"
        class="news-full-card"
        role="button"
        tabindex="0"
        @click="openRecord(r)"
      >
        <div class="full-time">{{ fmtTime(r.pubDate || r.createdAt) }}</div>
        <div>
          <h3>{{ r.title || '（无标题）' }}</h3>
          <p>{{ r.sourceOrg || '未知来源' }} · 正文 {{ r.bodyChars }} 字 · 阶段 {{ r.stage }}</p>
          <div class="news-full-meta">
            <span class="tag gray">#{{ r.id }}</span>
            <span :class="['tag', fastLaneColor(r.status)]">{{ fastLaneLabel(r.status) }}</span>
            <span v-if="r.stats?.factDrafts" class="tag green">Fact Lane 事实草稿 {{ r.stats.factDrafts }} 条</span>
            <span v-else class="tag gray">Fact Lane 未产出</span>
            <span :class="['tag', statusColor(r.status)]">{{ statusLabel(r.status) }}</span>
            <a v-if="r.articleId" class="tag blue fact-link" :href="`/articles/${r.articleId}`" target="_blank" rel="noopener" @click.stop>事实稿 ↗</a>
          </div>
        </div>
        <span class="full-arrow">↗</span>
      </article>
    </div>

    <div v-if="!loading && records.length" class="load-more">
      <button v-if="hasMore" class="act-btn" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '正在加载更多…' : '加载更多' }} <span class="arw">↓</span>
      </button>
      <span class="load-tip">
        {{ loadingMore ? '正在加载更多…' : `已加载 ${records.length} / ${total} 条` }}
      </span>
      <div ref="sentinel" class="load-sentinel"></div>
    </div>

    <DemoDrawer :open="drawer.open" :eyebrow="drawer.eyebrow" :title="drawer.title" @close="drawer.open = false">
      <div v-if="detailLoading" class="empty-block">正在读取事件明细…</div>
      <div v-else v-html="drawer.html" @click="onDrawerClick"></div>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import { esc } from '@/demo/demoUi';
import {
  categoryApi,
  datasetApi,
  discoveryApi,
  entityApi,
  factApi,
  type ProductionRecord,
  type ReportEntity,
} from '@/api';
import { publicUrl } from '@/utils/publicUrl';
import { formatDateTime } from '@/utils/timeText';

const loading = ref(true);
const detailLoading = ref(false);
const records = ref<ProductionRecord[]>([]);
const total = ref(0);
const q = ref('');
const filter = ref<'all' | 'done' | 'running'>('all');

/** 下拉加载更多：按发布时间倒序分页追加，页大小与首屏一致 */
const PAGE_SIZE = 30;
const page = ref(1);
const loadingMore = ref(false);
const hasMore = computed(() => records.value.length < total.value);
const sentinel = ref<HTMLElement | null>(null);

const filters = [
  { key: 'all' as const, label: '全部新闻' },
  { key: 'done' as const, label: '已完成' },
  { key: 'running' as const, label: '处理中' },
];

/** 时间必须带年份：库里混有 2008/2009 的历史存量新闻；纯日期字段（pubDate）只渲染日期，不带假时刻 */
const fmtTime = (v: string | null) => formatDateTime(v);
const statusLabel = (s: string) =>
  ({ done: '已完成', running: '处理中', pending: '待处理', failed: '失败', skipped: '已跳过' })[s] || s;
const statusColor = (s: string) => ({ done: 'green', running: 'blue', pending: 'orange', failed: 'orange' })[s] || 'gray';
/** Fast Lane 分发状态按记录真实 status 推断，而非固定文案 */
const fastLaneLabel = (s: string) =>
  ({ done: 'Fast Lane 已分发', running: 'Fast Lane 处理中', pending: 'Fast Lane 待处理', failed: 'Fast Lane 分发失败', skipped: 'Fast Lane 已跳过' })[s] ||
  'Fast Lane 待处理';
const fastLaneColor = (s: string) => ({ done: 'blue', running: 'blue', pending: 'gray', failed: 'orange', skipped: 'gray' })[s] || 'gray';

/** 抽屉 HTML 片段渲染：统一标签 */
const tag = (t: string | number, color = 'gray') => `<span class="tag ${color}">${esc(t)}</span>`;
/** 实体发布状态 → 中文标签 */
const ENTITY_STATUS: Record<string, [string, string]> = {
  published: ['已发布 published', 'green'],
  draft: ['草稿 draft', 'orange'],
  archived: ['已归档 archived', 'gray'],
};
/** 事实状态 → 中文标签（对齐原型 statusTag） */
const FACT_STATUS: Record<string, [string, string]> = {
  active: ['有效 active', 'green'],
  superseded: ['已替代 superseded', 'gray'],
  expired: ['已过期 expired', 'orange'],
  uncertain: ['待核实 uncertain', 'orange'],
  disputed: ['存疑 disputed', 'orange'],
  retired: ['已退役 retired', 'gray'],
};
const factStatusTag = (s: string) => tag(...(FACT_STATUS[s] ?? [s, 'gray'] as [string, string]));

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  return records.value.filter((r) => {
    const hitKw = !kw || `${r.title ?? ''}${r.id}${r.sourceOrg ?? ''}`.toLowerCase().includes(kw);
    const hitF =
      filter.value === 'all' ||
      (filter.value === 'done' && r.status === 'done') ||
      (filter.value === 'running' && r.status !== 'done' && r.status !== 'skipped');
    return hitKw && hitF;
  });
});

const drawer = reactive({ open: false, eyebrow: '', title: '', html: '' });
const currentRecord = ref<ProductionRecord | null>(null);
const newsHtml = ref('');
const linkedEntities = ref<ReportEntity[]>([]);

async function openRecord(r: ProductionRecord) {
  currentRecord.value = r;
  drawer.eyebrow = 'NEWS EVENT / TRACE';
  drawer.title = r.title || `记录 #${r.id}`;
  drawer.html = '';
  drawer.open = true;
  detailLoading.value = true;
  try {
    const d = await discoveryApi.record(r.id);
    const rep = d.report;
    const entities = rep?.entities ?? [];
    linkedEntities.value = entities;
    const facts = rep?.facts ?? [];
    const relations = rep?.relations ?? [];
    drawer.html = `
      <div class="drawer-stat">
        <span class="tag gray">#${esc(r.id)}</span>
        <span class="tag blue">${esc(d.stage)}</span>
        <span class="tag ${statusColor(d.status)}">${esc(statusLabel(d.status))}</span>
      </div>
      <p class="drawer-desc">${esc(d.sourceOrg || '未知来源')} · ${d.pubDate ? esc(new Date(d.pubDate).toLocaleDateString('zh-CN')) : '无发布日期'} · 正文 ${esc(d.bodyChars)} 字</p>
      ${
        rep?.article?.bodyPreview
          ? `<div class="drawer-subhead">正文预览</div><div class="evidence-card"><p>${esc(rep.article.bodyPreview).slice(0, 600)}…</p></div>`
          : ''
      }
      <div class="drawer-subhead">事件流转轨迹</div>
      <div class="trace-step"><strong>新闻入库</strong>生产线接收文章并落库<small>记录 ID: ${esc(r.id)}</small></div>
      <div class="trace-step"><strong>Fast Lane · 快速分发</strong>新闻原文进入站点与 Feed 通道<small>收录结果为外部检测项，此处不宣称已收录</small></div>
      <div class="trace-step"><strong>Fact Lane · 抽取结果</strong>实体 ${entities.length} · 事实 ${facts.length} · 事件 ${(rep?.events ?? []).length} · 关系 ${relations.length}<small>LLM 调用 ${esc(d.calls.total)} 次 / 错误 ${esc(d.calls.errors)} 次</small></div>
      ${
        entities.length
          ? `<div class="drawer-subhead">识别到的实体</div>${entities
              .slice(0, 6)
              .map((e) => `<div class="drawer-fact"><h4>${esc(e.name)}</h4><p>${esc(e.description || e.type)}</p><div class="drawer-fact-meta"><span class="tag gray">${esc(e.type)}</span><span class="tag blue">模型置信度（非可信度）${esc(String(e.confidence ?? '—'))}</span></div></div>`)
              .join('')}`
          : ''
      }
      <div class="drawer-subhead">业务边界</div>
      <div class="fact-route">新闻进入 Fast Lane，不表示该新闻全部陈述已经被确认为可发布的城市事实。Facts 发布必须通过独立审核门禁。</div>
      ${entities.length ? `<div class="drawer-actions sep"><button class="act-btn primary" data-open-entities="1">查看关联城市实体 <span class="arw">↗</span></button></div>` : ''}`;
    newsHtml.value = drawer.html;
  } catch {
    drawer.html = '<div class="empty-block">事件明细读取失败</div>';
    newsHtml.value = drawer.html;
  } finally {
    detailLoading.value = false;
  }
}

/** 抽屉内 HTML 用事件委托绑定按钮（v-html 内的 @click 不生效） */
function onDrawerClick(ev: MouseEvent) {
  const el = (ev.target as HTMLElement).closest(
    '[data-open-entities],[data-open-entity],[data-back-news],[data-back-entities]',
  ) as HTMLElement | null;
  if (!el) return;
  const ds = el.dataset;
  if (ds.openEntities) openEntityList();
  else if (ds.openEntity) void openEntityDetail(Number(ds.openEntity));
  else if (ds.backEntities) openEntityList();
  else if (ds.backNews) backToNews();
}

/** 本条新闻关联的城市实体清单 */
function openEntityList() {
  if (!linkedEntities.value.length) return;
  drawer.eyebrow = 'FACT REGISTRY / ENTITY';
  drawer.title = `关联城市实体 · ${linkedEntities.value.length} 个`;
  drawer.html =
    linkedEntities.value
      .map((e) => {
        const eid = e.createdEntityId ?? e.matchedEntityId ?? null;
        return `<div class="drawer-fact">
            <h4>${esc(e.name)}</h4>
            <p>${esc(e.description || e.type || '')}</p>
            <div class="drawer-fact-meta">
              <span class="tag gray">${esc(e.type || '实体')}</span>
              <span class="tag blue">模型置信度（非可信度）${esc(String(e.confidence ?? '—'))}</span>
            </div>
            ${eid ? `<div class="drawer-actions tight"><button class="act-chip" data-open-entity="${eid}">查看档案 <span class="arw">↗</span></button></div>` : '<span class="tag gray">本稿未入库</span>'}
          </div>`;
      })
      .join('') +
    `<div class="drawer-actions sep"><button class="act-btn" data-back-news="1"><span class="arw">←</span> 返回新闻详情</button></div>`;
}

/** 单实体档案（GET /entities/:id + 事实清单 + 分类/语料域），结构对齐原型 entityDetail */
async function openEntityDetail(id: number) {
  drawer.eyebrow = 'FACT REGISTRY / ENTITY';
  drawer.title = '实体档案';
  drawer.html = '<div class="empty-block">正在读取实体档案…</div>';
  try {
    const d = await entityApi.detail(id);
    const [factsRes, category, dataset] = await Promise.all([
      factApi.list({ entityId: id, pageSize: 20 }),
      d.categoryId ? categoryApi.get(d.categoryId).catch(() => null) : Promise.resolve(null),
      d.originDatasetId ? datasetApi.get(d.originDatasetId).catch(() => null) : Promise.resolve(null),
    ]);
    const facts = factsRes.items ?? [];
    const [estLabel, estColor] = ENTITY_STATUS[d.status] ?? [d.status, 'gray'];
    const archiveHref =
      dataset?.code && d.slug
        ? publicUrl(`/archive/${encodeURIComponent(dataset.code)}/${encodeURIComponent(d.slug)}`)
        : '';
    drawer.title = d.name;
    drawer.html = `
      <div class="drawer-stat">
        ${tag(d.urn)}
        ${category ? tag(category.name, 'blue') : ''}
        ${tag(estLabel, estColor)}
      </div>
      ${d.lede ? `<p class="drawer-desc">${esc(d.lede)}</p>` : ''}
      <div class="drawer-subhead">实体事实 · ${factsRes.total} 条${facts.length < factsRes.total ? `（展示前 ${facts.length} 条）` : ''}</div>
      ${
        facts.length
          ? facts
              .map((f) => {
                const ev = f.evidences?.[0];
                return `<div class="drawer-fact">
                  <h4>${esc(f.dimension)}</h4>
                  <p>${esc(f.statement)}</p>
                  <div class="drawer-fact-meta">${factStatusTag(f.status)}${ev?.publishedAt ? tag(String(ev.publishedAt).slice(0, 10), 'gray') : ''}</div>
                  ${ev ? `<small class="source-link">${esc(ev.materialTitle || ev.sourceOrg || '来源证据')}</small>` : ''}
                  <small style="color:#90a2ae">${esc(f.code ?? `#${f.id}`)}</small>
                </div>`;
              })
              .join('')
          : '<div class="empty-block">该实体暂无已发布事实</div>'
      }
      <div class="drawer-subhead">原系统参考</div>
      ${
        archiveHref
          ? `<a class="source-link" target="_blank" rel="noopener" href="${archiveHref}">打开原事实发布页（含证据链） ↗</a>`
          : '<span class="tag gray">暂无公开事实页</span>'
      }
      <div class="fact-route">事实页均来自生产事实库，逐条附原文证据与核验锚点。</div>
      <div class="drawer-actions sep">
        <button class="act-btn" data-back-entities="1"><span class="arw">←</span> 返回实体列表</button>
        <button class="act-btn" data-back-news="1"><span class="arw">←</span> 返回新闻详情</button>
      </div>`;
  } catch {
    drawer.html =
      '<div class="empty-block">实体档案读取失败</div><div class="drawer-actions sep"><button class="act-btn" data-back-entities="1"><span class="arw">←</span> 返回实体列表</button></div>';
  }
}

/** 回到新闻详情视图 */
function backToNews() {
  drawer.eyebrow = 'NEWS EVENT / TRACE';
  drawer.title = currentRecord.value?.title || '新闻详情';
  drawer.html = newsHtml.value;
}

/**
 * 取一页记录。append=false 用于首屏（替换），true 用于下拉加载（追加）。
 * 一律按新闻发布时间倒序：库里混有 2008/2009 存量稿，按处理先后取会把老稿带进首屏。
 */
async function load(p: number, append: boolean) {
  if (append) {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;
  } else {
    loading.value = true;
  }
  try {
    const res = await discoveryApi.records({ page: p, pageSize: PAGE_SIZE, orderBy: 'pubDate' });
    records.value = append ? [...records.value, ...res.items] : res.items;
    total.value = res.total;
    page.value = res.page || p;
  } catch {
    if (!append) records.value = [];
  } finally {
    loading.value = false;
    loadingMore.value = false;
    await nextTick();
    autoLoad();
  }
}

const loadMore = () => void load(page.value + 1, true);

/** 首屏内容不足一屏时哨兵会一直可见，IntersectionObserver 不再回调，需在每次加载后补判一次 */
function autoLoad() {
  const el = sentinel.value;
  if (!el || loadingMore.value || loading.value || !hasMore.value) return;
  if (el.getBoundingClientRect().top <= window.innerHeight + 200) loadMore();
}

let io: IntersectionObserver | null = null;
watch(
  sentinel,
  (el) => {
    io?.disconnect();
    io = null;
    if (!el) return;
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
  },
  { flush: 'post' },
);

onMounted(() => void load(1, false));

onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});
</script>

<style scoped>
.load-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 24px 0 4px;
}
.load-tip {
  color: #8b9fab;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.load-sentinel {
  width: 100%;
  height: 1px;
}
.news-full-meta .fact-link {
  cursor: pointer;
  text-decoration: none;
}
.news-full-meta .fact-link:hover {
  filter: brightness(0.9);
}
</style>
