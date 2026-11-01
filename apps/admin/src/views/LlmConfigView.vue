<template>
  <div class="page">
    <div class="toolbar">
      <div class="title-wrap">
        <h2 class="page-title">大模型设置</h2>
        <div class="active-tags">
          <template v-if="production.length">
            <el-tag v-for="m in production" :key="m.id" type="success" effect="plain">
              生产线：{{ m.name }}（{{ m.model }}）
            </el-tag>
            <el-tag type="info" effect="plain">
              共 {{ production.length }} 条生产线 · 抽取时并发调用、结果合并
            </el-tag>
          </template>
          <el-tag v-else type="warning" effect="plain">
            生产线未设置：需在「文本模型」里启用并设为生产线（否则回落环境变量 / 规则抽取）
          </el-tag>
          <el-tag v-if="activeVector" type="success" effect="plain">
            向量生产线：{{ activeVector.name }}（{{ activeVector.model }}{{ activeVector.useDefaultDim ? '' : ` · ${activeVector.dimensions}维` }}）
          </el-tag>
          <el-tag v-else type="warning" effect="plain">向量生产线：未设置（回落 EMBED_PROVIDER 环境变量）</el-tag>
        </div>
      </div>
      <el-button type="primary" @click="openCreate(activeTab)">
        新建{{ TAB_LABEL[activeTab] }}配置
      </el-button>
    </div>

    <el-tabs v-model="activeTab" @tab-change="load">
      <el-tab-pane label="文本模型（生产线）" name="text">
        <el-table :data="rowsText" v-loading="loading" border stripe>
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="model" label="模型" min-width="150" />
          <el-table-column prop="baseUrl" label="接口地址" min-width="240" show-overflow-tooltip />
          <el-table-column label="温度" width="80" align="center">
            <template #default="{ row }">{{ Number(row.temperature) }}</template>
          </el-table-column>
          <el-table-column label="并发数" width="80" align="center">
            <template #default="{ row }">{{ row.concurrency ?? 10 }}</template>
          </el-table-column>
          <el-table-column label="生产线" width="100" align="center">
            <template #default="{ row }"><el-tag v-if="row.isDefault" type="success">是</el-tag><span v-else>-</span></template>
          </el-table-column>
          <el-table-column label="启用" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.enabled" type="success">启用</el-tag>
              <el-tag v-else type="info">停用</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="330" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button link type="success" @click="testRow(row)">测试</el-button>
              <el-button link type="warning" :disabled="row.isDefault" @click="setDefault(row)">设为生产线</el-button>
              <el-button link :disabled="!row.isDefault" @click="unsetDefault(row)">取消生产线</el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="向量模型" name="vector">
        <el-table :data="rowsVector" v-loading="loading" border stripe>
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="model" label="模型" min-width="150" />
          <el-table-column label="维度" width="120" align="center">
            <template #default="{ row }">
              <template v-if="row.useDefaultDim">默认</template>
              <template v-else>{{ row.dimensions ?? '—' }}</template>
            </template>
          </el-table-column>
          <el-table-column prop="baseUrl" label="接口地址" min-width="220" show-overflow-tooltip />
          <el-table-column label="生产线" width="100" align="center">
            <template #default="{ row }"><el-tag v-if="row.isDefault" type="success">是</el-tag><span v-else>-</span></template>
          </el-table-column>
          <el-table-column label="启用" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.enabled" type="success">启用</el-tag>
              <el-tag v-else type="info">停用</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="300" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button link type="success" @click="testRow(row)">测试</el-button>
              <el-button link type="warning" :disabled="row.isDefault" @click="setDefault(row)">设为生产线</el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="dialog" :title="editing ? '编辑配置' : '新建配置'" width="620px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="类型">
          <el-radio-group v-model="form.kind" :disabled="!!editing">
            <el-radio value="text">文本模型</el-radio>
            <el-radio value="vector">向量模型</el-radio>
          </el-radio-group>
          <div class="field-hint">生产线抽取只认「文本模型」里启用并设为生产线的配置，多条时并发调用</div>
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" placeholder="如 生产-GLM / 生产-Embedding" /></el-form-item>
        <template v-if="form.kind !== 'vector'">
          <el-form-item label="接口地址">
            <el-input v-model="form.baseUrl" placeholder="https://host/v1/chat/completions" />
          </el-form-item>
          <el-form-item label="模型"><el-input v-model="form.model" placeholder="glm-4.5" /></el-form-item>
          <el-form-item label="温度"><el-input-number v-model="form.temperature" :min="0" :max="2" :step="0.1" /></el-form-item>
          <el-form-item label="最大 Token">
            <el-input-number v-model="form.maxTokens" :min="1" :max="128000" :step="1024" />
            <span class="field-hint">单次调用输出上限（含思考 token）。建议 ≥1024；批量抽取场景建议 64000 以上，GLM-4.6 最高 128K</span>
          </el-form-item>
          <el-form-item label="并发数">
            <el-input-number v-model="form.concurrency" :min="1" :max="50" :step="1" />
            <span class="field-hint">设为生产线的渠道跑批时按此并发数展开 worker（默认 10）</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="模型"><el-input v-model="form.model" placeholder="embedding-3" /></el-form-item>
          <el-form-item label="接口地址">
            <el-input v-model="form.baseUrl" placeholder="https://open.bigmodel.cn/api/paas/v4/embeddings" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="form.apiKey" type="password" show-password
              :placeholder="apiKeyHint" />
            <div class="field-hint">留空则沿用对话账号同款智谱 key（服务器 .env 的 ZHIPU_API_KEY）</div>
          </el-form-item>
          <el-form-item label="使用默认维度">
            <el-switch v-model="form.useDefaultDim" />
            <span class="field-hint ml8">{{ form.useDefaultDim ? '请求不带 dimensions，用智谱默认维度' : '指定维度并随请求发送' }}</span>
          </el-form-item>
          <el-form-item v-if="!form.useDefaultDim" label="维度">
            <el-input-number v-model="form.dimensions" :min="1" :max="4096" :step="64" placeholder="如 2048" />
          </el-form-item>
        </template>
        <el-form-item label="API Key" v-if="form.kind !== 'vector'">
          <el-input v-model="form.apiKey" type="password" show-password :placeholder="editing ? '留空则不修改' : 'sk-...'" />
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        <el-form-item label="设为生产线"><el-switch v-model="form.isDefault" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        <el-button v-if="!editing" @click="testForm">测试连接</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="testDialog" title="连通性测试" width="480px">
      <pre class="test-out">{{ testResult ? JSON.stringify(testResult, null, 2) : '测试中…' }}</pre>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { llmConfigApi, type LlmSetting, type LlmSettingKind } from '@/api';

const TAB_LABEL: Record<LlmSettingKind, string> = { text: '文本', vector: '向量' };

const activeTab = ref<LlmSettingKind>('text');
const rowsText = ref<LlmSetting[]>([]);
const rowsVector = ref<LlmSetting[]>([]);
const production = ref<LlmSetting[]>([]);
const activeText = ref<LlmSetting | null>(null);
const activeVector = ref<LlmSetting | null>(null);
const loading = ref(false);
const dialog = ref(false);
const editing = ref<number | null>(null);
const saving = ref(false);
const testDialog = ref(false);
const testResult = ref<unknown>(null);

const VEC_DEFAULT_URL = 'https://open.bigmodel.cn/api/paas/v4/embeddings';
const apiKeyHint = editing ? '留空则不修改' : '留空则沿用服务器 ZHIPU_API_KEY';

const blank = () => ({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  kind: 'text' as LlmSettingKind,
  dimensions: null as number | null,
  useDefaultDim: true,
  temperature: 0.1,
  maxTokens: 2048,
  concurrency: 10,
  enabled: true,
  isDefault: false,
  notes: null as string | null,
});
const form = reactive(blank());

watch(
  () => form.kind,
  (k) => {
    if (k === 'vector') {
      if (!form.model) form.model = 'embedding-3';
      if (!form.baseUrl) form.baseUrl = VEC_DEFAULT_URL;
      if (form.dimensions == null) form.dimensions = 2048;
    }
  },
);

async function load() {
  loading.value = true;
  try {
    const [t, v, pd, at, av] = await Promise.all([
      llmConfigApi.list('text'),
      llmConfigApi.list('vector'),
      llmConfigApi.production(),
      llmConfigApi.active('text'),
      llmConfigApi.active('vector'),
    ]);
    rowsText.value = t;
    rowsVector.value = v;
    production.value = pd;
    activeText.value = at;
    activeVector.value = av;
  } finally {
    loading.value = false;
  }
}

function openCreate(kind: LlmSettingKind) {
  editing.value = null;
  Object.assign(form, blank());
  form.kind = kind;
  if (kind === 'vector') {
    form.model = 'embedding-3';
    form.baseUrl = VEC_DEFAULT_URL;
  }
  dialog.value = true;
}
function openEdit(row: LlmSetting) {
  editing.value = row.id;
  Object.assign(form, {
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: '',
    model: row.model,
    kind: row.kind,
    dimensions: row.dimensions ?? null,
    useDefaultDim: row.useDefaultDim,
    temperature: Number(row.temperature),
    maxTokens: row.maxTokens,
    concurrency: row.concurrency ?? 10,
    enabled: row.enabled,
    isDefault: row.isDefault,
    notes: row.notes,
  });
  dialog.value = true;
}

async function save() {
  saving.value = true;
  try {
    const payload: Record<string, unknown> = { ...form };
    if (payload.kind !== 'vector') {
      delete payload.dimensions;
      delete payload.useDefaultDim;
    }
    if (payload.kind === 'vector') {
      delete payload.temperature;
      delete payload.maxTokens;
    }
    if (editing.value) {
      if (!form.apiKey) delete payload.apiKey;
      await llmConfigApi.update(editing.value, payload as never);
    } else {
      await llmConfigApi.create(payload as never);
    }
    ElMessage.success('已保存');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

async function setDefault(row: LlmSetting) {
  await llmConfigApi.setDefault(row.id);
  ElMessage.success(row.kind === 'text' ? '已加入生产线（多条将并发调用）' : '已设为向量生产线');
  await load();
}
async function unsetDefault(row: LlmSetting) {
  await llmConfigApi.unsetDefault(row.id);
  ElMessage.success('已移出生产线');
  await load();
}
async function remove(row: LlmSetting) {
  await ElMessageBox.confirm(`确认删除「${row.name}」？`, '提示', { type: 'warning' });
  await llmConfigApi.remove(row.id);
  ElMessage.success('已删除');
  await load();
}
async function testRow(row: LlmSetting) {
  testDialog.value = true;
  testResult.value = null;
  testResult.value = await llmConfigApi.test({ id: row.id });
}
async function testForm() {
  testDialog.value = true;
  testResult.value = null;
  testResult.value = await llmConfigApi.test({ config: { ...form } });
}

onMounted(load);
</script>

<style scoped>
.page {
  padding: 18px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  justify-content: space-between;
}
.title-wrap {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.active-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.field-hint {
  font-size: 12px;
  color: #8a97a5;
}
.ml8 {
  margin-left: 8px;
}
.test-out {
  background: #f6f8fa;
  padding: 12px;
  border-radius: 6px;
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>