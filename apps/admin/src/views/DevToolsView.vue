<template>
  <div class="dev-tools">
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>开发调试 · 数据工具</span>
          <el-button text :loading="loading" @click="loadStats">刷新统计</el-button>
        </div>
      </template>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="清空管线数据会同时清空已入库的新闻"
        description="会清空：抽取任务、草稿、待裁决、事实、事件、证据、关系边、实体属性/文章关联/向量/图谱节点、LLM 调用日志、已入库新闻语料及正文，并重置新闻增量游标。保留：实体与实体别名、分类/维度配置、大模型设置、账号。操作不可撤销。"
      />

      <el-form-item label="当前待清理数据" class="stats-line">
        <span v-if="loading" class="hint">读取中…</span>
        <template v-else>
          <el-tag type="info" effect="plain">合计 {{ stats.total }} 行</el-tag>
          <el-tag v-if="stats.running > 0" type="danger" effect="plain">有 {{ stats.running }} 条任务执行中</el-tag>
          <el-tag v-else type="success" effect="plain">无执行中任务</el-tag>
        </template>
      </el-form-item>

      <el-table :data="stats.items" border stripe size="small" max-height="420">
        <el-table-column prop="label" label="数据" min-width="160" />
        <el-table-column prop="table" label="表名" min-width="180" />
        <el-table-column prop="rows" label="行数" width="120" align="right" />
      </el-table>

      <div class="actions">
        <el-button type="danger" :loading="clearing" :disabled="loading" @click="clearPipeline">
          一键清空管线数据
        </el-button>
        <span class="hint">建议先「取消排队」并等执行中的任务结束，再清空</span>
      </div>
    </el-card>

    <el-card shadow="never" class="mt">
      <template #header>
        <div class="card-head">
          <span>新闻源 · 增量游标</span>
          <el-button text :loading="cursorLoading" @click="loadCursor">刷新</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="重置后下次入库回到「取最新 N 条」模式"
        description="已入库的新闻不会重复：入库时按 external_key 幂等去重。适用于游标异常或需要重新从最新开始采集的场景。"
      />
      <el-form-item label="当前游标" class="stats-line">
        <span v-if="cursorLoading" class="hint">读取中…</span>
        <template v-else-if="cursor">
          <el-tag effect="plain">{{ cursor.docId }}</el-tag>
          <el-tag type="info" effect="plain">发布时间 {{ cursor.pubDate ? fmt(cursor.pubDate) : '—' }}</el-tag>
        </template>
        <el-tag v-else type="warning" effect="plain">无（下次入库取最新 N 条）</el-tag>
      </el-form-item>
      <div class="actions">
        <el-button type="warning" :loading="resetting" :disabled="cursorLoading || !cursor" @click="resetCursor">
          重置游标
        </el-button>
        <span class="hint">重置不会删除已入库的数据与任务</span>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { devApi, newsApi, type NewsEsCursor, type PipelineStatItem } from '@/api';

const fmt = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';

const loading = ref(false);
const clearing = ref(false);
const stats = reactive<{ items: PipelineStatItem[]; total: number; running: number }>({
  items: [],
  total: 0,
  running: 0,
});

async function loadStats() {
  loading.value = true;
  try {
    const r = await devApi.pipelineStats();
    stats.items = r.items;
    stats.total = r.total;
    stats.running = r.running;
  } catch (e) {
    ElMessage.error((e as Error).message || '读取统计失败（若接口 404，请重启后端服务）');
  } finally {
    loading.value = false;
  }
}

async function clearPipeline() {
  try {
    await ElMessageBox.confirm(
      `将清空 ${stats.total} 行管线数据（事实、事件、证据、关系、草稿、任务与调用日志），实体与实体别名会保留。操作不可恢复，确定继续？`,
      '清空管线数据',
      { type: 'warning', confirmButtonText: '确定清空', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  clearing.value = true;
  try {
    const r = await devApi.clearPipeline();
    const failed = r.failures.length ? `，${r.failures.length} 张表失败` : '';
    ElMessage.success(`已清空 ${r.cleared.length} 张表 / 共 ${r.total} 行${failed}`);
    if (r.failures.length) console.warn('[dev] 清空失败明细：', r.failures);
    await loadStats();
  } finally {
    clearing.value = false;
  }
}

// ---------------- 新闻源增量游标 ----------------
const cursor = ref<NewsEsCursor | null>(null);
const cursorLoading = ref(false);
const resetting = ref(false);

async function loadCursor() {
  cursorLoading.value = true;
  try {
    const r = await newsApi.getEsConfig();
    cursor.value = r.cursor;
  } finally {
    cursorLoading.value = false;
  }
}

async function resetCursor() {
  if (!cursor.value) return;
  try {
    await ElMessageBox.confirm(
      `将删除当前增量游标（${cursor.value.docId}），下次入库回到「取最新 N 条」模式。已入库的数据与任务不受影响。确定重置？`,
      '重置增量游标',
      { type: 'warning', confirmButtonText: '确定重置', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  resetting.value = true;
  try {
    await newsApi.resetCursor();
    ElMessage.success('增量游标已重置');
    await loadCursor();
  } finally {
    resetting.value = false;
  }
}

onMounted(() => {
  void loadStats();
  void loadCursor();
});
</script>

<style scoped>
.dev-tools {
  padding: 4px;
}
.mt {
  margin-top: 16px;
  border-radius: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.stats-line {
  margin-top: 12px;
}
.stats-line .el-tag {
  margin-right: 8px;
}
.actions {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
