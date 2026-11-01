<template>
  <div class="page">
    <el-card shadow="never" class="line-card">
      <template #header>
        <div class="card-head">
          <span>当前生产线（文本模型 · 启用并设为生产线）</span>
          <div>
            <el-button size="small" @click="loadAll">刷新</el-button>
            <el-button size="small" type="primary" @click="$router.push('/llm-config')">去配置</el-button>
          </div>
        </div>
      </template>
      <div v-if="line.models.length" class="models">
        <el-tag v-for="m in line.models" :key="m.id" type="success" effect="dark" size="large">
          {{ m.name }} · {{ m.model }} ×{{ m.concurrency ?? 10 }}
        </el-tag>
        <el-tag type="info" effect="plain" size="large">
          总并发 {{ line.concurrency }} 路并行消化队列（每渠道并发数在「大模型设置」配置）
        </el-tag>
      </div>
      <el-alert
        v-else
        type="warning"
        :closable="false"
        show-icon
        title="未配置生产线"
        description="「大模型设置 → 文本模型」里没有启用并设为生产线的配置，跑批会直接报错"
      />
    </el-card>

    <el-form :inline="true" class="filters">
      <el-form-item label="数据集">
        <el-select v-model="f.datasetId" clearable placeholder="全部" style="width: 180px">
          <el-option v-for="d in datasets" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="f.status" clearable placeholder="全部" style="width: 130px">
          <el-option label="排队中" value="pending" />
          <el-option label="进行中" value="running" />
          <el-option label="已完成" value="done" />
          <el-option label="失败" value="failed" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="loadRecords">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
      <el-form-item v-if="f.datasetId">
        <el-button :loading="queuing" @click="buildQueue">抽样入队(10 篇)</el-button>
        <el-button type="primary" :loading="running" @click="runQueue">跑批</el-button>
        <el-button type="warning" plain :loading="cancelling" @click="cancelQueue">取消排队</el-button>
        <el-button type="danger" :loading="terminating" @click="terminateQueue">终止任务</el-button>
      </el-form-item>
    </el-form>

    <el-table :data="items" border stripe v-loading="loading">
      <el-table-column prop="id" label="任务" width="80" />
      <el-table-column label="文章" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">{{ row.title ?? '(无题)' }}</template>
      </el-table-column>
      <el-table-column label="来源" min-width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ row.sourceOrg ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="正文" width="90">
        <template #default="{ row }">{{ row.bodyChars }} 字</template>
      </el-table-column>
      <el-table-column label="阶段" width="110">
        <template #default="{ row }">{{ STAGE_TEXT[row.stage] ?? row.stage }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="STATUS_TYPE[row.status]">{{ STATUS_TEXT[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="模型调用" width="150">
        <template #default="{ row }">
          {{ row.llm.calls }} 次<template v-if="row.llm.errors">，<span class="err">失败 {{ row.llm.errors }}</span></template>
        </template>
      </el-table-column>
      <el-table-column label="Token" width="100">
        <template #default="{ row }">{{ row.llm.totalTokens }}</template>
      </el-table-column>
      <el-table-column label="产出" width="150">
        <template #default="{ row }">
          实体 {{ statOf(row, 'entitiesCreated') }} · 事实 {{ statOf(row, 'factDrafts') }} · 事件
          {{ statOf(row, 'eventDrafts') }}
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="开始时间" width="170" :formatter="timeFmt" />
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.id)">明细</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="mt"
      background
      layout="prev, pager, next, total"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="(p: number) => { page = p; loadRecords(); }"
    />

    <!-- 单篇处理明细 -->
    <el-drawer v-model="drawer" :title="detail ? `处理明细 · 任务 #${detail.id}` : '处理明细'" size="72%">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="3" border size="small" class="mb">
          <el-descriptions-item label="文章" :span="2">{{ detail.title ?? '(无题)' }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ detail.sourceOrg ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="STATUS_TYPE[detail.status]">{{ STATUS_TEXT[detail.status] }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="阶段">{{ STAGE_TEXT[detail.stage] ?? detail.stage }}</el-descriptions-item>
          <el-descriptions-item label="尝试次数">{{ detail.attempts }}</el-descriptions-item>
          <el-descriptions-item label="正文">{{ detail.bodyChars }} 字</el-descriptions-item>
          <el-descriptions-item label="发布时间">{{ detail.pubDate ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="文章 ID">{{ detail.articleId ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="新建实体">{{ statOf(detail, 'entitiesCreated') }}</el-descriptions-item>
          <el-descriptions-item label="合并/直中">
            {{ statOf(detail, 'entitiesMerged') }} / {{ statOf(detail, 'entitiesExact') }}
          </el-descriptions-item>
          <el-descriptions-item label="待裁决">{{ statOf(detail, 'alignPending') }}</el-descriptions-item>
          <el-descriptions-item label="事实/事件草稿">
            {{ statOf(detail, 'factDrafts') }} / {{ statOf(detail, 'eventDrafts') }}
          </el-descriptions-item>
          <el-descriptions-item label="C 层/驳回">
            {{ statOf(detail, 'cLayer') }} / {{ statOf(detail, 'rejected') }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.errorMsg" label="错误" :span="3">
            <span class="err">{{ detail.errorMsg }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-row :gutter="12" class="cards">
          <el-col :span="4"><el-statistic title="模型调用" :value="detail.calls.total" /></el-col>
          <el-col :span="4"><el-statistic title="成功" :value="detail.calls.success" /></el-col>
          <el-col :span="4">
            <el-statistic title="失败" :value="detail.calls.errors" value-style="color:#f56c6c" />
          </el-col>
          <el-col :span="4"><el-statistic title="总 Token" :value="detail.calls.totalTokens" /></el-col>
          <el-col :span="4"><el-statistic title="平均耗时(ms)" :value="detail.calls.avgLatencyMs" /></el-col>
          <el-col :span="4"><el-statistic title="参与模型" :value="detail.byModel.length" /></el-col>
        </el-row>

        <el-tabs v-model="tab">
          <el-tab-pane label="抽取报告" name="report">
            <template v-if="report()">
              <el-alert
                type="info"
                :closable="false"
                class="mb"
                :title="`生产线 ${report()!.summary.models.join(' + ')}｜${report()!.summary.stageCount} 个阶段、${report()!.summary.tokens} token｜抽出实体 ${report()!.summary.entityCount} 个、事实 ${report()!.summary.factCount} 条、事件 ${report()!.summary.eventCount} 条、关系 ${report()!.summary.relationCount ?? 0} 条`"
              />

              <el-divider content-position="left">处理流水</el-divider>
              <el-table :data="report()!.stages" border stripe size="small">
                <el-table-column label="阶段" width="110">
                  <template #default="{ row }">{{ STAGE_TEXT[row.stage] ?? row.stage }}</template>
                </el-table-column>
                <el-table-column label="调用模型" width="80">
                  <template #default="{ row }">{{ row.calls }}</template>
                </el-table-column>
                <el-table-column label="Token" width="90">
                  <template #default="{ row }">{{ row.tokens }}</template>
                </el-table-column>
                <el-table-column label="总耗时ms" width="100">
                  <template #default="{ row }">{{ row.latencyMs }}</template>
                </el-table-column>
                <el-table-column label="各模型结果">
                  <template #default="{ row }">
                    <div v-for="m in row.models" :key="m.model" class="model-line">
                      <el-tag size="small" :type="m.ok ? 'success' : 'danger'">{{ m.model }}</el-tag>
                      <span class="model-result">{{ m.result }}</span>
                      <span class="muted">{{ m.latencyMs }}ms · {{ m.tokens }} tok</span>
                    </div>
                  </template>
                </el-table-column>
              </el-table>

              <el-divider content-position="left">抽取到的实体（{{ report()!.entities.length }}）</el-divider>
              <el-table :data="report()!.entities" border stripe size="small" max-height="320">
                <el-table-column prop="name" label="实体" min-width="130" />
                <el-table-column prop="type" label="类型" width="140" />
                <el-table-column label="审核" width="120">
                  <template #default="{ row }">
                    {{ row.audit }}<span v-if="row.auditBy" class="muted">（{{ row.auditBy }}）</span>
                  </template>
                </el-table-column>
                <el-table-column label="如何处置" min-width="200" show-overflow-tooltip>
                  <template #default="{ row }">
                    {{ row.action }}
                    <span v-if="row.matchedEntityName" class="muted">→ {{ row.matchedEntityName }}</span>
                    <span v-if="row.createdEntityId" class="muted">→ 新实体 #{{ row.createdEntityId }}</span>
                    <span v-if="row.reason" class="muted">（{{ row.reason }}）</span>
                  </template>
                </el-table-column>
                <el-table-column label="来源模型" width="150">
                  <template #default="{ row }">{{ (row.fromModels ?? []).join('、') || '-' }}</template>
                </el-table-column>
                <el-table-column label="置信度" width="80">
                  <template #default="{ row }">{{ row.confidence ?? '-' }}</template>
                </el-table-column>
                <el-table-column label="原文依据" min-width="200" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.evidence || '-' }}</template>
                </el-table-column>
              </el-table>

              <el-divider content-position="left">抽取到的事实（{{ report()!.facts.length }}）</el-divider>
              <el-table :data="report()!.facts" border stripe size="small" max-height="320">
                <el-table-column prop="entityName" label="实体" width="120" />
                <el-table-column prop="dimension" label="维度" width="120" />
                <el-table-column prop="statement" label="陈述" min-width="240" show-overflow-tooltip />
                <el-table-column prop="quote" label="原文引句" min-width="220" show-overflow-tooltip />
                <el-table-column label="来源模型" width="140">
                  <template #default="{ row }">{{ (row.fromModels ?? []).join('、') || '-' }}</template>
                </el-table-column>
                <el-table-column label="置信度" width="80">
                  <template #default="{ row }">{{ row.confidence ?? '-' }}</template>
                </el-table-column>
                <el-table-column prop="status" label="状态" width="90" />
              </el-table>

              <el-divider content-position="left">抽取到的事件（{{ report()!.events.length }}）</el-divider>
              <el-table :data="report()!.events" border stripe size="small" max-height="280">
                <el-table-column prop="entityName" label="实体" width="120" />
                <el-table-column prop="description" label="事件" min-width="220" show-overflow-tooltip />
                <el-table-column prop="timeText" label="时间" width="140" />
                <el-table-column prop="quote" label="原文引句" min-width="200" show-overflow-tooltip />
                <el-table-column label="来源模型" width="140">
                  <template #default="{ row }">{{ (row.fromModels ?? []).join('、') || '-' }}</template>
                </el-table-column>
                <el-table-column prop="status" label="状态" width="90" />
              </el-table>

              <el-divider content-position="left">抽取到的关系（{{ (report()!.relations ?? []).length }}）</el-divider>
              <el-table :data="report()!.relations ?? []" border stripe size="small" max-height="320">
                <el-table-column prop="head" label="头实体" min-width="130" />
                <el-table-column label="关系" width="120">
                  <template #default="{ row }">
                    <el-tag size="small">{{ String(row.predicate ?? '').replace('rel_', '') }}</el-tag>
                    <span v-if="row.predicateRaw" class="muted">（{{ row.predicateRaw }}）</span>
                  </template>
                </el-table-column>
                <el-table-column label="尾实体" min-width="140">
                  <template #default="{ row }">
                    {{ row.tailText }}
                    <el-tag v-if="!row.tailMatched" size="small" type="warning" effect="plain">新候选</el-tag>
                    <el-tag v-else size="small" type="success" effect="plain">已入库</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="statement" label="陈述" min-width="220" show-overflow-tooltip />
                <el-table-column prop="quote" label="原文引句" min-width="200" show-overflow-tooltip />
                <el-table-column label="来源模型" width="140">
                  <template #default="{ row }">{{ (row.fromModels ?? []).join('、') || '-' }}</template>
                </el-table-column>
                <el-table-column label="置信度" width="80">
                  <template #default="{ row }">{{ Number(row.confidence ?? 0).toFixed(2) }}</template>
                </el-table-column>
                <el-table-column prop="status" label="状态" width="90" />
              </el-table>

              <el-divider content-position="left">正文（前 800 字）</el-divider>
              <pre class="code">{{ report()!.article.bodyPreview }}</pre>
            </template>
            <el-empty v-else description="该记录还没有抽取报告（旧数据或处理失败）" />
          </el-tab-pane>

          <el-tab-pane label="按模型" name="model">
            <el-table :data="detail.byModel" border stripe size="small">
              <el-table-column label="配置" min-width="140">
                <template #default="{ row }">{{ row.settingName ?? '环境变量' }}</template>
              </el-table-column>
              <el-table-column prop="model" label="模型" min-width="160" />
              <el-table-column prop="calls" label="调用" width="80" />
              <el-table-column prop="success" label="成功" width="80" />
              <el-table-column label="失败" width="80">
                <template #default="{ row }"><span :class="{ err: row.errors }">{{ row.errors }}</span></template>
              </el-table-column>
              <el-table-column prop="totalTokens" label="Token" width="100" />
              <el-table-column prop="avgLatencyMs" label="平均耗时" width="100" />
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="按阶段" name="stage">
            <el-table :data="detail.byStage" border stripe size="small">
              <el-table-column label="阶段" min-width="160">
                <template #default="{ row }">{{ STAGE_TEXT[row.stage] ?? row.stage ?? '-' }}</template>
              </el-table-column>
              <el-table-column prop="calls" label="调用" width="90" />
              <el-table-column prop="totalTokens" label="Token" width="110" />
              <el-table-column prop="avgLatencyMs" label="平均耗时" width="110" />
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="调用明细" name="calls">
            <el-form :inline="true" class="filters">
              <el-form-item label="状态">
                <el-select v-model="callFilter.status" clearable placeholder="全部" style="width: 120px">
                  <el-option label="成功" value="success" />
                  <el-option label="失败" value="error" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button size="small" type="primary" @click="loadCalls(1)">查询</el-button>
              </el-form-item>
            </el-form>
            <el-table :data="calls" border stripe size="small" v-loading="callsLoading" max-height="400">
              <el-table-column prop="createdAt" label="时间" width="165" :formatter="timeFmt" />
              <el-table-column label="阶段" width="110">
                <template #default="{ row }">
                  {{ STAGE_TEXT[row.detailJson?.stage] ?? row.detailJson?.stage ?? '-' }}
                </template>
              </el-table-column>
              <el-table-column prop="model" label="模型" min-width="140" />
              <el-table-column label="结果" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ callSummary(row) }}</template>
              </el-table-column>
              <el-table-column prop="totalTokens" label="Token" width="90" />
              <el-table-column prop="latencyMs" label="耗时ms" width="90" />
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.status === 'success' ? 'success' : 'danger'">
                    {{ row.status === 'success' ? '成功' : '失败' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openCall(row)">查看</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              class="mt"
              size="small"
              background
              layout="prev, total, next"
              :total="callsTotal"
              :page-size="callPageSize"
              :current-page="callPage"
              @current-change="(p: number) => loadCalls(p)"
            />
          </el-tab-pane>

          <el-tab-pane label="草稿明细" name="drafts">
            <el-table :data="drafts" border stripe size="small" v-loading="draftsLoading" max-height="400">
              <el-table-column prop="id" label="ID" width="70" />
              <el-table-column prop="targetType" label="类型" width="80" />
              <el-table-column label="实体" min-width="120">
                <template #default="{ row }">{{ payload(row).entityName ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="维度" width="110">
                <template #default="{ row }">{{ payload(row).dimension ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="陈述" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ payload(row).statement ?? payload(row).description ?? '-' }}
                </template>
              </el-table-column>
              <el-table-column label="引句" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ (payload(row).evidence as Record<string, unknown> | undefined)?.quote ?? '-' }}
                </template>
              </el-table-column>
              <el-table-column label="置信度" width="80">
                <template #default="{ row }">{{ payload(row).confidence ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag
                    size="small"
                    :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : 'info'"
                  >
                    {{ row.status === 'approved' ? '通过' : row.status === 'rejected' ? '驳回' : '待审' }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              class="mt"
              size="small"
              background
              layout="prev, total, next"
              :total="draftsTotal"
              :page-size="draftPageSize"
              :current-page="draftPage"
              @current-change="(p: number) => loadDrafts(p)"
            />
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <!-- 单次调用明细 -->
    <el-dialog v-model="callDialog" title="调用明细" width="720px">
      <div v-if="current">
        <el-descriptions :column="2" border size="small" class="mb">
          <el-descriptions-item label="模型">{{ current.model }}</el-descriptions-item>
          <el-descriptions-item label="阶段">
            {{ current.detailJson?.stage ? (STAGE_TEXT[current.detailJson.stage] ?? current.detailJson.stage) : '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="时间">{{ fmtTime(current.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="耗时">{{ current.latencyMs }} ms</el-descriptions-item>
          <el-descriptions-item label="Token">
            {{ current.promptTokens }} / {{ current.completionTokens }} / {{ current.totalTokens }}
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="current.status === 'success' ? 'success' : 'danger'">
              {{ current.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="current.errorMessage" label="错误" :span="2">
            <span class="err">{{ current.errorMessage }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <div class="block">
          <div class="block-title">本次调用明细</div>
          <pre class="code">{{ JSON.stringify(current.detailJson ?? {}, null, 2) }}</pre>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  datasetApi,
  discoveryApi,
  type ExtractionDraft,
  type LlmCallLog,
  type ProductionLine,
  type ProductionRecord,
  type ProductionRecordDetail,
} from '@/api';

const STATUS_TEXT: Record<string, string> = {
  pending: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
};
const STATUS_TYPE: Record<string, 'success' | 'warning' | 'info' | 'danger' | 'primary'> = {
  pending: 'info',
  running: 'primary',
  done: 'success',
  failed: 'danger',
  skipped: 'warning',
};
const STAGE_TEXT: Record<string, string> = {
  pending: '待跑',
  discover: '实体发现',
  audit: '入库审核',
  align: '实体对齐',
  fact: '事实抽取',
  done: '完成',
};

const line = ref<ProductionLine>({ source: 'none', concurrency: 0, models: [], env: null });
const datasets = ref<{ id: number; name: string }[]>([]);
const f = reactive<{ datasetId?: number; status?: string }>({});
const items = ref<ProductionRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const queuing = ref(false);
const running = ref(false);
const cancelling = ref(false);
const terminating = ref(false);

const drawer = ref(false);
const tab = ref('report');
const detail = ref<ProductionRecordDetail | null>(null);
const detailId = ref(0);
const detailLoading = ref(false);
const calls = ref<LlmCallLog[]>([]);
const callsTotal = ref(0);
const callPage = ref(1);
const callPageSize = ref(20);
const callsLoading = ref(false);
const callFilter = reactive<{ status?: string }>({});
const drafts = ref<ExtractionDraft[]>([]);
const draftsTotal = ref(0);
const draftPage = ref(1);
const draftPageSize = ref(20);
const draftsLoading = ref(false);
const callDialog = ref(false);
const current = ref<LlmCallLog | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

function fmtTime(v: unknown) {
  if (!v) return '-';
  return new Date(String(v)).toLocaleString('zh-CN', { hour12: false });
}

const timeFmt = (_row: unknown, _column: unknown, v: unknown) => fmtTime(v);

function statOf(row: { stats?: Record<string, unknown> }, key: string) {
  const v = (row.stats as Record<string, unknown> | undefined)?.[key];
  return v ?? 0;
}

function report() {
  return detail.value?.report ?? null;
}

function payload(row: ExtractionDraft) {
  return (row.payloadJson ?? {}) as Record<string, unknown>;
}

function callSummary(row: LlmCallLog) {
  const d = (row.detailJson ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (d.entities != null) parts.push(`实体 ${d.entities}`);
  if (d.results != null) parts.push(`审核 ${d.results}`);
  if (d.facts != null) parts.push(`事实 ${d.facts}`);
  if (d.events != null) parts.push(`事件 ${d.events}`);
  if (d.entityName) parts.push(String(d.entityName));
  if (d.mention) parts.push(`判决 ${d.mention}`);
  if (d.verdicts) parts.push(JSON.stringify(d.verdicts));
  return parts.join('，') || '-';
}

async function loadLine() {
  try {
    line.value = await discoveryApi.production();
  } catch {
    line.value = { source: 'none', concurrency: 0, models: [], env: null };
  }
}

async function loadRecords() {
  loading.value = true;
  try {
    const res = await discoveryApi.records({
      datasetId: f.datasetId,
      status: f.status,
      page: page.value,
      pageSize: pageSize.value,
    });
    items.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

function reset() {
  f.datasetId = undefined;
  f.status = undefined;
  page.value = 1;
  loadRecords();
}

async function buildQueue() {
  if (!f.datasetId) return;
  queuing.value = true;
  try {
    const r = await discoveryApi.buildQueue(f.datasetId, 10, { bodyMin: 500, bodyMax: 3000, batch: 'incremental' });
    ElMessage.success(`入队 ${r.created} 篇（跳过 ${r.skipped}）`);
    await loadRecords();
  } finally {
    queuing.value = false;
  }
}

async function runQueue() {
  if (!f.datasetId) return;
  running.value = true;
  try {
    await discoveryApi.runQueue(f.datasetId);
    ElMessage.success('跑批已启动');
    setTimeout(loadRecords, 3000);
  } finally {
    running.value = false;
  }
}

async function cancelQueue() {
  if (!f.datasetId) return;
  try {
    await ElMessageBox.confirm(
      '将把该语料域下「排队中」的任务置为「跳过」；正在处理中的单篇会跑完（不会中断）。确定取消排队？',
      '取消排队',
      { type: 'warning', confirmButtonText: '确定取消', cancelButtonText: '关闭' },
    );
  } catch {
    return;
  }
  cancelling.value = true;
  try {
    const r = await discoveryApi.cancelQueue(f.datasetId);
    ElMessage.success(`已取消 ${r.cancelled} 条排队任务（在途的会跑完）`);
    await loadRecords();
  } finally {
    cancelling.value = false;
  }
}

/** 终止任务：中断在途 LLM 调用，排队中 + 进行中全部立即取消 */
async function terminateQueue() {
  if (!f.datasetId) return;
  try {
    await ElMessageBox.confirm(
      '将「中断」正在执行的 LLM 调用，并把该语料域下所有「排队中 / 进行中」的任务立即置为「跳过」。已产出的部分数据保留。确定终止？',
      '终止任务',
      { type: 'warning', confirmButtonText: '确定终止', cancelButtonText: '关闭' },
    );
  } catch {
    return;
  }
  terminating.value = true;
  try {
    const r = await discoveryApi.terminateQueue(f.datasetId);
    ElMessage.success(`已终止 ${r.terminated} 条任务（含在途）`);
    await loadRecords();
  } finally {
    terminating.value = false;
  }
}

async function openDetail(id: number) {
  detailId.value = id;
  drawer.value = true;
  tab.value = 'model';
  detail.value = null;
  tab.value = 'report';
  detailLoading.value = true;
  try {
    detail.value = await discoveryApi.record(id);
    await Promise.all([loadCalls(1), loadDrafts(1)]);
  } finally {
    detailLoading.value = false;
  }
  if (detail.value?.status === 'running' || detail.value?.status === 'pending') {
    setTimeout(() => {
      if (drawer.value && detailId.value === id) void openDetail(id);
    }, 5000);
  }
}

async function loadCalls(p: number) {
  callPage.value = p;
  callsLoading.value = true;
  try {
    const res = await discoveryApi.recordCalls(detailId.value, {
      status: callFilter.status,
      page: p,
      pageSize: callPageSize.value,
    });
    calls.value = res.items;
    callsTotal.value = res.total;
  } finally {
    callsLoading.value = false;
  }
}

async function loadDrafts(p: number) {
  draftPage.value = p;
  draftsLoading.value = true;
  try {
    const res = await discoveryApi.recordDrafts(detailId.value, { page: p, pageSize: draftPageSize.value });
    drafts.value = res.items;
    draftsTotal.value = res.total;
  } finally {
    draftsLoading.value = false;
  }
}

function openCall(row: LlmCallLog) {
  current.value = row;
  callDialog.value = true;
}

async function loadAll() {
  await Promise.all([loadLine(), loadRecords()]);
}

onMounted(async () => {
  try {
    const res = await datasetApi.list({ pageSize: 100 });
    datasets.value = res.items ?? [];
  } catch {
    datasets.value = [];
  }
  await loadAll();
  timer = setInterval(() => {
    if (drawer.value) return;
    if (items.value.some((r) => r.status === 'running' || r.status === 'pending')) void loadRecords();
  }, 10000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.page {
  padding: 18px;
}
.line-card {
  margin-bottom: 14px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.models {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.filters {
  margin-bottom: 10px;
}
.cards {
  margin: 14px 0;
}
.mb {
  margin-bottom: 12px;
}
.mt {
  margin-top: 10px;
}
.err {
  color: #f56c6c;
}
.muted {
  color: #8a97a5;
  margin-left: 6px;
  font-size: 12px;
}
.model-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}
.model-result {
  font-size: 12px;
}
.block {
  margin-top: 12px;
}
.block-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.code {
  background: #f6f8fa;
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>
