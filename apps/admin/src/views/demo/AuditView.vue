<template>
  <section class="page active" aria-label="操作审计">
    <div class="page-head">
      <div>
        <p class="eyebrow">AUDIT & TRACE</p>
        <h1>操作审计</h1>
        <p>事实状态变化、审核决定和发布结果都会留痕。以下为生产库 audit_log 的真实记录。</p>
      </div>
      <button class="small-btn" @click="load">刷新日志 ↺</button>
    </div>

    <div class="panel">
      <div class="panel-heading">
        <h3>操作日志</h3>
        <span class="helper">共 {{ total }} 条 · 按时间倒序</span>
      </div>
      <div class="audit-log">
        <div v-if="loading" class="empty-block">加载中…</div>
        <div v-else-if="!items.length" class="empty-block">暂无审计记录</div>
        <template v-else>
          <div v-for="a in items" :key="a.id" class="audit-item">
            <span class="audit-clock">{{ fmtTime(a.createdAt) }}</span>
            <span class="audit-copy">
              {{ a.action }}
              <small>{{ a.targetType }}{{ a.targetId ? ' #' + a.targetId : '' }}{{ a.remark ? ' · ' + a.remark : '' }}</small>
            </span>
            <span class="audit-chip"><span class="tag gray">{{ actor(a) }}</span></span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { auditApi, type AuditLogItem } from '@/api';

const loading = ref(true);
const items = ref<AuditLogItem[]>([]);
const total = ref(0);

const fmtTime = (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false });

// 操作人：优先显示 display_name，其次登录名，最后回退到「用户 #id」
const actor = (a: AuditLogItem) =>
  a.userId ? a.userName || a.username || `用户 #${a.userId}` : '系统';

async function load() {
  loading.value = true;
  try {
    const res = await auditApi.list({ pageSize: 50 });
    items.value = res.items;
    total.value = res.total;
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* 标题与日志条目均内缩 22px，避免「操作日志」贴住面板左缘 */
.panel-heading {
  padding: 0 22px;
}
</style>
