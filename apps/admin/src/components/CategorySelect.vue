<template>
  <el-cascader
    v-model="inner"
    :options="options"
    :props="{ expandTrigger: 'hover', emitPath: false, checkStrictly: true }"
    :disabled="!datasetId"
    clearable
    filterable
    placeholder="选择实体类别"
    @change="onChange"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMetaStore } from '@/stores/meta';

const props = defineProps<{
  datasetId: number | null | undefined;
  modelValue: number | null;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: number | null): void }>();

const meta = useMetaStore();
const inner = ref<number | null>(props.modelValue ?? null);

const options = computed(() =>
  props.datasetId ? meta.categoryCascaderOptions(props.datasetId) : [],
);

watch(
  () => props.datasetId,
  async (id) => {
    if (!id) return;
    await meta.loadTree(id);
  },
  { immediate: true },
);

watch(
  () => props.modelValue,
  (v) => {
    inner.value = v ?? null;
  },
);

const onChange = (v: unknown) => {
  emit('update:modelValue', (v as number) ?? null);
};
</script>
