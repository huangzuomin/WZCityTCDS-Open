<template>
  <div class="app-shell demo-root">
    <aside class="sidebar" :class="{ open: mobileOpen }">
      <a class="brand" href="#overview" aria-label="温州有据城市事实发布系统" @click.prevent="go('overview')">
        <span class="brand-icon"><span></span><span></span><span></span><span></span></span>
        <span class="brand-lines"><strong>温州有据</strong><small>WENZHOU · FACTFLOW</small></span>
      </a>
      <div class="workspace-badge">
        <span class="pulse"></span><span>事实发布工作空间</span><span class="tiny-chevron">⌄</span>
      </div>

      <template v-for="group in menuGroups" :key="group.caption">
        <div class="nav-caption" :class="{ 'nav-second': group.second }">{{ group.caption }}</div>
        <nav class="main-nav" aria-label="功能导航">
          <button
            v-for="item in group.items"
            :key="item.page"
            class="nav-link"
            :class="{ active: current === item.page }"
            @click="go(item.page)"
          >
            <span class="nav-ico"><DemoIcon :name="item.icon" /></span>{{ item.title }}
            <span v-if="item.kbd" class="nav-kbd">{{ item.kbd }}</span>
            <span v-else-if="item.countKey != null" class="nav-count">{{ countOf(item) }}</span>
            <span v-else-if="item.alertKey != null && countOf(item) > 0" class="nav-alert">{{ countOf(item) }}</span>
          </button>
        </nav>
      </template>

      <div class="side-spacer"></div>
      <div class="side-service">
        <div class="service-head"><span class="service-beacon"></span>原型运行状态</div>
        <div class="service-desc">交互演示模式 · 未连接生产系统</div>
        <div class="service-track"><span></span><span></span><span></span><span></span></div>
        <button class="small-btn demo-switch" @click="router.push('/dashboard')">切换到经典后台</button>
      </div>
      <div class="side-footer">
        <span class="side-avatar">温</span>
        <span><strong>温州市新闻传媒中心</strong><small>城市可信内容枢纽 · 发布层</small></span>
        <span class="side-dots">···</span>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <div class="mobile-top"><button class="mobile-menu" aria-label="打开菜单" @click="mobileOpen = !mobileOpen">☰</button></div>
        <div class="breadcrumb">
          <span>可信内容枢纽</span><span class="crumb-sep">/</span><strong>{{ currentTitle }}</strong>
        </div>
        <div class="top-actions">
          <span class="global-status"><span></span>生产环境</span>
          <span class="top-date">数据快照 · {{ today }}</span>
        </div>
      </header>
      <main class="content">
        <router-view />
      </main>
    </div>

    <DemoToast />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoToast from '@/demo/DemoToast.vue';
import { newsApi, pipelineApi } from '@/api';
import skin from '@/demo/demo-skin.css?raw';
import { publicUrl } from '@/utils/publicUrl';

const route = useRoute();
const router = useRouter();
const mobileOpen = ref(false);

const TITLES: Record<string, string> = {
  overview: '运行总览',
  news: '实时新闻流',
  changes: '事实变更',
  catalog: '城市事实目录',
  review: '审核工作台',
  distribution: '机器发布中心',
  observatory: 'AI 引用观察',
  audit: '操作审计',
};

interface MenuItem {
  page: string;
  title: string;
  icon: string;
  kbd?: string;
  /** 公开展示页已迁到前端端口：标记后点击整页跳转前端站点 */
  external?: boolean;
  countKey?: keyof typeof counts;
  alertKey?: keyof typeof counts;
}

const counts = reactive({ news: 0, changes: 0, pending: 0 });

const menuGroups: { caption: string; second?: boolean; items: MenuItem[] }[] = [
  {
    caption: '工作台',
    items: [
      { page: 'overview', title: '运行总览', icon: 'layout', kbd: '01', external: true },
      { page: 'news', title: '实时新闻流', icon: 'radio', countKey: 'news', external: true },
      { page: 'changes', title: '事实变更', icon: 'git', countKey: 'changes', external: true },
      { page: 'catalog', title: '城市事实目录', icon: 'layers', external: true },
      { page: 'review', title: '审核工作台', icon: 'check', alertKey: 'pending' },
    ],
  },
  {
    caption: '发布与观察',
    second: true,
    items: [
      { page: 'distribution', title: '机器发布中心', icon: 'brackets', external: true },
      { page: 'observatory', title: 'AI 引用观察', icon: 'activity', external: true },
      { page: 'audit', title: '操作审计', icon: 'clock' },
    ],
  },
  {
    caption: '发布体系 v1.2',
    second: true,
    items: [
      { page: 'publishing', title: '发布总览', icon: 'layout', external: true },
      { page: 'topics', title: '实体与主题', icon: 'layers', external: true },
      { page: 'facts', title: '事实与证据', icon: 'shield', external: true },
      { page: 'machine-access', title: '面向机器的发布接口', icon: 'brackets', external: true },
    ],
  },
  {
    caption: '概念原型（演示数据）',
    second: true,
    items: [
      { page: 'publications', title: '事实发布记录', icon: 'check', external: true },
      { page: 'reality', title: '现实变化流', icon: 'activity', external: true },
      { page: 'knowledge', title: '知识更新流', icon: 'git', external: true },
    ],
  },
];

const current = computed(() => (route.path.split('/').pop() || 'review').split('?')[0]);
const countOf = (item: MenuItem) =>
  item.countKey ? counts[item.countKey] : item.alertKey ? counts[item.alertKey] : 0;
const currentTitle = computed(() => TITLES[current.value] ?? '审核工作台');
const today = computed(() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
});

const go = (page: string) => {
  mobileOpen.value = false;
  const item = menuGroups.flatMap((g) => g.items).find((i) => i.page === page);
  if (item?.external) {
    // 公开展示页在前端端口：整页跳转（前台是独立 SPA）
    window.location.assign(publicUrl(`/${page}`));
    return;
  }
  router.push(`/demo/${page}`);
};

// demo 皮肤：仅在本布局挂载期间注入 document.head，卸载即移除，不污染经典后台
let skinEl: HTMLStyleElement | null = null;

onMounted(async () => {
  skinEl = document.createElement('style');
  skinEl.setAttribute('data-demo-skin', '1');
  skinEl.textContent = skin;
  document.head.appendChild(skinEl);

  // 计数接口各自容错：公开访客无登录时 pipeline 草稿 401，不影响其余计数
  try {
    counts.news = (await newsApi.runs({ pageSize: 1 })).total;
  } catch {
    // 计数失败不影响页面使用
  }
  try {
    counts.changes = (await pipelineApi.listDrafts({ pageSize: 1 })).total;
  } catch {
    // 计数失败不影响页面使用
  }
  try {
    counts.pending = (await pipelineApi.listDrafts({ status: 'pending', pageSize: 1 })).total;
  } catch {
    // 计数失败不影响页面使用
  }
});

onBeforeUnmount(() => {
  skinEl?.remove();
  skinEl = null;
  document.body.style.overflow = '';
});
</script>
