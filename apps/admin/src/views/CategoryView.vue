<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">实体类别</h2>
        <div class="page-desc">
          类别形成全局继承树：<strong>子类别自动继承父类别的自定义字段</strong>（祖先字段需勾选「可继承」，同名 key 由子类覆写）。
          语料域通过「数据集 → 关联分类」挑选自己使用的分类并启用维度子集。
        </div>
      </div>
      <el-button type="primary" @click="openCreate(null)">新建顶级类别</el-button>
    </div>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索名称/标识" clearable style="width: 220px" @keyup.enter="load" />
      <el-button @click="load">查询</el-button>
      <el-button @click="$router.push('/field-defs')">去配置字段</el-button>
    </div>

    <el-table
      :data="tree"
      v-loading="loading"
      border
      row-key="id"
      default-expand-all
      :tree-props="{ children: 'children' }"
    >
      <el-table-column prop="name" label="类别名称" min-width="200" />
      <el-table-column prop="code" label="标识" min-width="130">
        <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" align="right" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openCreate(row.id)">加子类别</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除该类别？" @confirm="remove(row)">
            <template #reference>
              <el-button link type="danger">删除</el-button>
            </template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? '编辑类别' : '新建类别'" width="520">
      <el-form :model="form" label-width="90px">
        <el-form-item label="标识 code" required>
          <el-input v-model="form.code" placeholder="小写字母开头，如 dish" :disabled="!!editing" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：菜品" />
        </el-form-item>
        <el-form-item label="父类别">
          <el-tree-select
            v-model="form.parentId"
            :data="tree"
            :props="{ label: 'name', children: 'children' }"
            check-strictly
            clearable
            placeholder="留空则为顶级类别"
            style="width: 100%"
          />
          <div class="hint">父类别决定字段继承链；不能选自己的后代</div>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" />
        </el-form-item>
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
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { categoryApi } from '@/api';
import { useMetaStore } from '@/stores/meta';
import type { CategoryNode } from '@/types';

const meta = useMetaStore();
const keyword = ref('');
const loading = ref(false);
const dialog = ref(false);
const submitting = ref(false);
const editing = ref<CategoryNode | null>(null);

const form = reactive({
  code: '',
  name: '',
  parentId: null as number | null,
  description: '' as string | null,
  sort: 0,
  status: 'active' as 'active' | 'disabled',
});

const tree = ref<CategoryNode[]>([]);

/** 后代 id 集合，用于禁止把类别挂到自己的后代上 */
function descendants(nodes: CategoryNode[], target: number, found: number[] = []): number[] {
  for (const n of nodes) {
    if (n.id === target) {
      const collect = (list: CategoryNode[]) => list.forEach((c) => (found.push(c.id), collect(c.children)));
      collect(n.children);
      return found;
    }
    descendants(n.children, target, found);
  }
  return found;
}

async function load() {
  loading.value = true;
  try {
    await meta.loadGlobalTree();
    tree.value = meta.trees;
  } finally {
    loading.value = false;
  }
}

function openCreate(parentId: number | null) {
  editing.value = null;
  form.code = '';
  form.name = '';
  form.parentId = parentId;
  form.description = '';
  form.sort = 0;
  form.status = 'active';
  dialog.value = true;
}

async function openEdit(row: CategoryNode) {
  const full = await categoryApi.get(row.id);
  editing.value = row;
  form.code = row.code;
  form.name = row.name;
  form.parentId = row.parentId;
  form.description = full.description ?? '';
  form.sort = row.sort;
  form.status = (row.status as 'active' | 'disabled') ?? 'active';
  dialog.value = true;
}

async function submit() {
  if (!form.code || !form.name) {
    ElMessage.warning('标识与名称必填');
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      code: form.code,
      name: form.name,
      parentId: form.parentId ?? null,
      description: form.description || null,
      sort: form.sort,
      status: form.status,
    };
    if (editing.value) {
      const bad = descendants(tree.value, editing.value.id);
      if (form.parentId && bad.includes(form.parentId)) {
        ElMessage.error('不能把类别挂到自己的子类别下');
        return;
      }
      await categoryApi.update(editing.value.id, payload);
    } else {
      await categoryApi.create(payload);
    }
    ElMessage.success('保存成功');
    dialog.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

async function remove(row: CategoryNode) {
  const res = await categoryApi.remove(row.id);
  ElMessage.success((res as { disabled?: boolean })?.disabled ? '已停用（存在子类别或实体）' : '已删除');
  await load();
}

onMounted(load);
</script>
