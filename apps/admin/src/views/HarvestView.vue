<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">任务计划</h2>
        <div class="page-desc">
          定时读取已发布实体 → websearch 搜索新闻源 → 采集新语料入库 → 规则抽取草稿 →
          更新事实档案（版本备查/事实变化/事件时间线/证据链/语料）
        </div>
      </div>
      <el-button type="primary" @click="openCreate">新建任务</el-button>
    </div>

    <!-- websearch token 配置 -->
    <div class="token-card">
      <div class="token-info">
        <span class="token-label">websearch token</span>
        <el-tag v-if="!config.tokenSet" size="small" type="danger">未配置</el-tag>
        <template v-else-if="config.expired">
          <el-tag size="small" type="danger">已过期</el-tag>
          <span class="token-preview mono">{{ config.preview }}</span>
        </template>
        <template v-else>
          <el-tag size="small" type="success">有效</el-tag>
          <span class="token-preview mono">{{ config.preview }}</span>
          <span class="token-expire">剩余 {{ config.daysLeft }} 天（{{ expireDate }} 过期）</span>
        </template>
        <el-tag v-if="config.source === 'env'" size="small" type="info" effect="plain">来源：环境变量</el-tag>
      </div>
      <div class="token-actions">
        <el-input
          v-model="tokenInput"
          placeholder="粘贴新的 x-ide-token JWT（Frida 捕获或浏览器登录态，约 14 天有效）"
          style="width: 420px"
          clearable
        />
        <el-button :loading="savingToken" @click="saveToken">保存 token</el-button>
        <el-button :loading="testing" @click="testToken">测试搜索</el-button>
      </div>
      <div v-if="testResult" class="test-result">
        <el-tag size="small" :type="testResult.ok ? 'success' : 'danger'">
          {{ testResult.ok ? `成功 · ${testResult.count} 条` : '失败' }}
        </el-tag>
        <span v-for="r in testResult.refs" :key="r.uri" class="test-ref">{{ r.title }}</span>
      </div>
    </div>

    <!-- 任务列表 -->
    <el-table :data="tasks" v-loading="loading" border>
      <el-table-column prop="name" label="任务名" min-width="140" />
      <el-table-column label="语料域" width="100">
        <template #default="{ row }">{{ datasetName(row.datasetId) }}</template>
      </el-table-column>
      <el-table-column label="间隔" width="110">
        <template #default="{ row }">{{ fmtInterval(row.intervalMinutes) }}</template>
      </el-table-column>
      <el-table-column prop="siteDomains" label="搜索域" width="110" />
      <el-table-column label="应用模式" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.applyMode === 'auto' ? 'warning' : 'info'">
            {{ row.applyMode === 'auto' ? '自动应用' : '草稿待审' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="启用" width="70">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="toggleEnabled(row, $event as boolean)" />
        </template>
      </el-table-column>
      <el-table-column label="上次运行" width="200">
        <template #default="{ row }">
          <template v-if="row.lastRun">
            <el-tag size="small" :type="RUN_TAG[row.lastRun.status] ?? 'info'">{{ RUN_LABEL[row.lastRun.status] ?? row.lastRun.status }}</el-tag>
            <span class="run-time">{{ fmtTime(row.lastRun.startedAt) }}</span>
          </template>
          <span v-else class="muted">未运行</span>
        </template>
      </el-table-column>
      <el-table-column label="下次运行" width="160">
        <template #default="{ row }">
          <span v-if="row.enabled && row.nextRunAt" :class="{ due: isDue(row) }">{{ fmtTime(row.nextRunAt) }}</span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="runningTasks.has(row.id)" @click="runNow(row)">
            {{ runningTasks.has(row.id) ? '运行中…' : '立即运行' }}
          </el-button>
          <el-button link @click="openRuns(row)">运行历史</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="removeTask(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建/编辑任务 -->
    <el-dialog v-model="dialog" :title="editing ? `编辑任务：${editing.name}` : '新建任务'" width="520px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="任务名" required>
          <el-input v-model="form.name" placeholder="如：瓯菜新闻源每日巡检" />
        </el-form-item>
        <el-form-item label="语料域" required>
          <el-select v-model="form.datasetId" :disabled="!!editing" style="width: 100%">
            <el-option v-for="d in meta.datasets" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="搜索域">
          <el-input v-model="form.siteDomains" placeholder="66wz.com（逗号分隔可多个）" />
        </el-form-item>
        <el-form-item label="执行间隔">
          <el-select v-model="form.intervalMinutes" style="width: 100%">
            <el-option v-for="o in INTERVALS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="每实体查询数">
          <el-input-number v-model="form.queriesPerEntity" :min="1" :max="10" />
          <div class="form-tip">主名/别名/组合词，每次搜索间隔 2s（风控限速）</div>
        </el-form-item>
        <el-form-item label="应用模式">
          <el-radio-group v-model="form.applyMode">
            <el-radio value="draft">草稿待审（P6 工作台人工审核）</el-radio>
            <el-radio value="auto">自动应用（校验全过才入库）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 运行历史抽屉 -->
    <el-drawer v-model="runsDrawer" :title="runsTask ? `运行历史：${runsTask.name}` : '运行历史'" size="56%">
      <el-table :data="runs" v-loading="runsLoading" border size="small" @row-click="openRunDetail">
        <el-table-column prop="id" label="#" width="60" />
        <el-table-column label="触发" width="70">
          <template #default="{ row }">{{ row.triggerType === 'manual' ? '手动' : '定时' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="RUN_TAG[row.status] ?? 'info'">{{ RUN_LABEL[row.status] ?? row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开始" width="150">
          <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="80">
          <template #default="{ row }">
            {{ row.finishedAt && row.startedAt ? `${Math.round((new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime()) / 1000)}s` : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="摘要">
          <template #default="{ row }">
            <span v-if="row.statsJson" class="run-summary">
              实体{{ row.statsJson.entities }} · 搜索{{ row.statsJson.searchCalls }}次 · 新URL {{ row.statsJson.newUrls }}
              · 入库{{ row.statsJson.articlesInserted }} · 草稿{{ row.statsJson.drafts ?? '-' }}
              <template v-if="Number(row.statsJson.autoApproved) > 0"> · 自动应用{{ row.statsJson.autoApproved }}</template>
            </span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="runsPage"
          :total="runsTotal"
          layout="total, prev, pager, next"
          :page-size="20"
          @current-change="loadRuns"
        />
      </div>
    </el-drawer>

    <!-- 单次运行详情 -->
    <el-dialog v-model="runDetailDialog" :title="`运行 #${runDetail?.id ?? ''} 详情`" width="680px">
      <template v-if="runDetail">
        <el-descriptions :column="3" border size="small" class="run-detail-stats">
          <el-descriptions-item label="实体">{{ runDetail.statsJson?.entities ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="搜索次数">{{ runDetail.statsJson?.searchCalls ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="命中结果">{{ runDetail.statsJson?.refsTotal ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="新 URL">{{ runDetail.statsJson?.newUrls ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="采集成功">{{ runDetail.statsJson?.pagesOk ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="采集失败">{{ runDetail.statsJson?.pagesFail ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="语料入库">{{ runDetail.statsJson?.articlesInserted ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="倒排命中">{{ runDetail.statsJson?.hits ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="说明">
            采集完成后到「生产线」抽样入队并跑批抽取
          </el-descriptions-item>
          <el-descriptions-item label="触发方式">{{ runDetail.triggerType === 'manual' ? '手动' : '定时' }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="runDetail.errorMsg" class="run-error">{{ runDetail.errorMsg }}</div>
        <div class="run-log">
          <div v-for="(line, i) in runDetail.logJson ?? []" :key="i" class="log-line">{{ line }}</div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { harvestApi, type HarvestTask, type HarvestRun, type HarvestConfig } from '@/api';
import { useMetaStore } from '@/stores/meta';

const meta = useMetaStore();
const loading = ref(false);
const saving = ref(false);
const tasks = ref<HarvestTask[]>([]);
const runningTasks = ref(new Set<number>());

const config = ref<HarvestConfig>({ tokenSet: false, source: 'none', expired: null, daysLeft: null, exp: null, preview: null });
const tokenInput = ref('');
const savingToken = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; count: number; refs: { title: string; uri: string }[] } | null>(null);

const dialog = ref(false);
const editing = ref<HarvestTask | null>(null);
const form = reactive({
  name: '',
  datasetId: null as number | null,
  siteDomains: '66wz.com',
  intervalMinutes: 1440,
  queriesPerEntity: 3,
  applyMode: 'draft' as 'draft' | 'auto',
});

const runsDrawer = ref(false);
const runsTask = ref<HarvestTask | null>(null);
const runs = ref<HarvestRun[]>([]);
const runsTotal = ref(0);
const runsPage = ref(1);
const runsLoading = ref(false);

const runDetailDialog = ref(false);
const runDetail = ref<HarvestRun | null>(null);

const INTERVALS = [
  { label: '每 6 小时', value: 360 },
  { label: '每 12 小时', value: 720 },
  { label: '每天', value: 1440 },
  { label: '每 3 天', value: 4320 },
  { label: '每周', value: 10080 },
];

const RUN_LABEL: Record<string, string> = { running: '运行中', succeeded: '成功', failed: '失败' };
const RUN_TAG: Record<string, string> = { running: 'warning', succeeded: 'success', failed: 'danger' };

const expireDate = computed(() =>
  config.value.exp ? new Date(config.value.exp * 1000).toLocaleDateString('zh-CN') : '',
);

const datasetName = (id: number) => meta.datasets.find((d) => d.id === id)?.name ?? id;
const fmtInterval = (m: number) => INTERVALS.find((i) => i.value === m)?.label ?? `每 ${m} 分钟`;
const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }).slice(5, 17) : '-');
const isDue = (row: HarvestTask) => new Date(row.nextRunAt ?? '').getTime() <= Date.now();

const load = async () => {
  loading.value = true;
  try {
    tasks.value = await harvestApi.tasks();
  } finally {
    loading.value = false;
  }
};

const loadConfig = async () => {
  config.value = await harvestApi.config();
};

const saveToken = async () => {
  if (!tokenInput.value.trim()) {
    ElMessage.warning('请粘贴 token');
    return;
  }
  savingToken.value = true;
  try {
    config.value = await harvestApi.saveConfig(tokenInput.value.trim());
    tokenInput.value = '';
    ElMessage.success('token 已保存');
  } finally {
    savingToken.value = false;
  }
};

const testToken = async () => {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await harvestApi.testConfig('三丝敲鱼');
  } catch (err) {
    testResult.value = { ok: false, count: 0, refs: [] };
    ElMessage.error((err as Error).message.slice(0, 120));
  } finally {
    testing.value = false;
  }
};

const openCreate = () => {
  editing.value = null;
  Object.assign(form, {
    name: '',
    datasetId: meta.datasets[0]?.id ?? null,
    siteDomains: '66wz.com',
    intervalMinutes: 1440,
    queriesPerEntity: 3,
    applyMode: 'draft',
  });
  dialog.value = true;
};

const openEdit = (row: HarvestTask) => {
  editing.value = row;
  Object.assign(form, {
    name: row.name,
    datasetId: row.datasetId,
    siteDomains: row.siteDomains,
    intervalMinutes: row.intervalMinutes,
    queriesPerEntity: row.queriesPerEntity,
    applyMode: row.applyMode,
  });
  dialog.value = true;
};

const save = async () => {
  if (!form.name.trim() || !form.datasetId) {
    ElMessage.warning('任务名与语料域必填');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      datasetId: form.datasetId,
      siteDomains: form.siteDomains.trim() || '66wz.com',
      intervalMinutes: form.intervalMinutes,
      queriesPerEntity: form.queriesPerEntity,
      applyMode: form.applyMode,
    };
    if (editing.value) await harvestApi.updateTask(editing.value.id, payload);
    else await harvestApi.createTask(payload);
    ElMessage.success('已保存');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
};

const toggleEnabled = async (row: HarvestTask, enabled: boolean) => {
  await harvestApi.updateTask(row.id, { enabled });
  ElMessage.success(enabled ? '已启用（按间隔自动执行）' : '已停用');
  await load();
};

const removeTask = async (row: HarvestTask) => {
  await ElMessageBox.confirm(`删除任务「${row.name}」及全部运行记录？`, '删除确认', { type: 'warning' });
  await harvestApi.deleteTask(row.id);
  ElMessage.success('已删除');
  await load();
};

const runNow = async (row: HarvestTask) => {
  const { runId } = await harvestApi.runTask(row.id);
  ElMessage.success(`已触发运行 #${runId}（后台执行，完成后自动刷新）`);
  runningTasks.value.add(row.id);
  pollRun(row.id, runId);
};

/** 轮询单次运行直到结束 */
const pollRun = async (taskId: number, runId: number) => {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const run = await harvestApi.runDetail(runId);
      if (run.status !== 'running') {
        runningTasks.value.delete(taskId);
        await load();
        const s = run.statsJson ?? {};
        ElMessage({
          type: run.status === 'succeeded' ? 'success' : 'error',
          message:
            run.status === 'succeeded'
              ? `运行 #${runId} 完成：新语料 ${s.articlesInserted ?? 0} 篇 · 草稿 ${s.drafts ?? 0} 条`
              : `运行 #${runId} 失败：${run.errorMsg ?? '未知错误'}`,
          duration: 6000,
        });
        return;
      }
    } catch {
      runningTasks.value.delete(taskId);
      return;
    }
  }
  runningTasks.value.delete(taskId);
};

const openRuns = async (row: HarvestTask) => {
  runsTask.value = row;
  runsPage.value = 1;
  runsDrawer.value = true;
  await loadRuns();
};

const loadRuns = async () => {
  runsLoading.value = true;
  try {
    const res = await harvestApi.runs(runsTask.value?.id, runsPage.value);
    runs.value = res.items;
    runsTotal.value = res.total;
  } finally {
    runsLoading.value = false;
  }
};

const openRunDetail = async (row: HarvestRun) => {
  runDetail.value = await harvestApi.runDetail(row.id);
  runDetailDialog.value = true;
};

onMounted(async () => {
  await Promise.all([meta.ensureLoaded(), loadConfig()]);
  await load();
});
</script>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', Consolas, monospace;
}

.muted {
  color: #8a97a5;
}

.due {
  color: #e6a23c;
}

.token-card {
  border: 1px solid #e3e7ec;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.token-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-label {
  font-weight: 600;
  color: #1d2b3a;
}

.token-preview {
  font-size: 12px;
  color: #8a97a5;
}

.token-expire {
  font-size: 12px;
  color: #67c23a;
}

.token-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.test-result {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #4e5969;
}

.test-ref {
  background: #f4f6f9;
  padding: 2px 8px;
  border-radius: 4px;
}

.form-tip {
  font-size: 12px;
  color: #8a97a5;
  line-height: 1.4;
  margin-top: 2px;
}

.run-time {
  margin-left: 6px;
  font-size: 12px;
  color: #8a97a5;
}

.run-summary {
  font-size: 12px;
  color: #4e5969;
}

.run-detail-stats {
  margin-bottom: 12px;
}

.run-error {
  color: #f56c6c;
  font-size: 13px;
  margin-bottom: 10px;
}

.run-log {
  background: #0d1117;
  border-radius: 6px;
  padding: 12px;
  max-height: 360px;
  overflow-y: auto;
}

.log-line {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.pager {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
</style>
