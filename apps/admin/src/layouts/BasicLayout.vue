<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="brand">
        <span class="brand-main">SSOT</span>
        <span class="brand-sub">事实档案后台</span>
      </div>
      <nav class="menu">
        <template v-for="item in menuItems" :key="item.title">
          <el-popover
            v-if="item.children"
            trigger="hover"
            :show-after="120"
            placement="right-start"
            :width="220"
            :persistent="false"
            popper-class="sup-menu"
          >
            <template #reference>
              <div class="mi" :class="{ active: activeIn(item) }">
                <el-icon><component :is="item.icon" /></el-icon>
                <span>{{ item.title }}</span>
              </div>
            </template>
            <div
              v-for="child in item.children"
              :key="child.path"
              class="mi sub"
              :class="{ active: route.path === child.path }"
              @click="nav(child.path!)"
            >
              <el-icon><component :is="child.icon" /></el-icon>
              <span>{{ child.title }}</span>
            </div>
          </el-popover>
          <div v-else class="mi" :class="{ active: route.path === item.path }" @click="nav(item.path!)">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </div>
        </template>
      </nav>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-title">{{ currentTitle }}</div>
        <nav class="header-nav">
          <a
            v-for="q in quickLinks"
            :key="q.path"
            class="hl"
            :class="{ active: route.path === q.path }"
            @click.prevent="router.push(q.path!)"
          >
            <el-icon><component :is="q.icon" /></el-icon>
            <span>{{ q.title }}</span>
          </a>
        </nav>
        <div class="header-right">
          <el-button size="small" @click="router.push('/demo/overview')">切换到演示后台</el-button>
          <el-tag size="small" type="info" effect="plain">{{ roleLabel }}</el-tag>
          <span class="user-name">{{ user?.displayName || user?.username }}</span>
          <el-button size="small" text @click="logout">退出</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Collection,
  Connection,
  Cpu,
  DataLine,
  Document,
  Aim,
  Files,
  Folder,
  Grid,
  List,
  Monitor,
  Reading,
  Setting,
  SetUp,
  Share,
  Tools,
  TrendCharts,
} from '@element-plus/icons-vue';
import { useMetaStore } from '@/stores/meta';
import { authApi, type AuthUser } from '@/api';
import { tokenStore } from '@/api/http';

const meta = useMetaStore();
const route = useRoute();
const router = useRouter();
const user = ref<AuthUser | null>(null);

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  editor: '编辑',
  reviewer: '审核',
  viewer: '只读',
};

interface MenuItem {
  path?: string;
  title: string;
  icon: Component;
  children?: MenuItem[];
}

const menuItems: MenuItem[] = [
  { path: '/dashboard', title: '概览', icon: DataLine },
  { path: '/datasets', title: '语料域', icon: Collection },
  {
    title: '实时新闻',
    icon: Reading,
    children: [
      { path: '/news', title: '入库记录', icon: Reading },
      { path: '/news/settings', title: '新闻源设置', icon: Setting },
    ],
  },
  { path: '/pipeline', title: '生产线', icon: Cpu },
  { path: '/graph', title: '知识图谱', icon: Share },
  {
    title: '内容管理',
    icon: Folder,
    children: [
      { path: '/categories', title: '实体类别', icon: Grid },
      { path: '/field-defs', title: '字段定义', icon: Collection },
      { path: '/dimensions', title: '口径维度', icon: List },
      { path: '/category-dimensions', title: '分类维度', icon: SetUp },
      { path: '/relation-schemas', title: '关系Schema', icon: Connection },
      { path: '/facts', title: '事实管理', icon: Files },
      { path: '/entities', title: '实体档案', icon: Document },
      { path: '/discovery-review', title: '发现审核', icon: Aim },
    ],
  },
  {
    title: '引用监测',
    icon: Connection,
    children: [
      { path: '/observatory', title: '观测台', icon: Connection },
      { path: '/geo-report', title: 'GEO 报告', icon: TrendCharts },
      { path: '/observatory/questions', title: '问题管理', icon: List },
      { path: '/observatory/settings', title: '设置', icon: Setting },
    ],
  },
  {
    title: '开发调试',
    icon: Tools,
    children: [
      { path: '/llm-log', title: '调用日志', icon: Monitor },
      { path: '/dev-tools', title: '数据工具', icon: Tools },
    ],
  },
  {
    title: '系统设置',
    icon: Setting,
    children: [
      { path: '/llm-config', title: '大模型设置', icon: Setting },
      { path: '/docs', title: '相关文档', icon: Document },
    ],
  },
];

/** header 快捷入口：把高频菜单拉平放顶部，省去逐层展开 */
const quickLinks: MenuItem[] = [
  { path: '/discovery-review', title: '发现审核', icon: Aim },
  { path: '/llm-log', title: '调试日志', icon: Monitor },
  { path: '/news', title: '入库记录', icon: Reading },
  { path: '/news/settings', title: '新闻源设置', icon: Setting },
  { path: '/dev-tools', title: '数据工具', icon: Tools },
  { path: '/entities', title: '实体档案', icon: Document },
];

const activePath = computed(() => route.path);
/** 一级项激活判定：自身路由 或 任一二级子路由命中 */
const activeIn = (item: MenuItem) =>
  route.path === item.path || !!item.children?.some((c) => c.path === route.path);
/** 点击菜单项跳转（自绘菜单用，替代 el-menu 的 router 模式） */
const nav = (path: string) => router.push(path);
const currentTitle = computed(() => {
  for (const item of menuItems) {
    if (item.path === route.path) return item.title;
    const child = item.children?.find((c) => c.path === route.path);
    if (child) return child.title;
  }
  return '';
});
const roleLabel = computed(() => ROLE_LABELS[user.value?.role ?? ''] ?? user.value?.role ?? '');

const logout = () => {
  tokenStore.clear();
  router.replace('/login');
};

onMounted(async () => {
  void meta.ensureLoaded();
  try {
    user.value = await authApi.me();
  } catch {
    // 401 已由拦截器统一处理（清 token 跳登录），这里只兜住 UI
  }
});
</script>

<style scoped>
.layout {
  height: 100%;
}

.aside {
  display: flex;
  flex-direction: column;
  background: var(--ssot-sidebar-bg);
  color: #fff;
  overflow: hidden; /* 菜单展开不撑动整体布局，避免触发 el-main 重排 */
}

.brand {
  padding: 18px 20px 22px;
  line-height: 1.2;
}

.brand-main {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 2px;
}

.brand-sub {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--ssot-sidebar-text-dim);
}

.menu {
  display: flex;
  flex-direction: column;
  border-right: none;
  background: transparent;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 一级菜单项（文本可见，点击可选；有二级时点击弹出浮层） */
.mi {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 10px;
  padding: 0 12px;
  height: 50px;
  border-radius: 10px;
  color: var(--ssot-sidebar-text);
  background: transparent;
  cursor: pointer;
  font-family: -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 0.5px;
  transition: background 0.15s ease, color 0.15s ease; /* 颜色/背景过渡为 GPU 合成，不卡 */
  user-select: none;
}

.mi:hover {
  background: var(--ssot-sidebar-hover);
  color: #fff;
}

/* 当前路由所在的一级分组：渐变底 + 左侧墨绿亮条 */
.mi.active {
  color: #fff;
  font-weight: 600;
  background: var(--ssot-sidebar-active-bg);
  box-shadow: inset 3px 0 0 var(--ssot-sidebar-accent);
}

/* 二级浮层（el-popover，teleport 到 body，须 :global 命中） */
:global(.sup-menu) {
  padding: 6px;
}

:global(.sup-menu .mi.sub) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 40px;
  color: #4e5969;
  border-radius: 6px;
  cursor: pointer;
  font-family: -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
  font-size: 14px;
  letter-spacing: 0.5px;
}

:global(.sup-menu .mi.sub:hover),
:global(.sup-menu .mi.sub.active) {
  color: #fff;
  background: var(--el-color-primary);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--ssot-line);
}

.header-title {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

.header-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 16px;
  overflow-x: auto;
}

.header-nav .hl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 13px;
  color: #4e5969;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
}

.header-nav .hl .el-icon {
  font-size: 14px;
}

.header-nav .hl:hover {
  color: var(--el-color-primary);
  background: var(--ssot-teal-pale);
}

.header-nav .hl.active {
  color: #fff;
  background: var(--el-color-primary);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-name {
  font-size: 13px;
  color: var(--ssot-muted);
}

.main {
  padding: 0;
  overflow: auto;
}
</style>
