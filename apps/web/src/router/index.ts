import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { releasePrerenderedTitle, setPageTitle } from '@/utils/pageTitle';

/**
 * 公开前台路由（外网可达，全部只读、无需登录）。
 * 与后台（apps/admin，base=/admin/，需登录）分开构建：这里不存在任何后台页面或登录入口。
 */
const routes: RouteRecordRaw[] = [
  // 语料域首页（公开）：须在 /archive/:dataset/:slug 之前注册
  {
    path: '/archive/home/:dataset',
    name: 'dataset-home',
    component: () => import('@/views/DatasetHomeView.vue'),
    meta: { title: '语料首页' },
  },
  // 语料域公开知识图谱（只读浏览）：须在 /archive/:dataset/:slug 之前注册
  {
    path: '/archive/:dataset/graph',
    name: 'dataset-graph',
    component: () => import('@/views/PublicGraphView.vue'),
    meta: { title: '知识图谱' },
  },
  // 单条变更的稳定公开地址：/archive/:dataset/:slug/change/:id（复用档案页并定位到该变更）
  {
    path: '/archive/:dataset/:slug/change/:id',
    name: 'archive-change',
    component: () => import('@/views/ArchiveView.vue'),
    meta: { title: '事实变更' },
  },
  // 单条事实的稳定公开地址：/archive/:dataset/:slug/fact/:code（复用档案页并定位到该事实）
  {
    path: '/archive/:dataset/:slug/fact/:code',
    name: 'archive-fact',
    component: () => import('@/views/ArchiveView.vue'),
    meta: { title: '事实条目' },
  },
  // 公开事实档案页（未发布实体由后端返回 404）
  {
    path: '/archive/:dataset/:slug',
    name: 'archive',
    component: () => import('@/views/ArchiveView.vue'),
    meta: { title: '事实档案' },
  },
  // 主题聚合页：一个主题跨文章合并去重后的全部事实（/facts/{topicId}）。
  // 旧链接 /facts/{articleId} 由页面内回源解析 301 到所属主题页，故这里只认主题 id。
  // 与文章页同为独立整页版式，不挂在 DemoLayout 下；与 SSG 静态页同版式。
  {
    path: '/facts/:topicId',
    name: 'topic-facts',
    component: () => import('@/views/proto/TopicFactsView.vue'),
    meta: { title: '主题事实档案' },
  },
  // 文章事实稿页：一篇文章抽取的全部事实（主题页的下钻页），迁到 /articles/{articleId}
  {
    path: '/articles/:articleId',
    name: 'article-facts',
    component: () => import('@/views/proto/ArticleFactsView.vue'),
    meta: { title: '文章事实稿' },
  },
  // 公开展示页（全部只读、无登录；审核/审计等运营页不在前台）
  // 顶级中性路径 /overview、/news、/changes、/catalog、/distribution、/observatory；
  // 旧 /demo/* 由部署层 301 到对应新路径，保住已收录 URL。
  {
    path: '/',
    component: () => import('@/layouts/DemoLayout.vue'),
    children: [
      { path: '', redirect: '/overview' },
      { path: 'overview', name: 'demo-overview', component: () => import('@/views/demo/OverviewView.vue'), meta: { title: '运行总览' } },
      { path: 'news', name: 'demo-news', component: () => import('@/views/demo/NewsView.vue'), meta: { title: '实时新闻流' } },
      { path: 'changes', name: 'demo-changes', component: () => import('@/views/demo/ChangesView.vue'), meta: { title: '事实变更' } },
      { path: 'catalog', name: 'demo-catalog', component: () => import('@/views/demo/CatalogView.vue'), meta: { title: '城市事实目录' } },
      { path: 'distribution', name: 'demo-distribution', component: () => import('@/views/demo/DistributionView.vue'), meta: { title: '机器发布中心' } },
      { path: 'observatory', name: 'demo-observatory', component: () => import('@/views/demo/ObservatoryView.vue'), meta: { title: 'AI 引用观察' } },
      // 内容视图（免登录只读）：与左侧菜单入口一一对应，
      // 每条路由同时有 SSG 静态页（爬虫与禁 JS 环境直读）与 SPA 交互版两条渲染路径。
      { path: 'publications', name: 'proto-publications', component: () => import('@/views/proto/PublicationsView.vue'), meta: { title: '事实发布记录' } },
      { path: 'topics', name: 'proto-topics', component: () => import('@/views/proto/TopicsView.vue'), meta: { title: '实体与主题' } },
      { path: 'facts', name: 'proto-facts', component: () => import('@/views/proto/FactsView.vue'), meta: { title: '事实与证据' } },
    ],
  },
  // 方法论页（E-E-A-T）：整页跳 SSG 静态页（/methodology/index.html，零 JS 全量内容），
  // 不在 SPA 内渲染——保证任何 UA（含禁 JS）都能读到完整方法论内容
  {
    path: '/methodology',
    beforeEnter: () => {
      window.location.replace('/methodology/');
      return false;
    },
    component: { render: () => null },
  },
  // 其他路径一律回首页（外网站点不存在后台路由）
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.afterEach((to) => {
  releasePrerenderedTitle(to.fullPath);
  setPageTitle(to.meta.title as string);
});

export default router;
