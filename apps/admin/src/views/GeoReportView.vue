<template>
  <div class="page">
    <div class="toolbar">
      <div class="t-left">
        <span class="t-title">GEO 效果分析报告</span>
        <el-tag type="info" effect="plain" size="small">
          用生产线文本模型分析最近 {{ questionLimit }} 条提问记录与各模型引用情况
        </el-tag>
      </div>
      <div class="t-right">
        <el-select v-model="questionLimit" size="small" style="width: 130px">
          <el-option :value="5" label="最近 5 题" />
          <el-option :value="10" label="最近 10 题" />
          <el-option :value="20" label="最近 20 题" />
          <el-option :value="30" label="最近 30 题" />
        </el-select>
        <el-button type="primary" :loading="generating" @click="generate">一键生成报告</el-button>
        <el-button :disabled="!report" @click="downloadHtml">下载 HTML</el-button>
        <el-button :disabled="!report" @click="openWindow">新窗口查看</el-button>
      </div>
    </div>

    <el-empty v-if="!generating && !report" description="点击「一键生成报告」，由生产线文本模型输出多维度分析与建议" :image-size="80" />

    <div v-if="generating" class="loading-box">
      <el-skeleton :rows="4" animated />
      <p class="loading-tip">大模型正在分析（通常 30~120 秒），请勿关闭页面…</p>
    </div>

    <div v-if="report && !generating" class="meta-bar">
      <el-tag size="small" effect="plain">生成时间 {{ fmt(report.generatedAt) }}</el-tag>
      <el-tag size="small" effect="plain">分析模型 {{ report.modelName }}</el-tag>
      <el-tag size="small" effect="plain">提问 {{ report.questionCount }} 条 / 回答 {{ report.answerCount }} 条</el-tag>
      <el-tag v-if="report.usage" size="small" effect="plain">token {{ report.usage.totalTokens }}</el-tag>
      <el-tag size="small" effect="plain">耗时 {{ Math.round(report.latencyMs / 1000) }}s</el-tag>
      <el-tag v-if="!report.llmOk" size="small" type="warning" effect="dark">模型输出未解析：{{ report.llmError }}</el-tag>
    </div>

    <iframe v-if="report && !generating" class="report-frame" :srcdoc="report.html" frameborder="0" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { geoReportApi, type GeoReport } from '@/api';

const generating = ref(false);
const report = ref<GeoReport | null>(null);
const questionLimit = ref(10);

const fmt = (v: string) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');

async function generate() {
  generating.value = true;
  report.value = null;
  try {
    report.value = await geoReportApi.generate({ questionLimit: questionLimit.value });
    ElMessage.success('报告已生成');
  } finally {
    generating.value = false;
  }
}

function downloadHtml() {
  if (!report.value) return;
  const blob = new Blob([report.value.html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `geo-report-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openWindow() {
  if (!report.value) return;
  const w = window.open('', '_blank');
  if (w) w.document.write(report.value.html);
  else ElMessage.warning('浏览器拦截了新窗口，请允许弹窗后再试');
}

onMounted(async () => {
  try {
    report.value = await geoReportApi.latest();
  } catch {
    report.value = null;
  }
});
</script>

<style scoped>
.page { padding: 16px 18px 24px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.t-left { display: flex; align-items: center; gap: 10px; }
.t-title { font-size: 16px; font-weight: 700; }
.t-right { display: flex; align-items: center; gap: 8px; }
.meta-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.loading-box { margin-top: 20px; }
.loading-tip { color: #8a5a00; font-size: 13px; }
.report-frame { flex: 1; width: 100%; min-height: 640px; border: 1px solid #e3e7ec; border-radius: 8px; background: #fff; }
</style>
