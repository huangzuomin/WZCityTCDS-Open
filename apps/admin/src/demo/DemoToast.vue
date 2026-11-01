<template>
  <div class="toast" :class="{ show: !!toastText }" role="status" aria-live="polite">
    {{ toastText }}
  </div>
</template>

<script setup lang="ts">
import { toastText } from '@/demo/demoUi';
</script>
