<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">系统驾驶舱</h2>
        <div class="page-desc">新闻进入、事实变化、待审核与仲裁的运行态总览</div>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 四指标卡 -->
    <el-row :gutter="16">
      <el-col :span="6">
        <el-card shadow="never" class="stat-card clickable" @click="go('/datasets')">
          <div class="stat-label">今日新闻事件</div>
          <div class="stat-value">{{ ops.todayNews }}</div>
          <div class="stat-sub">今日入库语料</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card clickable" @click="go('/discovery-review')">
          <div class="stat-label">待人工确认（草稿）</div>
          <div class="stat-value warning">{{ ops.pendingDrafts }}</div>
          <div class="stat-sub">点击进入发现审核 →</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card clickable" @click="go('/facts?status=arbitrating')">
          <div class="stat-label">仲裁中事实</div>
          <div class="stat-value danger">{{ ops.pendingArbitration }}</div>
          <div class="stat-sub">点击查看事实管理 →</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">最近一次采集运行</div>
          <div v-if="ops.lastHarvest" class="harvest-card">
            <div class="harvest-row">
              <el-tag size="small" :type="RUN_TAG[ops.lastHarvest.status] ?? 'info'">
                {{ RUN_LABEL[ops.lastHarvest.status] ?? ops.lastHarvest.status }}
              </el-tag>
              <span class="hl-name">{{ ops.lastHarvest.taskName }}</span>
            </div>
            <div class="harvest-row">
              <span class="hl-time">{{ fmtTime(ops.lastHarvest.finishedAt) }}</span>
            </div>
            <div v-if="ops.lastHarvest.stats" class="hl-stat mono">
              实体{{ ops.lastHarvest.stats.entities ?? '-' }} · 入库{{ ops.lastHarvest.stats.articlesInserted ?? '-' }} · 草稿{{ ops.lastHarvest.stats.drafts ?? '-' }}
            </div>
          </div>
          <div v-else class="stat-sub">暂无采集运行记录</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近一次 AI 引用 -->
    <el-card shadow="never" class="mt">
      <div class="section-title">
        <span>最近一次 AI 引用</span>
      </div>
      <div v-if="ops.lastCitation" class="citation-strip">
        <span class="dot" />
        <span class="ci-time">{{ fmtTime(ops.lastCitation.at) }}</span>
        <span class="ci-model">{{ ops.lastCitation.model }}</span>
        <span class="ci-q">「{{ ops.lastCitation.question }}」→ 引用</span>
        <el-tag size="small" effect="plain" :type="ops.lastCitation.cited === 'fact_page' ? 'success' : 'primary'">
          {{ ops.lastCitation.cited === 'fact_page' ? '我方事实页' : '我方站内页（新闻）' }}
        </el-tag>
        <a v-if="ops.lastCitation.url" :href="ops.lastCitation.url" target="_blank" rel="noopener" class="ci-url">{{ ops.lastCitation.url }}</a>
        <span v-if="ops.lastCitation.factUrl" class="ci-fact">
          关联事实页：<a :href="ops.lastCitation.factUrl" target="_blank" rel="noopener">{{ ops.lastCitation.factUrl }}</a>
        </span>
      </div>
      <div v-else class="muted">暂无 AI 引用记录（需先跑一轮探针）</div>
    </el-card>

    <!-- 知识资产总览（全景图表） -->
    <el-card shadow="never" class="mt">
      <div class="section-title">
        <span>知识资产总览</span>
        <span class="muted small">{{ vizGeneratedAt ? `更新于 ${fmtTime(vizGeneratedAt)}` : '' }}</span>
      </div>
      <el-row :gutter="16" v-loading="vizLoading">
        <!-- 第一行：资产数量统计 -->
        <el-col :span="6" class="chart-cell">
          <div class="chart-title">实体数量</div>
          <div ref="countEntityEl" class="chart-sm"></div>
        </el-col>
        <el-col :span="6" class="chart-cell">
          <div class="chart-title">事实数量（active）</div>
          <div ref="countFactEl" class="chart-sm"></div>
        </el-col>
        <el-col :span="6" class="chart-cell">
          <div class="chart-title">事件数量</div>
          <div ref="countEventEl" class="chart-sm"></div>
        </el-col>
        <el-col :span="6" class="chart-cell">
          <div class="chart-title">关系数量</div>
          <div ref="countRelationEl" class="chart-sm"></div>
        </el-col>
        <!-- 第二行：分布图表 -->
        <el-col :span="12" class="chart-cell">
          <div class="chart-title">实体按分类</div>
          <div ref="entityChartEl" class="chart"></div>
        </el-col>
        <el-col :span="12" class="chart-cell">
          <div class="chart-title">事实按维度（active）</div>
          <div ref="factChartEl" class="chart"></div>
        </el-col>
        <el-col :span="12" class="chart-cell">
          <div class="chart-title">事实变化·近30天趋势</div>
          <div ref="changeChartEl" class="chart"></div>
        </el-col>
        <el-col :span="12" class="chart-cell">
          <div class="chart-title">关系谓词 Top</div>
          <div ref="relationChartEl" class="chart"></div>
        </el-col>
      </el-row>
    </el-card>

    <!-- 生产线处理进度 -->
    <el-card shadow="never" class="mt">
      <div class="section-title">
        <span>生产线处理进度（发现 → 审核 → 对齐 → 事实）</span>
        <el-button link type="primary" @click="go('/pipeline')">生产线 →</el-button>
      </div>
      <div v-if="records.length" class="run-list">
        <div v-for="r in records" :key="r.id" class="run-item" @click="go('/pipeline')">
          <el-tag size="small" :type="RUN_TAG[r.status] ?? 'info'">{{ RUN_LABEL[r.status] ?? r.status }}</el-tag>
          <span class="run-id mono">#{{ r.id }}</span>
          <span class="run-model">{{ r.title }}</span>
          <span class="run-stat">
            实体 {{ r.stats?.entitiesCreated ?? 0 }} · 事实 {{ r.stats?.factDrafts ?? 0 }} · 事件
            {{ r.stats?.eventDrafts ?? 0 }}
          </span>
          <span v-if="r.status === 'running'" class="run-live">● 进行中</span>
          <span class="muted small">{{ fmtTime(r.createdAt) }}</span>
        </div>
      </div>
      <div v-else class="muted">暂无处理记录</div>
    </el-card>

    <!-- 最近进入系统的语料 -->
    <el-row :gutter="16" class="mt">
      <el-col :span="24">
        <el-card shadow="never" class="stream">
          <div class="section-title">
            <span>最近进入系统的语料</span>
            <span class="muted small">近 10 条</span>
          </div>
          <div v-if="ops.recentArticles.length" class="stream-list">
            <div v-for="a in ops.recentArticles" :key="a.id" class="stream-item">
              <a :href="a.url" target="_blank" rel="noopener" class="art-link">{{ a.title }}</a>
              <div class="stream-meta">
                <span class="muted">{{ fmtTime(a.createdAt) }}</span>
                <el-tag size="small" type="info" effect="plain">命中 {{ a.hitCount }}</el-tag>
                <el-tag v-if="a.hasChange" size="small" type="warning" effect="plain">触发变化</el-tag>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无语料" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 语料域统计（保留） -->
    <el-card shadow="never" class="mt">
      <div class="section-title"><span>语料域规模</span></div>
      <el-table :data="rows" v-loading="loading" border>
        <el-table-column prop="name" label="语料域" min-width="140" />
        <el-table-column prop="code" label="标识" min-width="120">
          <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
        </el-table-column>
        <el-table-column prop="categoryCount" label="类别数" width="100" align="right" />
        <el-table-column prop="entityCount" label="实体数" width="100" align="right" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
              {{ row.status === 'active' ? '启用' : '归档' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push('/entities?datasetId=' + row.id)">
              查看实体
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { Refresh } from '@element-plus/icons-vue';
import * as echarts from 'echarts';
import http from '@/api/http';
import { datasetApi, discoveryApi, type ProductionRecord } from '@/api';
import type { Dataset } from '@/types';
import { useMetaStore } from '@/stores/meta';

const router = useRouter();
const meta = useMetaStore();
const loading = ref(false);

const ops = ref({
  todayNews: 0,
  pendingDrafts: 0,
  pendingArbitration: 0,
  lastHarvest: null as null | {
    runId: number;
    status: string;
    finishedAt: string | null;
    stats: Record<string, unknown> | null;
    taskName: string | null;
  },
  recentArticles: [] as {
    id: number;
    title: string;
    url: string;
    publishedAt: string | null;
    createdAt: string;
    hitCount: number;
    hasChange: number;
  }[],
  lastCitation: null as null | {
    at: string;
    model: string;
    question: string;
    cited: 'fact_page' | 'same_domain';
    url: string;
    factUrl: string | null;
  },
});

const rows = ref<{ id: number; name: string; code: string; status: string; categoryCount: number; entityCount: number }[]>(
  [],
);
const records = ref<ProductionRecord[]>([]);

// ---- viz 全景图表 ----
interface VCat { name?: string; category: string; count: number }
interface VDim { dimension: string; count: number }
interface VChange { date: string; cntNew: number; cntUpdate: number; cntCorroborate: number; cntRetire: number }
interface VPred { predicate: string; count: number }
interface VCounts { entity: number; fact: number; event: number; relation: number }
const viz = ref<{
  entityByCategory: VCat[];
  factByDimension: VDim[];
  changeTrend: VChange[];
  relationByPredicate: VPred[];
  counts: VCounts;
} | null>(null);
const vizGeneratedAt = ref('');
const vizLoading = ref(false);
const countEntityEl = ref<HTMLDivElement | null>(null);
const countFactEl = ref<HTMLDivElement | null>(null);
const countEventEl = ref<HTMLDivElement | null>(null);
const countRelationEl = ref<HTMLDivElement | null>(null);
const entityChartEl = ref<HTMLDivElement | null>(null);
const factChartEl = ref<HTMLDivElement | null>(null);
const changeChartEl = ref<HTMLDivElement | null>(null);
const relationChartEl = ref<HTMLDivElement | null>(null);
let countEntityChart: echarts.ECharts | null = null;
let countFactChart: echarts.ECharts | null = null;
let countEventChart: echarts.ECharts | null = null;
let countRelationChart: echarts.ECharts | null = null;
let entityChart: echarts.ECharts | null = null;
let factChart: echarts.ECharts | null = null;
let changeChart: echarts.ECharts | null = null;
let relationChart: echarts.ECharts | null = null;

const AXIS_COLOR = '#8a97a5';

/** 渲染全部图表（数据就绪且 DOM 可挂载后调用） */
function renderViz() {
  const d = viz.value;
  if (!d) return;
  void nextTick(() => {
    const counts = d.counts ?? { entity: 0, fact: 0, event: 0, relation: 0 };
    countEntityChart = drawCount(counts.entity, '#0b5cab', countEntityChart, countEntityEl);
    countFactChart = drawCount(counts.fact, '#22764a', countFactChart, countFactEl);
    countEventChart = drawCount(counts.event, '#9a60b4', countEventChart, countEventEl);
    countRelationChart = drawCount(counts.relation, '#b7791f', countRelationChart, countRelationEl);
    entityChart = drawDone(d.entityByCategory, entityChart, entityChartEl);
    factChart = drawDim(d.factByDimension, factChart, factChartEl);
    changeChart = drawTrend(d.changeTrend, changeChart, changeChartEl);
    relationChart = drawPred(d.relationByPredicate, relationChart, relationChartEl);
  });
}
/** 单值数量图：环形 + 中央大数字 */
function drawCount(val: number, color: string, inst: echarts.ECharts | null, elRef: Ref<HTMLDivElement | null>): echarts.ECharts | null {
  if (!elRef.value) return inst;
  inst ??= echarts.init(elRef.value);
  inst.setOption({
    series: [{
      type: 'pie', radius: ['62%', '82%'], center: ['50%', '48%'], silent: true,
      label: { show: false },
      data: [{ value: val, name: '' }],
      itemStyle: { color },
    }],
    graphic: [{
      type: 'text', left: 'center', top: '40%',
      style: { text: String(val), fontSize: 26, fontWeight: 700, fill: '#1d2b3a', textAlign: 'center' },
    }],
  });
  return inst;
}
function drawDone(data: VCat[], inst: echarts.ECharts | null, elRef: Ref<HTMLDivElement | null>): echarts.ECharts | null {
  if (!elRef.value) return inst;
  inst ??= echarts.init(elRef.value);
  const label = (x: VCat) => x.name || x.category.replace(/^.*\./, '') || x.category;
  inst.setOption({
    color: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'],
    tooltip: { trigger: 'item', formatter: '{b}: {c}' },
    legend: { type: 'scroll', bottom: 0, textStyle: { color: AXIS_COLOR, fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['35%', '62%'], center: ['50%', '45%'], avoidLabelOverlap: true,
      label: { color: '#4e5969', fontSize: 11, formatter: '{b}\n{c}' },
      data: data.map((x) => ({ name: label(x), value: x.count })),
    }],
  });
  return inst;
}
function drawDim(data: VDim[], inst: echarts.ECharts | null, elRef: Ref<HTMLDivElement | null>): echarts.ECharts | null {
  if (!elRef.value) return inst;
  inst ??= echarts.init(elRef.value);
  inst.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 14, top: 6, bottom: 26 },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: '#eef1f5' } } },
    yAxis: { type: 'category', inverse: true, data: data.slice().reverse().map((x) => x.dimension), axisLabel: { color: '#4e5969', fontSize: 11 } },
    series: [{
      type: 'bar', data: data.slice().reverse().map((x) => x.count),
      itemStyle: { color: '#0b5cab', borderRadius: [0, 3, 3, 0] },
      barMaxWidth: 14,
    }],
  });
  return inst;
}
function drawTrend(data: VChange[], inst: echarts.ECharts | null, elRef: Ref<HTMLDivElement | null>): echarts.ECharts | null {
  if (!elRef.value) return inst;
  inst ??= echarts.init(elRef.value);
  const dates = data.map((x) => x.date?.slice(5) ?? '');
  inst.setOption({
    color: ['#22764a', '#0b5cab', '#9a60b4', '#b7791f'],
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: AXIS_COLOR, fontSize: 11 } },
    grid: { left: 36, right: 14, top: 26, bottom: 26 },
    xAxis: { type: 'category', data: dates, axisLabel: { color: AXIS_COLOR, fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: '#eef1f5' } } },
    series: [
      { name: '新增', type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x.cntNew) },
      { name: '更新', type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x.cntUpdate) },
      { name: '印证', type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x.cntCorroborate) },
      { name: '退役', type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x.cntRetire) },
    ],
  });
  return inst;
}
function drawPred(data: VPred[], inst: echarts.ECharts | null, elRef: Ref<HTMLDivElement | null>): echarts.ECharts | null {
  if (!elRef.value) return inst;
  inst ??= echarts.init(elRef.value);
  inst.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 14, top: 6, bottom: 26 },
    xAxis: { type: 'value', axisLabel: { color: AXIS_COLOR }, splitLine: { lineStyle: { color: '#eef1f5' } } },
    yAxis: { type: 'category', inverse: true, data: data.slice().reverse().map((x) => x.predicate), axisLabel: { color: '#4e5969', fontSize: 11 } },
    series: [{
      type: 'bar', data: data.slice().reverse().map((x) => x.count),
      itemStyle: { color: '#22764a', borderRadius: [0, 3, 3, 0] },
      barMaxWidth: 14,
    }],
  });
  return inst;
}
function disposeViz() {
  countEntityChart?.dispose(); countFactChart?.dispose(); countEventChart?.dispose(); countRelationChart?.dispose();
  entityChart?.dispose(); factChart?.dispose(); changeChart?.dispose(); relationChart?.dispose();
  countEntityChart = countFactChart = countEventChart = countRelationChart = null;
  entityChart = factChart = changeChart = relationChart = null;
}

const RUN_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
};
const RUN_TAG: Record<string, string> = {
  pending: 'info',
  running: 'warning',
  done: 'success',
  failed: 'danger',
  skipped: 'info',
};

const go = (path: string) => router.push(path);
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

async function load() {
  loading.value = true;
  try {
    const [opsRes, datasets] = await Promise.all([
      http.get<never, typeof ops.value>('/dashboard/ops'),
      meta.loaded ? Promise.resolve(meta.datasets) : datasetApi.list({ pageSize: 200 }),
    ]);
    ops.value = opsRes;
    try {
      records.value = (await discoveryApi.records({ pageSize: 8 })).items;
    } catch {
      records.value = [];
    }
    if (!meta.loaded) {
      meta.datasets = datasets as Dataset[];
      meta.loaded = true;
    }
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }

  // 语料域规模（独立，失败不回滚其它区块）
  try {
    const dsList = meta.loaded ? meta.datasets : await datasetApi.list({ pageSize: 200 });
    const stats = await Promise.all((dsList as { id: number }[]).map((d) => datasetApi.stats(d.id)));
    rows.value = (dsList as { id: number; name: string; code: string; status: string }[]).map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      status: d.status,
      categoryCount: stats.find((s) => s.datasetId === d.id)?.categoryCount ?? 0,
      entityCount: stats.find((s) => s.datasetId === d.id)?.entityCount ?? 0,
    }));
  } catch {
    rows.value = [];
  }

  // 知识资产图表（独立于 ops，失败不阻塞页面）
  vizLoading.value = true;
  try {
    const d = await http.get<never, typeof viz.value & { generatedAt: string }>('/dashboard/viz');
    viz.value = d;
    vizGeneratedAt.value = d.generatedAt ?? '';
    renderViz();
  } catch {
    /* 图表数据拉取失败不阻塞 */
  } finally {
    vizLoading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(disposeViz);
</script>

<style scoped>
.mt {
  margin-top: 16px;
}
.muted {
  color: #8a97a5;
}
.small {
  font-size: 12px;
}
.mono {
  font-family: 'JetBrains Mono', Consolas, monospace;
}

.stat-card {
  border-top: 3px solid #0b5cab;
  height: 128px;
  display: flex;
  flex-direction: column;
}
.stat-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
}
.stat-card .stat-sub {
  margin-top: auto;
}
.stat-card.clickable {
  cursor: pointer;
  transition: box-shadow 0.2s;
}
.stat-card.clickable:hover {
  box-shadow: 0 4px 16px rgba(11, 92, 171, 0.18);
}
.stat-label {
  font-size: 13px;
  color: #8a94a6;
}
.stat-value {
  font-size: 30px;
  font-weight: 700;
  margin-top: 6px;
}
.stat-value.warning {
  color: #e6a23c;
}
.stat-value.danger {
  color: #f56c6c;
}
.stat-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #8a97a5;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: #1d2b3a;
  margin-bottom: 12px;
}

.harvest-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hl-name {
  font-weight: 600;
}
.hl-time {
  font-size: 12px;
  color: #8a97a5;
}
.hl-stat {
  font-size: 12px;
  color: #4e5969;
}

.harvest-card {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.harvest-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.citation-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid #eef1f5;
  border-radius: 6px;
  background: #f9fbfd;
}
.citation-strip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #0b5cab;
  flex-shrink: 0;
}
.ci-time {
  font-size: 13px;
  color: #4e5969;
}
.ci-model {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}
.ci-q {
  font-size: 13px;
  color: #1d2b3a;
}
.ci-url {
  font-size: 12px;
  color: #0b5cab;
  text-decoration: none;
  word-break: break-all;
}
.ci-url:hover {
  text-decoration: underline;
}
.ci-fact {
  font-size: 12px;
  color: #8a97a5;
}
.ci-fact a {
  color: #0b5cab;
  text-decoration: none;
}
.ci-fact a:hover {
  text-decoration: underline;
}

.run-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.run-item {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid #eef1f5;
  border-radius: 6px;
  cursor: pointer;
}
.run-item:hover {
  border-color: #0b5cab;
  background: #f7faff;
}
.run-id {
  font-weight: 600;
}
.run-model {
  font-size: 12px;
  color: #4e5969;
  background: #f0f3f7;
  padding: 1px 8px;
  border-radius: 3px;
}
.run-stat {
  font-size: 13px;
  color: #1d2b3a;
}
.run-live {
  font-size: 12px;
  color: #e6a23c;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to {
    visibility: hidden;
  }
}

.chart-cell {
  margin-bottom: 16px;
}
.chart-title {
  font-size: 13px;
  color: #4e5969;
  margin-bottom: 6px;
}
.chart {
  width: 100%;
  height: 280px;
}
.chart-sm {
  width: 100%;
  height: 120px;
}

.stream {
  height: 100%;
}
.stream-list {
  max-height: 360px;
  overflow-y: auto;
}
.stream-item {
  padding: 10px 0;
  border-bottom: 1px dashed #eef1f5;
}
.stream-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.art-link {
  color: #0b5cab;
  text-decoration: none;
  font-size: 14px;
}
.art-link:hover {
  text-decoration: underline;
}
.chg-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.entity-link {
  color: #0b5cab;
  text-decoration: none;
  font-weight: 500;
}
.entity-link:hover {
  text-decoration: underline;
}
.chg-summary {
  margin-top: 4px;
  font-size: 13px;
  color: #1d2b3a;
  line-height: 1.6;
}
</style>
