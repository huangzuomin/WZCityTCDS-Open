<template>
  <section class="page active" aria-label="事实变更">
    <div class="page-head">
      <div>
        <p class="eyebrow">FACT CHANGE TRACKER</p>
        <h1>事实变更</h1>
        <p>记录每次抽取对城市事实的影响，区分新增、更新、佐证与退役，并保留旧口径到新主张的完整轨迹。</p>
      </div>
    </div>
    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" placeholder="搜索变更内容或实体名称..." aria-label="搜索事实变更" />
      </label>
      <div class="segment">
        <button v-for="f in filters" :key="f.key" :class="{ selected: filter === f.key }" @click="filter = f.key">
          {{ f.label }}
        </button>
      </div>
    </div>

    <div class="panel table-panel">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>事实 / 事实编号</th><th>影响实体</th><th>变更类型</th><th>状态</th><th>发生时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="6"><div class="empty-block">加载中…</div></td></tr>
            <tr v-else-if="!rows.length"><td colspan="6"><div class="empty-block">没有匹配的事实变更</div></td></tr>
            <template v-else>
              <tr v-for="c in rows" :key="c.id">
                <td>
                  <strong>{{ c.factStatement || c.summary || `变更 #${c.id}` }}</strong>
                  <span class="table-sub">{{ factCodeText(c) }}</span>
                </td>
                <td>
                  {{ c.entityName }}
                  <div class="table-sub">{{ c.datasetCode || '全局实体' }} · #{{ c.entityId }}</div>
                </td>
                <td><span :class="['tag', typeColor(c.changeType)]">{{ typeLabel(c.changeType) }}</span></td>
                <td><span :class="['tag', stateColor(c.changeType)]">{{ stateLabel(c.changeType) }}</span></td>
                <td>{{ dateText(c.occurredAt || c.createdAt) }}</td>
                <td><button class="table-link" @click="openChange(c)">查看详情 ↗</button></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div class="table-foot">
        <span class="table-sub">共 {{ total }} 条变更</span>
        <div class="pager">
          <button class="small-btn" :disabled="page <= 1 || loading" @click="go(page - 1)">← 上一页</button>
          <span class="table-sub">{{ page }} / {{ maxPage }}</span>
          <button class="small-btn" :disabled="page >= maxPage || loading" @click="go(page + 1)">下一页 →</button>
        </div>
      </div>
    </div>

    <DemoDrawer :open="drawer.open" :eyebrow="drawer.eyebrow" :title="drawer.title" @close="drawer.open = false">
      <div v-html="drawer.html"></div>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import { esc } from '@/demo/demoUi';
import { changesApi, type FactChangeRow } from '@/api';
import { publicUrl } from '@/utils/publicUrl';
import { formatDateTime } from '@/utils/timeText';

const loading = ref(true);
const rows = ref<FactChangeRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 50;
const q = ref('');
const filter = ref<'all' | 'new' | 'update' | 'corroborate' | 'retire'>('all');

const filters = [
  { key: 'all' as const, label: '全部' },
  { key: 'new' as const, label: '新增' },
  { key: 'update' as const, label: '更新' },
  { key: 'corroborate' as const, label: '佐证' },
  { key: 'retire' as const, label: '退役' },
];

const typeLabel = (t: string) =>
  ({ new: 'New 新增', update: 'Update 更新', corroborate: 'Corroborate 佐证', retire: 'Retire 退役' })[t] || t;
const typeColor = (t: string) =>
  ({ new: 'purple', update: 'blue', corroborate: 'green', retire: 'gray' })[t] || 'gray';
/** 本条变更生效后的事实状态：退役后不再现行，其余类型仍为现行 */
const stateLabel = (t: string) => (t === 'retire' ? '已退役' : '已生效');
const stateColor = (t: string) => (t === 'retire' ? 'gray' : 'green');

/** 纯日期字段（occurred_at）只渲染日期，带时刻字段（created_at）仍显示时刻 */
const dateText = (v: string | null) => formatDateTime(v);

/** 事实编号：优先用本条指向的事实（退役取被退役的那条），退回 id，再退回（无编号） */
const factCodeText = (c: FactChangeRow) =>
  c.factCode || (c.toFactId || c.fromFactId ? `#${c.toFactId ?? c.fromFactId}` : '（无编号）');

const maxPage = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

const drawer = reactive({ open: false, eyebrow: '', title: '', html: '' });

/**
 * 抽屉文案按变更类型分别生成：
 * 佐证类（corroborate）没有"旧版本 → 新版本"这回事（同一口径被更多来源支持，不产生新版本），
 * 沿用统一模板会写出"无历史口径，本项为新增"这种自相矛盾的说明；
 * 同理 rationale 里的历史模板文本（讲的是别的结论）不再对外展示。
 */
const TYPE_COPY: Record<
  string,
  { label: string; cls: string; beforeLabel: string; afterLabel: string; effect: string }
> = {
  new: {
    label: 'New 新增',
    cls: 'purple',
    beforeLabel: '旧状态 / 历史口径',
    afterLabel: '新主张 / 当前口径',
    effect: '新增一条此前库中没有的事实；若旧口径为空，表示此前没有同口径记录。',
  },
  update: {
    label: 'Update 更新',
    cls: 'blue',
    beforeLabel: '此前口径（已被替代，仅留痕备查）',
    afterLabel: '新主张 / 当前口径',
    effect: '同一维度出现新表述，取代旧版本；旧版本不删除、保留备查。',
  },
  corroborate: {
    label: 'Corroborate 佐证',
    cls: 'green',
    beforeLabel: '现行口径（未发生变化）',
    afterLabel: '本次佐证',
    effect: '同一口径再次被另一篇来源支持：来源计数 +1、刷新核验时间，不产生新版本。',
  },
  retire: {
    label: 'Retire 退役',
    cls: 'gray',
    beforeLabel: '被退役的口径',
    afterLabel: '（无新口径）',
    effect: '该事实不再计为现行，保留备查。退役不产生新口径。',
  },
};
const copyOf = (t: string) =>
  TYPE_COPY[t] ?? {
    label: t,
    cls: 'gray',
    beforeLabel: '旧状态 / 历史口径',
    afterLabel: '新主张 / 当前口径',
    effect: '该变更的发生过程与结果说明见下方内容。',
  };

function openChange(c: FactChangeRow) {
  const archiveHref = c.datasetCode && c.entitySlug ? publicUrl(`/archive/${c.datasetCode}/${c.entitySlug}`) : '';
  const t = String(c.changeType ?? '');
  const cp = copyOf(t);
  const stmt = c.factStatement || c.summary || '';
  const isRetire = t === 'retire';
  const isCorroborate = t === 'corroborate';
  const beforeText = c.fromStatement || (isCorroborate ? stmt : '（无历史口径）');
  // 佐证没有「旧版本 → 新版本」（from_fact_id 恒为 NULL），沿用统一模板会让两侧显示同一句话。
  // 右侧「本次佐证」改为展示本次新增来源的原文引句 + 文章标题 + 日期，并补一行来源计数。
  const corrQuote = (c.corroborateQuote ?? '').trim();
  const corrSource = [
    c.articleTitle || '（无来源文章）',
    formatDateTime(c.occurredAt || c.createdAt),
    typeof c.corroborateCount === 'number' ? `来源计数 ${c.corroborateCount}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // 新增/更新/佐证取 to 侧陈述；退役没有新版本，新口径一栏本就应为空
  const afterText = isRetire
    ? '（无新口径）'
    : isCorroborate
      ? // 取不到引句时回退到原有「本次佐证」文案（陈述本身），不渲染 undefined / 空标签
        esc(corrQuote || stmt || '（无陈述）') +
        (c.toDimension ? `　（维度：${esc(c.toDimension)}）` : '') +
        `<small style="display:block;margin-top:6px;color:#8b9fab">本次新增来源：${esc(corrSource)}</small>`
      : esc(c.toStatement || c.summary || '（无结构化新口径）') +
        (c.toDimension ? `　（维度：${esc(c.toDimension)}）` : '');

  drawer.eyebrow = 'FACT CHANGE';
  drawer.title = stmt || `变更 #${c.id}`;
  drawer.html = `
    <div class="drawer-stat">
      <span class="tag ${cp.cls}">${esc(cp.label)}</span>
      <span class="tag ${isRetire ? 'gray' : 'green'}">${isRetire ? '已退役' : '已生效'}</span>
    </div>
    <div class="drawer-subhead">关联实体</div>
    <div class="fact-route">${esc(c.entityName)}<br>${esc(c.datasetCode || '全局实体')} · #${esc(c.entityId)}</div>
    <div class="drawer-subhead">${esc(cp.beforeLabel)}</div>
    <div class="drawer-fact"><p>${esc(beforeText)}</p></div>
    <div class="drawer-subhead">${esc(cp.afterLabel)}</div>
    <div class="drawer-fact"><p>${afterText}</p></div>
    <div class="drawer-subhead">结果说明</div>
    <p class="drawer-desc">${esc(cp.effect)}${c.articleTitle ? `<br>来源：${esc(c.articleTitle)}${c.articleUrl ? ` · ${esc(c.articleUrl)}` : ''}` : ''}</p>
    ${archiveHref ? `<a class="table-link" style="display:inline-block;margin-top:16px" href="${esc(archiveHref)}" target="_blank" rel="noopener">查看实体档案 ↗</a>` : ''}`;
  drawer.open = true;
}

async function go(p: number) {
  page.value = p;
  await load();
}

async function load() {
  loading.value = true;
  try {
    const res = await changesApi.list({
      page: page.value,
      pageSize,
      // 分类/关键词一律在服务端筛选：total 与列表同源，避免「表里几十条、抬头写全库数」
      changeType: filter.value === 'all' ? undefined : filter.value,
      keyword: q.value.trim() || undefined,
      // 本页是审计视图：系统维护类变更也要可见，否则全库唯一的退役记录会被默认过滤掉
      includeSystem: true,
    });
    rows.value = res.items;
    total.value = res.total;
  } catch {
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

// 分类切换立刻重查；关键词输入防抖 300ms，且都回到第 1 页
let kwTimer: ReturnType<typeof setTimeout> | null = null;
watch(filter, () => {
  page.value = 1;
  void load();
});
watch(q, () => {
  if (kwTimer) clearTimeout(kwTimer);
  kwTimer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 300);
});

onMounted(load);
</script>

<style scoped>
.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 15px 16px;
}
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pager .small-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
