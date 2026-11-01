<template>
  <section class="page active" aria-label="事实与证据">
    <div class="page-head">
      <div>
        <p class="eyebrow">FACT REGISTRY / 核验对象</p>
        <h1>事实与证据</h1>
        <p>事实是可持续维护的对象。核验内容是什么、来源说了什么、哪些时间已经确认、有哪些版本，必须逐项分清。</p>
      </div>
      <span class="page-head-tag">{{ total }} 条事实 · 实时读取</span>
    </div>

    <div class="toolbar">
      <label class="searchbox">
        <DemoIcon name="search" />
        <input v-model="q" placeholder="搜索事实陈述句..." aria-label="搜索事实" />
      </label>
    </div>

    <div v-if="loading" class="empty-block">加载中…</div>
    <div v-else-if="!rows.length" class="empty-block">没有符合条件的事实</div>
    <template v-else>
      <div class="proto-fact-list">
        <RealFactCard v-for="f in rows" :key="f.id" :fact="f">
          <template #foot>
            <button class="link-btn" @click="openFact(f)">打开事实详情 ↗</button>
          </template>
        </RealFactCard>
      </div>

      <div class="table-foot">
        <span class="table-sub">共 {{ total }} 条事实</span>
        <div class="pager">
          <button class="small-btn" :disabled="page <= 1 || loading" @click="go(page - 1)">← 上一页</button>
          <span class="table-sub">{{ page }} / {{ maxPage }}</span>
          <button class="small-btn" :disabled="page >= maxPage || loading" @click="go(page + 1)">下一页 →</button>
        </div>
      </div>
    </template>

    <div class="section-head">
      <h2>把证据和结论分开</h2>
      <span class="meta-note">有引文不等于引文能证明事实</span>
    </div>
    <div class="panel proto-big-card">
      <div class="two-col">
        <div>
          <h3 class="proto-sub-title">来源主张</h3>
          <p class="proto-narrative">一篇关于乐清的新闻提到某位干部在机关食堂就餐，这个文本本身不能用来证明乐清的行政区划。</p>
          <ProtoChip text="原文可能真实" kind="blue" />
        </div>
        <div>
          <h3 class="proto-sub-title">核验的命题</h3>
          <p class="proto-narrative">要证明乐清是温州下辖县级市，应当选择直接涉及行政区划的权威资料，而不是任意出现“乐清”的报道。</p>
          <ProtoChip text="必须检验证据蕴含" kind="warn" />
        </div>
      </div>
    </div>

    <DemoDrawer
      :open="drawer.open"
      :eyebrow="drawer.eyebrow"
      :title="drawer.title"
      @close="drawer.open = false"
    >
      <div v-if="drawer.loading" class="empty-block">正在读取事实详情…</div>
      <template v-else-if="drawer.fact">
        <div class="drawer-stat">
          <span class="tag blue">{{ drawer.fact.dimension }}</span>
          <span class="tag gray">{{ typeText(drawer.fact.factType) }}</span>
          <span :class="['tag', statusColor(drawer.fact.status)]">{{ statusText(drawer.fact.status) }}</span>
        </div>
        <div class="drawer-subhead">事实陈述</div>
        <div class="drawer-fact"><p>{{ drawer.fact.statement }}</p></div>
        <div class="drawer-subhead">稳定标识与版本</div>
        <div class="fact-route">
          {{ drawer.fact.code || `F-${drawer.fact.id}` }} · 实体 #{{ drawer.fact.entityId }} · v{{ drawer.fact.version }} · 模型置信度（非可信度）{{ drawer.fact.confidence }}
        </div>
        <div class="drawer-subhead">时间语义</div>
        <p class="drawer-desc">
          首次知悉：{{ drawer.fact.firstSeenAt || '—' }}<br />
          最近核验：{{ drawer.fact.lastVerifiedAt || '—' }}
        </p>
        <div class="drawer-subhead">证据引句 · 共 {{ drawer.fact.evidences?.length ?? 0 }} 条</div>
        <template v-if="drawer.fact.evidences?.length">
          <div v-for="e in drawer.fact.evidences" :key="e.id" class="drawer-fact">
            <h4>{{ e.code || '引句' }} · {{ e.sourceOrg || '未知来源' }}</h4>
            <p>{{ e.quote }}</p>
            <div class="drawer-fact-meta">
              <span class="tag gray">{{ e.role }}</span>
              <span class="tag gray">{{ e.verifyStatus || '未标注核验' }}</span>
              <span class="tag gray">质量 {{ e.qualityGrade || '—' }}</span>
              <span class="tag gray">{{ e.publishedAt || '—' }}</span>
            </div>
            <small v-if="e.materialTitle" class="source-link">{{ e.materialTitle }}</small>
          </div>
        </template>
        <div v-else class="empty-block">该事实暂无引句证据</div>
      </template>
    </DemoDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import DemoDrawer from '@/demo/DemoDrawer.vue';
import ProtoChip from '@/demo/ProtoChip.vue';
import RealFactCard from '@/demo/RealFactCard.vue';
import { factApi, type FactItem } from '@/api';

const PAGE_SIZE = 30;
const loading = ref(true);
const rows = ref<FactItem[]>([]);
const total = ref(0);
const page = ref(1);
const q = ref('');

const maxPage = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

const typeText = (t: string) =>
  ({ current_state: '现行状态', source_claim: '来源主张', occurred: '发生事件' })[t] || t;
const statusText = (s: string) =>
  ({ active: '已生效', review: '待复核', superseded: '已被替换', disputed: '争议中', retired: '已退役' })[s] || s;
/** 抽屉里用 demo-skin 的 tag 色值 */
const statusColor = (s: string) =>
  ({ active: 'green', review: 'orange', superseded: 'gray', disputed: 'orange', retired: 'gray' })[s] || 'gray';

const drawer = reactive({
  open: false,
  loading: false,
  title: '',
  eyebrow: 'FACT / 事实对象',
  fact: null as FactItem | null,
});

async function openFact(f: FactItem) {
  drawer.open = true;
  drawer.loading = true;
  drawer.fact = null;
  drawer.title = f.statement;
  try {
    drawer.fact = await factApi.detail(f.id);
  } catch {
    drawer.fact = f;
  } finally {
    drawer.loading = false;
  }
}

async function go(p: number) {
  page.value = p;
  await load();
}

async function load() {
  loading.value = true;
  try {
    const res = await factApi.list({
      page: page.value,
      pageSize: PAGE_SIZE,
      keyword: q.value.trim() || undefined,
      // 只显示现行事实：已被替代/归档的历史版本不在列表中
      activeOnly: true,
    });
    rows.value = res.items;
    total.value = res.total;
  } catch {
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

let timer: number | undefined;
watch(q, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    page.value = 1;
    void load();
  }, 300);
});

onMounted(load);
</script>

<style scoped>
.table-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 4px 4px;
}
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pager .small-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
