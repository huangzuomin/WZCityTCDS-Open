<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">口径维度</h2>
        <div class="page-desc">
          事实的口径分组（身份定义/制作工艺/荣誉事件…），按分类定义、全局中文名；语料域在「数据集 → 关联分类」里为各分类挑选启用子集
        </div>
      </div>
      <el-button type="primary" @click="openCreate">新建维度</el-button>
    </div>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索 code/名称" clearable style="width: 220px" @keyup.enter="load" />
      <el-button @click="load">查询</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column prop="sort" label="排序" width="70" align="right" />
      <el-table-column prop="code" label="code（事实挂靠键）" min-width="140">
        <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="name" label="维度名" min-width="120" />
      <el-table-column prop="description" label="说明" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">{{ row.description || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            link
            :type="row.status === 'active' ? 'danger' : 'success'"
            @click="toggleStatus(row)"
          >
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !rows.length" description="暂无维度" />

    <el-dialog v-model="dialog" :title="editing ? `编辑维度：${editing.name}` : '新建维度'" width="480px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="code" required>
          <el-input
            v-model="form.code"
            :disabled="!!editing"
            placeholder="中文维度名，如 身份定义"
          />
          <div class="form-tip">code 与名称一致（均为中文），事实通过 code 挂靠维度，创建后不可修改</div>
        </el-form-item>
        <el-form-item label="维度名" required>
          <el-input v-model="form.name" placeholder="如 身份定义" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="该口径采集什么" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { factDimensionApi, type FactDimension } from '@/api';

const loading = ref(false);
const saving = ref(false);
const rows = ref<FactDimension[]>([]);
const dialog = ref(false);
const editing = ref<FactDimension | null>(null);
const keyword = ref('');

const form = reactive({
  code: '',
  name: '',
  description: '',
  sort: 0,
});

const load = async () => {
  loading.value = true;
  try {
    const all = await factDimensionApi.list();
    const kw = keyword.value.trim().toLowerCase();
    rows.value = kw ? all.filter((d) => d.code.toLowerCase().includes(kw) || d.name.toLowerCase().includes(kw)) : all;
  } finally {
    loading.value = false;
  }
};

const openCreate = () => {
  editing.value = null;
  Object.assign(form, { code: '', name: '', description: '', sort: rows.value.length });
  dialog.value = true;
};

const openEdit = (row: FactDimension) => {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    sort: row.sort,
  });
  dialog.value = true;
};

const ZH_DIM = /^[\u4e00-\u9fa5]{2,32}$/;

const save = async () => {
  if (!form.code.trim() || !form.name.trim()) {
    ElMessage.warning('code 与维度名必填');
    return;
  }
  if (!ZH_DIM.test(form.code.trim()) || !ZH_DIM.test(form.name.trim())) {
    ElMessage.warning('code 与维度名必须为 2~32 位中文字符（如 身份定义）');
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await factDimensionApi.update(editing.value.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        sort: form.sort,
      });
      ElMessage.success('已保存');
    } else {
      await factDimensionApi.create({
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        sort: form.sort,
      });
      ElMessage.success('已创建');
    }
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
};

const toggleStatus = async (row: FactDimension) => {
  const next = row.status === 'active' ? 'disabled' : 'active';
  await factDimensionApi.update(row.id, { status: next });
  ElMessage.success(next === 'active' ? '已启用' : '已停用（档案页不再展示该分组）');
  await load();
};

onMounted(load);
</script>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', Consolas, monospace;
}

.form-tip {
  font-size: 12px;
  color: #8a97a5;
  line-height: 1.4;
  margin-top: 2px;
}
</style>
