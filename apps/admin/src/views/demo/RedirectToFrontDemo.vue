<template>
  <div style="padding: 48px; color: #758599; font: 14px/1.6 'Segoe UI', 'PingFang SC', 'Microsoft Yahei', sans-serif">
    正在跳转到公开演示站…
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { publicUrl } from '@/utils/publicUrl';

/**
 * 旧公开展示路径（总览/新闻流/变更/目录/发布中心/引用观察）在后台已不存在，
 * 已迁移到前端端口（apps/web，顶级路径 /overview、/news…）。
 * 本组件把 /admin/demo/* 整页跳转到前端站点对应路径。
 */
const route = useRoute();
const target = publicUrl(route.path.replace(/^\/admin\/demo/, '') || '/overview');
window.location.replace(target);
</script>
