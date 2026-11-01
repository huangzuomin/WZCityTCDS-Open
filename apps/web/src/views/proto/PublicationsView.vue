<template>
  <section class="page active" aria-label="事实发布记录">
    <div class="page-head">
      <div>
        <p class="eyebrow">PUBLIC RECORDS / 来源入库记录</p>
        <h1>事实发布记录</h1>
        <p>每次签发形成独立公开记录；一次发布可以包含新增事实、对既有事实的更正，以及相关的证据和编辑责任。</p>
      </div>
      <span class="page-head-tag">实时读取 · 只读</span>
    </div>

    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" placeholder="搜索文章标题或来源机构..." aria-label="搜索发布记录" />
      </label>
    </div>

    <div class="proto-layout-side">
      <div>
        <div class="panel">
          <div v-if="loading" class="empty-block">加载中…</div>
          <div v-else-if="!groups.length" class="empty-block">没有符合条件的发布记录</div>
          <template v-else>
            <article
              v-for="g in groups"
              :key="g.key"
              class="proto-pub-item proto-clickable"
              @click="open(g)"
            >
              <div class="proto-pub-head">
                <span class="proto-time">{{ dateText(g.date) }}</span>
                <span class="proto-tagrow">
                  <ProtoChip v-if="g.counts.new" :text="`新增 ${g.counts.new}`" kind="blue" />
                  <ProtoChip v-if="g.counts.update" :text="`更新 ${g.counts.update}`" kind="warn" />
                  <ProtoChip v-if="g.counts.corroborate" :text="`佐证 ${g.counts.corroborate}`" kind="knowledge" />
                  <ProtoChip v-if="g.counts.retire" :text="`退役 ${g.counts.retire}`" kind="note" />
                </span>
              </div>
              <h3>{{ g.title }}</h3>
              <div class="proto-pub-meta">
                <span>来源 · {{ g.source || '—' }}</span>
                <span>涉及事实 {{ g.items.length }} 条</span>
              </div>
              <div class="proto-pub-foot">
                <span class="proto-small proto-muted">入库 {{ dateText(g.createdAt) }}</span>
                <button class="link-btn" type="button" @click.stop="open(g)">查看明细 ↗</button>
              </div>
            </article>
          </template>
        </div>

        <div class="proto-load-more">
          <span v-if="loadingMore">正在加载更多…</span>
          <button
            v-else-if="hasMore"
            class="small-btn"
            type="button"
            :disabled="loading"
            @click="loadMore"
          >
            加载更多（已加载 {{ loadedCount }} / {{ total }} 条发布记录）
          </button>
          <span v-else-if="loadedCount">已加载全部 {{ total }} 条发布记录</span>
        </div>
        <p v-if="error" class="helper">{{ error }}</p>
      </div>

      <aside>
        <div class="panel proto-aside-card">
          <p class="eyebrow">WHY PUBLICATION?</p>
          <h3>发布记录不是文章，也不是实体页</h3>
          <p>新闻是来源之一；事实是被维护的知识对象；发布记录说明编辑部这一次向社会公开了什么、基于何种证据、如何承担更正责任。</p>
          <div class="proto-divider"></div>
          <div v-for="s in SOURCES" :key="s.b" class="proto-source-row">
            <span class="proto-source-dot"></span>
            <div>
              <b class="proto-small">{{ s.b }}</b>
              <p>{{ s.p }}</p>
            </div>
          </div>
          <div class="proto-note-box" style="margin-top: 14px">{{ HONEST_NOTE }}</div>
        </div>
      </aside>
    </div>

    <DemoDrawer :open="drawer.open" :eyebrow="drawer.eyebrow" :title="drawer.title" @close="drawer.open = false">
      <template v-if="drawer.group">
        <div class="proto-field">
          <span class="proto-field-name">原文链接</span>
          <span class="proto-field-value">
            <a
              v-if="drawer.group.url"
              class="source-link"
              :href="drawer.group.url"
              target="_blank"
              rel="noopener"
            >{{ drawer.group.url }}</a>
            <span v-else>该记录未关联来源文章网址</span>
          </span>
        </div>
        <div class="proto-field"><span class="proto-field-name">来源</span><span class="proto-field-value">{{ drawer.group.source || '—' }}</span></div>
        <div class="proto-field"><span class="proto-field-name">入库时间</span><span class="proto-field-value">{{ dateTimeText(drawer.group.createdAt) }}</span></div>
        <div class="proto-field"><span class="proto-field-name">涉及事实</span><span class="proto-field-value">{{ drawer.group.items.length }} 条</span></div>

        <div class="drawer-subhead">逐条事实变更明细</div>
        <div v-for="c in drawer.group.items" :key="c.id" class="drawer-fact">
          <h4>
            <a
              v-if="archiveHref(c)"
              class="proto-entity-link"
              :href="archiveHref(c)"
              target="_blank"
              rel="noopener"
            >{{ c.entityName }} ↗</a>
            <span v-else>{{ c.entityName }}</span>
          </h4>
          <div class="proto-tagrow" style="margin-bottom: 8px">
            <ProtoChip :text="typeLabel(c.changeType)" :kind="typeKind(c.changeType)" />
            <span v-if="c.toDimension" class="tag gray">{{ c.toDimension }}</span>
          </div>
          <p>{{ c.toStatement || c.summary || '（无结构化陈述）' }}</p>
        </div>
      </template>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import ProtoChip from '@/demo/ProtoChip.vue';
import { changesApi, type FactChangeRow, type PublicationGroup } from '@/api';
import { publicUrl } from '@/utils/publicUrl';

/** 每页发布记录（文章）数：分页单位与展示单位一致，对齐实时新闻流的做法 */
const PAGE_SIZE = 20;

const HONEST_NOTE =
  '本页按 change_type 近似归集：update ≈ 口径 / 现实变化，corroborate ≈ 认知 / 证据更新。系统当前尚未拆分“现实变化 / 认知更新”双轴，此处归集为近似口径。';

const SOURCES = [
  { b: '稳定地址', p: '可以引用一次签发，不因日后修改事实而失去历史记录。' },
  { b: '签发边界', p: '明确签发了哪些内容，哪些尚未完成核验。' },
  { b: '可机器读取', p: 'HTML 是公共入口，JSON 是同一条发布记录的结构化表示。' },
];

const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
/** 后端已按文章分好组的发布记录；分页单位是文章，不是变更条数 */
const rawGroups = ref<PublicationGroup[]>([]);
const total = ref(0);
const page = ref(1);
const q = ref('');
const loadedCount = computed(() => rawGroups.value.length);

interface Counts {
  new: number;
  update: number;
  corroborate: number;
  retire: number;
}

interface PubGroup {
  key: string;
  title: string;
  url: string | null;
  source: string;
  date: string | null;
  createdAt: string | null;
  counts: Counts;
  items: FactChangeRow[];
}

/**
 * 一条“发布记录”= 一篇文章入库后产生的一批事实变更。
 * 分组由后端完成（/api/changes?groupBy=article），这里只做展示映射和本地关键词过滤。
 */
const groups = computed<PubGroup[]>(() => {
  const list = (rawGroups.value ?? []).map((g) => {
    const counts: Counts = { new: 0, update: 0, corroborate: 0, retire: 0 };
    for (const c of g.items) counts[c.changeType] += 1;
    const first = g.items[0];
    return {
      key: g.key,
      title: g.articleTitle || `未命名来源 · 变更 #${first?.id ?? g.key}`,
      url: g.articleUrl,
      // 来源机构（温州日报等），与实时新闻流的 sourceOrg 展示口径一致
      source: g.sourceOrg || first?.sourceOrg || '未知来源',
      date: first?.occurredAt || g.createdAt,
      createdAt: g.createdAt,
      counts,
      items: g.items,
    };
  });
  const kw = q.value.trim().toLowerCase();
  return kw ? list.filter((g) => `${g.title} ${g.source}`.toLowerCase().includes(kw)) : list;
});

const hasMore = computed(() => rawGroups.value.length < total.value);

const dateText = (v: string | null) => (v ? new Date(v).toLocaleDateString('zh-CN') : '—');
const dateTimeText = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');

type ChipKind = 'world' | 'knowledge' | 'warn' | 'blue' | 'note' | 'outline';
const typeLabel = (t: string) => ({ new: '新增', update: '更新', corroborate: '佐证', retire: '退役' })[t] || t;
const typeKind = (t: string): ChipKind =>
  ({ new: 'blue', update: 'warn', corroborate: 'knowledge', retire: 'note' } as Record<string, ChipKind>)[t] ?? 'note';

const archiveHref = (c: FactChangeRow) =>
  c.datasetCode && c.entitySlug ? publicUrl(`/archive/${c.datasetCode}/${c.entitySlug}`) : '';

const drawer = reactive({
  open: false,
  eyebrow: 'PUBLICATION / 来源入库记录',
  title: '',
  group: null as PubGroup | null,
});

function open(g: PubGroup) {
  drawer.group = g;
  drawer.title = g.title;
  drawer.open = true;
}

async function loadFirst() {
  loading.value = true;
  error.value = '';
  try {
    // 按发布记录分页：pageSize 是文章数，total 也是文章数
    const res = await changesApi.publications({ page: 1, pageSize: PAGE_SIZE });
    // 接口是聚合分组出口；字段缺失（如后端未部署到支持 groupBy=article 的版本）时降级为空列表，
    // 否则 rawGroups 会被赋成 undefined 并让渲染直接抛错
    rawGroups.value = res.groups ?? [];
    total.value = res.total ?? 0;
    page.value = 1;
  } catch {
    rawGroups.value = [];
    total.value = 0;
    error.value = '数据加载失败，请稍后重试。';
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  error.value = '';
  try {
    const next = page.value + 1;
    const res = await changesApi.publications({ page: next, pageSize: PAGE_SIZE });
    const incoming = res.groups ?? [];
    // 按分组键去重，避免翻页期间有新变更插入导致同一篇重复出现
    const seen = new Set(rawGroups.value.map((g) => g.key));
    rawGroups.value = [...rawGroups.value, ...incoming.filter((g) => !seen.has(g.key))];
    total.value = res.total ?? 0;
    page.value = next;
  } catch {
    error.value = '加载更多失败，可重试。';
  } finally {
    loadingMore.value = false;
  }
}

const onScroll = () => {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  const doc = document.documentElement;
  if (window.innerHeight + window.scrollY >= doc.scrollHeight - 500) void loadMore();
};

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true });
  void loadFirst();
});

onBeforeUnmount(() => window.removeEventListener('scroll', onScroll));
</script>
