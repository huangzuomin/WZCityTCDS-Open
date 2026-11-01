<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">事实管理</h2>
        <div class="page-desc">
          append-only 版本链：陈述与证据不可原地修改，元数据（状态/置信度/仲裁说明）可改，口径修正走「退役 + 新建」
        </div>
      </div>
    </div>

    <div class="toolbar">
      <el-select
        v-model="query.datasetId"
        placeholder="语料域"
        clearable
        style="width: 150px"
        @change="onDatasetChange"
      >
        <el-option v-for="d in meta.datasets" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
      <el-select
        v-model="query.entityId"
        placeholder="实体"
        clearable
        filterable
        style="width: 200px"
        @change="onEntityChange"
      >
        <el-option v-for="e in entities" :key="e.id" :label="e.name" :value="e.id" />
      </el-select>
      <el-select v-model="query.dimension" placeholder="口径维度" clearable style="width: 150px" @change="load">
        <el-option v-for="d in dimensions" :key="d.code" :label="d.name" :value="d.code" />
      </el-select>
      <el-select v-model="query.status" placeholder="状态" clearable style="width: 130px" @change="load">
        <el-option label="生效" value="active" />
        <el-option label="仲裁中" value="pending_arbitration" />
        <el-option label="已替代" value="superseded" />
        <el-option label="草稿" value="draft" />
        <el-option label="待复核" value="pending_review" />
        <el-option label="已退役" value="archived" />
        <el-option label="已驳回" value="rejected" />
      </el-select>
      <el-input
        v-model="query.keyword"
        placeholder="陈述关键词"
        clearable
        style="width: 170px"
        @keyup.enter="load"
      />
      <el-button type="primary" @click="load">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
    </div>

    <el-alert
      v-if="conflictGroups.length"
      type="warning"
      :closable="false"
      show-icon
      class="conflict-banner"
    >
      <template #title>
        <span>
          该实体有 {{ conflictGroups.length }} 个维度存在口径冲突
          （共 {{ conflictGroups.reduce((s, g) => s + g.count, 0) }} 条事实待仲裁）
        </span>
        <el-button type="primary" size="small" class="conflict-btn" :loading="arbitrating" @click="openArbitrate">
          冲突裁决
        </el-button>
      </template>
    </el-alert>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column prop="code" label="编号" width="90" />
      <el-table-column label="维度" width="110">
        <template #default="{ row }">{{ dimLabel(row.dimension) }}</template>
      </el-table-column>
      <el-table-column prop="statement" label="陈述" min-width="340" show-overflow-tooltip />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ FACT_TYPE[row.factType] ?? row.factType }}</template>
      </el-table-column>
      <el-table-column label="状态" width="95">
        <template #default="{ row }">
          <el-tag size="small" :type="STATUS_TAG[row.status] ?? 'info'">
            {{ STATUS_LABEL[row.status] ?? row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="版本" width="65" align="right">
        <template #default="{ row }">v{{ row.version }}</template>
      </el-table-column>
      <el-table-column label="置信度" width="90" align="right">
        <template #default="{ row }">{{ (row.confidence * 100).toFixed(0) }}%</template>
      </el-table-column>
      <el-table-column label="证据" width="65" align="right">
        <template #default="{ row }">{{ row.evidences?.length ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="首见" width="105">
        <template #default="{ row }">{{ row.firstSeenAt?.slice(0, 10) ?? '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button
            v-if="row.status === 'active' || row.status === 'pending_arbitration'"
            link
            type="danger"
            @click="retire(row)"
          >
            退役
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[20, 50, 100]"
        @size-change="load"
        @current-change="load"
      />
    </div>

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawer" :title="`事实 ${detail?.code ?? ''}`" size="52%">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="维度">{{ dimLabel(detail.dimension) }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ FACT_TYPE[detail.factType] ?? detail.factType }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="STATUS_TAG[detail.status] ?? 'info'">
              {{ STATUS_LABEL[detail.status] ?? detail.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="版本">v{{ detail.version }}</el-descriptions-item>
          <el-descriptions-item label="首见">{{ detail.firstSeenAt?.slice(0, 10) ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="最近核实">{{ detail.lastVerifiedAt?.slice(0, 10) ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="置信度">{{ (detail.confidence * 100).toFixed(0) }}%</el-descriptions-item>
          <el-descriptions-item label="被替代">
            <span v-if="detail.supersededById" class="mono">#{{ detail.supersededById }}</span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="陈述" :span="2">{{ detail.statement }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.arbitrationNote" label="仲裁说明" :span="2">
            {{ detail.arbitrationNote }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- 证据链 -->
        <h4 class="sec-title">证据（{{ detail.evidences?.length ?? 0 }}）</h4>
        <div v-for="ev in detail.evidences ?? []" :key="ev.id" class="ev-card">
          <div class="ev-head">
            <el-tag size="small" :type="ev.verifyStatus === 'passed' ? 'success' : 'info'" effect="plain">
              {{ ev.verifyStatus === 'passed' ? 'R1 通过' : ev.verifyStatus || '未校验' }}
            </el-tag>
            <el-tag v-if="ev.role && ev.role !== 'support'" size="small" type="danger" effect="plain">
              {{ ev.role === 'refute' ? '反驳' : ev.role }}
            </el-tag>
            <span class="ev-src">{{ ev.sourceOrg ?? ev.materialTitle ?? '-' }}</span>
            <span class="ev-date">{{ ev.publishedAt?.slice(0, 10) ?? '' }}</span>
          </div>
          <div class="ev-quote">“{{ ev.quote }}”</div>
        </div>
        <el-empty v-if="!detail.evidences?.length" description="该事实暂无挂靠证据" :image-size="60" />

        <!-- 元数据编辑 -->
        <h4 class="sec-title">元数据（只改元数据，不产生新版本，全程审计）</h4>
        <el-form label-width="90px" size="small">
          <el-form-item label="状态">
            <el-select v-model="editForm.status" style="width: 200px">
              <el-option label="生效" value="active" />
              <el-option label="仲裁中" value="pending_arbitration" />
              <el-option label="已退役" value="archived" />
            </el-select>
          </el-form-item>
          <el-form-item label="置信度">
            <el-input-number v-model="editForm.confidence" :min="0" :max="1" :step="0.05" :precision="2" />
          </el-form-item>
          <el-form-item label="仲裁说明">
            <el-input
              v-model="editForm.arbitrationNote"
              type="textarea"
              :rows="2"
              placeholder="口径冲突时的裁决依据，展示在档案页"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="saveMeta">保存元数据</el-button>
          </el-form-item>
        </el-form>
      </template>
    </el-drawer>

    <!-- 冲突裁决 -->
    <el-dialog v-model="conflictDialog" title="冲突裁决" width="760px" destroy-on-close>
      <div v-for="g in conflictGroups" :key="g.dimension" class="arb-group">
        <div class="arb-group-head">
          <strong>{{ dimLabel(g.dimension) }}</strong>
          <span class="muted">共 {{ g.count }} 条</span>
          <el-checkbox
            v-model="resolutions[g.dimension].mode"
            :true-value="'coexist'"
            :false-value="'adopt'"
          >标为多流派并存（不强行归一）</el-checkbox>
        </div>
        <el-radio-group
          v-model="resolutions[g.dimension].winnerFactId"
          :disabled="resolutions[g.dimension].mode === 'coexist'"
          class="arb-radios"
        >
          <el-radio v-for="f in g.facts" :key="f.id" :value="f.id" border class="arb-radio">
            <span class="mono">{{ f.code }}</span>
            <el-tag size="small" :type="STATUS_TAG[f.status] ?? 'info'">{{ STATUS_LABEL[f.status] ?? f.status }}</el-tag>
            <span class="arb-conf">{{ (Number(f.confidence) * 100).toFixed(0) }}%</span>
            <span class="arb-stmt">{{ f.statement }}</span>
          </el-radio>
        </el-radio-group>
      </div>
      <el-input
        v-model="arbNote"
        type="textarea"
        :rows="2"
        placeholder="裁决依据（写入仲裁说明，展示在档案页；adopt 与 coexist 通用）"
      />
      <template #footer>
        <el-button @click="conflictDialog = false">取消</el-button>
        <el-button type="primary" :loading="arbitrating" @click="submitArbitrate">提交裁决</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { factApi, factDimensionApi, entityApi, type FactDimension, type FactItem } from '@/api';
import type { EntityListItem } from '@/types';
import { useMetaStore } from '@/stores/meta';

const meta = useMetaStore();
const loading = ref(false);
const saving = ref(false);
const rows = ref<FactItem[]>([]);
const total = ref(0);
const entities = ref<EntityListItem[]>([]);
const dimensions = ref<FactDimension[]>([]);
const drawer = ref(false);
const detail = ref<FactItem | null>(null);
const conflictGroups = ref<{ dimension: string; count: number; facts: FactItem[] }[]>([]);
const conflictDialog = ref(false);
const arbitrating = ref(false);
const arbNote = ref('');
const resolutions = reactive<Record<string, { mode: 'adopt' | 'coexist'; winnerFactId: number | null }>>({});

const query = reactive({
  datasetId: null as number | null,
  entityId: null as number | null,
  dimension: null as string | null,
  status: null as string | null,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const editForm = reactive({
  status: 'active',
  confidence: 0.5,
  arbitrationNote: '',
});

const FACT_TYPE: Record<string, string> = {
  occurred: '已发生事实',
  current_state: '当前状态',
  source_claim: '信源陈述',
};

const STATUS_LABEL: Record<string, string> = {
  active: '生效',
  pending_arbitration: '仲裁中',
  superseded: '已替代',
  draft: '草稿',
  pending_review: '待复核',
  rejected: '已驳回',
  archived: '已退役',
};

const STATUS_TAG: Record<string, string> = {
  active: 'success',
  pending_arbitration: 'warning',
  superseded: 'info',
  draft: 'info',
  pending_review: 'warning',
  rejected: 'danger',
  archived: 'info',
};

const dimLabel = (code: string) =>
  dimensions.value.find((d) => d.code === code)?.name ?? code;

const load = async () => {
  loading.value = true;
  try {
    const res = await factApi.list({
      entityId: query.entityId ?? undefined,
      dimension: query.dimension ?? undefined,
      status: query.status ?? undefined,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
};

const onDatasetChange = async () => {
  query.entityId = null;
  query.dimension = null;
  entities.value = [];
  dimensions.value = [];
  if (query.datasetId) {
    const [ent, dims] = await Promise.all([
      entityApi.list({ datasetId: query.datasetId, pageSize: 200 }),
      factDimensionApi.list(),
    ]);
    entities.value = ent.items;
    dimensions.value = dims;
  }
  await load();
  await loadConflicts();
};

const onEntityChange = async () => {
  await load();
  await loadConflicts();
};

const loadConflicts = async () => {
  if (!query.entityId) {
    conflictGroups.value = [];
    return;
  }
  try {
    const res = await factApi.conflicts(query.entityId);
    conflictGroups.value = res.groups ?? [];
  } catch {
    conflictGroups.value = [];
  }
};

const openArbitrate = () => {
  conflictGroups.value.forEach((g) => {
    const winner = [...g.facts].sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
    resolutions[g.dimension] = { mode: 'adopt', winnerFactId: winner?.id ?? null };
  });
  arbNote.value = '';
  conflictDialog.value = true;
};

const submitArbitrate = async () => {
  if (!query.entityId) return;
  arbitrating.value = true;
  try {
    for (const g of conflictGroups.value) {
      const r = resolutions[g.dimension] ?? { mode: 'adopt' as const, winnerFactId: null };
      await factApi.arbitrate({
        entityId: query.entityId as number,
        dimension: g.dimension,
        mode: r.mode,
        winnerFactId: r.mode === 'adopt' ? (r.winnerFactId ?? undefined) : undefined,
        note: arbNote.value.trim() || null,
      });
    }
    ElMessage.success('冲突已裁决（已记审计）');
    conflictDialog.value = false;
    await Promise.all([loadConflicts(), load()]);
  } finally {
    arbitrating.value = false;
  }
};

const resetQuery = () => {
  Object.assign(query, { entityId: null, dimension: null, status: null, keyword: '', page: 1 });
  load();
};

const openDetail = (row: FactItem) => {
  detail.value = row;
  Object.assign(editForm, {
    status: row.status,
    confidence: Number(row.confidence),
    arbitrationNote: row.arbitrationNote ?? '',
  });
  drawer.value = true;
};

const saveMeta = async () => {
  if (!detail.value) return;
  saving.value = true;
  try {
    await factApi.update(detail.value.id, {
      status: editForm.status,
      confidence: editForm.confidence,
      arbitrationNote: editForm.arbitrationNote.trim() || null,
    });
    ElMessage.success('元数据已保存（已记审计）');
    drawer.value = false;
    await load();
  } finally {
    saving.value = false;
  }
};

const retire = async (row: FactItem) => {
  const { value } = await ElMessageBox.prompt('退役原因（记入事实变化流）', `退役 ${row.code}`, {
    confirmButtonText: '退役',
    cancelButtonText: '取消',
    inputType: 'textarea',
  }).catch(() => ({ value: '' }) as { value: string });
  if (!value) return;
  await factApi.retire(row.id, value);
  ElMessage.success('已退役（原版本保留备查）');
  await load();
};

onMounted(async () => {
  await meta.ensureLoaded();
  if (meta.datasets.length) {
    query.datasetId = meta.datasets[0].id;
    await onDatasetChange();
  }
});
</script>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', Consolas, monospace;
}

.conflict-banner {
  margin-bottom: 12px;
}

.conflict-btn {
  margin-left: 12px;
}

.arb-group {
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.arb-group-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.muted {
  color: #8a97a5;
  font-size: 12px;
}

.arb-radios {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.arb-radio {
  width: 100%;
  margin: 0 !important;
  height: auto !important;
  white-space: normal;
}

.arb-radio :deep(.el-radio__label) {
  white-space: normal;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.arb-conf {
  color: #1d2b3a;
  font-weight: 600;
}

.arb-stmt {
  color: #4e5969;
}

.sec-title {
  margin: 20px 0 10px;
  font-size: 14px;
  color: #1d2b3a;
}

.ev-card {
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
}

.ev-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.ev-src {
  color: #4e5969;
}

.ev-date {
  color: #8a97a5;
}

.ev-quote {
  margin-top: 4px;
  font-size: 13px;
  color: #4e5969;
  line-height: 1.6;
}
</style>
