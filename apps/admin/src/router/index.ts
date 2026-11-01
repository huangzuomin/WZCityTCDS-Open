import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { tokenStore } from '@/api/http';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录', public: true },
  },
  // 公开页（语料首页 / 档案页 / 公开图谱）已迁到 apps/web，后台不再注册这些路由
  {
    path: '/',
    component: () => import('@/layouts/BasicLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '概览', icon: 'DataLine' },
      },
      {
        path: 'datasets',
        name: 'datasets',
        component: () => import('@/views/DatasetView.vue'),
        meta: { title: '语料域', icon: 'Collection' },
      },
      {
        path: 'news',
        name: 'news',
        component: () => import('@/views/RealtimeNewsView.vue'),
        meta: { title: '入库记录', icon: 'Reading' },
      },
      {
        path: 'news/settings',
        name: 'news-settings',
        component: () => import('@/views/RealtimeNewsSettingView.vue'),
        meta: { title: '新闻源设置', icon: 'Setting' },
      },
      {
        path: 'categories',
        name: 'categories',
        component: () => import('@/views/CategoryView.vue'),
        meta: { title: '实体类别', icon: 'Grid' },
      },
      {
        path: 'field-defs',
        name: 'field-defs',
        component: () => import('@/views/FieldDefsView.vue'),
        meta: { title: '字段定义', icon: 'Collection' },
      },
      {
        path: 'dimensions',
        name: 'dimensions',
        component: () => import('@/views/DimensionView.vue'),
        meta: { title: '口径维度', icon: 'List' },
      },
      {
        path: 'category-dimensions',
        name: 'category-dimensions',
        component: () => import('@/views/CategoryDimensionView.vue'),
        meta: { title: '分类维度', icon: 'SetUp' },
      },
      {
        path: 'relation-schemas',
        name: 'relation-schemas',
        component: () => import('@/views/RelationSchemaView.vue'),
        meta: { title: '关系Schema', icon: 'Connection' },
      },
      {
        path: 'facts',
        name: 'facts',
        component: () => import('@/views/FactView.vue'),
        meta: { title: '事实管理', icon: 'Files' },
      },
      {
        path: 'entities',
        name: 'entities',
        component: () => import('@/views/EntityView.vue'),
        meta: { title: '实体档案', icon: 'Document' },
      },
      {
        path: 'discovery-review',
        name: 'discovery-review',
        component: () => import('@/views/DiscoveryReviewView.vue'),
        meta: { title: '发现审核', icon: 'Aim' },
      },
      {
        path: 'pipeline',
        name: 'pipeline',
        component: () => import('@/views/PipelineView.vue'),
        meta: { title: '生产线', icon: 'Cpu' },
      },
      {
        path: 'graph',
        name: 'graph',
        component: () => import('@/views/GraphView.vue'),
        meta: { title: '知识图谱', icon: 'Share' },
      },
      {
        path: 'llm-config',
        name: 'llm-config',
        component: () => import('@/views/LlmConfigView.vue'),
        meta: { title: '大模型设置', icon: 'Setting' },
      },
      {
        path: 'docs',
        name: 'docs',
        component: () => import('@/views/DocsView.vue'),
        meta: { title: '相关文档', icon: 'Document' },
      },
      {
        path: 'llm-log',
        name: 'llm-log',
        component: () => import('@/views/LlmLogView.vue'),
        meta: { title: '调用日志', icon: 'Monitor' },
      },
      {
        path: 'dev-tools',
        name: 'dev-tools',
        component: () => import('@/views/DevToolsView.vue'),
        meta: { title: '开发调试', icon: 'Tools' },
      },
      {
        path: 'geo-report',
        name: 'geo-report',
        component: () => import('@/views/GeoReportView.vue'),
        meta: { title: 'GEO 报告', icon: 'TrendCharts' },
      },
      {
        path: 'observatory',
        name: 'observatory',
        component: () => import('@/views/ObservatoryView.vue'),
        meta: { title: '观测台', icon: 'Connection' },
      },
      {
        path: 'observatory/questions',
        name: 'observatory-questions',
        component: () => import('@/views/QuestionManageView.vue'),
        meta: { title: '问题管理', icon: 'List' },
      },
      {
        path: 'observatory/settings',
        name: 'observatory-settings',
        component: () => import('@/views/ObservatorySettingView.vue'),
        meta: { title: '设置', icon: 'Setting' },
      },
    ],
  },
  // 演示版后台：公开展示页已迁到前端端口（apps/web 顶级路径 /overview、/news…），此处仅保留需登录的运营页
  {
    path: '/demo',
    component: () => import('@/layouts/DemoLayout.vue'),
    redirect: '/demo/review',
    children: [
      {
        path: 'review',
        name: 'demo-review',
        component: () => import('@/views/demo/ReviewView.vue'),
        meta: { title: '审核工作台' },
      },
      {
        path: 'audit',
        name: 'demo-audit',
        component: () => import('@/views/demo/AuditView.vue'),
        meta: { title: '操作审计' },
      },
      // 旧公开展示路径（总览/新闻流/目录/发布中心/引用观察等）跳转到前端端口对应页面
      {
        path: ':pathMatch(.*)*',
        name: 'demo-front-redirect',
        component: () => import('@/views/demo/RedirectToFrontDemo.vue'),
      },
    ],
  },
];

const router = createRouter({
  // 与 vite base 一致：生产挂在 /admin/ 下
  history: createWebHistory('/admin/'),
  routes,
});

export default router;

// 路由守卫：后台全站需登录（公开展示页已迁到前端端口 apps/web，本应用不再承载）
router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!tokenStore.get()) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = (to.meta.title as string) || '';
  document.title = title ? `${title} · SSOT` : 'SSOT';
});
