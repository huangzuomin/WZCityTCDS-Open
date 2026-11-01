<template>
  <section class="page active" aria-label="AI 引用观察">
    <div class="page-head">
      <div>
        <p class="eyebrow">AI CITATION OBSERVATORY</p>
        <h1>AI 引用观察</h1>
        <p>从外部模型答案里检查城市事实有没有被正确理解与引用。数据来自固定问题集的真实探测跑批。</p>
      </div>
      <span class="page-head-tag">真实探测数据 · {{ snapshot?.generatedAt ? fmtDate(snapshot.generatedAt) : '—' }}</span>
    </div>

    <div class="observe-grid">
      <div class="panel wide-observe">
        <div class="panel-heading">
          <div>
            <h3>引用变化趋势</h3>
            <p class="helper">近 4 周真实探测观测，按周统计被正确引用的比例</p>
          </div>
          <span class="legend"><i></i>引用正确率（真实）</span>
        </div>
        <div class="chart-area">
          <div class="chart-guides"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
          <div class="bar-chart">
            <div v-for="d in weeklyBars" :key="d.label" class="bar-col">
              <div :class="['bar', { 'is-empty': d.value == null }]" :style="{ height: (d.value ?? 0) + '%' }">
                <span>{{ d.value == null ? '—' : d.value + '%' }}</span>
              </div>
              <div class="bar-label">{{ d.label }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel observe-aside">
        <div class="eyebrow">QUALITY OVER VOLUME</div>
        <h3>被引用，不等于被说对。</h3>
        <p>事实服务不仅观察有无提及，也应核对引用来源是否正确、时间口径是否匹配、过时信息是否被重复传播。</p>
        <div class="observe-legend"><span class="mini-dot teal"></span>命中事实页 / 同域内容</div>
        <div class="observe-legend"><span class="mini-dot orange"></span>其他来源</div>
        <div class="observe-legend"><span class="mini-dot purple"></span>未引用</div>
        <div class="drawer-fact-meta" style="margin-top:22px">
          <span class="tag green">引用率 {{ pct(snapshot?.metrics.citationRate ?? null) }}</span>
          <span class="tag gray">样本 {{ snapshot?.metrics.citationRateBase ?? 0 }} 题</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-heading">
          <h3>固定问题集观测</h3>
          <span class="helper">按问题 × 模型判定引用命中</span>
        </div>
        <div v-if="!snapshot?.questions?.length" class="empty-block">暂无固定问题集数据</div>
        <div
          v-for="q in snapshot?.questions?.slice(0, 6)"
          :key="q.id"
          class="monitor-item"
        >
          <span :class="['tag', questionColor(q)]">{{ questionLabel(q) }}</span>
          <div>
            <strong>{{ q.question }}</strong>
            <p>期望：{{ q.expectedAnswer }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { observatoryApi, type ObservatorySnapshot } from '@/api';

const snapshot = ref<ObservatorySnapshot | null>(null);

const fmtDate = (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false });
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** 近 4 周引用变化：真实探测数据按周分桶（该周无样本时显示 —） */
const weeklyBars = computed(() =>
  (snapshot.value?.weeklyStats ?? []).map((w) => ({
    label: w.label,
    value: w.rate == null ? null : Math.round(w.rate * 100),
  })),
);

const CITE_LABEL: Record<string, string> = {
  fact_page: '命中事实页',
  same_domain: '命中同域',
  other: '其他源',
  none: '未引用',
};
const CITE_COLOR: Record<string, string> = {
  fact_page: 'green',
  same_domain: 'green',
  other: 'orange',
  none: 'purple',
};

/** 一个问题行取首个非 none 的模型结论作为代表色 */
function questionStatus(q: { byModel: Record<string, string> }) {
  const vals = Object.values(q.byModel || {});
  if (vals.includes('fact_page') || vals.includes('same_domain')) return 'fact_page';
  if (vals.includes('other')) return 'other';
  return 'none';
}
const questionColor = (q: { byModel: Record<string, string> }) => CITE_COLOR[questionStatus(q)] || 'gray';
const questionLabel = (q: { byModel: Record<string, string> }) => CITE_LABEL[questionStatus(q)] || '—';

onMounted(async () => {
  try {
    snapshot.value = await observatoryApi.snapshot();
  } catch {
    snapshot.value = null;
  }
});
</script>

<style scoped>
/* 该周无探测样本：弱化为灰柱并显示 — */
.bar.is-empty {
  background: #c9d4da;
  opacity: 0.55;
}
.bar.is-empty > span {
  color: #a4b2be;
}
</style>
