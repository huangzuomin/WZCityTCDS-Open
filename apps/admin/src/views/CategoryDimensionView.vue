<template>
  <div class="page">
    <div class="page-header">
      <h2 class="page-title">分类维度</h2>
      <span class="page-sub">
        每个分类定义一套中文口径维度（category_dimension 绑定）。此处为所选语料域在分类上配置<strong>启用子集</strong>
        （dataset_category.dim_ids）；不配置时抽取自动使用该分类的默认维度。
      </span>
    </div>

    <el-card>
      <div class="filters">
        <el-select v-model="datasetId" placeholder="语料域" style="width: 220px" @change="onDatasetChange">
          <el-option v-for="d in datasets" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>
        <el-button type="primary" :disabled="!categoryId" :loading="saving" @click="save">保存启用子集</el-button>
        <el-button type="success" :disabled="!datasetId" :loading="classifying" @click="autoClassify">
          按语义自动归类维度
        </el-button>
        <span v-if="categoryId" class="count-tip">
          启用 {{ ownAssignedIds.length }}
          <template v-if="inheritedIds.length">（含继承 {{ inheritedIds.length }}，不可改）</template>
          / 分类默认 {{ defaultDimIds.length }} · 共 {{ allDims.length }}
        </span>
      </div>

      <div v-loading="loading" class="cat-layout">
        <!-- 左：分类树 -->
        <div class="cat-tree">
          <div class="tree-title">分类</div>
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

        <!-- 右：维度配置 -->
        <div v-if="!categoryId" class="cat-detail">
          <el-empty description="请在左侧选择分类" />
        </div>

        <div v-else class="cat-detail">
          <el-alert type="info" :closable="false" class="dim-hint">
            分类「{{ currentCategoryName }}」的默认维度（抽取回退值，只读）：<template v-if="defaultDimIds.length">
              <el-tag v-for="d in defaultDims" :key="d.id" size="small" class="dim-tag" effect="plain">{{ d.name }}</el-tag>
            </template><template v-else><span class="muted">未绑定默认维度</span></template>
          </el-alert>

          <div class="transfer-wrap">
            <div class="transfer-title">
              本语料域启用子集（勾选后保存；继承维度固定右侧不可移除）
              <el-button
                v-if="!ownAssignedIds.length && defaultDimIds.length"
                link
                type="primary"
                size="small"
                class="sync-default"
                @click="syncDefault"
              >
                同步为分类默认（{{ defaultDimIds.length }}）
              </el-button>
            </div>
            <el-transfer
              v-model="assignedIds"
              :data="transferData"
              :titles="['全部维度', '启用维度']"
              class="dim-transfer"
            />
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { categoryApi, datasetApi, discoveryApi } from '@/api';
import type { FactDimension } from '@/api';
import type { CategoryNode, Dataset } from '@/types';

const datasets = ref<Dataset[]>([]);
const datasetId = ref<number>();
const categoryTree = ref<CategoryNode[]>([]);
const categoryId = ref<number>();
const currentCategoryName = ref('');
const allDims = ref<FactDimension[]>([]);
const assignedIds = ref<number[]>([]);
const inheritedIds = ref<number[]>([]);
const defaultDimIds = ref<number[]>([]);
const loading = ref(false);
const saving = ref(false);
const classifying = ref(false);

const dimById = computed(() => new Map(allDims.value.map((d) => [d.id, d])));
const defaultDims = computed(() => defaultDimIds.value.map((id) => dimById.value.get(id)).filter(Boolean) as FactDimension[]);

const transferData = computed(() =>
  allDims.value.map((d) => {
    const inherited = inheritedIds.value.includes(d.id);
    return {
      key: d.id,
      // 继承维度固定在右侧且禁用（不可勾选/移除），仅可在父分类上编辑
      disabled: inherited,
      label: inherited ? `${d.name} · [继承]` : d.name,
    };
  }),
);

/** 自身可编辑的分配（剔除继承的） */
const ownAssignedIds = computed(() => assignedIds.value.filter((id) => !inheritedIds.value.includes(id)));

const loadDatasets = async () => {
  const res = await datasetApi.list({ pageSize: 100 });
  datasets.value = res.items;
  if (res.items.length) {
    datasetId.value = res.items[0].id;
    await onDatasetChange();
  }
};

const onDatasetChange = async () => {
  categoryId.value = undefined;
  currentCategoryName.value = '';
  allDims.value = [];
  assignedIds.value = [];
  inheritedIds.value = [];
  defaultDimIds.value = [];
  const res = await categoryApi.list({ tree: true });
  categoryTree.value = res.items as CategoryNode[];
};

const onCategoryChange = (node: CategoryNode | null) => {
  if (!node) return;
  categoryId.value = node.id;
  currentCategoryName.value = node.name;
  void loadAssignment();
};

const loadAssignment = async () => {
  if (!datasetId.value || !categoryId.value) {
    allDims.value = [];
    assignedIds.value = [];
    inheritedIds.value = [];
    defaultDimIds.value = [];
    return;
  }
  loading.value = true;
  try {
    const res = await discoveryApi.categoryDimensions(categoryId.value, datasetId.value);
    allDims.value = res.dimensions;
    inheritedIds.value = res.inheritedIds ?? [];
    defaultDimIds.value = res.defaultDimIds ?? [];
    // 右侧展示 自身分配 + 继承（继承项禁用，不可移除）
    assignedIds.value = [...res.assignedIds, ...inheritedIds.value];
  } finally {
    loading.value = false;
  }
};

const save = async () => {
  if (!categoryId.value || !datasetId.value) return;
  saving.value = true;
  try {
    await discoveryApi.setCategoryDimensions(categoryId.value, datasetId.value, ownAssignedIds.value);
    ElMessage.success(`已保存「${currentCategoryName.value}」的启用子集（${ownAssignedIds.value.length} 个维度）`);
  } finally {
    saving.value = false;
  }
};

/** 一键把分类默认维度填入启用子集（显式生效，可再删减后保存） */
const syncDefault = () => {
  const merged = [...new Set([...assignedIds.value, ...defaultDimIds.value])];
  assignedIds.value = merged.filter((id) => !inheritedIds.value.includes(id));
};

const autoClassify = async () => {
  if (!datasetId.value) return;
  try {
    await ElMessageBox.confirm(
      '将用生产线模型按语义把本语料域的维度自动归类到各分类（写入分类默认绑定，会覆盖已有映射），是否继续？',
      '按语义自动归类维度',
      { type: 'warning', confirmButtonText: '开始归类', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  classifying.value = true;
  try {
    const res = await discoveryApi.autoClassifyDimensions(datasetId.value);
    ElMessage.success(`自动归类完成：显式归类 ${res.classified} 个，全局维度 ${res.global} 个（共 ${res.total} 个）`);
    if (categoryId.value) await loadAssignment();
  } catch (err) {
    ElMessage.error((err as Error).message || '自动归类失败');
  } finally {
    classifying.value = false;
  }
};

onMounted(loadDatasets);
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
.dim-hint {
  margin-bottom: 16px;
  line-height: 2;
}
.dim-tag {
  margin: 2px 4px 2px 0;
}
.transfer-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.transfer-title {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
.dim-transfer {
  justify-content: center;
}
</style>
