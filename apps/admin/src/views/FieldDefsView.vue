<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">字段定义</h2>
        <div class="page-desc">
          为实体类别配置自定义属性（分类属性）。子类别会继承父类别中「可继承」的字段，同名 key 由子类覆写；这些字段会驱动实体档案的动态表单。
        </div>
      </div>
      <el-button type="primary" :disabled="!categoryId" @click="openCreate">新建字段</el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="datasetId" placeholder="选择语料域" style="width: 220px" @change="onDatasetChange">
        <el-option v-for="d in meta.datasets" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
      <el-tree-select
        v-model="categoryId"
        :data="categoryTree"
        :props="{ label: 'name', children: 'children' }"
        value-key="id"
        check-strictly
        clearable
        placeholder="选择类别"
        style="width: 260px"
        @change="load"
      />
      <span v-if="!categoryId" class="hint">请先选择语料域与类别</span>
    </div>

    <el-alert
      v-if="categoryId"
      type="info"
      :closable="false"
      class="inherit-tip"
      title="下方为当前类别实际生效的字段（含继承自父类别的字段）。标注「继承自 XX」的字段在父类别定义，需到父类别修改/停用；标注「本类别」的可直接编辑。子类别只会继承父类别中「可继承」的字段。"
    />

    <el-table :data="fields" v-loading="loading" border>
      <el-table-column prop="key" label="标识" min-width="120">
        <template #default="{ row }"><span class="mono">{{ row.key }}</span></template>
      </el-table-column>
      <el-table-column prop="label" label="显示名" min-width="120" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">{{ fieldTypeLabel(row.type) }}</template>
      </el-table-column>
      <el-table-column label="来源" min-width="130">
        <template #default="{ row }">
          <el-tag v-if="isOwn(row)" size="small" type="success">本类别</el-tag>
          <el-tag v-else size="small" type="info">继承自 {{ categoryNameMap.get(row.categoryId) || row.categoryId }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="required" label="必填" width="70" align="center">
        <template #default="{ row }"><el-tag size="small" :type="row.required ? 'danger' : 'info'">{{ row.required ? '是' : '否' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="inheritable" label="可继承" width="80" align="center">
        <template #default="{ row }"><el-tag size="small" :type="row.inheritable ? 'success' : 'info'">{{ row.inheritable ? '是' : '否' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="searchable" label="可搜索" width="80" align="center">
        <template #default="{ row }"><el-tag size="small" :type="row.searchable ? 'success' : 'info'">{{ row.searchable ? '是' : '否' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="80" align="center">
        <template #default="{ row }"><el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="70" align="right" />
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <template v-if="isOwn(row)">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm title="确定删除该字段？" @confirm="remove(row)">
              <template #reference><el-button link type="danger">删除</el-button></template>
            </el-popconfirm>
          </template>
          <span v-else class="hint">在父类别定义</span>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑字段' : '新建字段'" width="680">
      <el-form :model="form" label-width="100px">
        <el-form-item label="类别">
          <el-tree-select
            :data="categoryTree"
            :props="{ label: 'name', children: 'children' }"
            value-key="id"
            v-model="form.categoryId"
            check-strictly
            disabled
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="标识 key" required>
          <el-input v-model="form.key" :disabled="!!editing" placeholder="如 flavor" />
          <div class="hint">字母开头，仅含字母、数字、下划线</div>
        </el-form-item>
        <el-form-item label="显示名" required>
          <el-input v-model="form.label" placeholder="如 口味" />
        </el-form-item>
        <el-form-item label="类型" required>
          <el-select v-model="form.type" style="width: 100%" @change="onTypeChange">
            <el-option v-for="t in FIELD_TYPES" :key="t" :label="FIELD_TYPE_LABEL[t]" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="可选项" v-if="isOptionType">
          <div class="options-editor">
            <div v-for="(opt, i) in form.options" :key="i" class="opt-row">
              <el-input v-model="opt.value" placeholder="值" style="width: 42%" />
              <el-input v-model="opt.label" placeholder="显示名" style="width: 42%" />
              <el-button text type="danger" @click="form.options.splice(i, 1)">删</el-button>
            </div>
            <el-button text type="primary" @click="form.options.push({ value: '', label: '' })">+ 添加选项</el-button>
          </div>
        </el-form-item>
        <el-form-item label="默认值">
          <el-input v-model="form.defaultValue" placeholder="可选；单选/多选填选项的值，布尔填 true/false" />
        </el-form-item>
        <el-form-item label="占位符">
          <el-input v-model="form.placeholder" placeholder="表单输入框内的提示" />
        </el-form-item>
        <el-form-item label="帮助文本">
          <el-input v-model="form.helpText" type="textarea" :rows="2" placeholder="字段下方的说明" />
        </el-form-item>
        <el-form-item label="分组">
          <el-input v-model="form.groupName" placeholder="用于在表单中分组展示" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" />
        </el-form-item>
        <el-form-item label="必填"><el-switch v-model="form.required" /></el-form-item>
        <el-form-item label="可继承"><el-switch v-model="form.inheritable" /></el-form-item>
        <el-form-item label="可搜索"><el-switch v-model="form.searchable" /></el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="disabled">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { fieldDefApi } from '@/api';
import { useMetaStore } from '@/stores/meta';
import { FIELD_TYPE_LABEL, type FieldDef, type FieldType } from '@/types';

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABEL) as FieldType[];
const meta = useMetaStore();
const route = useRoute();

const datasetId = ref<number | null>(null);
const categoryId = ref<number | null>(null);
const loading = ref(false);
const fields = ref<FieldDef[]>([]);
const dialog = ref(false);
const submitting = ref(false);
const editing = ref<FieldDef | null>(null);

const categoryTree = computed(() => (datasetId.value ? meta.treeOf(datasetId.value) : []));
const isOptionType = computed(() => form.type === 'select' || form.type === 'multiselect');

const categoryNameMap = computed(() => {
  const map = new Map<number, string>();
  const walk = (nodes: { id: number; name: string; children?: unknown[] }[]) => {
    for (const n of nodes) {
      map.set(n.id, n.name);
      if (Array.isArray(n.children)) walk(n.children as { id: number; name: string; children?: unknown[] }[]);
    }
  };
  walk(categoryTree.value as { id: number; name: string; children?: unknown[] }[]);
  return map;
});

function fieldTypeLabel(t: string): string {
  return FIELD_TYPE_LABEL[t as FieldType] ?? t;
}

function isOwn(row: FieldDef): boolean {
  return row.categoryId === categoryId.value;
}

const form = reactive({
  categoryId: null as number | null,
  key: '',
  label: '',
  type: 'text' as FieldType,
  required: false,
  inheritable: true,
  searchable: false,
  options: [] as { value: string; label: string }[],
  defaultValue: '' as string | null,
  placeholder: '' as string | null,
  helpText: '' as string | null,
  groupName: '' as string | null,
  sort: 0,
  status: 'active' as 'active' | 'disabled',
});

async function load() {
  if (!categoryId.value) {
    fields.value = [];
    return;
  }
  loading.value = true;
  try {
    fields.value = await fieldDefApi.resolved(categoryId.value);
  } finally {
    loading.value = false;
  }
}

function onDatasetChange() {
  categoryId.value = null;
  void load();
}

function onTypeChange() {
  if (!isOptionType.value) form.options = [];
}

function openCreate() {
  if (!categoryId.value) return;
  editing.value = null;
  form.categoryId = categoryId.value;
  form.key = '';
  form.label = '';
  form.type = 'text';
  form.required = false;
  form.inheritable = true;
  form.searchable = false;
  form.options = [];
  form.defaultValue = null;
  form.placeholder = null;
  form.helpText = null;
  form.groupName = null;
  form.sort = 0;
  form.status = 'active';
  dialog.value = true;
}

async function openEdit(row: FieldDef) {
  editing.value = row;
  form.categoryId = row.categoryId;
  form.key = row.key;
  form.label = row.label;
  form.type = row.type;
  form.required = row.required;
  form.inheritable = row.inheritable;
  form.searchable = row.searchable;
  form.options = row.options ? [...row.options] : [];
  form.defaultValue = (row.defaultValue as string) ?? null;
  form.placeholder = row.placeholder;
  form.helpText = row.helpText;
  form.groupName = row.groupName;
  form.sort = row.sort;
  form.status = row.status;
  dialog.value = true;
}

async function submit() {
  if (!form.categoryId) {
    ElMessage.warning('请选择类别');
    return;
  }
  if (!form.key || !form.label) {
    ElMessage.warning('标识与显示名必填');
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      categoryId: form.categoryId,
      key: form.key,
      label: form.label,
      type: form.type,
      required: form.required,
      inheritable: form.inheritable,
      searchable: form.searchable,
      options: isOptionType.value ? form.options.filter((o) => o.value && o.label) : null,
      defaultValue: form.defaultValue || null,
      placeholder: form.placeholder || null,
      helpText: form.helpText || null,
      groupName: form.groupName || null,
      sort: form.sort,
      status: form.status,
    };
    if (editing.value) await fieldDefApi.update(editing.value.id, payload);
    else await fieldDefApi.create(payload);
    ElMessage.success('保存成功');
    dialog.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

async function remove(row: FieldDef) {
  await fieldDefApi.remove(row.id);
  ElMessage.success('已删除');
  await load();
}

onMounted(async () => {
  await meta.ensureLoaded();
  const qd = Number(route.query.datasetId);
  if (qd && meta.datasets.some((d) => d.id === qd)) datasetId.value = qd;
  else if (meta.datasets.length) datasetId.value = meta.datasets[0].id;
  if (datasetId.value) {
    await meta.loadTree(datasetId.value);
    await meta.loadCategories(datasetId.value);
  }
  const qc = Number(route.query.categoryId);
  if (qc) categoryId.value = qc;
  else {
    const t = categoryTree.value;
    if (t.length) categoryId.value = t[0].id;
  }
  await load();
});
</script>

<style scoped>
.inherit-tip { margin: 12px 0; }
.options-editor { display: flex; flex-direction: column; gap: 8px; }
.opt-row { display: flex; gap: 8px; align-items: center; }
.hint { color: #909399; font-size: 12px; margin-top: 2px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
