<template>
  <div class="drawer-overlay" :hidden="!open" @click="emit('close')"></div>
  <aside class="detail-drawer" :class="{ open }" aria-label="详情抽屉" :aria-hidden="open ? 'false' : 'true'">
    <div class="drawer-top">
      <div>
        <span class="eyebrow">{{ eyebrow }}</span>
        <h2>{{ title }}</h2>
      </div>
      <button class="close-drawer" aria-label="关闭详情" @click="emit('close')">×</button>
    </div>
    <div class="drawer-body">
      <slot />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { watch } from 'vue';

const props = defineProps<{ open: boolean; eyebrow?: string; title?: string }>();
const emit = defineEmits<{ close: [] }>();

// 抽屉打开时锁定页面滚动（与 docs/demo 行为一致）
watch(
  () => props.open,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : '';
  },
);
</script>
