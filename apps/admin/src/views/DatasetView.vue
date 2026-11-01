<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">语料域</h2>
        <div class="page-desc">最高层的隔离单位：瓯菜 / 温州文化 / 瓯窑 …各自拥有独立的类别、字段、提示词与语料</div>
      </div>
      <el-button type="primary" @click="openCreate">新建语料域</el-button>
    </div>

    <el-table :data="meta.datasets" v-loading="loading" border row-key="id">
      <el-table-column prop="id" label="ID" width="80" align="right" />
      <el-table-column label="名称" min-width="140">
        <template #default="{ row }">
          <a class="ds-link" :href="publicUrl(`/archive/home/${row.code}`)" target="_blank" rel="noopener">{{ row.name }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="code" label="标识" min-width="120">
        <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
      <el-table-column prop="sort" label="排序" width="80" align="right" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '启用' : '归档' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="160">
        <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="340" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openHomeCfg(row)">配置首页</el-button>
          <el-button link type="primary" @click="openLinks(row)">关联分类</el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除该语料域？" @confirm="remove(row)">
            <template #reference>
              <el-button link type="danger">删除</el-button>
            </template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <!-- 配置首页：选分类目录 + 每目录实体数量（0 = 不在首页展示） -->
    <el-dialog v-model="homeCfgDialog" :title="`配置首页：${homeCfgDataset?.name ?? ''}`" width="560" destroy-on-close>
      <div class="hint" style="margin-bottom: 12px">
        勾选要展示在首页的分类目录，并设置每个目录展示的实体数量（填 0 或不勾选 = 该目录不在首页展示）。修改仅在点击「保存」后生效。
      </div>
      <div v-loading="homeCfgLoading" style="min-height: 120px">
        <el-empty v-if="!homeCfgLinks.length" description="尚未关联分类，请先在「关联分类」里添加" :image-size="60" />
        <div v-for="l in homeCfgLinks" :key="l.categoryId" class="home-cfg-row">
          <el-checkbox v-model="homeCfgSel[l.categoryId]">
            <span class="mono">{{ l.code }}</span>
            <span style="color: #909399; margin-left: 6px">{{ l.name }}</span>
          </el-checkbox>
          <el-input-number
            v-if="homeCfgSel[l.categoryId]"
            v-model="homeCfgCount[l.categoryId]"
            :min="1"
            :max="200"
            size="small"
            style="width: 110px"
          />
          <span v-else class="cfg-off">不在首页</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="homeCfgDialog = false">取消</el-button>
        <el-button type="primary" :loading="homeCfgSaving" @click="saveHomeCfg">保存</el-button>
      </template>
    </el-dialog>

    <!-- 关联分类 + 启用维度（v2） -->
    <el-dialog v-model="linksDialog" :title="`关联分类：${linksDataset?.name ?? ''}`" width="860" destroy-on-close>
      <div v-loading="linksLoading" style="min-height: 260px">
        <div class="hint" style="margin-bottom: 8px">
          勾选 = 该语料域使用此全局分类（管线提示词会注入这些分类清单，实体类型从中选择）；每个分类可单独启用维度子集（空 = 不抽取该分类的事实维度）。修改仅在点击「保存」后生效。
        </div>
        <el-row :gutter="16">
          <el-col :span="10">
            <div class="links-pane-title">全局分类树</div>
            <el-tree
              :data="meta.trees"
              :props="{ label: 'name', children: 'children' }"
              node-key="id"
              show-checkbox
              default-expand-all
              :check-strictly="true"
              ref="catTreeRef"
              @check="onTreeCheckLocal"
            />
          </el-col>
          <el-col :span="14">
            <div class="links-pane-title">各分类启用维度（点击分类名编辑）</div>
            <el-empty v-if="!links.length" description="尚未关联分类" :image-size="60" />
            <div v-for="l in links" :key="l.categoryId" class="link-row">
              <div class="link-row-head">
                <span class="mono">{{ l.code }}</span>
                <span style="color: #909399">{{ l.name }}</span>
                <el-button
                  link
                  type="danger"
                  style="margin-left: auto"
                  @click="unlink(l.categoryId)"
                >取消关联</el-button>
              </div>
              <el-select
                v-model="dimSel[l.categoryId]"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                placeholder="选择该分类启用的维度（可多选）"
                style="width: 100%"
              >
                <el-option v-for="d in allDims" :key="d.id" :label="`${d.code}（${d.name}）`" :value="d.id" />
              </el-select>
            </div>
          </el-col>
        </el-row>
      </div>
      <template #footer>
        <el-button @click="linksDialog = false">取消</el-button>
        <el-button type="primary" :loading="linksSaving" @click="saveLinks">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dialog" :title="editing ? '编辑语料域' : '新建语料域'" width="520">
      <el-form :model="form" label-width="90px">
        <el-form-item label="标识 code" required>
          <el-input v-model="form.code" placeholder="小写字母开头，如 wenzhou-city-trust" :disabled="!!editing" />
          <div class="hint">用于生成实体 URN：{{ form.code || 'xxx' }}:dish:三丝敲鱼</div>
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：瓯菜" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="archived">归档</el-radio>
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
import { nextTick, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { datasetApi, type DatasetCategoryLink, type FactDimension } from '@/api';
import { useMetaStore } from '@/stores/meta';
import { formatTime } from '@/utils/format';
import { publicUrl } from '@/utils/publicUrl';
import type { Dataset } from '@/types';

const meta = useMetaStore();
const loading = ref(false);
const dialog = ref(false);
const submitting = ref(false);
const editing = ref<Dataset | null>(null);

const form = reactive({
  code: '',
  name: '',
  description: '' as string | null,
  sort: 0,
  status: 'active' as Dataset['status'],
});

// ---- v2 关联分类面板 ----
const linksDialog = ref(false);
const linksLoading = ref(false);
const linksSaving = ref(false);
const linksDataset = ref<Dataset | null>(null);
const links = ref<DatasetCategoryLink[]>([]);
const allDims = ref<FactDimension[]>([]);
const dimSel = reactive<Record<number, number[]>>({});
const catTreeRef = ref();

function reset() {
  form.code = '';
  form.name = '';
  form.description = '';
  form.sort = 0;
  form.status = 'active';
}

function openCreate() {
  editing.value = null;
  reset();
  dialog.value = true;
}

function openEdit(row: Dataset) {
  editing.value = row;
  form.code = row.code;
  form.name = row.name;
  form.description = row.description ?? '';
  form.sort = row.sort;
  form.status = row.status;
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
      description: form.description || null,
      sort: form.sort,
      status: form.status,
    };
    if (editing.value) await datasetApi.update(editing.value.id, payload);
    else await datasetApi.create(payload);
    ElMessage.success('保存成功');
    dialog.value = false;
    await meta.loadDatasets();
  } finally {
    submitting.value = false;
  }
}

async function remove(row: Dataset) {
  const res = await datasetApi.remove(row.id);
  ElMessage.success((res as { archived?: boolean })?.archived ? '已归档（存在子数据）' : '已删除');
  await meta.loadDatasets();
}

// ---- v2 配置首页（选分类 + 每目录数量）----
const homeCfgDialog = ref(false);
const homeCfgLoading = ref(false);
const homeCfgSaving = ref(false);
const homeCfgDataset = ref<Dataset | null>(null);
const homeCfgLinks = ref<DatasetCategoryLink[]>([]);
const homeCfgSel = reactive<Record<number, boolean>>({});
const homeCfgCount = reactive<Record<number, number>>({});

async function openHomeCfg(row: Dataset) {
  homeCfgDataset.value = row;
  homeCfgDialog.value = true;
  homeCfgLoading.value = true;
  try {
    const res = await datasetApi.linkedCategories(row.id);
    homeCfgLinks.value = res.links;
    Object.keys(homeCfgSel).forEach((k) => delete homeCfgSel[Number(k)]);
    Object.keys(homeCfgCount).forEach((k) => delete homeCfgCount[Number(k)]);
    res.links.forEach((l) => {
      homeCfgSel[l.categoryId] = Number(l.homeShow ?? 0) > 0;
      homeCfgCount[l.categoryId] = Number(l.homeShow ?? 0) || 8;
    });
  } finally {
    homeCfgLoading.value = false;
  }
}

/** 配置首页：本地暂存后一次批量提交（只改 homeShow，不动关联集合） */
async function saveHomeCfg() {
  const dsId = homeCfgDataset.value?.id;
  if (!dsId) return;
  homeCfgSaving.value = true;
  try {
    const links = homeCfgLinks.value.map((l) => ({
      categoryId: l.categoryId,
      homeShow: homeCfgSel[l.categoryId] ? homeCfgCount[l.categoryId] ?? 1 : 0,
    }));
    const res = await datasetApi.syncCategories(dsId, links);
    homeCfgLinks.value = res.links;
    Object.keys(homeCfgSel).forEach((k) => delete homeCfgSel[Number(k)]);
    Object.keys(homeCfgCount).forEach((k) => delete homeCfgCount[Number(k)]);
    res.links.forEach((l) => {
      homeCfgSel[l.categoryId] = Number(l.homeShow ?? 0) > 0;
      homeCfgCount[l.categoryId] = Number(l.homeShow ?? 0) || 8;
    });
    ElMessage.success('首页配置已保存');
  } finally {
    homeCfgSaving.value = false;
  }
}

async function openLinks(row: Dataset) {
  linksDataset.value = row;
  linksDialog.value = true;
  linksLoading.value = true;
  try {
    await meta.loadGlobalTree();
    const res = await datasetApi.linkedCategories(row.id);
    links.value = res.links;
    allDims.value = res.allDims;
    Object.keys(dimSel).forEach((k) => delete dimSel[Number(k)]);
    links.value.forEach((l) => (dimSel[l.categoryId] = [...(l.dimIds ?? [])]));
    await nextTick();
    catTreeRef.value?.setCheckedKeys(links.value.map((l) => l.categoryId));
  } finally {
    linksLoading.value = false;
  }
}

/** 取消关联：本地移除 + 树同步（保存时统一提交） */
function unlink(categoryId: number) {
  links.value = links.value.filter((l) => l.categoryId !== categoryId);
  delete dimSel[categoryId];
  catTreeRef.value?.setCheckedKeys(links.value.map((l) => l.categoryId));
}

/** 树勾选只做本地同步（不请求后端），右侧列表与树即时一致，保存时统一提交 */
function onTreeCheckLocal(_data: unknown, info: { checkedKeys: number[] }) {
  const checked = new Set(info.checkedKeys.map(Number));
  const existing = new Map(links.value.map((l) => [l.categoryId, l]));
  const next = [...links.value];
  // 新增勾选 → 本地补一行（dimIds 留空待配）
  for (const cat of meta.trees.flatMap((t) => [t, ...(t.children ?? [])])) {
    if (checked.has(cat.id) && !existing.has(cat.id)) {
      next.push({
        id: 0,
        datasetId: linksDataset.value?.id ?? 0,
        categoryId: cat.id,
        dimIds: [],
        homeShow: 0,
        sort: next.length,
        code: cat.code,
        name: cat.name,
        description: null,
        parentId: cat.parentId ?? null,
        status: 'active',
        dims: [],
      } as DatasetCategoryLink);
      dimSel[cat.id] = [];
    }
  }
  // 取消勾选 → 本地移除（仅保留当前勾选的分类）
  links.value = next.filter((l) => checked.has(l.categoryId));
}

/** 关联分类：本地暂存后一次批量提交（关联集合 + 各分类维度） */
async function saveLinks() {
  const dsId = linksDataset.value?.id;
  if (!dsId) return;
  linksSaving.value = true;
  try {
    // 以树的勾选为准生成完整关联集合
    const checkedKeys: number[] = catTreeRef.value?.getCheckedKeys() ?? [];
    const wantIds = new Set(checkedKeys.map(Number));
    const target = [...wantIds].map((categoryId) => ({
      categoryId,
      dimIds: dimSel[categoryId] ?? [],
    }));
    const res = await datasetApi.syncCategories(dsId, target);
    links.value = res.links;
    allDims.value = res.allDims;
    Object.keys(dimSel).forEach((k) => delete dimSel[Number(k)]);
    links.value.forEach((l) => (dimSel[l.categoryId] = [...(l.dimIds ?? [])]));
    await nextTick();
    catTreeRef.value?.setCheckedKeys(links.value.map((l) => l.categoryId));
    ElMessage.success('关联分类已保存');
  } finally {
    linksSaving.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await meta.loadDatasets();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.links-pane-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: #606266;
}
.link-row {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.link-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.home-cfg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px;
  border-bottom: 1px solid #f0f1f3;
}
.ds-link {
  color: #2f6fed;
  font-weight: 500;
}
.ds-link:hover {
  color: #1a4fc9;
}
.cfg-off {
  color: #c0c4cc;
  font-size: 13px;
}
.mono {
  font-family: 'JetBrains Mono', Consolas, monospace;
}
</style>
