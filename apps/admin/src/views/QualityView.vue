<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">质量看板 · 瓯菜抽取六维评估</h2>
        <div class="page-desc">
          基于 885 篇语料、943 条抽取草稿的全量校验结果 —— 忠实性 / 归属正确性 / 字段符合 / 信息量 / 支持度 / 自评校准
        </div>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <el-alert
      v-if="errMsg"
      class="mt"
      type="error"
      :title="errMsg"
      show-icon
      :closable="false"
    />

    <template v-if="report">
      <!-- 总览指标卡 -->
      <el-row :gutter="16" class="mt">
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">整体通过率</div>
            <div class="stat-value" :class="toneClass(report.summary.passRate)">{{ report.summary.passRate }}%</div>
            <div class="stat-sub">{{ fmtNum(report.summary.passedDrafts) }} 通过 / {{ fmtNum(report.summary.draftTotal) }} 草稿</div>
          </el-card>
        </el-col>
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">草稿总数</div>
            <div class="stat-value">{{ fmtNum(report.summary.draftTotal) }}</div>
            <div class="stat-sub">拦截 {{ fmtNum(report.summary.rejectedDrafts) }} 条</div>
          </el-card>
        </el-col>
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">已采纳事实</div>
            <div class="stat-value">{{ fmtNum(report.summary.factActive) }}</div>
            <div class="stat-sub">落库 active</div>
          </el-card>
        </el-col>
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">待人工审核</div>
            <div class="stat-value warning">{{ fmtNum(report.summary.factReview) }}</div>
            <div class="stat-sub">置信度低 · pending_review</div>
          </el-card>
        </el-col>
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">事实总数</div>
            <div class="stat-value">{{ fmtNum(report.summary.factTotal) }}</div>
            <div class="stat-sub">active + 待审</div>
          </el-card>
        </el-col>
        <el-col :span="4">
          <el-card shadow="never" class="stat-card">
            <div class="stat-label">维度覆盖</div>
            <div class="stat-value">{{ coveredDims }} / 7</div>
            <div class="stat-sub">七口径维度分布</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 六个质量维度 -->
      <el-card shadow="never" class="mt">
        <div class="section-title"><span>六个质量维度</span></div>
        <el-row :gutter="16">
          <el-col v-for="d in dimensionCards" :key="d.key" :span="8" class="dim-col">
            <div class="dim-card">
              <div class="dim-head">
                <span class="dim-name">{{ d.label }}</span>
                <span class="dim-value" :class="toneClass(d.value)">{{ d.unit ? d.value + ' ' + d.unit : d.value + '%' }}</span>
              </div>
              <div class="dim-sub muted">{{ d.sub }}</div>
              <div class="dim-track">
                <div class="dim-bar" :class="toneClass(d.value, true)" :style="{ width: clampPct(d.barPct) + '%' }"></div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-card>

      <!-- 规则通过率 -->
      <el-card shadow="never" class="mt">
        <div class="section-title">
          <span>校验规则通过率</span>
          <span class="hint">共 {{ report.rules.length }} 条规则 · 全量 943 草稿逐条校验</span>
        </div>
        <div class="rule-list">
          <div v-for="r in ruleRows" :key="r.code" class="rule-item">
            <div class="rule-head">
              <span class="rule-code">{{ r.label }}</span>
              <span class="rule-rate mono" :class="toneClass(r.passRate)">{{ r.passRate }}%</span>
            </div>
            <div class="rule-track">
              <div class="rule-bar" :class="toneClass(r.passRate, true)" :style="{ width: r.passRate + '%' }"></div>
            </div>
            <div class="rule-meta muted">
              通过 {{ fmtNum(r.passed) }} / {{ fmtNum(r.total) }}
              <template v-if="r.failed > 0">· 拦截 <span class="danger">{{ fmtNum(r.failed) }}</span></template>
            </div>
          </div>
        </div>
      </el-card>

      <!-- 字段维度分布 -->
      <el-card shadow="never" class="mt">
        <div class="section-title"><span>口径维度 · 字段分布</span></div>
        <el-table :data="dimRows" border size="small">
          <el-table-column label="维度" min-width="120">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="字段数" width="110" align="right">
            <template #default="{ row }"><span class="mono">{{ fmtNum(row.count) }}</span></template>
          </el-table-column>
          <el-table-column label="已采纳" width="100" align="right">
            <template #default="{ row }"><span class="mono ok">{{ fmtNum(row.active) }}</span></template>
          </el-table-column>
          <el-table-column label="待审" width="90" align="right">
            <template #default="{ row }"><span class="mono warn">{{ fmtNum(row.review) }}</span></template>
          </el-table-column>
          <el-table-column label="采纳占比" min-width="160">
            <template #default="{ row }">
              <div class="mini-track">
                <div class="mini-bar" :class="toneClass(row.activeRate)" :style="{ width: row.activeRate + '%' }"></div>
              </div>
              <span class="mono small">{{ row.activeRate }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="平均 N 值" width="120" align="right">
            <template #default="{ row }"><span class="mono">{{ row.avgN }}</span></template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-empty v-else-if="!loading" description="暂无质量数据" :image-size="80" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { qualityApi, type QualityReport } from '@/api';

const report = ref<QualityReport | null>(null);
const loading = ref(false);
const errMsg = ref('');

const DIM_LABELS: Record<string, string> = {
  belonging: '归属',
  main_ingredients: '主料',
  core_technique: '核心技法',
  flavor_features: '口味特征',
  origin_story: '起源故事',
  appearance: '外观',
  quality_notes: '品质评价',
};

const RULE_LABELS: Record<string, string> = {
  R1_QUOTE_VERBATIM: 'R1 引文逐字接地',
  R2_SUBJECT_ANCHOR: 'R2 主语锚定',
  R3_SPAN_BOUNDS: 'R3 跨度边界',
  R4_CONFIDENCE_RANGE: 'R4 置信度区间',
  R5_QUOTE_LENGTH: 'R5 引文长度',
  R6_TIME_PRESENT: 'R6 时间要素',
  R7_CONFIDENCE_MIN: 'R7 置信度下限',
  X1_NAME_SPLIT: 'X1 菜名拆解',
  X2_VALUE_LENGTH: 'X2 取值长度',
  X3_FIELD_ROUTING: 'X3 字段路由',
  X4_COOCCURRENCE: 'X4 共现误归因',
  X5_QUALITY_ANCHOR: 'X5 品质锚点',
  X6_ENTITY_TYPE: 'X6 实体类型',
};

// ---------------------------------------------------------------- 计算

const coveredDims = computed(() => report.value?.byDimension.filter((d) => d.count > 0).length ?? 0);

const dimensionCards = computed(() => {
  const m = report.value?.metrics;
  const dims = report.value?.byDimension ?? [];
  const infoCoverage = dims.length ? (dims.filter((d) => d.count > 0).length / dims.length) * 100 : 0;
  const supportN = dims.length
    ? dims.reduce((a, d) => a + (Number(d.avgN) || 0), 0) / dims.length
    : 0;
  const base: { key: string; label: string; sub: string; value: number; unit?: string; barPct: number }[] = [
    { key: 'faithfulness', label: '忠实性', sub: '引文逐字接地 · R1', value: m?.faithfulness ?? 0, barPct: m?.faithfulness ?? 0 },
    { key: 'attribution', label: '归属正确性', sub: '主语锚定 + 作用域 · R2', value: m?.attribution ?? 0, barPct: m?.attribution ?? 0 },
    { key: 'fieldRouting', label: '字段符合', sub: '维度归属零误放 · X3', value: m?.fieldRouting ?? 0, barPct: m?.fieldRouting ?? 0 },
    { key: 'info', label: '信息量', sub: '叙事维度字段分布覆盖', value: Number(infoCoverage.toFixed(1)), unit: '%', barPct: infoCoverage },
    { key: 'support', label: '支持度', sub: '事实平均 N 值', value: Number(supportN.toFixed(2)), unit: 'N', barPct: Math.min(100, (supportN / 5) * 100) },
    { key: 'calibration', label: '自评校准', sub: '置信度下限通过 · R7', value: m?.confidenceMin ?? 0, barPct: m?.confidenceMin ?? 0 },
  ];
  return base;
});

const ruleRows = computed(() => {
  const rules = report.value?.rules ?? [];
  return rules.map((r) => {
    const total = Number(r.total) || 0;
    const failed = Number(r.failed) || 0;
    const passed = Math.max(0, total - failed);
    const passRate = total ? Number(((passed / total) * 100).toFixed(1)) : 100;
    return {
      code: r.ruleCode,
      label: RULE_LABELS[r.ruleCode] ?? r.ruleCode,
      total,
      failed,
      passed,
      passRate,
    };
  });
});

const dimRows = computed(() => {
  const dims = report.value?.byDimension ?? [];
  const max = Math.max(...dims.map((d) => d.count), 1);
  return dims.map((d) => {
    const activeRate = d.count ? Number(((d.active / d.count) * 100).toFixed(1)) : 0;
    return {
      ...d,
      label: DIM_LABELS[d.dimension] ?? d.dimension,
      activeRate,
      pct: d.count ? (d.count / max) * 100 : 0,
      avgN: Number(d.avgN ?? 0).toFixed(2),
    };
  });
});

// ---------------------------------------------------------------- 展示辅助

const toneClass = (v: number, isBar = false) => {
  const tone = v >= 98 ? 'good' : v >= 90 ? 'ok' : v >= 80 ? 'warn' : 'bad';
  return isBar ? `bar-${tone}` : `val-${tone}`;
};
const clampPct = (v: number) => Math.min(100, Math.max(3, v));

const fmtNum = (n: number | null | undefined) => Number(n ?? 0).toLocaleString('zh-CN');

// ---------------------------------------------------------------- 加载

async function load() {
  loading.value = true;
  errMsg.value = '';
  try {
    report.value = await qualityApi.report();
  } catch (e: any) {
    errMsg.value = e?.message ? `加载失败：${e.message}` : '加载质量数据失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.mt { margin-top: 16px; }
.muted { color: #8a97a5; }
.small { font-size: 12px; }
.mono { font-family: Consolas, Monaco, 'Courier New', monospace; font-size: 12px; }
.hint { font-size: 12px; color: #8a94a6; }
.danger { color: #f56c6c; }
.warn { color: #e6a23c; }
.ok { color: #67c23a; }

/* 指标卡 */
.stat-card { border-top: 3px solid #0b5cab; }
.stat-label { font-size: 13px; color: #8a94a6; }
.stat-value { font-size: 26px; font-weight: 700; margin-top: 6px; }
.stat-value.warning { color: #e6a23c; }
.stat-sub { margin-top: 4px; font-size: 12px; color: #8a97a5; }

/* 数值配色 */
.val-good { color: #67c23a; }
.val-ok { color: #0b5cab; }
.val-warn { color: #e6a23c; }
.val-bad { color: #f56c6c; }

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: #1d2b3a;
  margin-bottom: 14px;
}

/* 六维度卡 */
.dim-col { margin-bottom: 12px; }
.dim-card {
  background: #fff;
  border: 1px solid #e3e7ec;
  border-radius: 4px;
  padding: 12px 14px;
}
.dim-head { display: flex; align-items: baseline; justify-content: space-between; }
.dim-name { font-size: 14px; font-weight: 600; color: #1d2b3a; }
.dim-value { font-size: 20px; font-weight: 700; }
.dim-sub { font-size: 12px; color: #8a97a5; margin: 2px 0 8px; }
.dim-track { height: 8px; background: #eef1f5; border-radius: 4px; overflow: hidden; }
.dim-bar { height: 100%; border-radius: 4px; }
.bar-good { background: #67c23a; }
.bar-ok { background: #0b5cab; }
.bar-warn { background: #e6a23c; }
.bar-bad { background: #f56c6c; }

/* 规则通过率 */
.rule-list { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 28px; }
.rule-item { display: flex; flex-direction: column; gap: 4px; }
.rule-head { display: flex; align-items: baseline; justify-content: space-between; }
.rule-code { font-size: 13px; font-weight: 500; color: #1d2b3a; }
.rule-rate { font-size: 13px; font-weight: 700; }
.rule-track { height: 8px; background: #eef1f5; border-radius: 4px; overflow: hidden; }
.rule-bar { height: 100%; border-radius: 4px; }
.rule-meta { font-size: 12px; }

/* 维度分布 */
.mini-track { height: 8px; background: #eef1f5; border-radius: 4px; overflow: hidden; display: inline-block; width: 70%; vertical-align: middle; margin-right: 8px; }
.mini-bar { height: 100%; border-radius: 4px; }
</style>
