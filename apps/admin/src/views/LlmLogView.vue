<template>
  <div class="page">
    <el-form :inline="true" class="filters">
      <el-form-item label="配置">
        <el-select v-model="f.settingId" clearable placeholder="全部" style="width: 190px">
          <el-option v-for="s in settings" :key="s.id" :label="`${s.name} / ${s.model}`" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="阶段">
        <el-select v-model="f.purpose" clearable placeholder="全部" style="width: 150px">
          <el-option v-for="p in PURPOSE_OPTIONS" :key="p.value" :label="p.label" :value="p.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="f.status" clearable placeholder="全部" style="width: 110px">
          <el-option label="成功" value="success" />
          <el-option label="失败" value="error" />
        </el-select>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker
          v-model="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="起"
          end-placeholder="止"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="query">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <el-checkbox v-model="autoRefresh" class="auto">自动刷新(5s)</el-checkbox>
        <span v-if="lastLoadedAt" class="hint">更新于 {{ lastLoadedAt }}</span>
      </el-form-item>
    </el-form>

    <el-row :gutter="12" class="cards" v-loading="loading">
      <el-col :span="4"><el-statistic title="调用次数" :value="stats.totals.calls" /></el-col>
      <el-col :span="4">
        <el-statistic title="成功率" :value="successRate" suffix="%" :value-style="successRate >= 99 ? 'color:#67c23a' : 'color:#e6a23c'" />
      </el-col>
      <el-col :span="4">
        <el-statistic title="失败" :value="stats.totals.errors" value-style="color:#f56c6c" />
      </el-col>
      <el-col :span="4"><el-statistic title="平均耗时" :value="stats.totals.avgLatencyMs" suffix="ms" /></el-col>
      <el-col :span="4">
        <el-statistic title="P95 耗时" :value="p95" suffix="ms" :value-style="p95 > 60000 ? 'color:#f56c6c' : ''" />
      </el-col>
      <el-col :span="4"><el-statistic title="总 Token" :value="stats.totals.totalTokens" /></el-col>
    </el-row>

    <el-card shadow="never" class="chart-card live-card">
      <template #header>
        <div class="live-head">
          <span class="chart-title">实时调用日志</span>
          <div class="live-ctl">
            <el-switch v-model="liveOn" active-text="实时" />
            <el-select v-model="liveInterval" size="small" style="width: 92px">
              <el-option :value="1000" label="1s" />
              <el-option :value="2000" label="2s" />
              <el-option :value="5000" label="5s" />
            </el-select>
            <el-checkbox v-model="liveOnlyError">只看错误</el-checkbox>
            <el-button size="small" @click="clearLive">清屏</el-button>
            <span class="hint">
              缓冲 {{ liveRows.length }} 条 · 累计新增 {{ liveNewCount }}
              <template v-if="liveErrorCount"> · <span class="err-num">错误 {{ liveErrorCount }}</span></template>
            </span>
          </div>
        </div>
      </template>

      <div v-if="visibleLiveRows.length" class="live-list">
        <div
          v-for="r in visibleLiveRows"
          :key="r.id"
          class="live-row"
          :class="{ err: r.status === 'error', fresh: freshIds.has(r.id) }"
        >
          <span class="lv-time">{{ timeOf(r.createdAt) }}</span>
          <span class="lv-model" :title="r.model">{{ r.model }}</span>
          <span class="lv-purpose">{{ purposeLabel(r.purpose) }}</span>
          <span class="lv-task">{{ r.taskId ? `#${r.taskId}` : '—' }}</span>
          <span class="lv-latency">{{ fmtMs(r.latencyMs) }}</span>
          <span class="lv-tokens">{{ fmt(r.totalTokens) }} tok</span>
          <span class="lv-status">{{ r.status === 'success' ? '成功' : '失败' }}</span>
          <span class="lv-msg" :title="r.errorMessage ?? ''">{{ r.errorMessage ?? '' }}</span>
        </div>
      </div>
      <el-empty v-else :description="liveOn ? '等待调用…' : '实时已关闭'" :image-size="60" />
    </el-card>

    <el-tabs v-model="tab" class="tabs">
      <!-- ------------------------------------------------ 概览 -->
      <el-tab-pane label="概览" name="overview">
        <el-card shadow="never" class="chart-card">
          <template #header><span class="chart-title">按日趋势（柱：调用次数 · 线：Token 消耗）</span></template>
          <div v-if="chart.pts.length" class="svg-wrap">
            <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" preserveAspectRatio="xMidYMid meet" class="trend-svg">
              <line v-for="(g, i) in chart.gridY" :key="'g' + i" :x1="chart.padL" :y1="g.y" :x2="chart.W - chart.padR" :y2="g.y" class="grid" />
              <text v-for="(g, i) in chart.gridY" :key="'lt' + i" :x="chart.padL - 6" :y="g.y + 3" class="axis-l">{{ fmt(g.tTokens) }}</text>
              <text v-for="(g, i) in chart.gridY" :key="'rt' + i" :x="chart.W - chart.padR + 6" :y="g.y + 3" class="axis-r">{{ fmt(g.tCalls) }}</text>
              <rect v-for="(p, i) in chart.pts" :key="'b' + i" :x="p.bx" :y="p.yB" :width="chart.barW" :height="p.hC" class="bar">
                <title>{{ p.day }} 调用 {{ fmt(p.calls) }} 次</title>
              </rect>
              <path :d="chart.areaPath" class="area" />
              <path :d="chart.linePath" class="line" />
              <circle v-for="(p, i) in chart.pts" :key="'c' + i" :cx="p.cx" :cy="p.yT" r="2.6" class="dot">
                <title>{{ p.day }} Token {{ fmt(p.tokens) }}</title>
              </circle>
              <text
                v-for="(p, i) in chart.pts"
                v-show="p.showLabel"
                :key="'x' + i"
                :x="p.cx"
                :y="chart.H - chart.padB + 16"
                class="axis-x"
              >
                {{ p.day }}
              </text>
            </svg>
            <div class="legend">
              <span class="lg-line">Token 消耗（左轴）</span>
              <span class="lg-bar">调用次数（右轴）</span>
            </div>
          </div>
          <el-empty v-else description="暂无数据" :image-size="60" />
        </el-card>

        <el-row :gutter="14">
          <el-col :span="12">
            <el-card shadow="never" class="chart-card">
              <template #header><span class="chart-title">按模型 · 调用次数 / Token</span></template>
              <div v-if="modelRows.length" class="hbar-list">
                <div v-for="m in modelRows" :key="m.key" class="hbar-row">
                  <span class="hbar-label" :title="m.label">{{ m.label }}</span>
                  <div class="hbar-track">
                    <div class="hbar-fill" :style="{ width: pct(m.calls, maxModelCalls) }">
                      <span class="hbar-val">{{ fmt(m.calls) }} 次 / {{ fmt(m.totalTokens) }} tok</span>
                    </div>
                  </div>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="60" />
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card shadow="never" class="chart-card">
              <template #header><span class="chart-title">耗时分布（用于排查超时/卡顿）</span></template>
              <div v-if="sampleRows.length" class="hist">
                <div v-for="b in latencyBuckets" :key="b.label" class="hist-row">
                  <span class="hist-label">{{ b.label }}</span>
                  <div class="hist-track">
                    <div class="hist-fill" :class="b.danger ? 'danger' : ''" :style="{ width: pct(b.count, maxBucket) }">
                      <span class="hbar-val">{{ b.count }}</span>
                    </div>
                  </div>
                </div>
                <div class="hint">基于本次加载的 {{ sampleRows.length }} 条记录{{ sampleCapped ? `（上限 ${SAMPLE_CAP} 条）` : '' }}</div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="60" />
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ------------------------------------------------ 按阶段 -->
      <el-tab-pane label="按阶段" name="purpose">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span class="chart-title">阶段汇总（调试重点：错误率与耗时）</span>
            <span class="hint"> · 基于 {{ sampleRows.length }} 条记录</span>
          </template>
          <el-table :data="purposeRows" border stripe size="small" max-height="360">
            <el-table-column prop="label" label="阶段" min-width="120" />
            <el-table-column prop="calls" label="调用" width="90" align="right" />
            <el-table-column prop="success" label="成功" width="90" align="right" />
            <el-table-column label="失败" width="90" align="right">
              <template #default="{ row }">
                <span :class="{ 'err-num': row.errors > 0 }">{{ row.errors }}</span>
              </template>
            </el-table-column>
            <el-table-column label="错误率" width="100" align="right">
              <template #default="{ row }">
                <el-tag v-if="row.errors" type="danger" effect="plain" size="small">{{ row.errorRate }}%</el-tag>
                <span v-else class="ok">0%</span>
              </template>
            </el-table-column>
            <el-table-column label="平均耗时" width="120" align="right">
              <template #default="{ row }">{{ fmtMs(row.avgLatency) }}</template>
            </el-table-column>
            <el-table-column label="最大耗时" width="120" align="right">
              <template #default="{ row }">
                <span :class="{ 'warn-num': row.maxLatency > 120000 }">{{ fmtMs(row.maxLatency) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="totalTokens" label="Token" width="120" align="right">
              <template #default="{ row }">{{ fmt(row.totalTokens) }}</template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-row :gutter="14">
          <el-col :span="12">
            <el-card shadow="never" class="chart-card">
              <template #header><span class="chart-title">各阶段调用次数</span></template>
              <div v-if="purposeRows.length" class="hbar-list">
                <div v-for="p in purposeRows" :key="p.key" class="hbar-row">
                  <span class="hbar-label" :title="p.label">{{ p.label }}</span>
                  <div class="hbar-track">
                    <div class="hbar-fill" :style="{ width: pct(p.calls, maxPurposeCalls) }">
                      <span class="hbar-val">{{ p.calls }}</span>
                    </div>
                  </div>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="60" />
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card shadow="never" class="chart-card">
              <template #header><span class="chart-title">各阶段平均耗时</span></template>
              <div v-if="purposeRows.length" class="hbar-list">
                <div v-for="p in purposeRows" :key="p.key" class="hbar-row">
                  <span class="hbar-label" :title="p.label">{{ p.label }}</span>
                  <div class="hbar-track">
                    <div class="hbar-fill alt" :style="{ width: pct(p.avgLatency, maxPurposeLatency) }">
                      <span class="hbar-val">{{ fmtMs(p.avgLatency) }}</span>
                    </div>
                  </div>
                </div>
              </div>
              <el-empty v-else description="暂无数据" :image-size="60" />
            </el-card>
          </el-col>
        </el-row>

        <el-card shadow="never" class="chart-card">
          <template #header><span class="chart-title">最慢的 10 次调用</span></template>
          <el-table :data="slowest" border stripe size="small">
            <el-table-column prop="createdAt" label="时间" width="180" />
            <el-table-column label="阶段" width="110">
              <template #default="{ row }">{{ purposeLabel(row.purpose) }}</template>
            </el-table-column>
            <el-table-column prop="model" label="模型" width="170" />
            <el-table-column label="任务" width="80">
              <template #default="{ row }">{{ row.taskId ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="耗时" width="110" align="right">
              <template #default="{ row }">
                <span class="warn-num">{{ fmtMs(row.latencyMs) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="totalTokens" label="Token" width="110" align="right" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'success' ? 'success' : 'danger'" size="small" effect="plain">
                  {{ row.status === 'success' ? '成功' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------------------------ 错误 -->
      <el-tab-pane :label="`错误(${errorRows.length})`" name="error">
        <el-card shadow="never" class="chart-card">
          <template #header><span class="chart-title">错误类型汇总</span></template>
          <el-table :data="errorGroups" border stripe size="small" max-height="300">
            <el-table-column prop="message" label="错误信息" min-width="360" show-overflow-tooltip />
            <el-table-column prop="count" label="次数" width="90" align="right" />
            <el-table-column label="涉及阶段" min-width="160">
              <template #default="{ row }">{{ row.purposes.join('、') }}</template>
            </el-table-column>
            <el-table-column label="涉及模型" min-width="180">
              <template #default="{ row }">{{ row.models.join('、') }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!errorGroups.length" description="所选范围内没有错误" :image-size="60" />
        </el-card>

        <el-card shadow="never" class="chart-card">
          <template #header><span class="chart-title">错误明细</span></template>
          <el-table :data="errorRows" border stripe size="small" max-height="420">
            <el-table-column prop="createdAt" label="时间" width="180" />
            <el-table-column label="阶段" width="110">
              <template #default="{ row }">{{ purposeLabel(row.purpose) }}</template>
            </el-table-column>
            <el-table-column prop="model" label="模型" width="170" />
            <el-table-column label="任务" width="80">
              <template #default="{ row }">{{ row.taskId ?? '—' }}</template>
            </el-table-column>
            <el-table-column prop="errorMessage" label="错误" min-width="360" show-overflow-tooltip />
          </el-table>
          <el-empty v-if="!errorRows.length" description="所选范围内没有错误" :image-size="60" />
        </el-card>
      </el-tab-pane>

      <!-- ------------------------------------------------ 明细 -->
      <el-tab-pane label="明细" name="detail">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span class="chart-title">调用明细</span>
            <span class="hint">
              · 共 {{ stats.totals.calls }} 条{{ sampleCapped ? `，本页仅加载最近 ${SAMPLE_CAP} 条` : '' }}
            </span>
          </template>
          <el-table :data="pagedRows" border stripe size="small" max-height="560">
            <el-table-column prop="createdAt" label="时间" width="180" />
            <el-table-column prop="model" label="模型" width="170" />
            <el-table-column label="阶段" width="110">
              <template #default="{ row }">{{ purposeLabel(row.purpose) }}</template>
            </el-table-column>
            <el-table-column label="任务" width="80">
              <template #default="{ row }">{{ row.taskId ?? '—' }}</template>
            </el-table-column>
            <el-table-column prop="promptTokens" label="Prompt" width="100" align="right" />
            <el-table-column prop="completionTokens" label="补全" width="100" align="right" />
            <el-table-column prop="totalTokens" label="总Token" width="100" align="right" />
            <el-table-column label="耗时" width="110" align="right">
              <template #default="{ row }">{{ fmtMs(row.latencyMs) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'success' ? 'success' : 'danger'" size="small" effect="plain">
                  {{ row.status === 'success' ? '成功' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="errorMessage" label="错误" min-width="200" show-overflow-tooltip />
          </el-table>
          <el-pagination
            class="mt"
            background
            layout="prev, total, next"
            :total="sampleRows.length"
            :page-size="pageSize"
            :current-page="page"
            @current-change="(p: number) => (page = p)"
          />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { llmConfigApi, llmLogApi, type LlmSetting, type LlmCallLog, type LlmLogStats } from '@/api';

/** 调试时可一次性加载的记录上限（客户端聚合用） */
const SAMPLE_CAP = 1000;
const PAGE_FETCH = 200;

const PURPOSE_LABELS: Record<string, string> = {
  discover: '实体发现',
  audit: '入库审核',
  judge: '对齐判决',
  facts: '事实抽取',
  relations: '关系抽取',
  extract: '抽取(旧管线)',
  'geo-report': 'GEO 报告',
  test: '连通测试',
};
const PURPOSE_OPTIONS = Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }));
const purposeLabel = (p: string) => PURPOSE_LABELS[p] ?? p;

const settings = ref<LlmSetting[]>([]);
const range = ref<[string, string] | null>(null);
const f = reactive<{ settingId?: number; status?: string; purpose?: string }>({});
const tab = ref('overview');
const autoRefresh = ref(false);
const lastLoadedAt = ref('');
const loading = ref(false);

const stats = ref<LlmLogStats>({
  totals: { calls: 0, success: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, avgLatencyMs: 0 },
  bySetting: [],
  byDay: [],
});
const sampleRows = ref<LlmCallLog[]>([]);
const sampleCapped = ref(false);

const page = ref(1);
const pageSize = ref(20);

const fmt = (n: number) => Number(n ?? 0).toLocaleString('en-US');
const fmtMs = (n: number) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}s` : `${fmt(n)}ms`);
const pct = (v: number, max: number) => `${Math.round((v / Math.max(1, max)) * 100)}%`;

// ---------------------------------------------------------------- 指标

const successRate = computed(() => {
  const t = stats.value.totals;
  return t.calls ? Number(((t.success / t.calls) * 100).toFixed(1)) : 0;
});

const p95 = computed(() => {
  const arr = sampleRows.value.map((r) => Number(r.latencyMs)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1)];
});

// ---------------------------------------------------------------- 聚合

interface Agg {
  key: string;
  label: string;
  calls: number;
  success: number;
  errors: number;
  errorRate: number;
  avgLatency: number;
  maxLatency: number;
  totalTokens: number;
}

function aggregate(rows: LlmCallLog[], keyOf: (r: LlmCallLog) => string, labelOf: (k: string) => string): Agg[] {
  const map = new Map<string, Agg & { _sumLatency: number }>();
  for (const r of rows) {
    const key = keyOf(r) || '(空)';
    const cur =
      map.get(key) ??
      { key, label: labelOf(key), calls: 0, success: 0, errors: 0, errorRate: 0, avgLatency: 0, maxLatency: 0, totalTokens: 0, _sumLatency: 0 };
    cur.calls += 1;
    if (r.status === 'error') cur.errors += 1;
    else cur.success += 1;
    cur._sumLatency += Number(r.latencyMs);
    cur.maxLatency = Math.max(cur.maxLatency, Number(r.latencyMs));
    cur.totalTokens += Number(r.totalTokens);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((a) => ({
      key: a.key,
      label: a.label,
      calls: a.calls,
      success: a.success,
      errors: a.errors,
      errorRate: a.calls ? Number(((a.errors / a.calls) * 100).toFixed(1)) : 0,
      avgLatency: a.calls ? Math.round(a._sumLatency / a.calls) : 0,
      maxLatency: a.maxLatency,
      totalTokens: a.totalTokens,
    }))
    .sort((a, b) => b.calls - a.calls);
}

const purposeRows = computed(() => aggregate(sampleRows.value, (r) => r.purpose, purposeLabel));
const maxPurposeCalls = computed(() => Math.max(1, ...purposeRows.value.map((p) => p.calls)));
const maxPurposeLatency = computed(() => Math.max(1, ...purposeRows.value.map((p) => p.avgLatency)));

const slowest = computed(() =>
  [...sampleRows.value].sort((a, b) => Number(b.latencyMs) - Number(a.latencyMs)).slice(0, 10),
);

const errorRows = computed(() => sampleRows.value.filter((r) => r.status === 'error'));

const errorGroups = computed(() => {
  const map = new Map<string, { message: string; count: number; purposes: Set<string>; models: Set<string> }>();
  for (const r of errorRows.value) {
    const msg = (r.errorMessage ?? '(无错误信息)').slice(0, 160);
    const cur = map.get(msg) ?? { message: msg, count: 0, purposes: new Set<string>(), models: new Set<string>() };
    cur.count += 1;
    cur.purposes.add(purposeLabel(r.purpose));
    cur.models.add(r.model);
    map.set(msg, cur);
  }
  return [...map.values()]
    .map((g) => ({ ...g, purposes: [...g.purposes], models: [...g.models] }))
    .sort((a, b) => b.count - a.count);
});

// 按模型（来自服务端全量统计，权威）
const modelRows = computed(() => {
  const map = new Map<string, { key: string; label: string; calls: number; totalTokens: number }>();
  for (const s of stats.value.bySetting) {
    const label = s.settingName || `模型:${s.model}`;
    const key = String(s.settingId ?? s.model);
    const cur = map.get(key) ?? { key, label, calls: 0, totalTokens: 0 };
    cur.calls += Number(s.calls);
    cur.totalTokens += Number(s.totalTokens);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls);
});
const maxModelCalls = computed(() => Math.max(1, ...modelRows.value.map((m) => m.calls)));

// 耗时分布
const latencyBuckets = computed(() => {
  const defs = [
    { label: '< 2s', max: 2000, danger: false },
    { label: '2 ~ 10s', max: 10000, danger: false },
    { label: '10 ~ 30s', max: 30000, danger: false },
    { label: '30 ~ 60s', max: 60000, danger: false },
    { label: '1 ~ 3min', max: 180000, danger: true },
    { label: '> 3min', max: Infinity, danger: true },
  ];
  const rows = defs.map((d) => ({ ...d, count: 0 }));
  for (const r of sampleRows.value) {
    const ms = Number(r.latencyMs);
    const idx = rows.findIndex((b) => ms < b.max);
    rows[idx < 0 ? rows.length - 1 : idx].count += 1;
  }
  return rows;
});
const maxBucket = computed(() => Math.max(1, ...latencyBuckets.value.map((b) => b.count)));

// 明细（客户端分页）
const pagedRows = computed(() => sampleRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

// ---------------------------------------------------------------- 按日趋势（沿用服务端 byDay）

const chart = computed(() => {
  const W = 760,
    H = 280,
    padL = 52,
    padR = 52,
    padT = 18,
    padB = 38;
  const innerW = W - padL - padR,
    innerH = H - padT - padB;
  const days = stats.value.byDay;
  const n = days.length;
  const maxT = Math.max(1, ...days.map((d) => Number(d.totalTokens)));
  const maxC = Math.max(1, ...days.map((d) => Number(d.calls)));
  const slot = n ? innerW / n : innerW;
  const barW = Math.min(22, slot * 0.5);
  const pts = days.map((d, i) => {
    const cx = padL + slot * i + slot / 2;
    const yT = padT + innerH - (Number(d.totalTokens) / maxT) * innerH;
    const hC = (Number(d.calls) / maxC) * innerH;
    return {
      cx,
      yT,
      hC,
      bx: cx - barW / 2,
      yB: padT + innerH - hC,
      day: String(d.day).slice(5),
      tokens: Number(d.totalTokens),
      calls: Number(d.calls),
      showLabel: n <= 16 || i % 2 === 0,
    };
  });
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.yT.toFixed(1)}`).join(' ');
  const areaPath = pts.length
    ? `M${pts[0].cx.toFixed(1)},${padT + innerH} ` +
      pts.map((p) => `L${p.cx.toFixed(1)},${p.yT.toFixed(1)}`).join(' ') +
      ` L${pts[pts.length - 1].cx.toFixed(1)},${padT + innerH} Z`
    : '';
  const gridY = [0, 1, 2, 3].map((k) => {
    const y = padT + innerH - (k / 3) * innerH;
    return { y, tTokens: Math.round((maxT * k) / 3), tCalls: Math.round((maxC * k) / 3) };
  });
  return { W, H, padL, padR, padT, padB, barW, pts, linePath, areaPath, gridY };
});

// ---------------------------------------------------------------- 实时日志（增量轮询）

/** 实时面板缓冲上限 */
const LIVE_CAP = 300;
const LIVE_PAGE = 50;

const liveRows = ref<LlmCallLog[]>([]);
const liveOn = ref(true);
const liveInterval = ref(2000);
const liveOnlyError = ref(false);
const liveNewCount = ref(0);
const liveErrorCount = ref(0);
const freshIds = ref<Set<number>>(new Set());

let lastLiveId = 0;
let liveTimer: number | null = null;
let liveBusy = false;

const visibleLiveRows = computed(() =>
  liveOnlyError.value ? liveRows.value.filter((r) => r.status === 'error') : liveRows.value,
);

const timeOf = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleTimeString('zh-CN', { hour12: false });
};

/** 拉一页最新日志，把比 lastLiveId 新的追加到顶部（首轮建立基线） */
async function pollLive() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const r = await llmLogApi.list({ ...filterParams(), page: 1, pageSize: LIVE_PAGE });
    const fresh = r.items.filter((x) => Number(x.id) > lastLiveId);
    if (!fresh.length) return;
    lastLiveId = Math.max(lastLiveId, ...fresh.map((x) => Number(x.id)));
    liveRows.value = [...fresh, ...liveRows.value].slice(0, LIVE_CAP);
    liveNewCount.value += fresh.length;
    liveErrorCount.value += fresh.filter((x) => x.status === 'error').length;
    // 新到行短暂高亮，便于肉眼捕捉
    const ids = new Set(fresh.map((x) => Number(x.id)));
    freshIds.value = ids;
    window.setTimeout(() => {
      for (const id of ids) freshIds.value.delete(id);
    }, 1600);
  } catch {
    /* 轮询失败静默，下一轮重试 */
  } finally {
    liveBusy = false;
  }
}

function resetLive() {
  lastLiveId = 0;
  liveRows.value = [];
  liveNewCount.value = 0;
  liveErrorCount.value = 0;
  freshIds.value = new Set();
}

function clearLive() {
  liveRows.value = [];
  liveNewCount.value = 0;
  liveErrorCount.value = 0;
  freshIds.value = new Set();
}

function applyLive() {
  if (liveTimer) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  if (!liveOn.value) return;
  liveTimer = window.setInterval(() => void pollLive(), liveInterval.value);
}

watch([liveOn, liveInterval], () => {
  applyLive();
});

// ---------------------------------------------------------------- 取数

function filterParams() {
  return {
    settingId: f.settingId,
    status: f.status,
    purpose: f.purpose,
    from: range.value?.[0],
    to: range.value?.[1],
  };
}

/** 分页拉取样本（用于客户端聚合），上限 SAMPLE_CAP */
async function fetchSample(): Promise<LlmCallLog[]> {
  const out: LlmCallLog[] = [];
  for (let p = 1; out.length < SAMPLE_CAP; p += 1) {
    const r = await llmLogApi.list({ ...filterParams(), page: p, pageSize: PAGE_FETCH });
    out.push(...r.items);
    if (r.items.length < PAGE_FETCH || out.length >= r.total) break;
  }
  sampleCapped.value = out.length >= SAMPLE_CAP;
  return out.slice(0, SAMPLE_CAP);
}

async function query() {
  loading.value = true;
  try {
    const [s, rows] = await Promise.all([llmLogApi.stats(filterParams()), fetchSample()]);
    stats.value = s;
    sampleRows.value = rows;
    page.value = 1;
    // 提高实时基线，避免实时面板重复推入这些已加载的记录
    if (rows.length) lastLiveId = Math.max(lastLiveId, ...rows.map((r) => Number(r.id)));
    lastLoadedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } finally {
    loading.value = false;
  }
}

function reset() {
  f.settingId = undefined;
  f.status = undefined;
  f.purpose = undefined;
  range.value = null;
  resetLive();
  query();
}

// 指标自动刷新：盯着错误与耗时变化
let timer: number | null = null;
function applyAuto() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
  if (autoRefresh.value) timer = window.setInterval(() => void query(), 5000);
}
watch(autoRefresh, applyAuto);

onMounted(async () => {
  settings.value = await llmConfigApi.list();
  await query();
  // 首屏用最新一页做基线，之后只追加新到的调用
  liveRows.value = sampleRows.value.slice(0, LIVE_PAGE);
  applyLive();
});
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (liveTimer) window.clearInterval(liveTimer);
});
</script>

<style scoped>
.page { padding: 18px; }
.filters { margin-bottom: 8px; }
.auto { margin-left: 12px; }
.cards { margin: 12px 0; }
.tabs :deep(.el-tabs__header) { margin-bottom: 12px; }
.chart-card { border-radius: 10px; margin-bottom: 14px; }
.chart-title { font-weight: 700; font-size: 14px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.ok { color: #67c23a; }
.err-num { color: #f56c6c; font-weight: 700; }
.warn-num { color: #e6a23c; font-weight: 600; }
.live-card :deep(.el-card__header) { padding: 10px 14px; }
.live-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.live-ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.live-list { max-height: 300px; overflow-y: auto; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.live-row {
  display: flex; align-items: center; gap: 10px; padding: 3px 8px;
  border-bottom: 1px dashed #f0f2f5; white-space: nowrap;
  transition: background-color .6s ease;
}
.live-row.fresh { background: #ecf5ff; }
.live-row.err { background: #fef0f0; }
.lv-time { flex: none; width: 78px; color: #6b7280; }
.lv-model { flex: none; width: 130px; overflow: hidden; text-overflow: ellipsis; color: #3c4654; }
.lv-purpose { flex: none; width: 76px; color: #409eff; }
.lv-task { flex: none; width: 56px; color: #909399; }
.lv-latency { flex: none; width: 66px; text-align: right; }
.lv-tokens { flex: none; width: 88px; text-align: right; color: #6b7280; }
.lv-status { flex: none; width: 42px; color: #67c23a; }
.live-row.err .lv-status { color: #f56c6c; font-weight: 700; }
.lv-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; color: #f56c6c; }
.hbar-list { display: flex; flex-direction: column; gap: 14px; }
.hbar-row { display: flex; align-items: center; gap: 10px; }
.hbar-label {
  width: 150px; flex: none; font-size: 12.5px; color: #3c4654;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hbar-track { flex: 1; background: #f0f2f5; border-radius: 6px; height: 22px; position: relative; }
.hbar-fill {
  height: 100%; border-radius: 6px; background: linear-gradient(90deg, #409eff, #66b1ff);
  min-width: 2px; display: flex; align-items: center; justify-content: flex-end;
  padding-right: 6px; transition: width .4s ease;
}
.hbar-fill.alt { background: linear-gradient(90deg, #e6a23c, #f3d19e); }
.hbar-val { font-size: 11.5px; color: #fff; white-space: nowrap; }
.hist { display: flex; flex-direction: column; gap: 10px; }
.hist-row { display: flex; align-items: center; gap: 10px; }
.hist-label { width: 76px; flex: none; font-size: 12.5px; color: #3c4654; }
.hist-track { flex: 1; background: #f0f2f5; border-radius: 6px; height: 20px; }
.hist-fill {
  height: 100%; border-radius: 6px; background: linear-gradient(90deg, #67c23a, #95d475);
  min-width: 2px; display: flex; align-items: center; justify-content: flex-end;
  padding-right: 6px; transition: width .4s ease;
}
.hist-fill.danger { background: linear-gradient(90deg, #f56c6c, #fab6b6); }
.svg-wrap { width: 100%; }
.trend-svg { width: 100%; height: 300px; }
.grid { stroke: #eef0f3; stroke-width: 1; }
.axis-l { fill: #409eff; font-size: 10px; text-anchor: end; }
.axis-r { fill: #67c23a; font-size: 10px; text-anchor: start; }
.axis-x { fill: #6b7280; font-size: 10px; text-anchor: middle; }
.bar { fill: #c9e2b3; }
.area { fill: rgba(64, 158, 255, 0.12); }
.line { fill: none; stroke: #409eff; stroke-width: 2; }
.dot { fill: #409eff; }
.legend { display: flex; gap: 20px; margin-top: 6px; font-size: 12px; color: #6b7280; }
.legend .lg-line::before, .legend .lg-bar::before {
  content: ''; display: inline-block; width: 14px; height: 8px; margin-right: 6px; vertical-align: middle; border-radius: 2px;
}
.legend .lg-line::before { background: #409eff; }
.legend .lg-bar::before { background: #c9e2b3; }
.mt { margin-top: 12px; }
</style>
