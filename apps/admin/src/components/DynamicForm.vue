<template>
  <el-form label-width="120px" label-position="right">
    <template v-for="(group, gi) in grouped" :key="gi">
      <div v-if="group.name" class="group-title">{{ group.name }}</div>
      <el-form-item
        v-for="field in group.fields"
        :key="field.key"
        :label="field.label"
        :required="field.required"
      >
        <!-- 单行 / 多行文本 -->
        <el-input
          v-if="field.type === 'text'"
          v-model="local[field.key] as string"
          :placeholder="field.placeholder || `请输入${field.label}`"
          clearable
        />
        <el-input
          v-else-if="field.type === 'textarea'"
          v-model="local[field.key] as string"
          type="textarea"
          :rows="3"
          :placeholder="field.placeholder || `请输入${field.label}`"
        />

        <!-- 数字 -->
        <el-input-number
          v-else-if="field.type === 'number'"
          v-model="local[field.key] as number"
          controls-position="right"
          class="full"
        />

        <!-- 日期 -->
        <el-date-picker
          v-else-if="field.type === 'date'"
          v-model="local[field.key] as string"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
        />

        <!-- 单选 / 多选 -->
        <el-select
          v-else-if="field.type === 'select'"
          v-model="local[field.key] as string"
          :placeholder="field.placeholder || `请选择${field.label}`"
          clearable
          class="full"
        >
          <el-option
            v-for="opt in field.options || []"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-select
          v-else-if="field.type === 'multiselect'"
          v-model="local[field.key] as string[]"
          multiple
          :placeholder="field.placeholder || `请选择${field.label}`"
          class="full"
        >
          <el-option
            v-for="opt in field.options || []"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>

        <!-- 布尔 -->
        <el-switch v-else-if="field.type === 'boolean'" v-model="local[field.key] as boolean" />

        <!-- 链接 -->
        <el-input
          v-else-if="field.type === 'url'"
          v-model="local[field.key] as string"
          placeholder="https://"
          clearable
        />

        <!-- 实体关联：搜索实体名后存实体 id（知识图谱据此成边） -->
        <el-select
          v-else-if="field.type === 'entity_ref'"
          :model-value="(local[field.key] as number) ?? undefined"
          filterable
          remote
          clearable
          reserve-keyword
          :placeholder="field.placeholder || '搜索实体名'"
          :remote-method="searchEntities"
          :loading="entityLoading"
          class="full"
          @update:model-value="(v: number | null) => (local[field.key] = v ?? null)"
        >
          <el-option v-for="o in entityOptions" :key="o.id" :label="`${o.name}（#${o.id}）`" :value="o.id" />
        </el-select>

        <!-- JSON -->
        <el-input
          v-else-if="field.type === 'json'"
          :model-value="jsonText(field.key)"
          type="textarea"
          :rows="3"
          placeholder="合法 JSON"
          @update:model-value="(v: string) => setJson(field.key, v)"
        />

        <div v-if="field.helpText" class="hint">{{ field.helpText }}</div>
      </el-form-item>
    </template>

    <el-empty v-if="!fields.length" description="该类别暂无自定义字段，请先到「字段定义」配置" :image-size="80" />
  </el-form>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { entityApi } from '@/api';
import type { FieldDef } from '@/types';

const props = defineProps<{
  fields: FieldDef[];
  modelValue: Record<string, unknown>;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: Record<string, unknown>): void }>();

const local = reactive<Record<string, unknown>>({ ...(props.modelValue ?? {}) });

watch(
  () => props.modelValue,
  (v) => {
    Object.assign(local, v ?? {});
  },
  { deep: true },
);

watch(
  local,
  (v) => {
    emit('update:modelValue', { ...v });
  },
  { deep: true },
);

/** 按 groupName 分组渲染 */
const grouped = computed(() => {
  const map = new Map<string, FieldDef[]>();
  for (const f of props.fields) {
    const key = f.groupName || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(f);
  }
  return [...map.entries()].map(([name, fields]) => ({ name, fields }));
});

/* ---------------- entity_ref 字段：实体选择器 ---------------- */
const entityOptions = ref<{ id: number; name: string }[]>([]);
const entityLoading = ref(false);

/** 远程搜索实体名（选中后存实体 id） */
const searchEntities = async (kw: string) => {
  if (!kw) return;
  entityLoading.value = true;
  try {
    const res = await entityApi.list({ keyword: kw, pageSize: 20 });
    const map = new Map(entityOptions.value.map((o) => [o.id, o]));
    for (const it of res.items ?? []) map.set(it.id, { id: it.id, name: it.name });
    entityOptions.value = [...map.values()];
  } catch {
    /* 拦截器已提示 */
  } finally {
    entityLoading.value = false;
  }
};

/** 回显：已有值（id）不在候选里时补进去，避免只显示裸 id */
const ensureRefOptions = async () => {
  const ids = props.fields
    .filter((f) => f.type === 'entity_ref')
    .map((f) => Number(local[f.key]))
    .filter((v) => Number.isFinite(v) && v > 0 && !entityOptions.value.some((o) => o.id === v));
  for (const id of ids) {
    try {
      const e = await entityApi.detail(id);
      if (e?.id) entityOptions.value = [...entityOptions.value, { id: e.id, name: e.name }];
    } catch {
      /* 实体不存在则忽略 */
    }
  }
};

onMounted(() => void ensureRefOptions());
watch(() => props.modelValue, () => void ensureRefOptions(), { deep: true });

const jsonText = (key: string) => {
  const v = local[key];
  return v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
};

const setJson = (key: string, text: string) => {
  if (!text.trim()) {
    local[key] = null;
    return;
  }
  try {
    local[key] = JSON.parse(text);
  } catch {
    // 输入过程中允许非法 JSON，交由服务端最终校验
  }
};
</script>

<style scoped>
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: #5a6572;
  padding: 6px 0 2px;
  border-bottom: 1px solid #eceff3;
  margin-bottom: 12px;
}

.full {
  width: 100%;
}
</style>
