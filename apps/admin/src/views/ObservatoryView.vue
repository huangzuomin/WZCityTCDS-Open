<template>
  <div class="ob">
    <!-- 顶部品牌区（对齐设计稿） -->
    <header class="hero">
      <div class="wrap">
        <div class="brand">
          <span class="logo">温州在线 · <b>城市事实</b></span>
          <span class="sub">City Real-time Trusted Content Distribution</span>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" plain @click="goReport">一键生成 GEO 报告</el-button>
          <el-button type="warning" plain :loading="probing" @click="runSample">随机跑 10 题</el-button>
        </div>
        <h1 class="title">AI Citation Observatory</h1>
        <p class="lede">
          回答最核心的问题：最新内容发布后，多久被搜索发现？事实更新后，多久被外部 AI 正确采用？我们有多大比例的内容进入 AI 引用链路？
          <span class="simbadge">引用记录依赖探针实际跑通；回答原文取决于模型接口是否成功返回</span>
        </p>

        <!-- KPI -->
        <div class="kpis">
          <div class="kpi">
            <div class="kv">{{ discoveryText }}</div>
            <div class="kl">Discovery Lag</div>
            <div class="ks">新闻发布 → 搜索首次发现（待接入搜索收录监测）</div>
          </div>
          <div class="kpi">
            <div class="kv">{{ fmtMin(snapshot?.metrics.aiFreshnessLagMin) }}</div>
            <div class="kl">AI Freshness Lag</div>
            <div class="ks">事实更新 → AI 首次正确采用</div>
          </div>
          <div class="kpi">
            <div class="kv">{{ fmtRate(snapshot?.metrics.citationRate) }}</div>
            <div class="kl">
              Citation Rate
              <el-tag v-if="snapshot?.metrics.citationRateDeltaPp != null" size="small" :type="snapshot.metrics.citationRateDeltaPp >= 0 ? 'success' : 'danger'" effect="plain">
                {{ snapshot.metrics.citationRateDeltaPp >= 0 ? '+' : '' }}{{ snapshot.metrics.citationRateDeltaPp }}pp
              </el-tag>
            </div>
            <div class="ks">固定问题集 {{ snapshot?.metrics.citationRateBase ?? 0 }} 题中引用我方内容</div>
          </div>
        </div>

        <!-- 最近一次引用 -->
        <div v-if="snapshot?.metrics.lastCitation" class="verified-strip">
          <span class="dot" />
          最近一次 AI Citation：{{ fmtTime(snapshot.metrics.lastCitation.at) }} · {{ snapshot.metrics.lastCitation.model }} ·
          「{{ snapshot.metrics.lastCitation.question }}」→ 引用
          <el-tag size="small" effect="plain">{{ snapshot.metrics.lastCitation.cited === 'fact_page' ? '我方事实页' : '我方站内页（新闻）' }}</el-tag>
          <a :href="snapshot.metrics.lastCitation.url" target="_blank" rel="noopener">{{ snapshot.metrics.lastCitation.url }}</a>
          <span class="lc-fact">
            关联事实页：<a :href="snapshot.metrics.lastCitation.factUrl" target="_blank" rel="noopener">{{ snapshot.metrics.lastCitation.factUrl }}</a>
          </span>
        </div>
      </div>
    </header>

    <div class="wrap body">
      <!-- Event Tracking -->
      <section id="tracking">
        <h2 class="sec">Event Tracking · 事件级追踪</h2>
        <p class="secdesc">从新闻发布到 AI 采用的完整时间轴。已完成节点显示实测时点，进行中节点显示下次探测计划。</p>
        <div v-if="snapshot?.events.length" class="timeline">
          <div v-for="ev in snapshot.events" :key="ev.id" class="tl-item" :class="{ sup: !ev.nodes.some((n) => n.state === 'done') }">
            <div class="tl-head">
              <b>{{ ev.title }}</b>
              <a class="entity-id" :href="ev.factUrl" target="_blank" rel="noopener" title="事实页（生产环境 66wz.com 可打开，本地无对应服务）">{{ ev.factId }}</a>
              <a v-if="ev.newsUrl" class="ev-link" :href="ev.newsUrl" target="_blank" rel="noopener">新闻原文</a>
            </div>
            <div class="tl-fact">
              <span v-if="ev.factEntity || ev.factDimension" class="tl-fact-meta">
                <span class="fk">实体</span>{{ ev.factEntity }}
                <span v-if="ev.factDimension" class="fdim">· 维度 {{ ev.factDimension }}</span>
              </span>
              <p v-if="ev.factStatement" class="tl-fact-stmt">{{ ev.factStatement }}</p>
            </div>
            <div class="tl-nodes">
              <span v-for="(n, i) in ev.nodes" :key="i" class="tl-node" :class="n.state">
                <span class="tl-date">{{ fmtTime(n.at) }}</span>
                <span class="tl-label">{{ n.label }}</span>
              </span>
            </div>
          </div>
        </div>
        <el-empty v-else description="暂无活跃事件" :image-size="60" />
      </section>

      <!-- 固定问题集 -->
      <section id="questions">
        <h2 class="sec">固定问题集（逐模型引用判定）</h2>
        <p class="secdesc">
          每周对配置的模型回归测试。点击任意一行可查看该题的「大模型回答记录」（各模型原文与引用来源）。
        </p>
        <div class="qtable-wrap">
          <el-table :data="snapshot?.questions ?? []" border stripe @row-click="openAnswers" class="qtable">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="row-hint">点击行打开「大模型回答记录」抽屉</div>
              </template>
            </el-table-column>
            <el-table-column prop="question" label="测试问题" min-width="300" show-overflow-tooltip />
            <el-table-column prop="expectedAnswer" label="预期口径（我方）" min-width="240" show-overflow-tooltip />
            <el-table-column v-for="col in snapshot?.modelColumns ?? []" :key="col.id" :label="col.label" width="140" align="center">
              <template #default="{ row }">
                <el-tag :type="citeType(row.byModel[col.id])" size="small" effect="dark">{{ citeText(row.byModel[col.id]) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="answerCount" label="回答次数" width="110" align="center" sortable />
            <el-table-column label="回答记录" width="110" align="center">
              <template #default>
                <el-link type="primary" :underline="false">查看 ›</el-link>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>
    </div>

    <!-- 大模型回答记录 抽屉 -->
    <el-drawer v-model="drawer" :title="`大模型回答记录`" size="46%" :with-header="true">
      <template #header>
        <div class="drawer-title">
          <span>大模型回答记录</span>
          <code class="qid">#{{ current?.id }}</code>
        </div>
      </template>
      <div v-if="current" class="drawer-body">
        <div class="dq">问：{{ current.question }}</div>
        <div class="dexp">预期口径：{{ current.expectedAnswer }}</div>
        <el-divider>各模型回答（按探测时间倒序）</el-divider>
        <div v-loading="loadingAnswers">
          <div v-for="(a, i) in answers" :key="i" class="ans-card">
            <div class="ans-head">
              <el-tag size="small" effect="plain">{{ a.modelLabel }}</el-tag>
              <el-tag :type="citeType(a.cited)" size="small" effect="dark">{{ citeText(a.cited) }}</el-tag>
              <span class="ans-time">{{ fmtTime(a.probedAt) }}</span>
              <span class="ans-method">匹配：{{ methodText(a.matchMethod) }}</span>
            </div>
            <pre v-if="a.rawAnswer" class="ans-text">{{ a.rawAnswer }}</pre>
            <div v-else class="ans-empty">（本次探测未捕获到模型原文，可能调用超时或模型未返回内容）</div>
            <div v-if="a.matchedUrl" class="ans-url">命中：<a :href="a.matchedUrl" target="_blank" rel="noopener">{{ a.matchedUrl }}</a></div>
            <div v-if="a.sourceUrls && a.sourceUrls.length" class="ans-src">
              来源 URL：
              <a v-for="u in a.sourceUrls" :key="u" :href="u" target="_blank" rel="noopener" class="src-link">{{ u }}</a>
            </div>
            <div v-if="a.excerpt" class="ans-excerpt">摘录：{{ a.excerpt }}</div>
          </div>
          <el-empty v-if="!loadingAnswers && !answers.length" description="该题暂无探测记录，先跑一轮探针" :image-size="60" />
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { observatoryApi, type CitedStatus, type ObservatorySnapshot, type ObservatoryQuestionRow, type ProbeAnswer } from '@/api';

const router = useRouter();
const snapshot = ref<ObservatorySnapshot | null>(null);
const loading = ref(false);
const probing = ref(false);

const goReport = () => router.push('/geo-report');

const drawer = ref(false);
const current = ref<ObservatoryQuestionRow | null>(null);
const answers = ref<ProbeAnswer[]>([]);
const loadingAnswers = ref(false);

const discoveryText = '—';
const fmtMin = (v: number | null | undefined) => (v == null ? '—' : v < 60 ? `${v} 分钟` : `${Math.floor(v / 60)}h${v % 60}m`);
const fmtRate = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '待探测');

const citeType = (c: CitedStatus): 'success' | 'warning' | 'info' => {
  if (c === 'fact_page' || c === 'same_domain') return 'success';
  if (c === 'other') return 'warning';
  return 'info';
};
const citeText = (c: CitedStatus): string => {
  if (c === 'fact_page' || c === 'same_domain') return '命中';
  return '其他源';
};
const methodText = (m: string) => (m === 'url_struct' ? 'URL 结构' : m === 'url_text' ? 'URL 文本' : '无');

async function load() {
  loading.value = true;
  try {
    snapshot.value = await observatoryApi.snapshot();
  } finally {
    loading.value = false;
  }
}

async function openAnswers(row: ObservatoryQuestionRow) {
  current.value = row;
  drawer.value = true;
  loadingAnswers.value = true;
  answers.value = [];
  try {
    answers.value = await observatoryApi.questionAnswers(row.id);
  } catch {
    answers.value = [];
  } finally {
    loadingAnswers.value = false;
  }
}

async function runSample() {
  probing.value = true;
  try {
    const { runs, results } = await observatoryApi.probe({ sample: 10 });
    const cited = results.filter((r) => r.cited === 'fact_page' || r.cited === 'same_domain').length;
    ElMessage.success(`已跑 ${runs.reduce((s, r) => s + r.questionCount, 0)} 题，引用我方 ${cited} 题`);
    await load();
  } catch {
    // 拦截器已提示
  } finally {
    probing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.ob { background: #f6f7f9; min-height: 100%; }
.wrap { width: 100%; margin: 0 auto; padding: 0 20px; }
.hero { background: linear-gradient(135deg, #0b2f56 0%, #0b5cab 100%); color: #fff; padding: 18px 0 22px; }
.brand { display: flex; align-items: baseline; gap: 12px; }
.brand .logo { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
.brand .logo b { color: #ffd166; }
.brand .sub { font-size: 12px; opacity: 0.85; }
.actions { float: right; }
.title { font-size: 26px; line-height: 1.3; margin: 14px 0 6px; }
.lede { color: #dce9f7; margin-top: 6px; max-width: 860px; font-size: 14px; }
.simbadge { display: inline-block; font-size: 11.5px; color: #8a5a00; background: #fff7e6; border: 1px dashed #e3c687; border-radius: 3px; padding: 1px 8px; margin-left: 8px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin: 18px 0 6px; }
.kpi { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 16px 18px; color: #1c2430; }
.kpi .kv { font-size: 30px; font-weight: 800; color: #0b3f7d; font-family: Consolas, Menlo, monospace; }
.kpi .kl { font-size: 13px; font-weight: 700; margin-top: 2px; display: flex; align-items: center; gap: 6px; }
.kpi .ks { font-size: 12px; color: #5a6572; margin-top: 4px; }
.verified-strip { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; background: #e7f4ec; border: 1px solid #cfe7d8; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #1f5c3a; }
.verified-strip .dot { width: 8px; height: 8px; border-radius: 50%; background: #22764a; display: inline-block; }
.verified-strip a { color: #22764a; word-break: break-all; }
.verified-strip .lc-fact { font-size: 12px; opacity: 0.85; }
.verified-strip .lc-fact a { text-decoration: underline; }
.body { padding-top: 26px; padding-bottom: 40px; }
.sec { font-size: 19px; padding-left: 10px; border-left: 4px solid #0b5cab; margin-bottom: 6px; }
.secdesc { color: #5a6572; font-size: 13px; margin-bottom: 14px; }
.timeline { position: relative; margin: 10px 0 30px 8px; padding-left: 26px; border-left: 2px solid #cfd8e2; }
.tl-item { position: relative; padding-bottom: 22px; }
.tl-item::before { content: ''; position: absolute; left: -33px; top: 6px; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 3px solid #0b5cab; }
.tl-item.sup::before { border-color: #9aa5b1; }
.tl-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.tl-head b { font-size: 14.5px; }
.entity-id { font-family: Consolas, Menlo, monospace; font-size: 12px; color: #0b5cab; background: #eaf2fb; border: 1px solid #cfe0f2; border-radius: 4px; padding: 1px 8px; }
.ev-link { color: #0b5cab; font-size: 12px; }
.tl-fact { margin-top: 6px; }
.tl-fact-meta { font-size: 12px; color: #3c4654; }
.tl-fact-meta .fk { color: #0b5cab; font-weight: 600; margin-right: 4px; }
.tl-fact-meta .fdim { color: #5a6572; margin-left: 6px; }
.tl-fact-stmt { font-size: 13px; color: #2a3542; background: #f3f7fc; border-left: 3px solid #0b5cab; border-radius: 4px; padding: 6px 10px; margin: 6px 0 0; line-height: 1.5; }
.tl-nodes { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 8px; }
.tl-node { font-size: 12.5px; display: inline-flex; align-items: baseline; gap: 6px; }
.tl-node .tl-date { font-family: Consolas, Menlo, monospace; color: #0b427a; font-weight: 700; }
.tl-node.done .tl-date { color: #22764a; }
.tl-node.pending .tl-date, .tl-node.planned .tl-date { color: #8a5a00; }
.qtable-wrap { overflow-x: auto; }
.qtable :deep(.el-table__row) { cursor: pointer; }
.row-hint { color: #a9b0bd; font-size: 12px; }
.drawer-title { display: flex; align-items: center; gap: 10px; font-weight: 700; }
.drawer-title .qid { font-family: Consolas, Menlo, monospace; font-size: 12px; color: #0b5cab; background: #eaf2fb; border: 1px solid #cfe0f2; border-radius: 4px; padding: 1px 8px; }
.drawer-body .dq { font-weight: 600; font-size: 15px; }
.drawer-body .dexp { color: #5a6572; font-size: 13px; margin: 6px 0 4px; }
.ans-card { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.ans-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ans-time { color: #5a6572; font-size: 12px; }
.ans-method { color: #9aa5b1; font-size: 12px; }
.ans-text { white-space: pre-wrap; word-break: break-word; background: #f8fafc; border: 1px solid #e3e7ec; border-radius: 6px; padding: 10px 12px; margin: 10px 0; font-family: inherit; font-size: 13px; color: #2a3542; max-height: 320px; overflow: auto; }
.ans-empty { color: #8a5a00; background: #fff7e6; border: 1px dashed #e3c687; border-radius: 6px; padding: 10px 12px; margin: 10px 0; font-size: 13px; }
.ans-url, .ans-src, .ans-excerpt { font-size: 12.5px; color: #3c4654; margin-top: 6px; word-break: break-all; }
.ans-src .src-link { display: block; color: #0b5cab; }
</style>
