<template>
  <div class="page">
    <!-- 语料池概览 -->
    <div class="pool-bar">
      <span class="card-title">语料池</span>
      <el-select v-model="sourceId" placeholder="选择新闻源" size="small" style="max-width: 240px" @change="reload">
        <el-option v-for="d in sources" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
      <el-tag v-if="!stats.ready" size="small" type="warning" effect="plain">新闻源（ES）不可达</el-tag>
      <el-tag v-else size="small" type="info" effect="plain">统计于 {{ stats.cachedAt ? fmt(stats.cachedAt) : '—' }}</el-tag>
      <el-button text type="primary" size="small" :loading="statsLoading" @click="refreshPool">刷新统计</el-button>
    </div>
    <el-row :gutter="12" class="cards" v-loading="statsLoading">
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <el-statistic title="新闻源总量（ES 命中）" :value="stats.total" />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <el-statistic title="已入库（已抽取）" :value="stats.ingested" />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <el-statistic
            title="剩余未抽取"
            :value="stats.remaining"
            :value-style="{ color: stats.remaining > 0 ? '#22764a' : '#8a93a0' }"
          />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card cursor-card">
          <div class="stat-label">增量游标（下次从此之后采集）</div>
          <div class="cursor-line">
            <span v-if="stats.cursor">
              {{ stats.cursor.pubDate ? fmt(stats.cursor.pubDate) : '—' }}
            </span>
            <el-tag v-else size="small" type="warning" effect="plain">无（首次取最新 N 条）</el-tag>
          </div>
          <div v-if="stats.cursor" class="cursor-id">{{ stats.cursor.docId }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 采集设置（计划在「新闻源设置」页配置） -->
    <el-card class="block" shadow="never">
      <template #header>
        <span class="card-title">采集设置</span>
        <el-tag size="small" effect="plain" type="info" style="margin-left: 10px">
          新闻源连接与任务计划在
          <router-link to="/news/settings">新闻源设置</router-link>
          页配置
        </el-tag>
      </template>
      <div class="ingest-bar">
        <span class="lbl">每次入库量</span>
        <el-input-number v-model="batchSize" :min="1" :max="200" :step="5" />
        <span class="hint">篇（无游标时首次取最新 N 条）</span>
        <el-button size="small" :loading="previewLoading" :disabled="!sourceId" @click="loadPreview">
          拉取预览
        </el-button>
        <el-button size="small" type="primary" :loading="ingesting" :disabled="!sourceId" @click="ingestOnly">
          仅入库（不跑批）
        </el-button>
      </div>
    </el-card>

    <!-- 采集预览 -->
    <el-card class="block" shadow="never">
      <template #header>
        <span class="card-title">采集预览 · 下次入库将拉取的新闻</span>
      </template>
      <el-table :data="preview" border stripe v-loading="previewLoading" max-height="360">
        <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
        <el-table-column prop="sourceName" label="来源" width="140" show-overflow-tooltip />
        <el-table-column prop="pubDate" label="发布日期" width="120" />
        <el-table-column label="正文" width="90">
          <template #default="{ row }">{{ row.bodyChars }} 字</template>
        </el-table-column>
        <el-table-column prop="excerpt" label="摘要" min-width="280" show-overflow-tooltip />
      </el-table>
      <p v-if="!preview.length" class="hint ml">暂无预览（游标已是最新，或新闻源不可达）；可点「拉取预览」重试。</p>
    </el-card>

    <!-- 执行记录 -->
    <el-card class="block" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-title">执行记录</span>
          <div>
            <el-button text type="primary" size="small" @click="loadRuns">刷新</el-button>
            <el-button type="warning" plain size="small" :loading="cancelling" :disabled="!sourceId" @click="cancelQueue">
              取消排队
            </el-button>
            <el-button type="danger" plain size="small" :loading="terminating" :disabled="!sourceId" @click="terminateQueue">
              终止任务
            </el-button>
          </div>
        </div>
      </template>
      <el-table :data="runs" v-loading="runsLoading" border stripe>
        <el-table-column label="开始时间" min-width="160">
          <template #default="{ row }">{{ fmt(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.source === 'manual' ? 'warning' : 'info'">
              {{ row.source === 'manual' ? '手动' : '计划' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模式" width="110" align="center">
          <template #default="{ row }">{{ row.mode === 'ingest+run' ? '入库+跑批' : '仅入库' }}</template>
        </el-table-column>
        <el-table-column prop="sampled" label="抽样" width="80" align="center" />
        <el-table-column prop="created" label="入库" width="80" align="center" />
        <el-table-column label="跑批(队列/完成/失败)" width="170" align="center">
          <template #default="{ row }">
            {{ row.queueTotal }} / <span class="ok">{{ row.done }}</span> / <span :class="{ err: row.failed }">{{ row.failed }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="entitiesCreated" label="新实体" width="80" align="center" />
        <el-table-column prop="factDrafts" label="事实草稿" width="90" align="center" />
        <el-table-column prop="tokens" label="Token" width="100" align="center" />
        <el-table-column label="耗时" width="90" align="center">
          <template #default="{ row }">{{ duration(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'running' ? 'warning' : row.status === 'success' ? 'success' : 'danger'"
              size="small"
              effect="plain"
            >
              {{ row.status === 'running' ? '执行中' : row.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="error" label="错误" min-width="160" show-overflow-tooltip />
      </el-table>
      <div class="pager">
        <el-pagination
          layout="prev, pager, next, total"
          :total="runsTotal"
          :page-size="runsPageSize"
          :current-page="runsPage"
          @current-change="(p: number) => ((runsPage = p), loadRuns())"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { discoveryApi, newsApi, type NewsPreviewItem, type NewsRunRecord, type NewsSource, type NewsStats } from '@/api';

const fmt = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';
const duration = (r: NewsRunRecord): string => {
  if (!r.startedAt || !r.finishedAt) return '—';
  const s = Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

const sources = ref<NewsSource[]>([]);
const sourceId = ref('');
const batchSize = ref(10);
const stats = ref<NewsStats>({ sourceId: '', sourceName: '', datasetId: 0, ready: false, total: 0, ingested: 0, remaining: 0, cachedAt: null, cursor: null });
const statsLoading = ref(false);

// ---------------- 统计 / 预览 ----------------
async function loadStats(force = false) {
  if (!sourceId.value) return;
  statsLoading.value = true;
  try {
    stats.value = await newsApi.stats(sourceId.value, force);
  } finally {
    statsLoading.value = false;
  }
}
function refreshPool() {
  void loadStats(true);
}

const preview = ref<NewsPreviewItem[]>([]);
const previewLoading = ref(false);
async function loadPreview() {
  if (!sourceId.value) return;
  previewLoading.value = true;
  try {
    preview.value = await newsApi.preview(sourceId.value, batchSize.value);
  } finally {
    previewLoading.value = false;
  }
}

const ingesting = ref(false);
async function ingestOnly() {
  if (!sourceId.value) return;
  ingesting.value = true;
  try {
    const r = await newsApi.ingest(sourceId.value, batchSize.value);
    ElMessage.success(`已入库 ${r.created} 篇（拉取 ${r.sampled}，跳过 ${r.skipped}），游标已推进`);
    await Promise.all([loadStats(), loadPreview()]);
  } finally {
    ingesting.value = false;
  }
}

function reload() {
  if (!sourceId.value) return;
  void loadStats();
  void loadPreview();
}

// ---------------- 执行记录 ----------------
const runs = ref<NewsRunRecord[]>([]);
const runsLoading = ref(false);
const runsTotal = ref(0);
const runsPage = ref(1);
const runsPageSize = 20;
async function loadRuns() {
  runsLoading.value = true;
  try {
    const res = await newsApi.runs({ page: runsPage.value, pageSize: runsPageSize });
    runs.value = res.items;
    runsTotal.value = res.total;
  } finally {
    runsLoading.value = false;
  }
}

// 取消排队：排队中的任务立即取消（在途的会跑完）
const cancelling = ref(false);
async function cancelQueue() {
  const dsId = sources.value.find((s) => s.id === sourceId.value)?.datasetId;
  if (!sourceId.value || !dsId) return;
  cancelling.value = true;
  try {
    const r = await discoveryApi.cancelQueue(dsId);
    ElMessage.success(`已取消 ${r.cancelled} 条排队任务（在途的会跑完）`);
    await loadRuns();
  } finally {
    cancelling.value = false;
  }
}

// 终止任务：中断在途 LLM 调用，排队中 + 进行中全部立即置为跳过
const terminating = ref(false);
async function terminateQueue() {
  const dsId = sources.value.find((s) => s.id === sourceId.value)?.datasetId;
  if (!sourceId.value || !dsId) return;
  try {
    await ElMessageBox.confirm(
      '将「中断」正在执行的 LLM 调用，并把所有「排队中 / 进行中」的任务立即置为「跳过」。已产出的部分数据保留。确定终止？',
      '终止任务',
      { type: 'warning', confirmButtonText: '确定终止', cancelButtonText: '关闭' },
    );
  } catch {
    return;
  }
  terminating.value = true;
  try {
    const r = await discoveryApi.terminateQueue(dsId);
    ElMessage.success(`已终止 ${r.terminated} 条任务（含在途）`);
    await loadRuns();
  } finally {
    terminating.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await newsApi.listSources();
    sources.value = res.sources ?? [];
    if (sources.value.length) sourceId.value = sources.value[0].id;
  } catch {
    sources.value = [];
  }
  await Promise.all([loadStats(), loadRuns()]);
  void loadPreview();
});
</script>

<style scoped>
.page { padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 16px; }
.block { border-radius: 10px; }
.cards { gap: 0; }
.stat-card { border-radius: 10px; }
.card-title { font-weight: 700; font-size: 15px; }
.card-head { display: flex; align-items: center; justify-content: space-between; }
.pool-bar { display: flex; align-items: center; gap: 10px; }
.pool-bar .card-title { margin-right: 4px; }
.cursor-card { display: flex; flex-direction: column; justify-content: center; }
.stat-label { font-size: 12px; color: #8a93a0; line-height: 1.4; }
.cursor-line { margin-top: 6px; font-weight: 700; font-size: 14px; }
.cursor-id { font-size: 11px; color: #8a93a0; margin-top: 2px; word-break: break-all; }
.ingest-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ingest-bar .lbl { font-size: 13px; color: #606266; }
.hint { color: #8a93a0; font-size: 12px; }
.hint.ml { margin-top: 8px; }
.err { color: #c0392b; font-size: 12px; }
.ok { color: #22764a; font-weight: 700; }
.pager { margin-top: 12px; justify-content: flex-end; display: flex; }
</style>
