<template>
  <div class="home-page">
    <header class="site">
      <div class="wrap">
        <div class="bar">
          <div class="brand">
            <span class="logo">{{ home?.dataset.name ?? '语料域' }} · <b>城市事实</b></span>
            <span class="sub">City Real-time Trusted Content Distribution</span>
          </div>
          <nav>
            <a href="#news">实时新闻</a>
            <a href="#changes">事实变化</a>
            <a href="#catalog">事实目录</a>
            <a href="#schema">Schema 映射</a>
            <a href="#machine">API · Feed</a>
            <a :href="`/archive/${home?.dataset.code}/graph`">知识图谱</a>
          </nav>
        </div>
        <div class="crumbs">{{ host }}/fact / <b>fact</b></div>
      </div>
    </header>

    <div class="wrap">
      <section style="padding-top: 24px">
        <h1 class="title" style="font-size: 28px">{{ home?.dataset.name || '城市事实' }}</h1>
        <p class="lede" style="font-size: 15.5px">
          让最新城市信息<b>更快进入搜索与 AI</b>（Fast Lane），让重要事实<b>持续沉淀为可信城市知识</b>（Fact Lane）。
          新闻是事件（News = Event），事实是状态（Fact = State）——这台流水线让信息从发生、发布、核验、沉淀，一路进入 AI 的认知链路。
        </p>

        <div class="pipeline">
          <div class="pl-title">语料流水线（Fast Lane 分发 · Fact Lane 沉淀）：</div>
          <div class="lane lane-fast">
            <span class="lane-name">Fast Lane</span>
            <span class="lanestep ok">发布</span><span class="lanesep">→</span>
            <span class="lanestep ok">Sitemap</span><span class="lanesep">→</span>
            <span class="lanestep ok">IndexNow</span><span class="lanesep">→</span>
            <span class="lanestep ok">搜索引擎</span><span class="lanesep">→</span>
            <span class="lanestep ok">AI 检索通道</span>
          </div>
          <div class="lane lane-fact">
            <span class="lane-name">Fact Lane</span>
            <span class="lanestep ok">锚定实体</span><span class="lanesep">→</span>
            <span class="lanestep ok">抽取 Claim</span><span class="lanesep">→</span>
            <span class="lanestep" :class="home?.stats.pendingReview ? 'warn' : 'ok'">{{ home?.stats.pendingReview || 0 }} 项待确认</span><span class="lanesep">→</span>
            <span class="lanestep ok">沉淀为事实</span>
          </div>
        </div>

        <div class="statrow">
          <div class="stat"><b>{{ home?.stats.todayNews ?? 0 }}</b>今日新闻</div>
          <div class="stat"><b>{{ home?.stats.todayChanges ?? 0 }}</b>今日 Fact Change</div>
          <div class="stat"><b>{{ home?.stats.pendingReview ?? 0 }}</b>待人工确认</div>
          <div class="stat"><b>{{ home?.stats.facts ?? 0 }}</b>有效事实</div>
        </div>
        <div class="verified-strip" style="margin-top: 8px">
          <span><span class="dot"></span>语料域 {{ home?.dataset.code }} · 已收录 {{ home?.stats.entities ?? 0 }} 实体 / {{ home?.stats.directories ?? 0 }} 分类目录</span>
          <span><a href="#catalog">进入事实目录 →</a></span>
        </div>
      </section>

      <section id="news" v-if="home?.news?.length">
        <h2 class="sec">实时新闻流 · 最近进入系统</h2>
        <p class="secdesc">每条新闻发布即进入 Fast Lane 分发；涉及受控实体的，同步进入 Fact Lane 做锚定、抽取与事实变化检测。</p>
        <div class="newsrow2" v-for="n in home.news" :key="n.id">
          <div class="nr-top">
            <span class="nr-time">{{ fmtTime(n.publishedAt) }}</span>
            <span class="nr-title"><a :href="n.url || '#'" target="_blank" rel="noopener">{{ n.title }}</a></span>
          </div>
          <div class="nr-meta">
            <span>Content ID：<code>{{ n.id }}</code></span>
            <span>来源：{{ n.sourceOrg || '未知' }}</span>
          </div>
        </div>
      </section>

      <section id="changes" v-if="home?.changes?.length">
        <h2 class="sec">最近事实变化 · Fact Change Feed</h2>
        <p class="secdesc">每一次事实变化都可被外部系统订阅。旧值不覆盖，全部保留版本关系。</p>
        <div class="newsrow2" v-for="c in home.changes" :key="c.id">
          <div class="nr-top">
            <span class="nr-time">{{ c.occurredAt || '' }}</span>
            <a class="entity-id" :href="`/archive/${home?.dataset.code}/${c.entitySlug}`">{{ c.entityName }}</a>
            <span class="chg" :class="chgClass(c.changeType)">{{ chgLabel(c.changeType) }}</span>
          </div>
          <div style="font-size: 14px; margin-top: 6px" v-if="c.toStatement || c.fromStatement || c.summary">
            <template v-if="c.toStatement && c.fromStatement">
              <span v-if="c.toDimension" class="k-dim">{{ c.toDimension }}：</span>{{ c.fromStatement }} <span class="oldval">→</span> <span class="newval">{{ c.toStatement }}</span>
            </template>
            <template v-else-if="c.toStatement">
              <span v-if="c.toDimension" class="k-dim">{{ c.toDimension }}：</span><span class="newval">{{ c.toStatement }}</span>
            </template>
            <template v-else>{{ c.summary }}</template>
          </div>
          <div class="nr-meta">
            <a :href="`/archive/${home?.dataset.code}/${c.entitySlug}`">Entity Page</a>
          </div>
        </div>
      </section>

      <section id="catalog">
        <h2 class="sec">城市事实目录 · 底层资产入口</h2>
        <p class="secdesc">按分类组织的高价值实体：永久 ID · 事实页 · 核心事实 · 历史时间线 · 证据链。</p>

        <div v-if="!home?.directories.length" class="empty">
          该语料域尚未配置首页目录。请到后台「语料域 → 配置首页」选择分类目录并设置数量。
        </div>

        <div v-for="dir in home?.directories ?? []" :key="dir.categoryId" class="dirgroup">
          <div class="dir-head">
            <span class="dir-name">{{ dir.name }}</span>
            <span class="dir-sub">{{ dir.description }}</span>
            <span class="dir-count">共 {{ dir.entityTotal }} 个 · 展示 {{ dir.entities.length }}</span>
          </div>
          <div class="cards">
            <a
              v-for="e in dir.entities"
              :key="e.id"
              class="ecard"
              :href="`/archive/${home?.dataset.code}/${e.slug}`"
            >
              <div class="en">{{ e.name }}</div>
              <div class="et">{{ dir.name }}</div>
              <div class="es">{{ e.lede || '暂无简介' }}</div>
              <div class="em">{{ e.slug }}</div>
              <div class="est">
                <span class="chip st-active">当前有效</span> {{ e.factCount }} 条 · 证据 {{ e.evidenceCount }} 条
              </div>
            </a>
          </div>
        </div>
      </section>

      <!-- 城市事实目录·底层资产入口：所列实体的合并知识图谱 -->
      <section id="cataloggraph">
        <h2 class="sec">目录实体知识图谱（{{ home?.graph?.nodes?.length ?? 0 }} 节点 · {{ home?.graph?.edges?.length ?? 0 }} 关系）</h2>
        <p class="secdesc">把「城市事实目录·底层资产入口」所列实体展开成一张网络：含实体及其一跳连接节点；点击实体可跳档案页。</p>
        <div v-if="home?.graph?.edges?.length" class="home-graphbox">
          <div class="home-graph-layout">
            <div ref="graphEl" class="home-graphcanvas"></div>
            <aside v-if="selectedNode" class="home-graph-side">
              <div class="gn-head">
                <b>{{ selectedNode.name }}</b>
                <span class="gn-type" :class="selectedNode.nodeType">{{ selectedNode.nodeType === 'concept' ? '概念' : '实体' }}</span>
              </div>
              <div v-if="selectedNode.categoryName" class="gn-meta">类别：{{ selectedNode.categoryName }}</div>
              <div v-if="selectedNode.lede" class="gn-lede">{{ selectedNode.lede }}</div>
              <a
                v-if="selectedNode.nodeType === 'entity' && selectedNode.slug && selectedNode.datasetCode"
                href="javascript:void(0)"
                class="gn-open"
                @click="openSelectedPage"
              >打开档案主页 →</a>
              <div class="gn-sec">关联关系（{{ edgesOf(selectedNode.id).length }}）</div>
              <ul class="gn-rels">
                <li v-for="e in edgesOf(selectedNode.id)" :key="e.id">
                  <span class="gn-dir" :class="{ tm: e.tail === selectedNode.id }">{{ e.head === selectedNode.id ? '顺' : '逆' }}</span>
                  <span class="gn-neighbor" @click="openNeighbor(e, selectedNode.id)">{{ neighborName(e, selectedNode.id) }}</span>
                  <span class="gn-pred">{{ e.label }}</span>
                </li>
              </ul>
            </aside>
          </div>
        </div>
        <p v-else class="secdesc">暂无关系数据（这些实体还没有入图的关联关系）。</p>
      </section>

      <section id="schema" v-if="schemaRows.length">
        <h2 class="sec">Entity → Schema.org 映射表</h2>
        <p class="secdesc">不为 rich result 强行套类型；不确定时使用 Thing。</p>
        <table class="kv">
          <tbody>
            <tr v-for="s in schemaRows" :key="s.type">
              <td>{{ s.desc }}</td>
              <td>
                <code>{{ s.type }}</code><br>
                <span style="font-size: 12px; color: #5a6572">{{ s.examples }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="machine">
        <div class="machine-card">
          <div class="machine-card-head">
            <span class="machine-card-title">机器出口</span>
            <span class="machine-card-sub">Machine-readable outputs</span>
          </div>
          <div class="machine-card-body">

            <div class="machine-line">
              <span class="machine-tag">语料域:</span>
              <span class="machine-cells">
                <a class="machine-path" :href="`/api/archive/home/${home?.dataset.code}`" target="_blank" rel="noopener">/api/archive/home/{{ home?.dataset.code }}</a> JSON <span class="machine-note">(目录卡片 + 统计)</span>
                <span class="machine-sep">·</span>
                <a class="machine-path" :href="`/archive/home/${home?.dataset.code}`" target="_blank" rel="noopener">/archive/home/{{ home?.dataset.code }}</a> HTML
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">目录:</span>
              <span class="machine-cells">
                <a class="machine-path" :href="`/api/archive/home/${home?.dataset.code}`" target="_blank" rel="noopener">directories</a> JSON <span class="machine-note">(含 各分类实体 + fact/evidence 计数)</span>
                <span class="machine-sep">·</span>
                <span class="machine-path" style="cursor:help">stats</span> <span class="machine-note">(今日新闻 / 有效事实 / 待确认)</span>
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">News:</span>
              <span class="machine-cells">
                <a class="machine-path" :href="`/api/archive/home/${home?.dataset.code}`" target="_blank" rel="noopener">news</a> JSON <span class="machine-note">(最近 10 篇实时新闻)</span>
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">变化流:</span>
              <span class="machine-cells">
                <a class="machine-path" :href="`/api/archive/home/${home?.dataset.code}`" target="_blank" rel="noopener">changes</a> JSON <span class="machine-note">(最近 16 条 Fact Change)</span>
                <span class="machine-sep">·</span>
                <a class="machine-path" href="/api/archive/feed.json" target="_blank" rel="noopener">feed.json</a> <span class="machine-note">(近 30 天变更)</span>
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">图谱:</span>
              <span class="machine-cells">
                <a class="machine-path" :href="`/archive/${home?.dataset.code}/graph`" target="_blank" rel="noopener">/archive/{{ home?.dataset.code }}/graph</a> JSON <span class="machine-note">(目录实体合并图谱)</span>
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">索引与订阅:</span>
              <span class="machine-cells">
                <a class="machine-path" href="/api/archive/sitemap.xml" target="_blank" rel="noopener">sitemap.xml</a>
                <span class="machine-sep">·</span>
                <a class="machine-path" href="/api/archive/feed.xml" target="_blank" rel="noopener">feed.xml</a>
                <span class="machine-sep">·</span>
                <a class="machine-path" href="/api/archive/catalog.json" target="_blank" rel="noopener">catalog.json</a>
              </span>
            </div>

            <div class="machine-line">
              <span class="machine-tag">MCP:</span>
              <span class="machine-cells">
                <span class="machine-path" style="cursor:help">枢纽侧 news-base-mcp</span> <span class="machine-note">为 Agent 直连通道 (list_entities / search_evidence / get_entity_timeline)</span>
              </span>
            </div>

          </div>
        </div>
      </section>
    </div>

    <footer class="site">
      <div class="wrap">
        <div class="cols">
          <div><h4>城市事实发布引擎</h4>温州有据 · fact-publishing-engine v1（本地验证）<br />生成时间：{{ (home?.generatedAt || '').replace('T', ' ').slice(0, 19) }}<br />语料域：{{ home?.dataset.code }}</div>
          <div><h4>双链路分工</h4>News = Event：回答"刚刚发生了什么"；<br />Fact = State：回答"现在是什么状态"。<br />新闻不承担长期状态管理，事实页不重写新闻。</div>
          <div><h4>版权</h4>内容版权归新闻原文作者；<br />事实与证据来自本地可信语料库。</div>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DataSet, Network } from 'vis-network/standalone';
import type { Edge as VisEdge, Node as VisNode, Options as VisOptions } from 'vis-network/standalone';
import { datasetHomeApi, type DatasetHome, type GraphEdge, type GraphNode } from '@/api';

const GRAPH_PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
const GRAPH_CONCEPT_COLOR = '#8a97a5';

const route = useRoute();
const router = useRouter();
const home = ref<DatasetHome | null>(null);
const host = ref('');
const graphEl = ref<HTMLDivElement | null>(null);
const selectedNode = ref<GraphNode | null>(null);
let network: Network | null = null;
let visNodes = new DataSet<VisNode>([]);
let visEdges = new DataSet<VisEdge>([]);

/** 目录实体合并知识图谱：force 布局，实体点可跳档案页 */
function renderGraph() {
  if (!graphEl.value || !home.value?.graph) return;
  const g = home.value.graph;
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const degree = new Map<number, number>();
  for (const e of g.edges) {
    degree.set(e.head, (degree.get(e.head) ?? 0) + 1);
    degree.set(e.tail, (degree.get(e.tail) ?? 0) + 1);
  }
  const entityCats = [...new Set(g.nodes.filter((n) => n.nodeType === 'entity').map((n) => n.categoryName ?? '未分类'))];
  const colorOf = (n: GraphNode) =>
    n.nodeType === 'concept' ? GRAPH_CONCEPT_COLOR : GRAPH_PALETTE[entityCats.indexOf(n.categoryName ?? '未分类') % GRAPH_PALETTE.length];

  const list: VisNode[] = g.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    shape: n.nodeType === 'concept' ? 'diamond' : 'dot',
    size: 12 + Math.min(degree.get(n.id) ?? 0, 20) * 1.3,
    color: { background: colorOf(n) },
    borderDashes: n.nodeType === 'concept' ? [4, 3] : false,
    title: [n.name, n.nodeType === 'concept' ? '概念' : `实体 · ${n.categoryName ?? '未分类'}`, (n as GraphNode).lede ?? '']
      .filter(Boolean)
      .join('\n'),
  }));

  const pairGroups = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    const key = `${e.head}\u0000${e.tail}`;
    pairGroups.set(key, [...(pairGroups.get(key) ?? []), e]);
  }
  const pairSet = new Set(pairGroups.keys());
  const edgeList: VisEdge[] = [];
  let seq = 0;
  for (const [key, members] of pairGroups) {
    const [from, to] = key.split('\u0000').map(Number);
    edgeList.push({
      id: `v${seq++}`,
      from,
      to,
      label: members[0].label,
      arrows: 'to',
      width: 1 + Math.min(Math.max(...members.map((m) => m.corroborateCount)), 3) * 0.6,
      title: members.map((m) => m.statement ?? `${nodeById.get(m.head)?.name ?? m.head} ${m.label} ${nodeById.get(m.tail)?.name ?? m.tail}`).join('\n\n'),
      smooth: pairSet.has(`${to}\u0000${from}`) ? { enabled: true, type: 'curvedCW', roundness: 0.15 } : false,
    });
  }

  visNodes = new DataSet<VisNode>(list);
  visEdges = new DataSet<VisEdge>(edgeList);
  const options: VisOptions = {
    autoResize: true,
    // 力学参数（Force Atlas 2）：与后台知识图谱一致 —— 引力-212 / 中心引力0.02 / 弹簧长130 / 刚度0.05
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      stabilization: { iterations: 250 },
      forceAtlas2Based: { gravitationalConstant: -212, centralGravity: 0.02, springLength: 130, springConstant: 0.05 },
    },
    interaction: { hover: true, navigationButtons: true, tooltipDelay: 150 },
    nodes: { font: { size: 13, strokeWidth: 0 } },
    edges: { font: { size: 11, strokeWidth: 3 } },
  };
  network?.destroy();
  network = new Network(graphEl.value, { nodes: visNodes, edges: visEdges }, options);
  network.on('stabilizationIterationsDone', () => network?.fit());
  // 单击：显示节点详情；双击：实体打开档案主页
  network.on('click', (params) => {
    const ids = (params as { nodes: number[] }).nodes;
    selectedNode.value = ids.length ? (nodeById.get(Number(ids[0])) ?? null) : null;
    if (ids.length) network?.selectNodes(ids);
    else network?.unselectAll();
  });
  network.on('doubleClick', (params) => {
    const ids = (params as { nodes: number[] }).nodes;
    if (ids.length) {
      const n = nodeById.get(Number(ids[0]));
      if (n?.nodeType === 'entity' && n.slug && n.datasetCode) {
        void router.push(`/archive/${n.datasetCode}/${n.slug}`);
      }
    }
  });
}

/** 某节点的关联关系（在当前子图内） */
const edgesOf = (id: number) => (home.value?.graph?.edges ?? []).filter((e) => e.head === id || e.tail === id);
const neighborName = (e: GraphEdge, id: number) =>
  (home.value?.graph?.nodes ?? []).find((n) => n.id === (e.head === id ? e.tail : e.head))?.name ?? '';
/** 点击详情里的邻居节点跳到档案页 */
function openNeighbor(e: GraphEdge, id: number) {
  const otherId = e.head === id ? e.tail : e.head;
  const n = (home.value?.graph?.nodes ?? []).find((x) => x.id === otherId);
  if (n?.nodeType === 'entity' && n.slug && n.datasetCode) void router.push(`/archive/${n.datasetCode}/${n.slug}`);
}
function openSelectedPage() {
  const n = selectedNode.value;
  if (n?.nodeType === 'entity' && n.slug && n.datasetCode) void router.push(`/archive/${n.datasetCode}/${n.slug}`);
}

const onResize = () => network?.redraw();

const chgMap: Record<string, { label: string; cls: string }> = {
  new: { label: 'New Fact', cls: 'chg-new' },
  update: { label: 'Update', cls: 'chg-update' },
  corroborate: { label: 'Corroborate', cls: 'chg-no_change' },
  retire: { label: 'Retire', cls: 'chg-supersede' },
};
const chgLabel = (t: string) => chgMap[t]?.label ?? t ?? 'Change';
const chgClass = (t: string) => chgMap[t]?.cls ?? 'chg-no_change';

const fmtTime = (v: string | null) => (v || '').replace('T', ' ').slice(0, 16);

// Entity → Schema.org 映射：由分类 code 推断
const SCHEMA_MAP: Array<{ codes: string[]; type: string; desc: string }> = [
  { codes: ['place', 'food', 'culture', 'scenic'], type: 'Place', desc: 'place（街区/景区/地标）' },
  { codes: ['event', 'activity', 'festival'], type: 'Event', desc: 'event（博览会/活动）' },
  { codes: ['project', 'construction', 'engineering'], type: 'Project', desc: 'project（重大工程）' },
  { codes: ['policy', 'service', 'transport', 'education', 'public'], type: 'GovernmentService', desc: 'policy / public service / transport program' },
  { codes: ['school', 'university', 'campus'], type: 'EducationalOrganization', desc: 'school（单所学校建档时）' },
  { codes: ['organization', 'company', 'org', 'enterprise'], type: 'Organization', desc: 'org / company' },
  { codes: ['person'], type: 'Person', desc: 'person（人物）' },
];
const schemaRows = computed(() => {
  const dirs = home.value?.directories ?? [];
  if (!dirs.length) return [];
  const rows = new Map<string, { type: string; desc: string; examples: string[] }>();
  for (const d of dirs) {
    const m = SCHEMA_MAP.find((s) => s.codes.includes(d.code));
    const type = m?.type ?? 'Thing';
    const key = type;
    if (!rows.has(key)) {
      rows.set(key, { type, desc: m?.desc ?? key === 'Thing' ? 'uncertain（缺省兜底）' : type, examples: [] });
    }
    const eg = d.entities.slice(0, 3).map((e) => `${d.name}·${e.name}`);
    rows.get(key)!.examples.push(...eg);
  }
  return Array.from(rows.values()).map((r) => ({ ...r, examples: r.examples.join(' · ') }));
});

onMounted(async () => {
  const code = String(route.params.dataset ?? '');
  if (!code) return;
  host.value = window.location.origin;
  try {
    home.value = await datasetHomeApi.get(code);
  } catch {
    /* 拦截器提示 */
  }
  // 图谱 div 是 v-if 渲染的，须等本轮 DOM 渲染完再初始化画布，否则 graphEl 尚为 null
  await nextTick();
  renderGraph();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  network?.destroy();
  network = null;
});
</script>

<style scoped>
.home-page {
  font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  color: #1c2430; background: #f6f7f9; line-height: 1.65; font-size: 15px; min-height: 100vh;
}
.home-page a { color: #0b5cab; text-decoration: none; }
.home-page a:hover { text-decoration: underline; }
.wrap { max-width: 1060px; margin: 0 auto; padding: 0 20px; }
header.site { background: linear-gradient(135deg, #0b2f56 0%, #0b5cab 100%); color: #fff; padding: 18px 0 0; }
header.site .bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.brand { display: flex; align-items: baseline; gap: 12px; }
.brand .logo { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
.brand .logo b { color: #ffd166; }
.brand .sub { font-size: 12px; opacity: .85; }
header.site nav a { color: #dce9f7; font-size: 13px; margin-left: 16px; }
.crumbs { font-size: 12.5px; color: #c9d9ea; padding: 12px 0 14px; font-family: Consolas, Menlo, monospace; }
.crumbs b { color: #fff; }
section { padding: 30px 0 6px; }
h1.title { font-size: 26px; line-height: 1.3; margin-bottom: 6px; }
.lede { color: #5a6572; margin-top: 8px; max-width: 820px; }
.pipeline { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 14px 16px; margin-top: 16px; }
.pipeline .pl-title { font-size: 13px; color: #5a6572; margin-bottom: 8px; }
.lane { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.lane .lane-name { flex: 0 0 84px; font-size: 12px; font-weight: 700; padding: 2px 0; }
.lane-fast .lane-name { color: #0b5cab; }
.lane-fact .lane-name { color: #22764a; }
.lanestep { font-size: 12px; background: #f2f6fb; border: 1px solid #d8e4f2; border-radius: 4px; padding: 2px 8px; color: #27425f; }
.lanestep.ok { background: #e7f4ec; border-color: #bfe0cc; color: #22764a; }
.lanestep.warn { background: #fdf5e6; border-color: #eedcb8; color: #8a5a00; }
.lanesep { color: #b9c5d2; font-size: 12px; align-self: center; }
.statrow { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 4px; }
.stat { background: #fff; border: 1px solid #e3e7ec; border-radius: 6px; padding: 8px 14px; font-size: 12.5px; color: #5a6572; }
.stat b { display: block; font-size: 18px; color: #1c2430; }
.verified-strip { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; background: #e7f4ec; border: 1px solid #cfe7d8; border-radius: 6px; padding: 10px 14px; font-size: 13px; }
.verified-strip .dot { width: 8px; height: 8px; border-radius: 50%; background: #22764a; display: inline-block; margin-right: 6px; }
h2.sec { font-size: 19px; padding-left: 10px; border-left: 4px solid #0b5cab; margin-bottom: 6px; }
p.secdesc { color: #5a6572; font-size: 13px; margin-bottom: 14px; }
.chip { display: inline-block; font-size: 12px; border-radius: 3px; padding: 1px 8px; border: 1px solid transparent; }
.st-active { color: #22764a; background: #e7f4ec; border-color: #bfe0cc; }
.chg { display: inline-block; font-size: 12px; border-radius: 3px; padding: 1px 8px; border: 1px solid transparent; }
.chg-new { color: #22764a; background: #e7f4ec; border-color: #bfe0cc; }
.chg-update { color: #0b5cab; background: #eaf2fb; border-color: #cfe0f2; }
.chg-no_change, .chg-supersede { color: #66707d; background: #eceff3; border-color: #d5dbe3; }
.entity-id { font-family: Consolas, Menlo, monospace; font-size: 13px; color: #0b5cab; background: #eaf2fb; border: 1px solid #cfe0f2; border-radius: 4px; padding: 2px 8px; display: inline-block; }
.k-dim { color: #5a6572; }
.oldval { color: #8a4b08; text-decoration: line-through; text-decoration-color: #d8b27a; }
.newval { color: #22764a; font-weight: 600; }
.newsrow2 { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 13px 16px; margin-bottom: 11px; }
.newsrow2 .nr-top { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
.newsrow2 .nr-time { font-family: Consolas, Menlo, monospace; font-size: 13px; color: #08427a; font-weight: 700; }
.newsrow2 .nr-title { font-size: 15px; font-weight: 600; }
.newsrow2 .nr-title a { color: #1c2430; }
.newsrow2 .nr-meta { font-size: 12px; color: #5a6572; margin-top: 5px; }
.newsrow2 .nr-meta code { font-family: Consolas, Menlo, monospace; font-size: 11.5px; }
.dirgroup { margin-bottom: 26px; }
.dir-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.dir-name { font-size: 17px; font-weight: 700; }
.dir-sub { color: #5a6572; font-size: 13px; flex: 1; }
.dir-count { color: #c0c4cc; font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.home-graphbox { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 10px; margin-top: 4px; }
.home-graph-layout { display: flex; gap: 12px; align-items: stretch; }
.home-graphcanvas { width: 100%; height: 520px; flex: 1 1 auto; min-width: 0; }
.home-graph-side { width: 300px; flex-shrink: 0; background: #f8fafc; border: 1px solid #e3e7ec; border-radius: 6px; padding: 12px; font-size: 13px; overflow: auto; max-height: 520px; }
.gn-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gn-head b { font-size: 16px; }
.gn-type { font-size: 12px; padding: 1px 8px; border-radius: 10px; }
.gn-type.concept { background: #f0f1f3; color: #5b6672; }
.gn-type.entity { background: #eaf2fb; color: #0b5cab; }
.gn-meta { color: #5a6572; margin-top: 6px; }
.gn-lede { color: #3c4654; line-height: 1.6; margin-top: 6px; }
.gn-open { display: inline-block; color: #0b5cab; margin-top: 8px; }
.gn-sec { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #d5dbe3; font-weight: 600; color: #1c2430; }
.gn-rels { list-style: none; margin: 6px 0 0; padding: 0; }
.gn-rels li { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid #f0f2f5; }
.gn-dir { font-size: 11px; color: #0b5cab; background: #eaf2fb; border: 1px solid #cfe0f2; border-radius: 3px; padding: 0 4px; flex-shrink: 0; }
.gn-dir.tm { color: #8a5a00; background: #fdf5e6; border-color: #eedcb8; }
.gn-neighbor { color: #0b5cab; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gn-pred { margin-left: auto; color: #22764a; flex-shrink: 0; }
.ecard { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 16px 18px; display: block; color: #1c2430; }
.ecard:hover { border-color: #0b5cab; text-decoration: none; box-shadow: 0 2px 10px rgba(11, 92, 171, .08); }
.ecard .en { font-weight: 700; font-size: 16px; }
.ecard .et { color: #5a6572; font-size: 12.5px; margin-top: 2px; }
.ecard .es { font-size: 13px; color: #3c4654; margin-top: 8px; min-height: 40px; }
.ecard .em { font-family: Consolas, Menlo, monospace; font-size: 11.5px; margin-top: 9px; color: #0b5cab; }
.ecard .est { margin-top: 8px; font-size: 11.5px; }
table.kv { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 6px; }
table.kv td { border: 1px solid #e3e7ec; padding: 6px 10px; }
table.kv td:first-child { background: #f8fafc; color: #5a6572; white-space: nowrap; width: 170px; }
.machine-card {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.28);
  padding: 18px 20px;
  margin: 4px 0 30px;
  color: #e2e8f0;
}
.machine-card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid #1e293b;
}
.machine-card-title { font-weight: 700; font-size: 15px; color: #fff; }
.machine-card-sub { font-size: 12px; color: #94a3b8; }
.machine-card-body { display: flex; flex-direction: column; gap: 10px; }
.machine-line { display: flex; align-items: baseline; gap: 8px; line-height: 1.7; }
.machine-tag { flex: 0 0 auto; min-width: 72px; color: #94a3b8; font-weight: 600; font-size: 13px; }
.machine-cells { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; font-size: 13px; }
.machine-path {
  color: #fff; font-family: Consolas, 'JetBrains Mono', monospace; font-size: 12.5px;
  text-decoration: none; border-bottom: 1px dashed transparent;
}
a.machine-path:hover { color: #38bdf8; border-bottom: 1px dashed #38bdf8; }
.machine-path b { color: #38bdf8; font-weight: 600; }
.machine-sep { color: #64748b; }
.machine-note { color: #64748b; font-size: 12px; }
footer.site { border-top: 1px solid #e3e7ec; background: #fff; margin-top: 20px; padding: 22px 0 40px; color: #5a6572; font-size: 12.5px; }
footer.site .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
footer.site h4 { font-size: 13px; color: #1c2430; margin-bottom: 6px; }
.empty { text-align: center; padding: 50px 0; color: #909399; background: #fff; border-radius: 8px; }
</style>