<template>
  <section class="page active" aria-label="运行总览">
    <div class="overview-hero">
      <div class="hero-text">
        <div class="hero-eyebrow"><span class="star-plus">✦</span> WENZHOU CITY TRUSTED FACT DISTRIBUTION</div>
        <h1>让新闻及时抵达，<br /><em>让事实值得信赖。</em></h1>
        <p>一条新闻，双轨流转。快速进入搜索与 AI，同时提炼为有来源、有版本、可追溯的城市可信知识。</p>
        <div class="hero-actions">
          <button class="btn btn-light" @click="openTour">查看一次完整流转 <span>↗</span></button>
          <button class="btn btn-outline-white" @click="router.push('/catalog')">浏览城市事实 <span>→</span></button>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="orbit orbit-one"></div>
        <div class="orbit orbit-two"></div>
        <div class="orbit orbit-three"></div>
        <div class="center-glyph">
          <svg viewBox="0 0 100 100">
            <path d="M24 48l22 22 32-43" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="50" cy="50" r="40" stroke="currentColor" stroke-width="1.4" fill="none" opacity=".35" />
          </svg>
        </div>
        <div class="orb-label o-a">NEWS <strong>EVENT</strong></div>
        <div class="orb-label o-b">VERIFIED <strong>FACT</strong></div>
        <div class="orb-label o-c">API <strong>· MCP</strong></div>
        <div class="mini-node n-a"></div>
        <div class="mini-node n-b"></div>
      </div>
      <div class="hero-corner">PUBLICATION ENGINE</div>
    </div>

    <div class="section-head top-summary-head">
      <div>
        <p class="eyebrow">SYSTEM PULSE</p>
        <h2>运行快照 <span class="meta-note">来自生产接口的实时统计</span></h2>
      </div>
      <button class="link-btn" @click="openMetrics">查看统计口径 <span>↗</span></button>
    </div>
    <div class="metrics-grid">
      <div class="metric">
        <div class="metric-top"><span class="metric-icon ic-blue"><DemoIcon name="radio" /></span><span class="metric-arrow">↗</span></div>
        <div class="metric-value">{{ pad(m.news) }}<span> 条</span></div>
        <div class="metric-name">新闻事件</div>
        <div class="metric-foot"><span class="mini-dot blue"></span>生产线处理记录</div>
      </div>
      <div class="metric">
        <div class="metric-top"><span class="metric-icon ic-teal"><DemoIcon name="git" /></span><span class="metric-arrow">↗</span></div>
        <div class="metric-value">{{ pad(m.changes) }}<span> 项</span></div>
        <div class="metric-name">事实变更</div>
        <div class="metric-foot"><span class="mini-dot teal"></span>历史事实变更</div>
      </div>
      <div class="metric">
        <div class="metric-top"><span class="metric-icon ic-orange"><DemoIcon name="check" /></span><span class="metric-arrow">↗</span></div>
        <div class="metric-value">{{ pad(m.pending) }}<span> 项</span></div>
        <div class="metric-name">待人工复核</div>
        <div class="metric-foot"><span class="mini-dot orange"></span>待事实审核队列</div>
      </div>
      <div class="metric">
        <div class="metric-top"><span class="metric-icon ic-purple"><DemoIcon name="activity" /></span><span class="metric-arrow">↗</span></div>
        <div class="metric-value">{{ citePct }}<span v-if="citePct !== '—'">%</span></div>
        <div class="metric-name">AI 引用率</div>
        <div class="metric-foot"><span class="mini-dot purple"></span>固定问题集观测</div>
      </div>
    </div>

    <div class="section-head workflow-head">
      <div>
        <p class="eyebrow">TWO LANES · ONE EVENT</p>
        <h2>一条新闻的双轨旅程</h2>
        <p class="head-desc">同一事件，同时触发快速内容分发和经过审核的事实沉淀。点击节点了解每一步。</p>
      </div>
      <button class="small-btn" @click="openTrack">查看事件轨迹 <span>↗</span></button>
    </div>
    <div class="workflow-panel">
      <div class="event-seed">
        <span class="seed-icon"><DemoIcon name="radio" /></span>
        <div>
          <span class="seed-super">TRIGGER · NEWS EVENT</span>
          <strong>新闻发布事件</strong>
          <small>CMS 发布 → 触发城市事实服务</small>
        </div>
        <span class="seed-time">{{ seedTime }}</span>
      </div>
      <div class="fork-stem"></div>
      <div class="lanes">
        <div class="lane lane-fast">
          <div class="lane-title">
            <div><span class="lane-overline">FAST LANE</span><h3><span class="lane-symbol">↗</span> 快速分发通道</h3></div>
            <span class="lane-time">秒级～分钟级 · 目标</span>
          </div>
          <p>新闻发布后尽快进入机器可发现的公开信息通道，无需等待知识审核。</p>
          <div class="steps">
            <button class="step done" @click="stepInfo('cms')"><span class="step-num">01</span><span>CMS 已发布</span><small>{{ seedTime }}</small></button>
            <span class="step-arrow">›</span>
            <button class="step done" @click="stepInfo('sitemap')"><span class="step-num">02</span><span>Sitemap 更新</span><small>完成</small></button>
            <span class="step-arrow">›</span>
            <button class="step done" @click="stepInfo('index')"><span class="step-num">03</span><span>搜索入口</span><small>持续收录</small></button>
          </div>
          <div class="lane-result"><span class="mini-dot blue"></span>终点：可被搜索及 AI 检索发现的新闻原文</div>
        </div>
        <div class="lane lane-fact">
          <div class="lane-title">
            <div><span class="lane-overline">FACT LANE</span><h3><span class="lane-symbol">◈</span> 可信事实沉淀通道</h3></div>
            <span class="lane-time">人工把关 · 可回溯</span>
          </div>
          <p>从新闻中发现事实候选，关联证据和历史版本，审核后再进入机器知识出口。</p>
          <div class="steps">
            <button class="step done" @click="stepInfo('match')"><span class="step-num">01</span><span>实体识别</span><small>{{ m.entities }} 个</small></button>
            <span class="step-arrow">›</span>
            <button class="step done" @click="stepInfo('extract')"><span class="step-num">02</span><span>抽取主张</span><small>{{ m.changes }} 条</small></button>
            <span class="step-arrow">›</span>
            <button class="step waiting" @click="stepInfo('review')"><span class="step-num">03</span><span>编辑核验</span><small>{{ m.pending }} 待审</small></button>
            <span class="step-arrow">›</span>
            <button class="step empty" @click="stepInfo('publish')"><span class="step-num">04</span><span>事实发布</span><small>未准入</small></button>
          </div>
          <div class="lane-result"><span class="mini-dot teal"></span>终点：带来源、状态和版本的可信城市事实</div>
        </div>
      </div>
      <div class="workflow-note">
        <DemoIcon name="info" />
        <div>{{ stepDetail }}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel news-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">EVENT STREAM</p><h3>最新新闻流 <span class="meta-note">生产线记录</span></h3></div>
          <button class="link-btn" @click="router.push('/news')">查看全部 <span>→</span></button>
        </div>
        <div v-if="loading" class="empty-block">加载中…</div>
        <div v-else-if="!records.length" class="empty-block">暂无生产线处理记录</div>
        <template v-else>
          <article
            v-for="r in records"
            :key="r.id"
            class="event-row"
            role="button"
            tabindex="0"
            @click="openRecord(r)"
          >
            <div class="event-time">{{ fmtFull(r.pubDate || r.createdAt) }}</div>
            <div class="event-details">
              <div class="ev-title">{{ r.title || '（无标题）' }}</div>
              <div class="event-meta">
                <span :class="['tag', fastLaneColor(r.status)]">{{ fastLaneLabel(r.status) }}</span>
                <span class="tag green">Fact Lane {{ r.stats?.factDrafts ?? 0 }} 项</span>
              </div>
            </div>
            <span class="full-arrow">↗</span>
          </article>
        </template>
      </div>
      <div class="panel queue-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">FACT CHANGE STREAM</p><h3>最新事实变更</h3></div>
          <button class="link-btn" @click="router.push('/changes')">查看全部 <span>→</span></button>
        </div>
        <div v-if="loading" class="empty-block">加载中…</div>
        <div v-else-if="!recentChanges.length" class="empty-block">暂无事实变更记录</div>
        <template v-else>
          <div
            v-for="c in recentChanges"
            :key="c.id"
            class="queue-item"
            role="button"
            tabindex="0"
            @click="openChange(c)"
          >
            <div>
              <div class="queue-name">{{ c.toStatement || c.summary || `变更 #${c.id}` }}</div>
              <div class="queue-desc">{{ c.entityName }}</div>
            </div>
            <span :class="['tag', c.changeType === 'retire' ? 'gray' : 'green']">{{
              c.changeType === 'retire' ? '已退役' : '已生效'
            }}</span>
          </div>
        </template>
      </div>
    </div>

    <div class="system-principle">
      <div class="principle-label">DESIGN PRINCIPLE</div>
      <strong>新闻是事件，事实是状态。</strong>
      <p>前者争取时效，后者守住准确。让一座城市在 AI 时代，既不失声，也不失真。</p>
      <span class="principle-decoration">✳</span>
    </div>

    <div v-if="tour.open" class="modal-overlay" @click.self="closeTour">
      <div class="modal" role="dialog" aria-modal="true" aria-label="演示导览">
        <button class="modal-close" aria-label="关闭" @click="closeTour">×</button>
        <div class="eyebrow">3-MINUTE PRODUCT WALKTHROUGH</div>
        <h2>新闻快分发 · 事实慢沉淀</h2>
        <p class="modal-intro">从一条新闻开始，看它如何经过两条不同通道，最终进入机器可读取的城市知识服务。</p>
        <div class="tour-progress">
          <span v-for="(step, j) in TOUR_STEPS" :key="step.index" :class="{ done: j <= tour.i }"></span>
        </div>
        <div class="tour-content">
          <div class="tour-index">{{ TOUR_STEPS[tour.i].index }}</div>
          <h3>{{ TOUR_STEPS[tour.i].title }}</h3>
          <p>{{ TOUR_STEPS[tour.i].desc }}</p>
          <p style="margin-top:14px;color:#397e7d;font-size:10px">对应功能：{{ TOUR_STEPS[tour.i].feature }}</p>
        </div>
        <div class="tour-actions">
          <button class="btn btn-muted" :disabled="tour.i === 0" @click="tourPrev">上一步</button>
          <button class="btn btn-primary" @click="tourNext">
            {{ tour.i === TOUR_STEPS.length - 1 ? '进入对应页面 →' : '下一步 →' }}
          </button>
        </div>
      </div>
    </div>

    <DemoDrawer :open="drawer.open" :eyebrow="drawer.eyebrow" :title="drawer.title" @close="drawer.open = false">
      <div v-html="drawer.html" @click="onDrawerClick"></div>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import { esc } from '@/demo/demoUi';
import {
  archiveApi,
  changesApi,
  discoveryApi,
  draftStatsApi,
  observatoryApi,
  type FactChangeRow,
  type ProductionRecord,
} from '@/api';
import { formatClock, formatDateTime } from '@/utils/timeText';

const router = useRouter();

const loading = ref(true);
const records = ref<ProductionRecord[]>([]);
const recentChanges = ref<FactChangeRow[]>([]);
const m = reactive({ news: 0, changes: 0, pending: 0, entities: 0, citationRate: null as number | null });
const stepDetail = ref(
  '这套工作流区分新闻事件与事实状态。快速分发不等于知识审核通过；只有获准发布的事实才能进入可信知识出口。',
);

const pad = (n: number | null | undefined) => (n == null ? '—' : String(n).padStart(2, '0'));
const citePct = computed(() =>
  m.citationRate == null ? '—' : (m.citationRate * 100).toFixed(m.citationRate * 100 >= 10 ? 0 : 1),
);
const seedTime = ref('--:--');
/** 纯日期字段只渲染日期，带时刻字段显示时:分（避免 date 字段被按 UTC 零点解析出假 08:00） */
const fmtTime = (v: string | null) => formatClock(v);
/** 事件列表要带年份：库里混有 2008/2009 的历史存量新闻；纯日期字段只渲染日期 */
const fmtFull = (v: string | null) => formatDateTime(v);
const changeTypeLabel = (t: string) =>
  ({ new: 'New 新增', update: 'Update 更新', corroborate: 'Corroborate 佐证', retire: 'Retire 退役' })[t] || t;
/** Fast Lane 分发状态按记录真实 status 推断，而非固定文案（与 NewsView 一致） */
const fastLaneLabel = (s: string) =>
  ({ done: 'Fast Lane 已分发', running: 'Fast Lane 处理中', pending: 'Fast Lane 待处理', failed: 'Fast Lane 分发失败', skipped: 'Fast Lane 已跳过' })[s] ||
  'Fast Lane 待处理';
const fastLaneColor = (s: string) => ({ done: 'blue', running: 'blue', pending: 'gray', failed: 'orange', skipped: 'gray' })[s] || 'gray';

const drawer = reactive({ open: false, eyebrow: '', title: '', html: '' });
const openModal = (eyebrow: string, title: string, html: string) => {
  drawer.eyebrow = eyebrow;
  drawer.title = title;
  drawer.html = html;
  drawer.open = true;
};

/** 抽屉内 HTML 用事件委托绑定按钮（v-html 内的 @click 不生效） */
function onDrawerClick(ev: MouseEvent) {
  const el = (ev.target as HTMLElement).closest('[data-nav]') as HTMLElement | null;
  const to = el?.dataset.nav;
  if (!to) return;
  drawer.open = false;
  void router.push(to);
}

const STEP_MSG: Record<string, string> = {
  cms: 'Fast Lane 从 CMS 已发布新闻事件开始。此处读取的是生产线入库记录，不是实时 CMS 连接。',
  sitemap: 'Sitemap、Feed 等出口提高机器发现新闻的机会，但不保证外部模型已经抓取或引用。',
  index: '搜索入口指向新闻原文与站点索引；实际被搜索收录需要外部检测。',
  match: 'Fact Lane 将新闻匹配到稳定的城市实体 ID，避免把所有新稿当作全新知识。',
  extract: '抽取的是待核验的事实候选（Claim），必须关联可定位的来源片段与时间口径。',
  review: '编辑核对证据后批准、存疑或驳回；机器抽取不能自动成为权威城市事实。',
  publish: '只有通过审核和权利校验的确定版本才能派生 HTML、JSON、Feed 或 MCP 可读事实。',
};
const stepInfo = (k: string) => {
  stepDetail.value = STEP_MSG[k] || stepDetail.value;
};

/** 3 分钟产品导览：与原型一致的 6 步流程弹窗 */
const TOUR_STEPS = [
  { index: '01 · 新闻发布', title: '新闻事件进入系统', desc: '选择 CMS 新闻事件，系统记录来源、发布时间、Content ID，并准备机器分发。', page: 'news', feature: '实时新闻流' },
  { index: '02 · 快速分发', title: 'Fast Lane 不等待事实审核', desc: '新闻通过 HTML、站点地图和 Feed 等渠道分发。此处不把已触发分发误写成已被搜索或 AI 收录。', page: 'overview', feature: '运行总览' },
  { index: '03 · 事实候选', title: 'Fact Lane 识别城市事实', desc: '内容匹配实体 ID，抽取带时间与来源的候选主张，进入人工复核队列。', page: 'changes', feature: '事实变更' },
  { index: '04 · 编辑把关', title: '让可信来自可追溯的判断', desc: '审核人查看来源和历史口径，批准、保留存疑或驳回，形成可追溯事件。', page: 'review', feature: '审核工作台' },
  { index: '05 · 机器出口', title: '同一事实版本，多个机器出口', desc: '事实页面、JSON API、JSON-LD、Feed 和 MCP 应使用同一份通过批准的事实版本。', page: 'distribution', feature: '机器发布中心' },
  { index: '06 · 效果反馈', title: '正确引用比引用次数更重要', desc: '观察模型是否引用、是否用错年份、是否缺乏证据，回流至事实治理。', page: 'observatory', feature: 'AI 引用观察' },
];

const tour = reactive({ open: false, i: 0 });
const openTour = () => {
  tour.i = 0;
  tour.open = true;
};
const closeTour = () => {
  tour.open = false;
};
const tourPrev = () => {
  tour.i = Math.max(0, tour.i - 1);
};
const tourNext = () => {
  if (tour.i === TOUR_STEPS.length - 1) {
    const p = TOUR_STEPS[tour.i].page;
    tour.open = false;
    router.push(`/${p}`);
    return;
  }
  tour.i += 1;
};

function openMetrics() {
  openModal(
    'MEASUREMENT PRINCIPLE',
    '关于本页指标',
    `<p class="drawer-desc">四项指标均来自生产事实库接口的实时统计，随数据更新自动刷新。</p>
     <div class="drawer-fact"><h4>新闻事件</h4><p>生产线处理记录总数（每篇入库新闻一条）。</p></div>
     <div class="drawer-fact"><h4>事实变更</h4><p>事实变更记录总数 —— 每次新闻对已有事实产生新增/更新/并列等影响时留痕一条。</p></div>
     <div class="drawer-fact"><h4>待人工复核</h4><p>抽取草稿中状态为 pending 的条数。仅统计事实/事件/证据/变更四类，<strong>不含图谱关系与实体候选</strong>（图谱另计）。</p></div>
     <div class="drawer-fact"><h4>AI 引用率</h4><p>固定问题集探测中，模型回答引用我方事实页或同域内容的比例。</p></div>
     <div class="fact-route">正式对外汇报时，需同时标注模型、问答集、样本量、执行时间与评分方式。</div>`,
  );
}

function openTrack() {
  const r = records.value[0];
  if (!r) return;
  openRecord(r);
}

function openRecord(r: ProductionRecord) {
  openModal(
    'NEWS EVENT / TRACE',
    r.title || `记录 #${r.id}`,
    `<div class="drawer-stat"><span class="tag gray">#${esc(r.id)}</span><span class="tag blue">${esc(r.stage)}</span><span class="tag green">${esc(r.status)}</span></div>
     <p class="drawer-desc">${esc(r.sourceOrg || '未知来源')} · ${r.pubDate ? esc(new Date(r.pubDate).toLocaleDateString('zh-CN')) : '无发布日期'} · 正文 ${esc(r.bodyChars)} 字</p>
     <div class="drawer-subhead">事件流转轨迹</div>
     <div class="trace-step"><strong>新闻入库</strong>生产线接收文章并落库<small>记录 ID: ${esc(r.id)}</small></div>
     <div class="trace-step"><strong>Fast Lane · 快速分发</strong>新闻原文进入站点与 Feed 通道<small>收录结果为外部检测项，此处不宣称已收录</small></div>
     <div class="trace-step"><strong>Fact Lane · 抽取与核验</strong>实体 ${esc(r.stats?.entitiesCreated ?? 0)} · 事实 ${esc(r.stats?.factDrafts ?? 0)} · 关系 ${esc(r.stats?.relationDrafts ?? 0)}<small>当前阶段 ${esc(r.stage)} / ${esc(r.status)}</small></div>
     <div class="drawer-subhead">业务边界</div>
     <div class="fact-route">新闻进入 Fast Lane，不表示该新闻全部陈述已经被确认为可发布的城市事实。事实发布必须通过独立审核门禁。</div>
     <button class="decision-btn approve" style="margin-top:19px" data-nav="/news">查看实时新闻流 ↗</button>`,
  );
}

function openChange(c: FactChangeRow) {
  const isRetire = c.changeType === 'retire';
  const isCorroborate = c.changeType === 'corroborate';
  const beforeText = c.fromStatement || (isCorroborate ? c.factStatement : '（无历史口径，本项为新增）');
  const afterText = isRetire
    ? '（无新口径）'
    : isCorroborate
      ? c.factStatement || c.summary
      : c.toStatement || c.summary;
  openModal(
    'FACT CHANGE',
    c.factStatement || c.summary || `变更 #${c.id}`,
    `<div class="drawer-stat"><span class="tag green">${isRetire ? '已退役' : '已生效'}</span><span class="tag gray">${esc(changeTypeLabel(c.changeType))}</span></div>
     <div class="drawer-subhead">关联实体</div>
     <div class="fact-route">${esc(c.entityName)} · ${esc(c.datasetCode || '全局实体')} #${esc(c.entityId)}</div>
     <div class="drawer-subhead">${isRetire ? '被退役的口径' : '旧状态 / 历史口径'}</div>
     <div class="drawer-fact"><p>${esc(beforeText || '（无历史口径）')}</p></div>
     <div class="drawer-subhead">${isRetire ? '（无新口径）' : '新主张 / 当前口径'}</div>
     <div class="drawer-fact"><p>${esc(afterText || '（无结构化新口径）')}</p></div>
     <div class="drawer-subhead">来源</div>
     <p class="drawer-desc">${esc(c.articleTitle || '（无来源文章）')}${c.rationale ? `<br>${esc(c.rationale)}` : ''}</p>
     <button class="decision-btn approve" style="margin-top:16px" data-nav="/changes">查看全部事实变更 ↗</button>`,
  );
}

onMounted(async () => {
  const [recRes, draftRes, changeRes, snapRes, siteRes] = await Promise.allSettled([
    discoveryApi.records({ pageSize: 5 }),
    draftStatsApi.get(),
    changesApi.list({ pageSize: 5 }),
    observatoryApi.snapshot(),
    archiveApi.siteStats(),
  ]);

  if (recRes.status === 'fulfilled') {
    records.value = recRes.value.items;
    m.news = recRes.value.total;
    const first = recRes.value.items[0];
    if (first?.pubDate) seedTime.value = fmtTime(first.pubDate);
  }
  if (draftRes.status === 'fulfilled') m.pending = draftRes.value.pendingReview;
  if (changeRes.status === 'fulfilled') {
    recentChanges.value = changeRes.value.items;
    m.changes = changeRes.value.total;
  }
  if (snapRes.status === 'fulfilled') m.citationRate = snapRes.value.metrics.citationRate;
  // 实体数改取站点唯一口径（全部已发布实体），与 SSR / catalog 保持一致
  if (siteRes.status === 'fulfilled') m.entities = siteRes.value.publishedEntities;
  loading.value = false;
});
</script>
