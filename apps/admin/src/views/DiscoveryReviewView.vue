<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">发现审核</h2>
        <div class="page-desc">实体发现与对齐管线的待裁决队列：实体候选、合并建议、属性冲突、新谓词、事实拦截与事件草稿</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <el-select v-model="datasetId" placeholder="按语料域过滤" style="width:200px" @change="loadAll">
          <el-option v-for="d in datasets" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
        <el-button :icon="Refresh" :loading="loading" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <!-- 概览 -->
    <div class="overview">
      <div class="ov-card"><div class="ov-num">{{ draftEntityCount }}</div><div class="ov-label">实体候选 (draft)</div></div>
      <div class="ov-card"><div class="ov-num">{{ pending.merge_suggest ?? 0 }}</div><div class="ov-label">合并建议</div></div>
      <div class="ov-card"><div class="ov-num">{{ pending.conflict ?? 0 }}</div><div class="ov-label">属性冲突</div></div>
      <div class="ov-card"><div class="ov-num">{{ pending.predicate_new ?? 0 }}</div><div class="ov-label">新谓词</div></div>
      <div class="ov-card"><div class="ov-num">{{ factPendingCount }}</div><div class="ov-label">事实拦截</div></div>
      <div class="ov-card"><div class="ov-num">{{ eventPendingCount }}</div><div class="ov-label">事件草稿</div></div>
      <div class="ov-card"><div class="ov-num">{{ relationPendingCount }}</div><div class="ov-label">关系草稿</div></div>
    </div>

    <el-tabs v-model="tab">
      <!-- 实体候选 -->
      <el-tab-pane lazy label="实体候选" name="entity">
        <div class="toolbar">
          <el-alert type="warning" :closable="false" class="hint grow">
            当前策略：暂不发布，档案页零污染。「自动审批」只发布已抽取到事实草稿的实体，其余保持草稿。
          </el-alert>
          <el-button type="success" :loading="autoPublishing" @click="autoPublish">自动审批发布</el-button>
        </div>
        <el-table :data="draftEntities" v-loading="loadingEntity" border class="mt">
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column prop="categoryName" label="类别" width="130" />
          <el-table-column prop="factCount" label="生效事实" width="90" align="right" />
          <el-table-column label="更新" width="170">
            <template #default="{ row }">{{ fmt(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEntity(row)">详情</el-button>
              <el-button link type="success" :loading="acting === row.id" @click="publishEntity(row)">发布</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="draftEntityCount"
            :page-size="20"
            :current-page="entityPage"
            @current-change="loadEntity"
          />
        </div>
      </el-tab-pane>

      <!-- 合并建议 -->
      <el-tab-pane lazy label="合并建议" name="merge">
        <div class="toolbar">
          <el-alert type="info" :closable="false" class="hint grow">
            文章里提到的名称（提及）与库中候选实体相似但拿不准。三选一：<b>合并</b>=并入选中候选作别名；<b>收录</b>=都不是，建成新实体；<b>驳回</b>=丢弃。
          </el-alert>
          <el-button type="warning" plain :loading="autoResolving" @click="autoWeakNew">自动裁决(top1≥0.95→合并/&lt;0.95→收录)</el-button>
        </div>
        <div v-loading="loadingMerge" class="cards mt">
          <el-empty v-if="!loadingMerge && !mergeTasks.length" description="暂无合并建议" />
          <el-card v-for="t in mergeTasks" :key="t.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="warning" effect="plain">合并建议 #{{ t.id }}</el-tag>
              <span class="mention">「{{ t.mentionName }}」</span>
              <span class="muted">应并入哪个实体？</span>
            </div>
            <div class="reason">{{ pl(t).reason }}</div>
            <el-radio-group v-model="selMap[t.id]" class="cands">
              <el-radio v-for="c in pl(t).candidates" :key="c.id" :value="c.id" class="cand">
                <span class="cand-name">{{ c.name }}</span>
                <el-tag size="small" :type="scoreTag(c.score)" effect="plain">{{ c.score.toFixed(2) }}</el-tag>
                <span class="muted">{{ c.src }}·字面{{ (c.lit ?? 0).toFixed(2) }}<template v-if="c.sem != null">·语义{{ c.sem.toFixed(2) }}</template></span>
              </el-radio>
            </el-radio-group>
            <div class="kv quote"><span class="k">出处</span><span class="v">“{{ pl(t).evidence }}”</span></div>
            <div class="task-actions">
              <el-button type="success" size="small" :loading="acting === t.id" :disabled="!selMap[t.id]" @click="resolveMerge(t)">
                合并到选中实体
              </el-button>
              <el-button type="primary" size="small" plain :loading="acting === t.id" @click="resolve(t, 'new')">都不是，收录为新实体</el-button>
              <el-button type="danger" size="small" plain :loading="acting === t.id" @click="resolve(t, 'reject')">驳回</el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="mergeTotal"
            :page-size="20"
            :current-page="mergePage"
            @current-change="loadMerge"
          />
        </div>
      </el-tab-pane>

      <!-- 冲突 -->
      <el-tab-pane lazy label="属性冲突" name="conflict">
        <div v-loading="loadingConflict" class="cards">
          <el-empty v-if="!loadingConflict && !conflictTasks.length" description="暂无属性冲突" />
          <el-card v-for="t in conflictTasks" :key="t.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="danger" effect="plain">属性冲突 #{{ t.id }}</el-tag>
              <span class="mention">「{{ t.mentionName }}」</span>
            </div>
            <div class="reason">{{ pl(t).reason }}</div>
            <el-radio-group v-model="selMap[t.id]" class="cands">
              <el-radio v-for="c in pl(t).candidates" :key="c.id" :value="c.id" class="cand">
                <span class="cand-name">{{ c.name }}</span>
                <el-tag size="small" :type="scoreTag(c.score)" effect="plain">{{ c.score.toFixed(2) }}</el-tag>
              </el-radio>
            </el-radio-group>
            <div class="judge" v-if="pl(t).judge">
              <b>模型判决：</b>{{ JSON.stringify(pl(t).judge) }}
            </div>
            <div class="task-actions">
              <el-button type="success" size="small" :loading="acting === t.id" :disabled="!selMap[t.id]" @click="resolveMerge(t)">
                认同为同一实体（写别名）
              </el-button>
              <el-button type="primary" size="small" plain :loading="acting === t.id" @click="resolve(t, 'new')">收录为新实体</el-button>
              <el-button type="danger" size="small" plain :loading="acting === t.id" @click="resolve(t, 'reject')">驳回</el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="conflictTotal"
            :page-size="20"
            :current-page="conflictPage"
            @current-change="loadConflict"
          />
        </div>
      </el-tab-pane>

      <!-- 新谓词 -->
      <el-tab-pane lazy label="新谓词" name="predicate">
        <el-alert type="info" :closable="false" class="hint">
          抽取时 LLM 用了维度表之外的表述（如「签约」「落成」）。把它映射到一个标准口径维度并注册后，后续抽取会自动翻译，同类谓词不再进入此队列。
        </el-alert>
        <div v-loading="loadingPredicate" class="cards">
          <el-empty v-if="!loadingPredicate && !predicateTasks.length" description="暂无新谓词" />
          <el-card v-for="t in predicateTasks" :key="t.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="info" effect="plain">新谓词 #{{ t.id }}</el-tag>
              <span class="mention">「{{ pl(t).raw }}」</span>
            </div>
            <div class="reason">建议映射维度：{{ (pl(t).suggestion ?? []).join('、') || '（无建议）' }}</div>
            <div class="pred-row">
              <el-select v-model="canonMap[t.id]" placeholder="选择目标维度（全部口径维度）" clearable filterable style="width: 320px">
                <el-option v-for="d in allDims" :key="d.code" :label="`${d.name}（${d.code}）`" :value="d.code" />
                <el-option label="__新建维度__" value="__new__" />
              </el-select>
              <template v-if="canonMap[t.id] === '__new__'">
                <el-input
                  v-model="newCanon[t.id]"
                  placeholder="新维度 code（如 签约）"
                  style="width: 160px"
                />
                <el-input
                  v-model="newName[t.id]"
                  placeholder="维度名（如 签约）"
                  style="width: 140px"
                />
                <el-select
                  v-model="newGroup[t.id]"
                  placeholder="分组/类别"
                  filterable
                  allow-create
                  default-first-option
                  style="width: 180px"
                >
                  <el-option v-for="g in groupOptions" :key="g" :label="g" :value="g" />
                </el-select>
              </template>
            </div>
            <div class="task-actions">
              <el-button
                type="success"
                size="small"
                :loading="acting === t.id"
                :disabled="!canonMap[t.id] || (canonMap[t.id] === '__new__' && !newCanon[t.id]?.trim())"
                @click="resolvePredicate(t)"
              >
                注册映射
              </el-button>
              <el-button type="danger" size="small" plain :loading="acting === t.id" @click="resolve(t, 'reject')">驳回</el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="predicateTotal"
            :page-size="20"
            :current-page="predicatePage"
            @current-change="loadPredicate"
          />
        </div>
      </el-tab-pane>

      <!-- 事实拦截 -->
      <el-tab-pane lazy label="事实拦截" name="fact">
        <el-alert type="info" :closable="false" class="hint">
          置信度低于 0.9 的事实草稿（逐字校验已通过），人工看证据决定是否收录。此处与「审核工作台」的草稿审核数据同源，那边支持批量与冲突裁决。
        </el-alert>
<div class="tab-toolbar">
  <el-button type="primary" :loading="autoReviewing" @click="autoReviewFacts">一键审批 ≥0.9</el-button>
</div>

        <div v-loading="loadingFact" class="cards mt">
          <el-empty v-if="!loadingFact && !factDrafts.length" description="暂无事实拦截" />
          <el-card v-for="d in factDrafts" :key="d.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="primary" effect="plain">事实 #{{ d.id }}</el-tag>
              <span class="mention">{{ factEntity(d) }}</span>
              <span class="muted">· {{ payload(d).dimension }}</span>
            </div>
            <div class="kv">
              <span class="k">维度</span>
              <span class="v">
                <el-tag size="small" effect="plain">{{ payload(d).dimension }}</el-tag>
                <el-tag v-if="payload(d).rawDimension && payload(d).rawDimension !== payload(d).dimension" size="small" type="warning" effect="plain">
                  原始：{{ payload(d).rawDimension }}
                </el-tag>
              </span>
            </div>
            <div class="kv"><span class="k">陈述</span><span class="v">{{ payload(d).statement }}</span></div>
            <div class="kv"><span class="k">置信度</span><span class="v">{{ Math.round((Number(payload(d).confidence) || 0) * 100) }}%</span></div>
            <div class="kv quote"><span class="k">引句</span><span class="v">“{{ payload(d).evidence?.quote }}”</span></div>
            <div class="kv" v-if="d.articleTitle || d.articleUrl">
              <span class="k">来源</span>
              <span class="v">
                <a v-if="d.articleUrl && d.articleUrl.startsWith('http')" :href="d.articleUrl" target="_blank" rel="noopener">{{ d.articleTitle || d.articleUrl }}</a>
                <template v-else>{{ d.articleTitle || d.articleUrl }}</template>
              </span>
            </div>
            <div class="task-actions">
              <el-button type="success" size="small" :loading="acting === d.id" @click="approveFact(d)">批准</el-button>
              <el-button type="danger" size="small" plain :loading="acting === d.id" @click="rejectFact(d)">驳回</el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="factPendingCount"
            :page-size="20"
            :current-page="factPage"
            @current-change="loadFacts"
          />
        </div>
      </el-tab-pane>

      <!-- 事件草稿 -->
      <el-tab-pane lazy label="事件草稿" name="event">
        <el-alert type="info" :closable="false" class="hint">
          抽取到的事件草稿（类型/时间/主体/描述/引句）。批准后写入 event 表（status=active）并进入档案页时间线；驳回则丢弃。与「审核工作台」草稿审核同源。
        </el-alert>
        <div class="tab-toolbar">
          <el-button type="primary" :loading="autoApproveEventsLoading" @click="autoApproveEvents">一键全部批准</el-button>
        </div>
        <div v-loading="loadingEvent" class="cards mt">
          <el-empty v-if="!loadingEvent && !eventDrafts.length" description="暂无事件草稿" />
          <el-card v-for="d in eventDrafts" :key="d.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="warning" effect="plain">事件 #{{ d.id }}</el-tag>
              <span class="mention">{{ factEntity(d) }}</span>
            </div>
            <div class="kv"><span class="k">类型</span><span class="v">{{ eventPayload(d).dimension }}</span></div>
            <div class="kv"><span class="k">时间</span><span class="v">{{ eventPayload(d).timeText }}</span></div>
            <div class="kv"><span class="k">主体</span><span class="v">{{ eventPayload(d).entityName }}</span></div>
            <div class="kv"><span class="k">描述</span><span class="v">{{ eventPayload(d).statement }}</span></div>
            <div class="kv quote"><span class="k">引句</span><span class="v">“{{ eventPayload(d).evidence?.quote }}”</span></div>
            <div class="task-actions">
              <el-button type="success" size="small" :loading="acting === d.id" @click="approveEvent(d)">批准</el-button>
              <el-button type="danger" size="small" plain :loading="acting === d.id" @click="rejectEvent(d)">驳回</el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="eventPendingCount"
            :page-size="20"
            :current-page="eventPage"
            @current-change="loadEvents"
          />
        </div>
      </el-tab-pane>

      <!-- 关系草稿（知识图谱的边） -->
      <el-tab-pane lazy label="关系草稿" name="relation">
        <el-alert type="info" :closable="false" class="hint">
          关系草稿（头实体 - 谓词 - 尾实体）。批准后写入知识图谱边表；尾实体标「新候选」的会在通过时自动建实体（草稿态）。驳回则丢弃。
        </el-alert>
        <div class="tab-toolbar">
          <el-button type="primary" plain :loading="llmReviewing" @click="llmReviewRelations">
            大模型审批纠偏{{ llmReviewProgress ? `（${llmReviewProgress}）` : '' }}
          </el-button>
          <el-button type="primary" :loading="autoApproveRelationsLoading" @click="autoApproveRelations">
            一键全部批准
          </el-button>
        </div>
        <div v-loading="loadingRelation" class="cards">
          <el-empty v-if="!loadingRelation && !relationDrafts.length" description="暂无关系草稿" />
          <el-card v-for="d in relationDrafts" :key="d.id" class="task-card">
            <div class="task-head">
              <el-tag size="small" type="warning" effect="plain">关系 #{{ d.id }}</el-tag>
              <span class="mention">{{ rp(d).head }}</span>
              <el-tag size="small">{{ String(rp(d).predicate ?? '').replace('rel_', '') }}</el-tag>
              <span class="mention">{{ rp(d).tailText }}</span>
              <el-tag v-if="!rp(d).tailEntityId" size="small" type="warning">新候选</el-tag>
              <el-tag v-else size="small" type="success" effect="plain">已入库</el-tag>
              <el-tooltip v-if="rp(d).verifyFailed" :content="rp(d).verifyReason ?? '判别式验证未通过'">
                <el-tag size="small" type="danger" effect="dark">验证未通过待人工</el-tag>
              </el-tooltip>
            </div>
            <div class="task-body">
              <div class="kv"><b>陈述</b>{{ rp(d).statement }}</div>
              <div class="kv"><b>引句</b><span class="quote">{{ rp(d).evidence?.quote }}</span></div>
              <div class="kv">
                <b>置信度</b>{{ rp(d).confidence ?? '-' }}
                <el-tag v-if="rp(d).verifyFailed" size="small" type="danger" effect="plain">已降级</el-tag>
              </div>
            </div>
            <div class="task-actions">
              <el-button type="success" size="small" :loading="acting === d.id" @click="approveRelation(d)">批准</el-button>
              <el-button type="danger" size="small" plain :loading="acting === d.id" @click="rejectRelation(d)">
                驳回
              </el-button>
            </div>
          </el-card>
        </div>
        <div class="page-bar">
          <el-pagination
            layout="total, prev, pager, next"
            :total="relationPendingCount"
            :page-size="20"
            :current-page="relationPage"
            @current-change="loadRelations"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import {
  datasetApi,
  discoveryApi,
  entityApi,
  factDimensionApi,
  pipelineApi,
  type AlignTask,
  type ExtractionDraft,
  type FactDimension,
} from '@/api';
import type { EntityListItem } from '@/types';

const datasetId = ref(1);
const datasets = ref<{ id: number; name: string }[]>([]);
const AUTO_NEW_THRESHOLD = 0.95;
const router = useRouter();

const tab = ref('entity');
const loading = ref(false);
const acting = ref<number | null>(null);
const autoPublishing = ref(false);
const autoResolving = ref(false);
const autoReviewing = ref(false);

const draftEntities = ref<EntityListItem[]>([]);
const draftEntityCount = ref(0);
const loadingEntity = ref(false);

const pending = reactive<Record<string, number>>({});
const factPendingCount = ref(0);

const mergeTasks = ref<AlignTask[]>([]);
const conflictTasks = ref<AlignTask[]>([]);
const predicateTasks = ref<AlignTask[]>([]);
const factDrafts = ref<ExtractionDraft[]>([]);
const eventDrafts = ref<ExtractionDraft[]>([]);
const loadingMerge = ref(false);
const loadingConflict = ref(false);
const loadingPredicate = ref(false);
const loadingFact = ref(false);
const loadingEvent = ref(false);
const eventPendingCount = ref(0);
const autoApproveEventsLoading = ref(false);
const relationDrafts = ref<ExtractionDraft[]>([]);
const relationPendingCount = ref(0);
const loadingRelation = ref(false);
const autoApproveRelationsLoading = ref(false);

const selMap = reactive<Record<number, number>>({});
const canonMap = reactive<Record<number, string>>({});
const newCanon = reactive<Record<number, string>>({});
const newName = reactive<Record<number, string>>({});
const newGroup = reactive<Record<number, string>>({});

// ---- 各列表分页状态 ----
const entityPage = ref(1);
const mergePage = ref(1);
const mergeTotal = ref(0);
const conflictPage = ref(1);
const conflictTotal = ref(0);
const predicatePage = ref(1);
const predicateTotal = ref(0);
const factPage = ref(1);
const eventPage = ref(1);
const relationPage = ref(1);

// 该语料域全部口径维度（用于新谓词映射时可选全量，而非仅任务里截取的 10 个）
const allDims = ref<FactDimension[]>([]);
const groupOptions = computed(() =>
  Array.from(new Set(allDims.value.map((d) => d.description).filter((g): g is string => !!g))),
);
const loadDims = async () => {
  try {
    const dims = await factDimensionApi.list();
    allDims.value = dims.filter((d) => d.status === 'active');
  } catch {
    /* 拦截器已提示 */
  }
};

interface Cand { id: number; name: string; score: number; src: string; lit: number; sem: number | null }

const pl = (t: AlignTask) => (t.payloadJson ?? {}) as Record<string, any>;
const payload = (d: ExtractionDraft) => (d.payloadJson ?? {}) as Record<string, any>;
/** 事件草稿 payload（kind='event'）：dimension=事件类型, timeText, entityName=主体, statement=描述 */
const eventPayload = (d: ExtractionDraft) => (d.payloadJson ?? {}) as Record<string, any>;
/** 关系草稿 payload（kind='relation'）：head 头实体名, predicate 归一谓词, tailText 尾实体文本 */
const rp = (d: ExtractionDraft) =>
  (d.payloadJson ?? {}) as {
    head?: string;
    predicate?: string;
    predicateRaw?: string | null;
    tailText?: string;
    tailEntityId?: number | null;
    tailType?: string | null;
    statement?: string;
    confidence?: number;
    evidence?: { quote?: string };
    verifyFailed?: boolean;
    verifyReason?: string;
  };
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-');
const factEntity = (d: ExtractionDraft) => d.entityName || (payload(d).entityName as string) || `实体#${d.entityId ?? '?'}`;
const scoreTag = (s: number) => (s >= 0.8 ? 'success' : s >= 0.6 ? 'warning' : 'danger');

const initSel = (list: AlignTask[]) => {
  for (const t of list) if (!selMap[t.id] && t.entityId) selMap[t.id] = t.entityId;
};

const loadEntity = async (page = entityPage.value) => {
  loadingEntity.value = true;
  try {
    const res = await entityApi.list({ datasetId: datasetId.value, status: 'draft', page, pageSize: 20 });
    draftEntities.value = res.items;
    draftEntityCount.value = res.total;
    entityPage.value = res.page;
  } finally {
    loadingEntity.value = false;
  }
};
const loadPending = async () => {
  const q = await discoveryApi.queue(datasetId.value);
  Object.assign(pending, q.pendingAlign);
};
const loadMerge = async (page = mergePage.value) => {
  loadingMerge.value = true;
  try {
    const res = await discoveryApi.alignTasks(datasetId.value, 'merge_suggest', page, 20);
    mergeTasks.value = res.items;
    mergeTotal.value = res.total;
    mergePage.value = res.page;
    initSel(mergeTasks.value);
  } finally {
    loadingMerge.value = false;
  }
};
const loadConflict = async (page = conflictPage.value) => {
  loadingConflict.value = true;
  try {
    const res = await discoveryApi.alignTasks(datasetId.value, 'conflict', page, 20);
    conflictTasks.value = res.items;
    conflictTotal.value = res.total;
    conflictPage.value = res.page;
    initSel(conflictTasks.value);
  } finally {
    loadingConflict.value = false;
  }
};
const loadPredicate = async (page = predicatePage.value) => {
  loadingPredicate.value = true;
  try {
    const res = await discoveryApi.alignTasks(datasetId.value, 'predicate_new', page, 20);
    predicateTasks.value = res.items;
    predicateTotal.value = res.total;
    predicatePage.value = res.page;
  } finally {
    loadingPredicate.value = false;
  }
};
const loadFacts = async (page = factPage.value) => {
  loadingFact.value = true;
  try {
    const res = await pipelineApi.listDrafts({ status: 'pending', targetType: 'fact', pageSize: 20, page, datasetId: datasetId.value });
    factDrafts.value = res.items;
    factPendingCount.value = res.total;
    factPage.value = res.page;
  } finally {
    loadingFact.value = false;
  }
};
const loadEvents = async (page = eventPage.value) => {
  loadingEvent.value = true;
  try {
    const res = await pipelineApi.listDrafts({ status: 'pending', targetType: 'event', pageSize: 20, page, datasetId: datasetId.value });
    eventDrafts.value = res.items;
    eventPendingCount.value = res.total;
    eventPage.value = res.page;
  } finally {
    loadingEvent.value = false;
  }
};

const loadRelations = async (page = relationPage.value) => {
  loadingRelation.value = true;
  try {
    const res = await pipelineApi.listDrafts({ status: 'pending', targetType: 'relation', pageSize: 20, page, datasetId: datasetId.value });
    relationDrafts.value = res.items;
    relationPendingCount.value = res.total;
    relationPage.value = res.page;
  } finally {
    loadingRelation.value = false;
  }
};

const approveRelation = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.approveDraft(d.id);
    ElMessage.success('已入图（尾实体为新候选时自动建实体）');
    await Promise.all([loadRelations(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const rejectRelation = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.rejectDraft(d.id);
    ElMessage.success('已驳回');
    await Promise.all([loadRelations(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const autoApproveRelations = async () => {
  if (!relationDrafts.value.length) return;
  autoApproveRelationsLoading.value = true;
  try {
    const res = await pipelineApi.batchReview(
      relationDrafts.value.map((d) => d.id),
      'approve',
    );
    ElMessage.success(`一键批准：${res.succeeded}/${res.total} 成功`);
    await Promise.all([loadRelations(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    autoApproveRelationsLoading.value = false;
  }
};

/**
 * 大模型审批纠偏关系草稿：发起后台任务（立即返回）后轮询进度，
 * approve 的直接入图，reject 的记 rejectReason 丢弃，revise 的按修正后的三元组入库。
 */
const llmReviewing = ref(false);
const llmReviewProgress = ref('');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const llmReviewRelations = async () => {
  if (!relationDrafts.value.length) {
    ElMessage.info('没有待审关系草稿');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将把 ${relationDrafts.value.length} 条待审关系草稿分批次交给生产线文本模型审核（模型来自「大模型设置」里设为生产线的文本模型，多条取第一条）。批准入图、驳回丢弃、方向/谓词有误的自动纠偏后入图。继续？`,
      '大模型审批纠偏',
      { type: 'warning', confirmButtonText: '开始审批', cancelButtonText: '取消' },
    );
  } catch { return; }

  const res = await pipelineApi.startLlmReview(relationDrafts.value.map((d) => d.id));
  if (!res.accepted) {
    ElMessage.warning(res.message || '上一轮大模型审批仍在执行中');
    return;
  }
  llmReviewing.value = true;
  llmReviewProgress.value = '';
  try {
    // 轮询后台任务进度（每 5s）；进程刷新后状态仍在后端，可继续查
    let state = res.state;
    while (state.running) {
      llmReviewProgress.value = state.total ? `${state.processed}/${state.total}` : '…';
      await sleep(5000);
      state = await pipelineApi.llmReviewStatus();
    }
    llmReviewing.value = false;
    llmReviewProgress.value = '';
    if (state.status === 'error') {
      ElMessage.error(`审批失败：${state.error ?? '未知错误'}`);
      await Promise.all([loadRelations(), loadPending()]);
      return;
    }
    const msg = `审批完成（${state.model ?? ''}）：通过 ${state.approved}/${state.total}，纠偏 ${state.revised}，驳回 ${state.rejected}，失败 ${state.failures?.length ?? 0}（${state.batches} 批）`;
    const detailParts: string[] = [];
    if (state.rejectedList?.length) {
      detailParts.push(
        `驳回明细（前 8 条）：\n` + state.rejectedList.slice(0, 8).map((r) => `#${r.id} ${r.reason ?? ''}`).join('\n'),
      );
    }
    if (state.revisedList?.length) {
      detailParts.push(
        `纠偏明细（前 8 条）：\n` + state.revisedList.slice(0, 8).map((r) => `#${r.id} ${r.detail ?? ''}`).join('\n'),
      );
    }
    if (detailParts.length) {
      try {
        await ElMessageBox.alert(`${msg}\n\n${detailParts.join('\n\n')}`, '大模型审批纠偏结果', { type: 'info' });
      } catch { /* 已展示 */ }
    } else {
      ElMessage.success(msg);
    }
    await Promise.all([loadRelations(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    llmReviewing.value = false;
    llmReviewProgress.value = '';
  }
};

const loadAll = async () => {
  loading.value = true;
  try {
    if (!datasets.value.length) {
      try {
        const res = await datasetApi.list({ pageSize: 200 });
        datasets.value = (res.items ?? []).map((d) => ({ id: d.id, name: d.name }));
        if (datasets.value.length && !datasets.value.some((d) => d.id === datasetId.value)) {
          datasetId.value = datasets.value[0].id;
        }
      } catch {
        /* 语料域列表拉取失败时沿用默认 */
      }
    }
    // 语料域切换或刷新时回到第 1 页
    entityPage.value = 1;
    mergePage.value = 1;
    conflictPage.value = 1;
    predicatePage.value = 1;
    factPage.value = 1;
    eventPage.value = 1;
    relationPage.value = 1;
    await Promise.all([
      loadEntity(),
      loadPending(),
      loadMerge(),
      loadConflict(),
      loadPredicate(),
      loadDims(),
      loadFacts(),
      loadEvents(),
      loadRelations(),
    ]);
  } finally {
    loading.value = false;
  }
};

const resolve = async (t: AlignTask, resolution: 'merge' | 'new' | 'reject') => {
  acting.value = t.id;
  try {
    await discoveryApi.resolve(t.id, resolution);
    ElMessage.success(
      resolution === 'merge' ? '已合并（写别名）' : resolution === 'new' ? '已收录为新实体（草稿）' : '已驳回',
    );
    await Promise.all([loadMerge(), loadConflict(), loadPending(), loadEntity()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const resolveMerge = async (t: AlignTask) => {
  acting.value = t.id;
  try {
    await discoveryApi.resolve(t.id, 'merge', undefined, selMap[t.id]);
    ElMessage.success('已合并（写别名）');
    await Promise.all([loadMerge(), loadConflict(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const resolvePredicate = async (t: AlignTask) => {
  const sel = canonMap[t.id];
  const isNew = sel === '__new__';
  const canonical = isNew ? (newCanon[t.id]?.trim() ?? '') : (sel ?? '');
  if (!canonical) return;
  const newNameVal = isNew ? newName[t.id]?.trim() || canonical : undefined;
  const newGroupVal = isNew ? newGroup[t.id]?.trim() || undefined : undefined;
  acting.value = t.id;
  try {
    await discoveryApi.resolve(t.id, 'merge', canonical, undefined, newNameVal, newGroupVal);
    ElMessage.success(`已注册映射：${pl(t).raw} → ${canonical}`);
    await Promise.all([loadPredicate(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

/** 自动裁决：top1 ≥0.95 → 自动合并；<0.95 → 自动收录新实体（对齐管线标准） */
const autoWeakNew = async () => {
  const candsOf = (t: AlignTask) => (pl(t).candidates ?? []) as Cand[];
  const mergeTasks2 = mergeTasks.value.filter((t) => (candsOf(t)[0]?.score ?? 0) >= AUTO_NEW_THRESHOLD);
  const newTasks2 = mergeTasks.value.filter((t) => (candsOf(t)[0]?.score ?? 0) < AUTO_NEW_THRESHOLD);
  if (!mergeTasks2.length && !newTasks2.length) {
    ElMessage.info('没有待裁决任务');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `按管线标准自动裁决 ${mergeTasks2.length + newTasks2.length} 条：top1≥${AUTO_NEW_THRESHOLD} 合并 ${mergeTasks2.length} 条，top1<${AUTO_NEW_THRESHOLD} 收录新实体 ${newTasks2.length} 条。确认？`,
      '自动裁决',
      { type: 'warning', confirmButtonText: '执行', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  autoResolving.value = true;
  let ok = 0;
  let failed = 0;
  try {
    for (const t of mergeTasks2) {
      const top = candsOf(t)[0];
      if (!top) continue;
      try {
        await discoveryApi.resolve(t.id, 'merge', undefined, top.id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    for (const t of newTasks2) {
      try {
        await discoveryApi.resolve(t.id, 'new');
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    ElMessage.success(`自动裁决完成：合并+收录 ${ok} 条，失败 ${failed} 条`);
    await Promise.all([loadMerge(), loadPending(), loadEntity()]);
  } finally {
    autoResolving.value = false;
  }
};

/** 自动审批：后端规则端点（有事实草稿的 draft 实体批量发布 + 审计留痕） */
const autoPublish = async () => {
  autoPublishing.value = true;
  try {
    const res = await entityApi.autoPublish(datasetId.value);
    if (!res.candidates) {
      ElMessage.info('没有符合规则（有事实草稿）的草稿实体');
      return;
    }
    ElMessage.success(`自动发布 ${res.published}/${res.candidates} 个实体（已留痕 audit_log）`);
    await loadEntity();
  } catch {
    /* 拦截器已提示 */
  } finally {
    autoPublishing.value = false;
  }
};

const openEntity = (row: EntityListItem) => router.push(`/entities?keyword=${encodeURIComponent(row.name)}`);

const publishEntity = async (row: EntityListItem) => {
  try {
    await ElMessageBox.confirm(
      `确认发布「${row.name}」？发布后将在档案页对外可见（draft → published）。`,
      '发布实体',
      { type: 'warning', confirmButtonText: '发布', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  acting.value = row.id;
  try {
    await entityApi.update(row.id, { status: 'published' });
    ElMessage.success('已发布');
    await loadEntity();
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const approveFact = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.approveDraft(d.id);
    ElMessage.success('已批准并写入事实版本链');
    await Promise.all([loadFacts(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};
const rejectFact = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.rejectDraft(d.id);
    ElMessage.success('已驳回');
    await Promise.all([loadFacts(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};

const autoReviewFacts = async () => {
  try {
    await ElMessageBox.confirm('将自动审批置信度 ≥0.9 的事实草稿，低于阈值的保留人工。继续？', '一键审批', { type: 'info' });
  } catch { return; }
  autoReviewing.value = true;
  try {
    const res = await pipelineApi.autoReviewFactDrafts(0.9);
    ElMessage.success(`自动审批完成：放行 ${res.autoApproved} 条，拦截 ${res.blocked} 条`);
    await loadFacts();
  } catch {
    /* 拦截器已提示 */
  } finally {
    autoReviewing.value = false;
  }
};

// —— 事件草稿 ——
const approveEvent = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.approveDraft(d.id);
    ElMessage.success('已批准，写入 event 表（active）并进入时间线');
    await Promise.all([loadEvents(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};
const rejectEvent = async (d: ExtractionDraft) => {
  acting.value = d.id;
  try {
    await pipelineApi.rejectDraft(d.id);
    ElMessage.success('已驳回');
    await Promise.all([loadEvents(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    acting.value = null;
  }
};
const autoApproveEvents = async () => {
  if (!eventDrafts.value.length) {
    ElMessage.info('没有待审事件草稿');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将一键批准 ${eventDrafts.value.length} 条事件草稿（写入 event 表并进入时间线）。继续？`,
      '一键全部批准',
      { type: 'warning', confirmButtonText: '执行', cancelButtonText: '取消' },
    );
  } catch { return; }
  autoApproveEventsLoading.value = true;
  try {
    const res = await pipelineApi.batchReview(eventDrafts.value.map((d) => d.id), 'approve');
    ElMessage.success(`一键批准：${res.succeeded}/${res.total} 成功`);
    await Promise.all([loadEvents(), loadPending()]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    autoApproveEventsLoading.value = false;
  }
};

onMounted(loadAll);
</script>

<style scoped>
.page {
  padding: 20px 24px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
.page-title {
  margin: 0;
  font-size: 20px;
}
.page-desc {
  margin-top: 4px;
  font-size: 13px;
  color: #8a97a5;
}
.overview {
  display: flex;
  gap: 14px;
  margin-bottom: 18px;
}
.ov-card {
  flex: 1;
  background: #f5f8fc;
  border: 1px solid #e3ebf5;
  border-radius: 10px;
  padding: 14px 16px;
  text-align: center;
}
.ov-num {
  font-size: 26px;
  font-weight: 700;
  color: #0b5cab;
}
.ov-label {
  margin-top: 4px;
  font-size: 12px;
  color: #8a97a5;
}
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}
.grow {
  flex: 1;
}
.hint {
  margin-bottom: 0;
}
.mt {
  margin-top: 12px;
}

.tab-toolbar {
  display: flex;
  justify-content: flex-end;
  margin: 12px 0 16px;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.task-card {
  border-left: 3px solid #0b5cab;
}
.task-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mention {
  font-weight: 600;
  color: #1d2b3a;
}
.muted {
  color: #8a97a5;
  font-size: 12px;
}
.reason {
  margin-top: 8px;
  font-size: 13px;
  color: #4e5969;
}
.cands {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.cand {
  background: #f7f9fc;
  border-radius: 6px;
  padding: 6px 10px;
  margin-right: 0 !important;
  height: auto;
  width: 100%;
}
.cand-name {
  font-weight: 600;
  color: #1d2b3a;
  margin-right: 8px;
}
.judge {
  margin-top: 8px;
  font-size: 12px;
  color: #4e5969;
  background: #fff7f0;
  border-radius: 6px;
  padding: 6px 10px;
}
.pred-row {
  margin-top: 8px;
  display: flex;
  gap: 10px;
  align-items: center;
}
.kv {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 13px;
}
.kv .k {
  color: #8a97a5;
  width: 56px;
  flex-shrink: 0;
}
.kv .v {
  color: #1d2b3a;
  line-height: 1.6;
}
.kv.quote .v {
  color: #4e5969;
}
.task-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.page-bar {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
