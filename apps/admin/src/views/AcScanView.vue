<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">AC 扫描 · 实体命中与上下文</h2>
        <div class="page-desc">
          文章归一化 → AC 自动机全局匹配 → 最长匹配过滤嵌套 → 句子窗口合并 → 上下文窗口（LLM 抽取调用单元）
        </div>
      </div>
      <div class="header-actions">
        <el-button type="primary" :icon="CaretRight" :disabled="isRunning" @click="confirmRun">
          触发全量扫描
        </el-button>
        <el-button :icon="Refresh" :loading="loading" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <!-- 任务运行状态 -->
    <el-card v-if="job" shadow="never" class="job-card">
      <div class="job-line">
        <el-tag size="small" :type="JOB_TAG[job.status]" effect="dark">
          {{ JOB_LABEL[job.status] }}
        </el-tag>
        <span class="muted small">任务 #{{ job.id }}</span>
        <template v-if="job.status === 'running'">
          <el-progress
            class="job-progress"
            :percentage="progressPct"
            :stroke-width="14"
            :format="(p: number) => `${p.toFixed(1)}%`"
          />
          <span class="mono small">{{ fmtNum(job.articleScanned) }} / {{ fmtNum(job.articleTotal) }} 篇</span>
        </template>
        <template v-else>
          <span class="muted small">
            建树 {{ fmtNum(job.patternCount) }} 词条 · {{ fmtMs(job.buildMs) }} ｜ 扫描 {{ fmtMs(job.scanMs) }}
          </span>
          <span class="muted small">
            {{ job.startedAt ? fmtTime(job.startedAt) : '' }}
            <template v-if="job.finishedAt"> → {{ fmtTime(job.finishedAt) }}</template>
          </span>
        </template>
      </div>
      <div v-if="job.status === 'failed' && job.errorMsg" class="job-error">{{ job.errorMsg }}</div>
    </el-card>
    <el-card v-else shadow="never" class="job-card">
      <div class="muted">还没有扫描任务 —— 点击右上角「触发全量扫描」开始</div>
    </el-card>

    <!-- 流水线各阶段 -->
    <div v-if="job" class="stages">
      <div class="stage">
        <div class="stage-label">语料文章</div>
        <div class="stage-value">{{ fmtNum(job.articleTotal) }}</div>
        <div class="stage-sub">已扫描 {{ fmtNum(job.articleScanned) }}</div>
      </div>
      <div class="stage-arrow">▸</div>
      <div class="stage">
        <div class="stage-label">AC 建树</div>
        <div class="stage-value">{{ fmtNum(job.patternCount) }}</div>
        <div class="stage-sub">Trie + BFS · {{ fmtMs(job.buildMs) }}</div>
      </div>
      <div class="stage-arrow">▸</div>
      <div class="stage">
        <div class="stage-label">原始命中</div>
        <div class="stage-value">{{ fmtNum(job.rawHitCount) }}</div>
        <div class="stage-sub">一遍全文扫描</div>
      </div>
      <div class="stage-arrow">▸</div>
      <div class="stage">
        <div class="stage-label">最长匹配保留</div>
        <div class="stage-value">{{ fmtNum(job.keptHitCount) }}</div>
        <div class="stage-sub danger" v-if="job.overlapFiltered">嵌套过滤 {{ fmtNum(job.overlapFiltered) }}</div>
        <div class="stage-sub" v-else>嵌套过滤 0</div>
      </div>
      <div class="stage-arrow">▸</div>
      <div class="stage">
        <div class="stage-label">句子窗口合并</div>
        <div class="stage-value">{{ fmtNum(job.contextCount) }}</div>
        <div class="stage-sub">同类别重叠合并</div>
      </div>
      <div class="stage-arrow">▸</div>
      <div class="stage done">
        <div class="stage-label">待 LLM 抽取</div>
        <div class="stage-value">{{ fmtNum(pendingCtx) }}</div>
        <div class="stage-sub">上下文窗口</div>
      </div>
    </div>

    <!-- 指标卡 -->
    <el-row v-if="stats" :gutter="16" class="mt">
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">命中文章</div>
          <div class="stat-value">{{ fmtNum(stats.job.hitArticleCount) }}</div>
          <div class="stat-sub">占语料 {{ hitRate }}%</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">保留命中</div>
          <div class="stat-value">{{ fmtNum(stats.job.keptHitCount) }}</div>
          <div class="stat-sub">平均 {{ keptPerArticle }} 次/命中文章</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">嵌套过滤</div>
          <div class="stat-value warning">{{ fmtNum(stats.job.overlapFiltered) }}</div>
          <div class="stat-sub">短词 ⊂ 长实体</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">上下文窗口</div>
          <div class="stat-value">{{ fmtNum(stats.job.contextCount) }}</div>
          <div class="stat-sub">LLM 调用单元</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">聚合压缩比</div>
          <div class="stat-value">{{ mergeRatio }}</div>
          <div class="stat-sub">命中 → 调用</div>
        </el-card>
      </el-col>
      <el-col :span="4">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">平均窗口</div>
          <div class="stat-value">{{ avgWindowChars }} <span class="stat-unit">字</span></div>
          <div class="stat-sub">窗口长度分布见下</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 实体排行 + 类别/窗口分布 -->
    <el-row v-if="stats" :gutter="16" class="mt">
      <el-col :span="12">
        <el-card shadow="never" class="board">
          <div class="section-title"><span>实体命中 TOP 15</span></div>
          <div v-if="stats.topEntities.length" class="rank-list">
            <div v-for="(e, i) in stats.topEntities" :key="e.entityId" class="rank-item">
              <span class="rank-no" :class="{ top: i < 3 }">{{ i + 1 }}</span>
              <span class="rank-name">{{ e.entityName }}</span>
              <el-tag size="small" effect="plain" class="rank-cat">{{ catLabel(e.categoryCode) }}</el-tag>
              <div class="rank-bar-track">
                <div class="rank-bar" :style="{ width: rankWidth(e.hits) }"></div>
              </div>
              <span class="rank-count mono">{{ fmtNum(e.hits) }}</span>
            </div>
          </div>
          <el-empty v-else description="暂无数据" :image-size="60" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never" class="board">
          <div class="section-title"><span>类别分布</span></div>
          <el-table :data="stats.categories" size="small" border>
            <el-table-column label="类别" min-width="90">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ catLabel(row.categoryCode) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="hits" label="保留命中" width="90" align="right">
              <template #default="{ row }"><span class="mono">{{ fmtNum(row.hits) }}</span></template>
            </el-table-column>
            <el-table-column prop="contexts" label="上下文窗口" width="100" align="right">
              <template #default="{ row }"><span class="mono">{{ fmtNum(row.contexts) }}</span></template>
            </el-table-column>
            <el-table-column prop="avgWindowChars" label="均窗(字)" width="85" align="right">
              <template #default="{ row }"><span class="mono">{{ row.avgWindowChars }}</span></template>
            </el-table-column>
            <el-table-column prop="avgMerge" label="均合并数" width="85" align="right">
              <template #default="{ row }"><span class="mono">{{ row.avgMerge }}</span></template>
            </el-table-column>
          </el-table>

          <div class="section-title mt"><span>窗口长度分布</span></div>
          <div class="len-bars">
            <div v-for="d in stats.lenDist" :key="d.bucket" class="len-item">
              <div class="len-label">{{ d.bucket }}</div>
              <div class="len-track">
                <div class="len-bar" :style="{ width: lenWidth(d.cnt) }"></div>
              </div>
              <div class="len-count mono">{{ fmtNum(d.cnt) }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 明细浏览 -->
    <el-card v-if="stats" shadow="never" class="mt">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="上下文窗口" name="contexts">
          <div class="toolbar">
            <el-select v-model="ctxFilter.category" placeholder="类别（全部）" clearable style="width: 150px" @change="reloadContexts">
              <el-option v-for="c in stats.categories" :key="c.categoryCode" :label="catLabel(c.categoryCode)" :value="c.categoryCode" />
            </el-select>
            <el-input
              v-model="ctxFilter.keyword"
              placeholder="窗口内容关键词"
              clearable
              style="width: 220px"
              @keyup.enter="reloadContexts"
              @clear="reloadContexts"
            />
            <el-button :icon="Search" @click="reloadContexts">查询</el-button>
            <span class="hint">共 {{ fmtNum(ctxTotal) }} 个窗口，点击行首展开查看高亮原文</span>
          </div>
          <el-table :data="ctxRows" v-loading="ctxLoading" border size="small" row-key="id">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="ctx-expand">
                  <div class="ctx-window" v-html="highlight(row.windowText, row.entityNames)"></div>
                  <div class="ctx-meta">
                    <span class="mono muted">pos {{ row.startPos }}-{{ row.endPos }} ｜ 原文 {{ row.windowChars }} 字</span>
                    <span class="muted">合并 {{ row.mergeCount }} 个命中窗口 ｜ 实体 {{ row.entityNames.join('、') }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="文章" min-width="260">
              <template #default="{ row }">
                <div class="ctx-title">{{ row.articleTitle ?? `#${row.articleId}` }}</div>
                <div class="muted small">{{ row.sourceOrg ?? '—' }} ｜ {{ row.publishedAt ?? '—' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="类别" width="90">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ catLabel(row.categoryCode) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="实体" min-width="200">
              <template #default="{ row }">
                <el-tag v-for="n in row.entityNames.slice(0, 3)" :key="n" size="small" class="ent-tag">{{ n }}</el-tag>
                <span v-if="row.entityNames.length > 3" class="muted small">+{{ row.entityNames.length - 3 }}</span>
              </template>
            </el-table-column>
            <el-table-column label="命中" width="60" align="center">
              <template #default="{ row }"><span class="mono">{{ row.hitCount }}</span></template>
            </el-table-column>
            <el-table-column label="窗口" width="70" align="center">
              <template #default="{ row }"><span class="mono">{{ row.windowChars }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'pending_llm' ? 'warning' : 'info'" effect="plain">
                  {{ row.status === 'pending_llm' ? '待抽取' : row.status === 'saturated_skip' ? '饱和跳过' : '已抽取' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="pager"
            layout="total, prev, pager, next, jumper"
            :total="ctxTotal"
            :page-size="ctxFilter.pageSize"
            :current-page="ctxFilter.page"
            @current-change="onCtxPage"
          />
        </el-tab-pane>

        <el-tab-pane label="命中明细" name="hits">
          <div class="toolbar">
            <el-radio-group v-model="hitFilter.filter" @change="reloadHits">
              <el-radio-button value="kept">保留命中</el-radio-button>
              <el-radio-button value="rejected">嵌套过滤</el-radio-button>
              <el-radio-button value="all">全部</el-radio-button>
            </el-radio-group>
            <el-select v-model="hitFilter.category" placeholder="类别（全部）" clearable style="width: 150px" @change="reloadHits">
              <el-option v-for="c in stats.categories" :key="c.categoryCode" :label="catLabel(c.categoryCode)" :value="c.categoryCode" />
            </el-select>
            <span class="hint">共 {{ fmtNum(hitTotal) }} 条</span>
          </div>
          <el-table :data="hitRows" v-loading="hitLoading" border size="small">
            <el-table-column label="实体" min-width="150">
              <template #default="{ row }">
                <span class="ent-name">{{ row.entityName }}</span>
                <el-tag size="small" effect="plain" class="rank-cat">{{ catLabel(row.categoryCode) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="命中文本" width="130">
              <template #default="{ row }"><span class="mono">{{ row.mention }}</span></template>
            </el-table-column>
            <el-table-column label="文章" min-width="280">
              <template #default="{ row }">
                <div class="ctx-title">{{ row.articleTitle ?? `#${row.articleId}` }}</div>
              </template>
            </el-table-column>
            <el-table-column label="位置" width="110" align="center">
              <template #default="{ row }"><span class="mono">{{ row.startPos }}-{{ row.endPos }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="130">
              <template #default="{ row }">
                <el-tag v-if="row.isKept" size="small" type="success" effect="plain">保留</el-tag>
                <el-tag v-else size="small" type="danger" effect="plain">嵌套短词</el-tag>
                <el-tag v-if="row.rejectReason === 'boundary_suspect'" size="small" type="warning" effect="plain">边界</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="窗口" width="80" align="center">
              <template #default="{ row }">
                <span v-if="row.contextId" class="mono">#{{ row.contextId }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            class="pager"
            layout="total, prev, pager, next, jumper"
            :total="hitTotal"
            :page-size="hitFilter.pageSize"
            :current-page="hitFilter.page"
            @current-change="onHitPage"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { CaretRight, Refresh, Search } from '@element-plus/icons-vue';
import { acscanApi, type AcContextItem, type AcHitItem, type AcScanJob, type AcScanStats } from '@/api';
import { useMetaStore } from '@/stores/meta';

const meta = useMetaStore();
const loading = ref(false);
const job = ref<AcScanJob | null>(null);
const stats = ref<AcScanStats | null>(null);
const activeTab = ref<'contexts' | 'hits'>('contexts');
let pollTimer: ReturnType<typeof setInterval> | null = null;

const ctxRows = ref<AcContextItem[]>([]);
const ctxTotal = ref(0);
const ctxLoading = ref(false);
const ctxFilter = ref({ category: '', keyword: '', page: 1, pageSize: 20 });

const hitRows = ref<AcHitItem[]>([]);
const hitTotal = ref(0);
const hitLoading = ref(false);
const hitFilter = ref<{ filter: 'kept' | 'rejected' | 'all'; category: string; page: number; pageSize: number }>({
  filter: 'kept',
  category: '',
  page: 1,
  pageSize: 20,
});

const CAT_LABELS: Record<string, string> = {
  dish: '菜品', dish_hot: '热菜', technique: '非遗技法', news: '新闻报道', video: '视频资料',
  food_street: '美食街区', food_ingredient: '食材', snack: '小吃', heritage: '非遗',
  person: '人物', place: '地名', concept: '概念',
};
const JOB_LABEL: Record<string, string> = { running: '扫描中', succeeded: '已完成', failed: '失败' };
const JOB_TAG: Record<string, string> = { running: 'warning', succeeded: 'success', failed: 'danger' };

// ---------------------------------------------------------------- 计算属性

const isRunning = computed(() => job.value?.status === 'running');
const progressPct = computed(() => {
  if (!job.value || !job.value.articleTotal) return 0;
  return (job.value.articleScanned / job.value.articleTotal) * 100;
});
const pendingCtx = computed(() => stats.value?.statusDist.find((s) => s.status === 'pending_llm')?.cnt ?? job.value?.contextCount ?? 0);
const hitRate = computed(() => {
  if (!job.value || !job.value.articleTotal) return '0';
  return ((job.value.hitArticleCount / job.value.articleTotal) * 100).toFixed(1);
});
const keptPerArticle = computed(() => {
  if (!job.value || !job.value.hitArticleCount) return '0';
  return (job.value.keptHitCount / job.value.hitArticleCount).toFixed(1);
});
const mergeRatio = computed(() => {
  if (!job.value?.contextCount) return '—';
  return (job.value.keptHitCount / job.value.contextCount).toFixed(1) + ' : 1';
});
const avgWindowChars = computed(() => {
  if (!stats.value?.categories.length) return '—';
  const total = stats.value.categories.reduce((a, c) => a + c.avgWindowChars * c.contexts, 0);
  const n = stats.value.categories.reduce((a, c) => a + c.contexts, 0);
  return n ? Math.round(total / n) : '—';
});

// ---------------------------------------------------------------- 数据加载

async function loadAll() {
  loading.value = true;
  try {
    await Promise.all([loadStats(), activeTab.value === 'contexts' ? reloadContexts() : reloadHits()]);
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  try {
    stats.value = await acscanApi.stats();
    job.value = stats.value.job;
    schedulePoll();
  } catch {
    // 无任务时 stats 会 404 → 只拉 latest job
    job.value = await acscanApi.latestJob();
  }
}

function schedulePoll() {
  stopPoll();
  if (isRunning.value) {
    pollTimer = setInterval(async () => {
      await loadStats();
      if (!isRunning.value) await loadAll();
    }, 3000);
  }
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function reloadContexts() {
  ctxLoading.value = true;
  try {
    const res = await acscanApi.contexts({
      category: ctxFilter.value.category || undefined,
      keyword: ctxFilter.value.keyword || undefined,
      page: ctxFilter.value.page,
      pageSize: ctxFilter.value.pageSize,
    });
    ctxRows.value = res.items;
    ctxTotal.value = res.total;
  } finally {
    ctxLoading.value = false;
  }
}

function onCtxPage(p: number) {
  ctxFilter.value.page = p;
  void reloadContexts();
}

async function reloadHits() {
  hitLoading.value = true;
  try {
    const res = await acscanApi.hits({
      filter: hitFilter.value.filter,
      category: hitFilter.value.category || undefined,
      page: hitFilter.value.page,
      pageSize: hitFilter.value.pageSize,
    });
    hitRows.value = res.items;
    hitTotal.value = res.total;
  } finally {
    hitLoading.value = false;
  }
}

function onHitPage(p: number) {
  hitFilter.value.page = p;
  void reloadHits();
}

// ---------------------------------------------------------------- 触发扫描

async function confirmRun() {
  const datasetId = Number(meta.datasets[0]?.id ?? 1);
  await ElMessageBox.confirm(
    `将对语料域 #${datasetId} 的全部文章执行 AC 扫描（建树 → 匹配 → 过滤 → 上下文窗口），后台执行，期间可实时查看进度。`,
    '触发全量扫描',
    { confirmButtonText: '开始扫描', cancelButtonText: '取消', type: 'info' },
  );
  const res = await acscanApi.run({ datasetId });
  await loadStats();
  activeTab.value = 'contexts';
  ElMessageBox.alert(`任务 #${res.jobId} 已启动，共 ${res.articleTotal} 篇文章。`, '已启动', {
    confirmButtonText: '知道了', type: 'success',
  });
}

// ---------------------------------------------------------------- 展示辅助

const catLabel = (code: string) => CAT_LABELS[code] ?? code;
const fmtNum = (n: number | null | undefined) => Number(n ?? 0).toLocaleString('zh-CN');
const fmtMs = (ms: number | null | undefined) => {
  const v = Number(ms ?? 0);
  return v >= 60000 ? `${Math.round(v / 60000)} 分钟` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
};
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');

const rankWidth = (hits: number) => {
  const max = stats.value?.topEntities[0]?.hits ?? 1;
  return `${Math.max(4, (hits / max) * 100)}%`;
};
const lenWidth = (cnt: number) => {
  const max = Math.max(...(stats.value?.lenDist.map((d) => d.cnt) ?? [1]), 1);
  return `${Math.max(3, (cnt / max) * 100)}%`;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 窗口文本按实体名高亮（长名优先，避免短名先命中） */
const highlight = (text: string, names: string[]) => {
  if (!names?.length) return escapeHtml(text);
  const sorted = [...names].sort((a, b) => b.length - a.length).map(escRe);
  const re = new RegExp(`(${sorted.join('|')})`, 'g');
  return escapeHtml(text).replace(re, '<mark>$1</mark>');
};

// ---------------------------------------------------------------- 生命周期

onMounted(async () => {
  void meta.ensureLoaded();
  await loadAll();
});
onBeforeUnmount(stopPoll);
</script>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
}
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
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 12px;
}
.hint {
  font-size: 12px;
  color: #8a94a6;
}
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.job-line {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.job-progress {
  flex: 1;
  min-width: 240px;
  max-width: 480px;
}
.job-error {
  margin-top: 10px;
  color: #f56c6c;
  font-size: 13px;
}

/* 流水线阶段 */
.stages {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.stage {
  flex: 1;
  min-width: 130px;
  background: #fff;
  border: 1px solid #e3e7ec;
  border-top: 3px solid #0b5cab;
  border-radius: 4px;
  padding: 10px 12px;
}
.stage.done {
  border-top-color: #67c23a;
}
.stage-label {
  font-size: 12px;
  color: #8a94a6;
}
.stage-value {
  font-size: 22px;
  font-weight: 700;
  margin-top: 2px;
}
.stage-sub {
  font-size: 11px;
  color: #8a97a5;
  margin-top: 2px;
}
.stage-sub.danger {
  color: #e6a23c;
}
.stage-arrow {
  align-self: center;
  color: #b3bcc7;
  font-size: 16px;
}

/* 指标卡 */
.stat-card {
  border-top: 3px solid #0b5cab;
}
.stat-label {
  font-size: 13px;
  color: #8a94a6;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  margin-top: 6px;
}
.stat-value.warning {
  color: #e6a23c;
}
.stat-unit {
  font-size: 13px;
  font-weight: 400;
  color: #8a97a5;
}
.stat-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #8a97a5;
}

/* 实体排行 */
.board {
  height: 100%;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: #1d2b3a;
  margin-bottom: 12px;
}
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rank-item {
  display: grid;
  grid-template-columns: 22px minmax(70px, auto) auto 1fr 56px;
  align-items: center;
  gap: 8px;
}
.rank-no {
  font-size: 12px;
  color: #8a97a5;
  text-align: center;
}
.rank-no.top {
  color: #0b5cab;
  font-weight: 700;
}
.rank-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rank-cat {
  flex-shrink: 0;
}
.rank-bar-track {
  height: 8px;
  background: #eef1f5;
  border-radius: 4px;
  overflow: hidden;
}
.rank-bar {
  height: 100%;
  background: linear-gradient(90deg, #0b5cab, #4a9be8);
  border-radius: 4px;
}
.rank-count {
  text-align: right;
  color: #4e5969;
}

/* 窗口长度分布 */
.len-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.len-item {
  display: grid;
  grid-template-columns: 64px 1fr 56px;
  align-items: center;
  gap: 10px;
}
.len-label {
  font-size: 12px;
  color: #8a97a5;
}
.len-track {
  height: 10px;
  background: #eef1f5;
  border-radius: 5px;
  overflow: hidden;
}
.len-bar {
  height: 100%;
  background: linear-gradient(90deg, #67c23a, #95d475);
  border-radius: 5px;
}
.len-count {
  text-align: right;
  color: #4e5969;
}

/* 上下文浏览 */
.ctx-title {
  font-size: 13px;
  color: #1d2b3a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-expand {
  padding: 4px 12px;
}
.ctx-window {
  font-size: 14px;
  line-height: 1.8;
  color: #1d2b3a;
  background: #f8fafc;
  border-radius: 4px;
  padding: 10px 14px;
}
.ctx-window :deep(mark) {
  background: #fde68a;
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
  font-weight: 600;
}
.ctx-meta {
  margin-top: 8px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.ent-tag {
  margin-right: 4px;
}
.ent-name {
  font-weight: 500;
  margin-right: 6px;
}
</style>
