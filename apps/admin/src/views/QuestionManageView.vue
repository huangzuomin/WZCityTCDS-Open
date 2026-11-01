<template>
  <div class="page">
    <div class="toolbar">
      <el-input v-model="kw" placeholder="搜索问题" clearable style="width: 220px" @keyup.enter="search" />
      <el-select v-model="statusFilter" placeholder="状态" clearable style="width: 130px" @change="search">
        <el-option label="启用" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-select v-model="catFilter" placeholder="类别" clearable style="width: 150px" @change="search">
        <el-option v-for="c in CATS" :key="c" :label="c" :value="c" />
      </el-select>
      <el-button type="primary" @click="openCreate">新建问题</el-button>
      <el-button @click="sync">从事实同步</el-button>
      <el-button type="success" :loading="probing" @click="runSample">随机跑 10 题</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="question" label="问题" min-width="280" show-overflow-tooltip />
      <el-table-column prop="expectedAnswer" label="预期口径" min-width="220" show-overflow-tooltip />
      <el-table-column label="类别" width="110" align="center">
        <template #default="{ row }"><el-tag size="small">{{ row.category }}</el-tag></template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.status === 'active'" type="success" size="small">启用</el-tag>
          <el-tag v-else type="info" size="small">停用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      :current-page="page"
      @current-change="(p: number) => { page = p; search(); }"
    />

    <el-dialog v-model="dialog" :title="editing ? '编辑问题' : '新建问题'" width="620px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="问题"><el-input v-model="form.question" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="预期口径"><el-input v-model="form.expectedAnswer" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="类别">
          <el-select v-model="form.category" style="width: 200px">
            <el-option v-for="c in CATS" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态"><el-switch v-model="form.active" active-text="启用" inactive-text="停用" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resultDialog" title="随机跑 10 题 · 结果" width="820px">
      <el-alert
        v-if="lastRun"
        :title="`共 ${lastRun.questionCount} 题 · 引用我方 ${citedCount} 题`"
        type="success"
        :closable="false"
        style="margin-bottom: 12px"
      />
      <el-table :data="results" border stripe max-height="420">
        <el-table-column prop="question" label="问题" min-width="240" show-overflow-tooltip />
        <el-table-column label="判定" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.cited === 'fact_page' || row.cited === 'same_domain' ? 'success' : row.cited === 'other' ? 'warning' : 'info'" size="small" effect="dark">
              {{ citeText(row.cited) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源 URL" min-width="200">
          <template #default="{ row }">
            <a v-for="u in row.sourceUrls || []" :key="u" :href="u" target="_blank" rel="noopener" class="url">{{ u }}</a>
            <span v-if="!row.sourceUrls || !row.sourceUrls.length" class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="模型回答" min-width="260">
          <template #default="{ row }">
            <span v-if="row.rawAnswer" class="ans">{{ row.rawAnswer.slice(0, 80) }}{{ row.rawAnswer.length > 80 ? '…' : '' }}</span>
            <span v-else class="muted">（未捕获原文）</span>
          </template>
        </el-table-column>
        <el-table-column prop="excerpt" label="摘录" min-width="200" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { observatoryApi, type ProbeQuestion, type ProbeRunResultRow } from '@/api';

const CATS = ['fact', 'time', 'status', 'place', 'public_service', 'history'] as const;

const rows = ref<ProbeQuestion[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const kw = ref('');
const statusFilter = ref<string | undefined>(undefined);
const catFilter = ref<string | undefined>(undefined);

const dialog = ref(false);
const editing = ref<number | null>(null);
const saving = ref(false);
const form = reactive({ question: '', expectedAnswer: '', category: 'fact', active: true });

const resultDialog = ref(false);
const results = ref<ProbeRunResultRow[]>([]);
const lastRun = ref<{ questionCount: number } | null>(null);
const probing = ref(false);
const citedCount = ref(0);

const citeText = (c: string) =>
  c === 'fact_page' ? '事实页' : c === 'same_domain' ? '同域' : c === 'other' ? '其他源' : '未引用';

async function search() {
  loading.value = true;
  try {
    const r = await observatoryApi.questions({
      page: page.value,
      pageSize: pageSize.value,
      status: statusFilter.value,
      category: catFilter.value,
      keyword: kw.value || undefined,
    });
    rows.value = r.items;
    total.value = r.total;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, { question: '', expectedAnswer: '', category: 'fact', active: true });
  dialog.value = true;
}
function openEdit(row: ProbeQuestion) {
  editing.value = row.id;
  Object.assign(form, {
    question: row.question,
    expectedAnswer: row.expectedAnswer,
    category: row.category,
    active: row.status === 'active',
  });
  dialog.value = true;
}
async function save() {
  saving.value = true;
  try {
    const payload = {
      question: form.question,
      expectedAnswer: form.expectedAnswer,
      category: form.category,
      status: form.active ? 'active' : 'disabled',
    };
    if (editing.value) await observatoryApi.updateQuestion(editing.value, payload);
    else await observatoryApi.createQuestion(payload);
    ElMessage.success('已保存');
    dialog.value = false;
    await search();
  } finally {
    saving.value = false;
  }
}
async function remove(row: ProbeQuestion) {
  await ElMessageBox.confirm(`确认删除该问题？`, '提示', { type: 'warning' });
  await observatoryApi.deleteQuestion(row.id);
  ElMessage.success('已删除');
  await search();
}
async function sync() {
  const { synced } = await observatoryApi.syncQuestions();
  ElMessage.success(`已从事实派生 ${synced} 题`);
  await search();
}
async function runSample() {
  probing.value = true;
  try {
    const { runs, results: res } = await observatoryApi.probe({ sample: 10 });
    results.value = res;
    lastRun.value = { questionCount: runs.reduce((s, r) => s + r.questionCount, 0) };
    citedCount.value = res.filter((r) => r.cited === 'fact_page' || r.cited === 'same_domain').length;
    resultDialog.value = true;
    await search();
  } finally {
    probing.value = false;
  }
}

onMounted(search);
</script>

<style scoped>
.page { padding: 18px; }
.toolbar { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.pager { margin-top: 14px; justify-content: flex-end; display: flex; }
.url { display: block; color: #165dff; word-break: break-all; font-size: 12px; }
.muted { color: #c0c4cc; }
.ans { color: #3c4654; font-size: 12.5px; white-space: pre-wrap; }
</style>
