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

      <div class="proto-navscroll">
        <template v-for="group in menuGroups" :key="group.caption">
          <div class="nav-caption" :class="{ 'nav-second': group.second }">{{ group.caption }}</div>
          <nav class="main-nav" aria-label="功能导航">
            <template v-for="item in group.items" :key="item.page">
              <a v-if="item.href" class="nav-link" :href="item.href">
                <span class="nav-ico"><DemoIcon :name="item.icon" /></span>{{ item.title }}
              </a>
              <button v-else class="nav-link" :class="{ active: current === item.page }" @click="go(item.page)">
                <span class="nav-ico"><DemoIcon :name="item.icon" /></span>{{ item.title }}
                <span v-if="item.kbd" class="nav-kbd">{{ item.kbd }}</span>
                <span v-else-if="item.countKey != null && countOf(item) > 0" class="nav-count">{{ countOf(item) }}</span>
              </button>
            </template>
          </nav>
        </template>
      </div>

      <div class="side-spacer"></div>
      <div class="side-service">
        <div class="service-head"><span class="service-beacon"></span>系统运行状态</div>
        <div class="service-desc">已连接生产事实库 · 实时统计</div>
        <div class="service-track"><span></span><span></span><span></span><span></span></div>
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
import { newsApi } from '@/api';
import skin from '@/demo/demo-skin.css?raw';
import protoSkin from '@/demo/prototype-skin.css?raw';

const route = useRoute();
const router = useRouter();
const mobileOpen = ref(false);

const TITLES: Record<string, string> = {
  overview: '运行总览',
  news: '实时新闻流',
  changes: '事实变更',
  catalog: '城市事实目录',
  distribution: '机器发布中心',
  observatory: 'AI 引用观察',
  publications: '事实发布记录',
  topics: '实体与主题',
  facts: '事实与证据',
};

interface MenuItem {
  page: string;
  title: string;
  icon: string;
  kbd?: string;
  countKey?: keyof typeof counts;
  /** 外链项：整页跳转（如 SSG 静态页），不走 SPA 路由 */
  href?: string;
}

const counts = reactive({ news: 0 });

const menuGroups: { caption: string; second?: boolean; items: MenuItem[] }[] = [
  {
    caption: '工作台',
    items: [
      { page: 'overview', title: '运行总览', icon: 'layout', kbd: '01' },
      { page: 'news', title: '实时新闻流', icon: 'radio', countKey: 'news' },
      { page: 'publications', title: '事实发布记录', icon: 'check' },
      { page: 'changes', title: '事实变更', icon: 'git' },
      { page: 'facts', title: '事实与证据', icon: 'shield' },
      { page: 'topics', title: '城市事实目录', icon: 'layers' },
    ],
  },
  {
    caption: '发布与观察',
    second: true,
    items: [
      { page: 'distribution', title: '机器发布中心', icon: 'brackets' },
      { page: 'observatory', title: 'AI 引用观察', icon: 'activity' },
    ],
  },
  {
    caption: '关于',
    second: true,
    items: [
      // 方法论页是 SSG 静态页（零 JS 全量内容），走整页跳转而非 SPA 路由
      { page: 'methodology', title: '方法论与核验', icon: 'shield', href: '/methodology/' },
    ],
  },
];

const current = computed(() => (route.path.split('/').pop() || 'overview').split('?')[0]);
const countOf = (item: MenuItem) => (item.countKey ? counts[item.countKey] : 0);
const currentTitle = computed(() => TITLES[current.value] ?? '运行总览');
const today = computed(() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
});

const go = (page: string) => {
  mobileOpen.value = false;
  router.push(`/${page}`);
};

// demo 皮肤：仅在本布局挂载期间注入 document.head，卸载即移除
let skinEl: HTMLStyleElement | null = null;
let protoSkinEl: HTMLStyleElement | null = null;

onMounted(async () => {
  skinEl = document.createElement('style');
  skinEl.setAttribute('data-demo-skin', '1');
  skinEl.textContent = skin;
  document.head.appendChild(skinEl);

  // 概念原型 v1.2 专有皮肤：同法注入、卸载一并移除
  protoSkinEl = document.createElement('style');
  protoSkinEl.setAttribute('data-proto-skin', '1');
  protoSkinEl.textContent = protoSkin;
  document.head.appendChild(protoSkinEl);

  // 公开展示：只取新闻执行记录计数（其余计数依赖需登录的审核接口，不做）
  try {
    counts.news = (await newsApi.runs({ pageSize: 1 })).total;
  } catch {
    // 计数失败不影响页面使用
  }
});

onBeforeUnmount(() => {
  skinEl?.remove();
  skinEl = null;
  protoSkinEl?.remove();
  protoSkinEl = null;
  document.body.style.overflow = '';
});
</script>
