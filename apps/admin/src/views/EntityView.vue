<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">实体档案</h2>
        <div class="page-desc">每个实体属于一个类别，表单字段由该类别的「字段定义」动态生成</div>
      </div>
      <el-button type="primary" @click="openCreate">新建实体</el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="query.datasetId" placeholder="语料域" clearable style="width: 170px" @change="onFilterDataset">
        <el-option v-for="d in meta.datasets" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
      <CategorySelect v-model="query.categoryId" :dataset-id="query.datasetId" style="width: 220px" />
      <el-select v-model="query.status" placeholder="状态" clearable style="width: 120px">
        <el-option label="草稿" value="draft" />
        <el-option label="已发布" value="published" />
        <el-option label="归档" value="archived" />
      </el-select>
      <el-select v-model="query.sort" placeholder="排序" style="width: 160px" @change="query.page = 1; load()">
        <el-option label="默认（ID）" value="id" />
        <el-option label="事实数量（多→少）" value="factCount" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="实体名" clearable style="width: 180px" @keyup.enter="load" />
      <el-button type="primary" @click="load">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" align="right" />
      <el-table-column prop="name" label="实体名" min-width="140" />
      <el-table-column prop="urn" label="URN" min-width="220">
        <template #default="{ row }"><span class="mono">{{ row.urn }}</span></template>
      </el-table-column>
      <el-table-column prop="slug" label="动态路由" min-width="150">
        <template #default="{ row }">
          <a
            v-if="row.status === 'published' && row.datasetCode"
            class="route-link mono"
            :href="publicUrl(`/archive/${row.datasetCode}/${row.slug}`)"
            target="_blank"
            rel="noopener"
          >/archive/{{ row.datasetCode }}/{{ row.slug }}</a>
          <span v-else class="mono muted">/archive/{{ row.datasetCode || 'dataset' }}/{{ row.slug }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类别" width="130">
        <template #default="{ row }">{{ row.categoryName || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="revision" label="版本" width="70" align="right" />
      <el-table-column prop="factCount" label="事实数" width="80" align="right" sortable />
      <el-table-column label="更新时间" width="160">
        <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'published' && row.datasetCode"
            link
            type="primary"
            @click="openArchive(row)"
          >
            档案
          </el-button>
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除该实体？（软删除）" @confirm="remove(row)">
            <template #reference>
              <el-button link type="danger">删除</el-button>
            </template>
          </el-popconfirm>
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

    <el-drawer v-model="drawer" :title="editing ? '编辑实体：' + editing.name : '新建实体'" size="60%">
      <el-form label-width="110px">
        <el-form-item label="语料域" required>
          <el-select v-model="form.datasetId" placeholder="选择语料域" :disabled="!!editing" @change="form.categoryId = null">
            <el-option v-for="d in meta.datasets" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="实体类别" required>
          <CategorySelect v-model="form.categoryId" :dataset-id="form.datasetId" :disabled="!!editing" />
          <div v-if="editing" class="hint">已创建实体的类别不可变更（URN 依赖它）</div>
        </el-form-item>
        <el-form-item label="实体名" required>
          <el-input v-model="form.name" placeholder="如：三丝敲鱼" />
        </el-form-item>
        <el-form-item label="别名">
          <div class="aliases">
            <el-tag v-for="(a, i) in form.aliases" :key="i" closable @close="form.aliases.splice(i, 1)">
              {{ a }}
            </el-tag>
            <el-input
              v-model="aliasInput"
              size="small"
              placeholder="输入后回车添加"
              style="width: 160px"
              @keyup.enter="addAlias"
            />
          </div>
          <div class="hint">别名用于语料抽取时的同义召回</div>
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="form.lede" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="种子来源">
          <el-input v-model="form.seedSource" placeholder="如：《中国瓯菜》书源" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="draft">草稿</el-radio>
            <el-radio value="published">已发布</el-radio>
            <el-radio value="archived">归档</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <el-divider content-position="left">自定义字段</el-divider>
      <DynamicForm v-model="form.attrs" :fields="fields" />

      <template #footer>
        <el-button @click="drawer = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { entityApi, fieldDefApi } from '@/api';
import { useMetaStore } from '@/stores/meta';
import CategorySelect from '@/components/CategorySelect.vue';
import DynamicForm from '@/components/DynamicForm.vue';
import { formatTime } from '@/utils/format';
import { publicUrl } from '@/utils/publicUrl';
import type { EntityListItem, FieldDef } from '@/types';

const meta = useMetaStore();
const route = useRoute();

/** 打开公开档案页（前台已与后台分离，走 publicUrl 以支持独立端口/子域） */
function openArchive(row: EntityListItem) {
  window.open(publicUrl(`/archive/${row.datasetCode}/${row.slug}`), '_blank', 'noopener');
}

const query = reactive({
  datasetId: null as number | null,
  categoryId: null as number | null,
  status: '' as string,
  keyword: '',
  sort: 'id' as 'id' | 'factCount',
  page: 1,
  pageSize: 20,
});

const rows = ref<EntityListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const drawer = ref(false);
const submitting = ref(false);
const editing = ref<EntityListItem | null>(null);
const fields = ref<FieldDef[]>([]);
const aliasInput = ref('');

const form = reactive({
  datasetId: null as number | null,
  categoryId: null as number | null,
  name: '',
  lede: '' as string | null,
  seedSource: '' as string | null,
  status: 'draft' as 'draft' | 'published' | 'archived',
  aliases: [] as string[],
  attrs: {} as Record<string, unknown>,
});

const statusText = (s: string) => ({ draft: '草稿', published: '已发布', archived: '归档' }[s] ?? s);
const statusTagType = (s: string) =>
  ({ draft: 'info', published: 'success', archived: 'warning' }[s] as 'info' | 'success' | 'warning') ?? 'info';

async function load() {
  loading.value = true;
  try {
    const res = await entityApi.list({
      datasetId: query.datasetId ?? undefined,
      categoryId: query.categoryId ?? undefined,
      status: query.status || undefined,
      keyword: query.keyword || undefined,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

function resetQuery() {
  query.datasetId = null;
  query.categoryId = null;
  query.status = '';
  query.keyword = '';
  query.page = 1;
  void load();
}

function onFilterDataset() {
  query.categoryId = null;
}

function addAlias() {
  const v = aliasInput.value.trim();
  if (!v) return;
  if (!form.aliases.includes(v)) form.aliases.push(v);
  aliasInput.value = '';
}

async function loadFields(categoryId: number | null | undefined) {
  if (!categoryId) {
    fields.value = [];
    return;
  }
  fields.value = await fieldDefApi.resolved(categoryId);
}

function openCreate() {
  editing.value = null;
  form.datasetId = query.datasetId ?? meta.datasets[0]?.id ?? null;
  form.categoryId = null;
  form.name = '';
  form.lede = '';
  form.seedSource = '';
  form.status = 'draft';
  form.aliases = [];
  form.attrs = {};
  fields.value = [];
  drawer.value = true;
}

async function openEdit(row: EntityListItem) {
  const detail = await entityApi.detail(row.id);
  editing.value = row;
  form.datasetId = detail.datasetId;
  form.categoryId = detail.categoryId;
  form.name = detail.name;
  form.lede = detail.lede ?? '';
  form.seedSource = detail.seedSource ?? '';
  form.status = detail.status;
  form.aliases = detail.aliases.map((a) => a.alias);
  form.attrs = { ...(detail.attrsJson ?? {}) };
  fields.value = detail.fields;
  drawer.value = true;
}

async function submit() {
  if (!form.datasetId || !form.categoryId) {
    ElMessage.warning('请选择语料域与实体类别');
    return;
  }
  if (!form.name) {
    ElMessage.warning('实体名必填');
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      name: form.name,
      lede: form.lede || null,
      seedSource: form.seedSource || null,
      status: form.status,
      aliases: form.aliases,
      attrs: form.attrs,
    };
    if (editing.value) await entityApi.update(editing.value.id, payload);
    else await entityApi.create({ originDatasetId: form.datasetId, categoryId: form.categoryId, ...payload });
    ElMessage.success('保存成功');
    drawer.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

async function remove(row: EntityListItem) {
  await entityApi.remove(row.id);
  ElMessage.success('已删除');
  await load();
}

watch(() => form.categoryId, loadFields);

onMounted(async () => {
  await meta.ensureLoaded();
  // 支持从概览页跳转带过来的 ?datasetId=
  const from = Number(route.query.datasetId);
  if (Number.isFinite(from) && from > 0) query.datasetId = from;
  await load();
});
</script>

<style scoped>
.route-link {
  color: #409eff;
  text-decoration: none;
  word-break: break-all;
}

.route-link:hover {
  text-decoration: underline;
}

.muted {
  color: #8a97a5;
}

.pager {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}

.aliases {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
</style>
