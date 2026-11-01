<template>
  <div class="page">
    <div class="page-header">
      <h2 class="page-title">关系 Schema</h2>
      <span class="page-sub">
        每个 head 实体分类 × tail 类型 配置一组建议关系词，抽取关系时动态注入提示词（head 按实体分类匹配，tail 按类型）。
        表内词优先选用，表外允许自拟更贴切的谓词。
      </span>
    </div>

    <el-card>
      <div class="filters">
        <el-button type="primary" :disabled="!categoryId" @click="openCreate">新增关系词配置</el-button>
        <span v-if="categoryId" class="count-tip">
          分类「{{ currentCategoryName }}」共 {{ rows.length }} 条（自身 {{ ownRows.length }}
          <template v-if="inheritedRows.length"> + 继承 {{ inheritedRows.length }} </template>）
        </span>
      </div>

      <div v-loading="loading" class="cat-layout">
        <!-- 左：分类树（head 分类） -->
        <div class="cat-tree">
          <div class="tree-title">head 分类</div>
          <el-tree
            :data="categoryTree"
            :props="{ label: 'name', children: 'children' }"
            node-key="id"
            highlight-current
            default-expand-all
            :expand-on-click-node="false"
            @current-change="onCategoryChange"
          />
          <el-empty v-if="!categoryTree.length" description="暂无分类" :image-size="60" />
        </div>

        <!-- 右：该分类的关系 schema 列表（含父链继承） -->
        <div v-if="!categoryId" class="cat-detail">
          <el-empty description="请在左侧选择分类" />
        </div>

        <div v-else class="cat-detail">
          <el-alert v-if="inheritedRows.length" type="info" :closable="false" class="inh-hint">
            子分类自动沿用父分类的关系词表（{{ inheritedCats }}）；继承项只读，如需覆盖请在对应父分类上修改，或在当前分类新增更具体的配置。
          </el-alert>
          <el-table :data="rows" size="small" border>
            <el-table-column label="tail 类型" width="220">
              <template #default="{ row }">
                <el-tag effect="dark" size="small">{{ row.tailType }}</el-tag>
                <el-tag v-if="isInherited(row)" type="info" size="small" class="inh-tag">继承自 {{ row.catName }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="建议关系词">
              <template #default="{ row }">
                <el-tag v-for="r in row.relations" :key="r" size="small" effect="plain" class="rel-tag">{{ r }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.status === 'active'"
                  :disabled="isInherited(row)"
                  inline-prompt
                  active-text="启"
                  inactive-text="停"
                  @change="(v: boolean) => toggleStatus(row, v)"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <template v-if="isInherited(row)">
                  <el-button link size="small" disabled>编辑</el-button>
                  <el-button link size="small" disabled>删除</el-button>
                </template>
                <template v-else>
                  <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                  <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
                </template>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="该分类（含继承）未配置关系词，抽取时完全自由生成" :image-size="60" />
            </template>
          </el-table>
        </div>
      </div>
    </el-card>

    <!-- 新增/编辑 对话框 -->
    <el-dialog v-model="dialogVisible" :title="editing ? '编辑关系词配置' : '新增关系词配置'" width="560px" destroy-on-close>
      <el-form :model="form" label-width="90px">
        <el-form-item label="head 分类">
          <el-input :model-value="currentCategoryName" disabled />
        </el-form-item>
        <el-form-item label="tail 类型" required>
          <el-select
            v-model="form.tailType"
            placeholder="选择或输入 tail 实体类型（分类 code）"
            filterable
            allow-create
            default-first-option
            style="width: 100%"
          >
            <el-option v-for="c in flatCategories" :key="c.code" :label="`${c.name}（${c.code}）`" :value="c.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="关系词" required>
          <el-select
            v-model="form.relations"
            placeholder="输入关系词后回车，可多选；也可直接自拟新词"
            multiple
            filterable
            allow-create
            default-first-option
            style="width: 100%"
          >
            <el-option v-for="r in relationSuggestions" :key="r" :label="r" :value="r" />
          </el-select>
          <div class="form-tip">建议词库：{{ relationSuggestions.join('、') }}</div>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="9999" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">启用（抽取时注入提示词）</el-radio>
            <el-radio value="disabled">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { categoryApi, discoveryApi } from '@/api';
import type { RelationSchemaItem } from '@/api';
import type { CategoryNode } from '@/types';

const categoryTree = ref<CategoryNode[]>([]);
const categoryId = ref<number>();
const currentCategoryName = ref('');
const rows = ref<RelationSchemaItem[]>([]);
const loading = ref(false);
const saving = ref(false);

const dialogVisible = ref(false);
const editing = ref<RelationSchemaItem | null>(null);
const form = ref<{ tailType: string; relations: string[]; sort: number; status: 'active' | 'disabled' }>({
  tailType: '',
  relations: [],
  sort: 0,
  status: 'active',
});

/** 当前分类自身配置的条目（categoryId 命中所选分类） */
const ownRows = computed(() => rows.value.filter((r) => r.categoryId === categoryId.value));
/** 从祖先链继承来的条目 */
const inheritedRows = computed(() => rows.value.filter((r) => r.categoryId !== categoryId.value));
const isInherited = (row: RelationSchemaItem) => row.categoryId !== categoryId.value;
/** 继承来源分类名（去重） */
const inheritedCats = computed(() => [...new Set(inheritedRows.value.map((r) => r.catName))].join('、'));

/** 分类树拍平为 code 列表（tail 类型候选） */
const flatCategories = computed(() => {
  const out: { code: string; name: string }[] = [];
  const walk = (nodes: CategoryNode[]) => {
    for (const n of nodes) {
      out.push({ code: n.code, name: n.name });
      if (n.children?.length) walk(n.children);
    }
  };
  walk(categoryTree.value);
  return out;
});

const relationSuggestions = [
  '任职于', '创办', '发起', '加入', '任教', '师从', '师徒', '合作', '主办', '承办', '协办',
  '签约', '发布', '认证', '获得', '授予', '入选', '担任', '当选', '出任',
  '位于', '地处', '发源于', '发祥于', '源于', '分布于',
  '时令搭配', '象征', '典故来源', '传承', '成名于', '隶属', '下辖',
];

const loadCategories = async () => {
  const res = await categoryApi.list({ tree: true });
  categoryTree.value = res.items as CategoryNode[];
};

const onCategoryChange = (node: CategoryNode | null) => {
  if (!node) return;
  categoryId.value = node.id;
  currentCategoryName.value = node.name;
  void loadRows();
};

const loadRows = async () => {
  if (!categoryId.value) return;
  loading.value = true;
  try {
    rows.value = await discoveryApi.relationSchemas(categoryId.value);
  } finally {
    loading.value = false;
  }
};

const openCreate = () => {
  editing.value = null;
  form.value = { tailType: '', relations: [], sort: 0, status: 'active' };
  dialogVisible.value = true;
};

const openEdit = (row: RelationSchemaItem) => {
  editing.value = row;
  form.value = { tailType: row.tailType, relations: [...row.relations], sort: row.sort, status: row.status };
  dialogVisible.value = true;
};

const save = async () => {
  if (!categoryId.value) return;
  if (!form.value.tailType.trim()) {
    ElMessage.warning('请填写 tail 类型');
    return;
  }
  if (!form.value.relations.length) {
    ElMessage.warning('请至少添加一个关系词');
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await discoveryApi.updateRelationSchema(editing.value.id, { ...form.value });
      ElMessage.success('已更新');
    } else {
      await discoveryApi.createRelationSchema({ categoryId: categoryId.value, ...form.value });
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    await loadRows();
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
};

const toggleStatus = async (row: RelationSchemaItem, active: boolean) => {
  try {
    await discoveryApi.updateRelationSchema(row.id, { status: active ? 'active' : 'disabled' });
    row.status = active ? 'active' : 'disabled';
    ElMessage.success(active ? '已启用' : '已停用');
  } catch (err) {
    ElMessage.error((err as Error).message || '操作失败');
  }
};

const remove = async (row: RelationSchemaItem) => {
  try {
    await ElMessageBox.confirm(
      `删除「${row.tailType}」的 ${row.relations.length} 个关系词配置？删除后该组合抽取时自由生成。`,
      '删除关系词配置',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await discoveryApi.deleteRelationSchema(row.id);
  ElMessage.success('已删除');
  await loadRows();
};

onMounted(loadCategories);
</script>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.count-tip {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.cat-layout {
  display: flex;
  gap: 16px;
  min-height: 420px;
}
.cat-tree {
  flex: 0 0 260px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 10px;
  overflow: auto;
  max-height: 560px;
}
.tree-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  padding: 4px 6px 10px;
  border-bottom: 1px dashed var(--el-border-color-lighter);
  margin-bottom: 8px;
}
.cat-detail {
  flex: 1;
  min-width: 0;
}
.rel-tag {
  margin: 2px 4px 2px 0;
}
.inh-hint {
  margin-bottom: 12px;
  line-height: 1.8;
}
.inh-tag {
  margin-left: 6px;
}
.form-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
  margin-top: 4px;
}
</style>
