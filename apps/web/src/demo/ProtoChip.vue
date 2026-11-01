<template>
  <span class="tag" :class="color">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

type ChipKind = 'world' | 'knowledge' | 'warn' | 'blue' | 'note' | 'outline';

const props = withDefaults(defineProps<{ text: string; kind?: ChipKind }>(), { kind: 'note' });

// 映射到 demo-skin .tag 色系（world=绿、knowledge=紫、warn=橙、blue=蓝、note/outline=灰）
const COLOR: Record<ChipKind, string> = {
  world: 'green',
  knowledge: 'purple',
  warn: 'orange',
  blue: 'blue',
  note: 'gray',
  outline: 'gray',
};

const color = computed(() => COLOR[props.kind] ?? 'gray');
</script>
