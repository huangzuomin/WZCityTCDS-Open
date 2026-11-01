<template>
  <div class="graph-page" :class="{ dark }">
    <header class="site">
      <div class="wrap bar">
        <div class="brand">
          <span class="logo">{{ data?.dataset.name ?? '语料域' }} · <b>知识图谱</b></span>
          <span class="sub">只读浏览 · 实体与概念的关系网络</span>
        </div>
        <nav>
          <a href="/overview">返回首页</a>
          <button class="theme" @click="dark = !dark">{{ dark ? '浅色' : '深色' }}</button>
        </nav>
      </div>
    </header>

    <div class="wrap">
      <!-- 工具栏全部用原生控件（本站不引 Element Plus，保持公开页瘦身） -->
      <div class="toolbar">
        <span class="gp-search">
          <input v-model="keyword" class="gp-input" placeholder="搜索节点名称" @input="onKeyword" />
          <button v-if="keyword" class="gp-clear" title="清空" @click="clearKeyword">×</button>
        </span>
        <select v-model.number="minDegree" class="gp-select" @change="refresh">
          <option :value="1">最小连接数 1</option>
          <option :value="2">最小连接数 2</option>
          <option :value="3">最小连接数 3</option>
          <option :value="5">最小连接数 5</option>
        </select>
        <span class="gp-btn-group">
          <button class="gp-btn" :class="{ on: physics }" @click="setPhysics(!physics)">布局</button>
          <button class="gp-btn" :class="{ on: labels }" @click="setLabels(!labels)">节点标签</button>
          <button class="gp-btn" @click="network?.fit({ animation: true })">适应</button>
        </span>
        <span class="gp-pop-wrap">
          <button class="gp-btn" :class="{ on: physicsOpen }" @click="physicsOpen = !physicsOpen">力学参数</button>
          <div v-if="physicsOpen" class="gp-pop" @click.stop>
            <div class="phys-panel">
              <div class="phys-row">
                <label>求解器</label>
                <select v-model="physicsCfg.solver" class="gp-select sm">
                  <option value="forceAtlas2Based">Force Atlas 2</option>
                  <option value="barnesHut">Barnes Hut</option>
                  <option value="repulsion">Repulsion</option>
                </select>
              </div>
              <div class="phys-row">
                <label>引力常数 {{ physicsCfg.gravitationalConstant }}</label>
                <input v-model.number="physicsCfg.gravitationalConstant" class="gp-range" type="range" min="-500" max="0" step="1" />
              </div>
              <div class="phys-row">
                <label>中心引力 {{ physicsCfg.centralGravity.toFixed(3) }}</label>
                <input v-model.number="physicsCfg.centralGravity" class="gp-range" type="range" min="0" max="1" step="0.005" />
              </div>
              <div class="phys-row">
                <label>弹簧长度 {{ physicsCfg.springLength }}</label>
                <input v-model.number="physicsCfg.springLength" class="gp-range" type="range" min="0" max="500" step="5" />
              </div>
              <div class="phys-row">
                <label>弹簧刚度 {{ physicsCfg.springConstant.toFixed(3) }}</label>
                <input v-model.number="physicsCfg.springConstant" class="gp-range" type="range" min="0" max="1" step="0.005" />
              </div>
              <div class="phys-panel-btns">
                <button class="gp-btn on" @click="applyPhysics">应用</button>
                <button class="gp-btn" @click="resetPhysics">重置</button>
              </div>
            </div>
          </div>
        </span>
        <span class="gp-pop-wrap">
          <button class="gp-btn" :class="{ on: exportOpen }" @click="exportOpen = !exportOpen">导出 ▾</button>
          <div v-if="exportOpen" class="gp-menu" @click.stop>
            <button class="gp-menu-item" @click="onExport('png')">PNG 图片</button>
            <button class="gp-menu-item" @click="onExport('json')">JSON（可见三元组）</button>
            <button class="gp-menu-item" @click="onExport('csv')">CSV（可见三元组）</button>
          </div>
        </span>
        <span class="muted">节点 {{ visibleNodes.length }} · 关系 {{ data?.edges.length ?? 0 }}</span>
      </div>

      <div class="body">
        <div class="canvas-card">
          <div ref="graphEl" class="graph"></div>
          <div v-if="loading" class="gp-loading">加载中…</div>
          <div v-if="legendOpen" class="panel legend">
            <div class="panel-head">
              <span>类别</span>
              <button class="x" @click="legendOpen = false">×</button>
            </div>
            <label v-for="c in legendCategories" :key="c.name" class="row">
              <input type="checkbox" :checked="!hiddenCategories.has(c.name)" @change="toggleCategory(c.name)" />
              <span class="dot" :style="{ background: c.color }"></span>
              <span class="name">{{ c.name }}</span>
              <span class="size">{{ c.count }}</span>
            </label>
          </div>
          <button v-if="!legendOpen" class="panel-toggle" @click="legendOpen = true">图例</button>
          <div v-if="!loading && !data?.edges.length" class="gp-empty">该语料域暂无可展示的关系</div>
        </div>

        <aside class="side">
          <template v-if="node">
            <h3 class="side-title">{{ node.name }}</h3>
            <div class="tags">
              <span class="tag" :class="node.nodeType">{{ node.nodeType === 'concept' ? '概念' : '实体' }}</span>
              <span v-if="node.categoryName" class="tag plain">{{ node.categoryName }}</span>
            </div>
            <p v-if="node.lede" class="lede">{{ node.lede }}</p>
            <a v-if="archiveHref" class="archive-link" :href="archiveHref">查看事实档案 →</a>

            <div class="side-sec">
              <div class="sec-head">关联关系（{{ nodeEdges.length }}）</div>
              <ul class="rels">
                <li v-for="e in nodeEdges" :key="e.id">
                  <a class="rel-node" href="javascript:void(0)" @click="selectNode(e.head === node.id ? e.tail : e.head)">
                    {{ nameOf(e.head === node.id ? e.tail : e.head) }}
                  </a>
                  <span class="rel-label" :class="{ rev: e.tail === node.id }">{{ e.label }}</span>
                  <span class="rel-dir">{{ e.head === node.id ? '顺' : '逆' }}</span>
                </li>
              </ul>
            </div>

            <div class="side-sec" v-if="indirectNodes.length">
              <div class="sec-head">间接连接（两跳内 · {{ indirectNodes.length }}）</div>
              <div class="indirect-list">
                <span
                  v-for="n in indirectNodes"
                  :key="n.id"
                  class="indirect-chip"
                  @click="selectNode(n.id)"
                >{{ n.name }}</span>
              </div>
            </div>

            <div class="side-sec">
              <div class="sec-head">路径查找（当前子图内）</div>
              <div class="path-row">
                <select v-model.number="pathTarget">
                  <option :value="undefined">选择目标节点</option>
                  <option v-for="n in otherNodes" :key="n.id" :value="n.id">{{ n.name }}</option>
                </select>
                <button class="gp-btn sm" @click="runPath">查找</button>
              </div>
              <div v-if="pathText" class="path-text">{{ pathText }}</div>
            </div>
          </template>
          <div v-else class="side-empty">
            点击图中节点查看详情与关联关系；双击可聚焦。
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { DataSet, Network } from 'vis-network/standalone';
import type { Edge as VisEdge, Node as VisNode, Options as VisOptions } from 'vis-network/standalone';
import { datasetGraphApi, type DatasetGraph, type GraphEdge, type GraphNode } from '@/api';
import { download, toCsv, toPng } from '@/utils/export';
import { toast } from '@/utils/toast';

const PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
const CONCEPT_COLOR = '#8a97a5';

const route = useRoute();
const datasetCode = String(route.params.dataset ?? '');
const data = ref<DatasetGraph | null>(null);
const loading = ref(false);
const dark = ref(false);
const labels = ref(true);
const physics = ref(true);
const physicsOpen = ref(false);
/** 导出菜单开合（原生下拉替代 el-dropdown） */
const exportOpen = ref(false);
/** 力学参数（Force Atlas 2），可调；应用后 setOptions 到画布 */
const physicsCfg = reactive({
  solver: 'forceAtlas2Based',
  gravitationalConstant: -212,
  centralGravity: 0.02,
  springLength: 130,
  springConstant: 0.05,
});
const DEFAULT_PHYSICS = { solver: 'forceAtlas2Based', gravitationalConstant: -212, centralGravity: 0.02, springLength: 130, springConstant: 0.05 };
const legendOpen = ref(true);
const hiddenCategories = ref(new Set<string>());
const minDegree = ref(1);
const keyword = ref('');
const selected = ref<number | null>(null);
const pathTarget = ref<number | undefined>();
const pathText = ref('');

const graphEl = ref<HTMLDivElement | null>(null);
let network: Network | null = null;
let visNodes = new DataSet<VisNode>([]);
let visEdges = new DataSet<VisEdge>([]);
let membersOf = new Map<string, GraphEdge[]>();

const nodes = computed(() => data.value?.nodes ?? []);
const edges = computed(() => data.value?.edges ?? []);
const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));
const node = computed(() => (selected.value == null ? null : nodeById.value.get(selected.value) ?? null));
const nameOf = (id: number) => nodeById.value.get(id)?.name ?? `#${id}`;
const archiveHref = computed(() =>
  node.value?.nodeType === 'entity' && node.value.slug ? `/archive/${datasetCode}/${node.value.slug}` : '',
);

const degreeMap = computed(() => {
  const deg = new Map<number, number>();
  for (const e of edges.value) {
    deg.set(e.head, (deg.get(e.head) ?? 0) + 1);
    deg.set(e.tail, (deg.get(e.tail) ?? 0) + 1);
  }
  return deg;
});
const categoryOf = (n: GraphNode) => (n.nodeType === 'concept' ? '概念' : n.categoryName ?? '未分类');
const entityCategories = computed(() => [...new Set(nodes.value.filter((n) => n.nodeType === 'entity').map(categoryOf))]);
const colorOf = (n: GraphNode) =>
  n.nodeType === 'concept' ? CONCEPT_COLOR : PALETTE[entityCategories.value.indexOf(categoryOf(n)) % PALETTE.length];
const legendCategories = computed(() => {
  const map = new Map<string, number>();
  for (const n of nodes.value) {
    const k = categoryOf(n);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count, color: colorOf(nodeById.value.get(nodes.value.find((n) => categoryOf(n) === name)!.id)!) }));
});

const isHidden = (n: GraphNode) =>
  hiddenCategories.value.has(categoryOf(n)) ||
  (degreeMap.value.get(n.id) ?? 0) < minDegree.value ||
  (!!keyword.value && !n.name.toLowerCase().includes(keyword.value.toLowerCase()));
const visibleNodes = computed(() => nodes.value.filter((n) => !isHidden(n)));
const nodeEdges = computed(() =>
  selected.value == null ? [] : edges.value.filter((e) => e.head === selected.value || e.tail === selected.value),
);

/** 从选中节点做 ≤2 跳 BFS，得出各节点所在跳数（0=选中本身） */
const hopNodes = computed(() => {
  const map = new Map<number, number>();
  if (selected.value == null) return map;
  map.set(selected.value, 0);
  const q: number[] = [selected.value];
  while (q.length) {
    const cur = q.shift() as number;
    const d = map.get(cur)!;
    if (d >= 2) continue;
    for (const e of edges.value) {
      const nid = e.head === cur ? e.tail : e.tail === cur ? e.head : null;
      if (nid != null && !map.has(nid)) {
        map.set(nid, d + 1);
        q.push(nid);
      }
    }
  }
  return map;
});
/** 两跳内的间接节点（不直接与选中节点相连） */
const indirectNodes = computed(() => {
  const hop = hopNodes.value;
  return [...hop.entries()]
    .filter(([id, d]) => id !== selected.value && d >= 2)
    .map(([id]) => ({ id, name: nameOf(id) }));
});

/** 已按选中节点扩到 2 跳的缓存，避免每次点击都重新拉接口 */
const widenedIds = new Set<number>();
/** 拉取选中节点的多跳子图并入当前图（显示所有直接+间接连接） */
async function widen(id: number) {
  if (widenedIds.has(id)) return;
  if (!data.value) return;
  const sub = await datasetGraphApi.entityGraph(datasetCode, id, 3).catch(() => null);
  if (!sub || selected.value !== id) return;
  widenedIds.add(id);
  const nodeSet = new Set(data.value.nodes.map((n) => n.id));
  const edgeSet = new Set(data.value.edges.map((e) => e.id));
  for (const n of sub.nodes) if (!nodeSet.has(n.id)) (data.value.nodes as GraphNode[]).push(n as GraphNode);
  for (const e of sub.edges) if (!edgeSet.has(e.id)) (data.value.edges as GraphEdge[]).push(e as GraphEdge);
  render();
  refreshStyles();
  network?.selectNodes([id]);
}
const otherNodes = computed(() => visibleNodes.value.filter((n) => n.id !== selected.value));

function render() {
  const list: VisNode[] = nodes.value.map((n) => ({
    id: n.id,
    label: n.name,
    shape: n.nodeType === 'concept' ? 'diamond' : 'dot',
    size: 12 + Math.min(degreeMap.value.get(n.id) ?? 0, 20) * 1.3,
    color: { background: colorOf(n) },
    borderDashes: n.nodeType === 'concept' ? [4, 3] : false,
    title: [n.name, n.nodeType === 'concept' ? '概念' : `实体 · ${n.categoryName ?? '未分类'}`, n.lede ?? '']
      .filter(Boolean)
      .join('\n'),
  }));

  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges.value) {
    const key = `${e.head}\u0000${e.tail}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const pairSet = new Set(groups.keys());
  const edgeList: VisEdge[] = [];
  membersOf = new Map();
  let seq = 0;
  for (const [key, members] of groups) {
    const id = `v${seq++}`;
    membersOf.set(id, members);
    const [from, to] = key.split('\u0000').map(Number);
    edgeList.push({
      id,
      from,
      to,
      label: members[0].label + (members.length > 1 ? ` +${members.length - 1}` : ''),
      arrows: 'to',
      width: 1 + Math.min(Math.max(...members.map((m) => m.corroborateCount)), 3) * 0.6,
      title: members.map((m) => m.statement ?? `${nameOf(m.head)} ${m.label} ${nameOf(m.tail)}`).join('\n\n'),
      smooth: pairSet.has(`${to}\u0000${from}`) ? { enabled: true, type: 'curvedCW', roundness: 0.15 } : false,
    });
  }

  visNodes = new DataSet<VisNode>(list);
  visEdges = new DataSet<VisEdge>(edgeList);
  const options: VisOptions = {
    autoResize: true,
    physics: physicsOptions(),
    interaction: { hover: true, navigationButtons: true, tooltipDelay: 150 },
    nodes: { font: { size: 14, strokeWidth: 0 } },
    edges: { font: { size: 11, strokeWidth: 3 } },
  };

  network?.destroy();
  if (!graphEl.value) return;
  network = new Network(graphEl.value, { nodes: visNodes, edges: visEdges }, options);
  network.on('stabilizationIterationsDone', () => {
    // 有选中节点时聚焦到「它 + 直接邻居」这一局部，避免缩放整个合并后的子图
    if (selected.value != null) {
      const focusIds = new Set<number>([selected.value]);
      for (const e of edges.value) {
        if (e.head === selected.value) focusIds.add(e.tail);
        else if (e.tail === selected.value) focusIds.add(e.head);
      }
      network?.fit({ nodes: [...focusIds], animation: true });
    } else {
      network?.fit();
    }
  });
  network.on('click', (params) => {
    const ids = (params as { nodes: number[] }).nodes;
    if (ids.length) selectNode(Number(ids[0]));
    else clearSelection();
  });
  network.on('doubleClick', (params) => {
    const ids = (params as { nodes: number[] }).nodes;
    if (ids.length) network?.focus(Number(ids[0]), { scale: 1.6, animation: true });
  });
  refreshStyles();
}

function physicsOptions(): VisOptions['physics'] {
  return {
    enabled: physics.value,
    solver: physicsCfg.solver as 'forceAtlas2Based',
    stabilization: { iterations: 250 },
    forceAtlas2Based: {
      gravitationalConstant: physicsCfg.gravitationalConstant,
      centralGravity: physicsCfg.centralGravity,
      springLength: physicsCfg.springLength,
      springConstant: physicsCfg.springConstant,
    },
  };
}

/** 应用力学参数到画布 */
function applyPhysics() {
  if (!network) return;
  network.setOptions({ physics: physicsOptions() });
  if (physics.value) network.startSimulation();
  else network.stopSimulation();
}
function resetPhysics() {
  Object.assign(physicsCfg, DEFAULT_PHYSICS);
  applyPhysics();
}

function refreshStyles() {
  if (!network) return;
  const nodeColor = dark.value ? '#e6edf3' : '#1f2328';
  const edgeColor = dark.value ? '#8b949e' : '#666666';
  const hidden = new Set(nodes.value.filter(isHidden).map((n) => n.id));
  const focus = selected.value != null ? new Set<number>([selected.value]) : null;
  if (focus) {
    for (const e of edges.value) {
      if (e.head === selected.value || e.tail === selected.value) {
        focus.add(e.head);
        focus.add(e.tail);
      }
    }
  }
  visNodes.update(
    visNodes.get().map((n) => {
      const id = Number(n.id);
      const on = !focus || focus.has(id);
      return {
        id,
        hidden: hidden.has(id),
        opacity: on ? 1 : 0.15,
        font: { color: nodeColor, size: labels.value && on ? 14 : 0, strokeWidth: 0 },
        borderWidth: id === selected.value ? 3 : 1,
        color: { background: colorOf(nodeById.value.get(id) ?? ({ nodeType: 'concept' } as GraphNode)), border: id === selected.value ? '#f5a623' : undefined },
      };
    }),
  );
  visEdges.update(
    visEdges.get().map((e) => {
      const members = membersOf.get(String(e.id)) ?? [];
      const on = !focus || members.some((m) => focus.has(m.head) || focus.has(m.tail));
      return {
        id: e.id,
        hidden: members.length > 0 && members.every((m) => hidden.has(m.head) || hidden.has(m.tail)),
        color: focus && !on ? { color: '#999999', opacity: 0.08 } : edgeColor,
        width: focus && on ? 2 : 1 + Math.min(Math.max(0, ...members.map((m) => m.corroborateCount)), 3) * 0.6,
        font: { size: 11, color: edgeColor, strokeColor: dark.value ? '#0d1117' : '#ffffff', strokeWidth: 3 },
      };
    }),
  );
}

function refresh() {
  refreshStyles();
}

function selectNode(id: number) {
  selected.value = id;
  pathTarget.value = undefined;
  pathText.value = '';
  refreshStyles();
  network?.selectNodes([id]);
  void widen(id);
}

function clearSelection() {
  selected.value = null;
  pathTarget.value = undefined;
  pathText.value = '';
  network?.unselectAll();
  refreshStyles();
}

function onKeyword() {
  refreshStyles();
}

/** 清空搜索框（替代 el-input 的 clearable） */
function clearKeyword() {
  keyword.value = '';
  refreshStyles();
}

function setLabels(on: boolean) {
  labels.value = on;
  refreshStyles();
}

function setPhysics(on: boolean) {
  physics.value = on;
  network?.setOptions({ physics: physicsOptions() });
  if (on) network?.startSimulation();
  else network?.stopSimulation();
}

function toggleCategory(name: string) {
  const s = new Set(hiddenCategories.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  hiddenCategories.value = s;
  refreshStyles();
}

/** 当前子图内 BFS 最短路（前台只读，跨子图不承诺） */
function runPath() {
  const from = selected.value;
  const to = pathTarget.value;
  if (from == null || to == null) return;
  const adj = new Map<number, number[]>();
  for (const e of edges.value) {
    adj.set(e.head, [...(adj.get(e.head) ?? []), e.tail]);
    adj.set(e.tail, [...(adj.get(e.tail) ?? []), e.head]);
  }
  const prev = new Map<number, number>();
  const seen = new Set<number>([from]);
  const queue = [from];
  let found = from === to;
  while (queue.length && !found) {
    const cur = queue.shift() as number;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }
  if (!found) {
    pathText.value = '当前子图内没有路径（可放宽筛选后重试）';
    return;
  }
  const chain: number[] = [];
  for (let cur = to; cur !== from; cur = prev.get(cur) as number) chain.unshift(cur);
  chain.unshift(from);
  pathText.value = chain.map(nameOf).join(' → ');
  network?.fit({ nodes: chain, animation: true });
}

function onExport(cmd: string) {
  if (cmd === 'png') {
    const canvas = graphEl.value?.querySelector('canvas');
    if (canvas) toPng(canvas as HTMLCanvasElement, `graph-${datasetCode}.png`);
    else toast('画布未就绪');
    return;
  }
  const triples = edges.value
    .filter((e) => {
      const head = nodeById.value.get(e.head);
      const tail = nodeById.value.get(e.tail);
      return !(head && isHidden(head)) && !(tail && isHidden(tail));
    })
    .map((e) => ({
      subject: nameOf(e.head),
      predicate: e.label,
      object: nameOf(e.tail),
      confidence: e.confidence,
      corroborateCount: e.corroborateCount,
      statement: e.statement,
    }));
  if (cmd === 'json') {
    download(`graph-${datasetCode}.json`, JSON.stringify(triples, null, 2), 'application/json');
    return;
  }
  toCsv(
    `graph-${datasetCode}.csv`,
    ['subject', 'predicate', 'object', 'confidence', 'corroborateCount', 'statement'],
    triples.map((t) => [t.subject, t.predicate, t.object, t.confidence, t.corroborateCount, t.statement]),
  );
}

async function load() {
  loading.value = true;
  try {
    data.value = await datasetGraphApi.get(datasetCode, 120);
    selected.value = null;
    widenedIds.clear();
    render();
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

const onResize = () => network?.redraw();

onMounted(async () => {
  await load();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  network?.destroy();
  network = null;
});
</script>

<style scoped>
.graph-page {
  min-height: 100vh;
  background: #f7f8fa;
}
.graph-page.dark {
  background: #0d1117;
  color: #e6edf3;
}
.site {
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.graph-page.dark .site {
  background: #161b22;
  border-color: #30363d;
}
.wrap {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 20px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
}
.brand .logo {
  font-size: 15px;
  font-weight: 600;
}
.brand .sub {
  margin-left: 10px;
  font-size: 12px;
  color: #8a97a5;
}
nav {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
}
nav a {
  color: #5470c6;
  text-decoration: none;
}
.theme {
  border: 1px solid #d0d7de;
  background: none;
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
  color: inherit;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 14px 0;
}
/* ---- 原生控件样式（替代 Element Plus 组件，保持原观感）---- */
.gp-search {
  position: relative;
  display: inline-block;
}
.gp-input {
  width: 200px;
  height: 30px;
  padding: 0 24px 0 10px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #fff;
  font-size: 13px;
  color: inherit;
  outline: none;
}
.gp-input:focus {
  border-color: #409eff;
}
.gp-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  line-height: 16px;
  text-align: center;
  border: none;
  border-radius: 50%;
  background: #dfe3e8;
  color: #4e5969;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.gp-select {
  height: 30px;
  padding: 0 6px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #fff;
  font-size: 13px;
  color: inherit;
  outline: none;
}
.gp-select.sm {
  height: 28px;
  width: 150px;
}
.gp-btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #fff;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.gp-btn:hover {
  background: #f2f6fc;
}
.gp-btn.on {
  background: #409eff;
  border-color: #409eff;
  color: #fff;
}
.gp-btn.sm {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.gp-btn-group {
  display: inline-flex;
}
.gp-btn-group .gp-btn {
  border-radius: 0;
  margin-left: -1px;
}
.gp-btn-group .gp-btn:first-child {
  border-radius: 4px 0 0 4px;
  margin-left: 0;
}
.gp-btn-group .gp-btn:last-child {
  border-radius: 0 4px 4px 0;
}
.gp-btn-group .gp-btn:hover,
.gp-btn-group .gp-btn.on {
  position: relative;
  z-index: 1;
}
.gp-pop-wrap {
  position: relative;
  display: inline-block;
}
.gp-pop {
  position: absolute;
  left: 0;
  top: 34px;
  z-index: 30;
  width: 320px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
.gp-menu {
  position: absolute;
  left: 0;
  top: 34px;
  z-index: 30;
  min-width: 170px;
  padding: 4px 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
.gp-menu-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: none;
  text-align: left;
  font-size: 13px;
  color: inherit;
  cursor: pointer;
}
.gp-menu-item:hover {
  background: #f2f6fc;
}
.gp-range {
  width: 100%;
  accent-color: #409eff;
}
.gp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8a97a5;
  font-size: 13px;
  pointer-events: none;
}
.gp-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.6);
  color: #4e5969;
  font-size: 13px;
  z-index: 20;
}
/* 深色主题 */
.graph-page.dark .gp-input,
.graph-page.dark .gp-select,
.graph-page.dark .gp-btn,
.graph-page.dark .gp-pop,
.graph-page.dark .gp-menu {
  background: #161b22;
  border-color: #30363d;
  color: #e6edf3;
}
.graph-page.dark .gp-btn:hover,
.graph-page.dark .gp-menu-item:hover {
  background: #21262d;
}
.graph-page.dark .gp-clear {
  background: #30363d;
  color: #c9d1d9;
}
.graph-page.dark .gp-loading {
  background: rgba(13, 17, 23, 0.6);
  color: #c9d1d9;
}
.graph-page.dark .gp-empty {
  color: #8b949e;
}
.muted {
  color: #8a97a5;
  font-size: 12px;
}
.phys-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.phys-row label {
  display: block;
  font-size: 12px;
  color: #4e5969;
  margin-bottom: 4px;
}
.phys-panel-btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.indirect-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.indirect-chip {
  font-size: 12px;
  color: #5470c6;
  background: #eef2ff;
  border: 1px solid #d0d7de;
  border-radius: 10px;
  padding: 1px 8px;
  cursor: pointer;
}
.indirect-chip:hover {
  background: #e0e7ff;
}
.body {
  display: flex;
  gap: 14px;
  align-items: stretch;
  padding-bottom: 20px;
}
.canvas-card {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.graph-page.dark .canvas-card {
  background: #0d1117;
  border-color: #30363d;
}
.graph {
  width: 100%;
  height: calc(100vh - 190px);
  min-height: 520px;
}
.side {
  width: 320px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 14px;
  max-height: calc(100vh - 190px);
  overflow: auto;
}
.graph-page.dark .side {
  background: #161b22;
  border-color: #30363d;
}
.side-title {
  margin: 0 0 8px;
  font-size: 16px;
}
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 10px;
  background: #eef2ff;
  color: #5470c6;
}
.tag.concept {
  background: #f0f1f3;
  color: #5b6672;
}
.tag.plain {
  background: #f3f4f6;
  color: #4e5969;
}
.lede {
  font-size: 13px;
  color: #4e5969;
  line-height: 1.6;
  margin: 8px 0;
}
.graph-page.dark .lede {
  color: #9aa4b2;
}
.archive-link {
  font-size: 13px;
  color: #5470c6;
  text-decoration: none;
}
.side-sec {
  margin-top: 14px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 10px;
}
.graph-page.dark .side-sec {
  border-color: #30363d;
}
.sec-head {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.rels {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}
.rels li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid #f2f3f5;
}
.graph-page.dark .rels li {
  border-color: #21262d;
}
.rel-node {
  color: #5470c6;
  text-decoration: none;
}
.rel-label {
  color: #3ba272;
}
.rel-label.rev {
  color: #fc8452;
}
.rel-dir {
  margin-left: auto;
  color: #8a97a5;
  font-size: 12px;
}
.path-row {
  display: flex;
  gap: 8px;
}
.path-row select {
  flex: 1;
  min-width: 0;
  height: 28px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: none;
  color: inherit;
  padding: 0 6px;
}
.path-text {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  color: #3ba272;
  word-break: break-all;
}
.side-empty {
  color: #8a97a5;
  font-size: 13px;
  line-height: 1.7;
}
.panel {
  position: absolute;
  right: 14px;
  top: 14px;
  z-index: 20;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  padding: 10px 12px;
  font-size: 13px;
  max-height: 60%;
  overflow: auto;
  min-width: 160px;
}
.graph-page.dark .panel {
  background: #161b22;
  border-color: #30363d;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-weight: 600;
}
.panel .x {
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: inherit;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  cursor: pointer;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.row .name {
  flex: 1;
}
.row .size {
  color: #8a97a5;
}
.panel-toggle {
  position: absolute;
  right: 14px;
  top: 14px;
  z-index: 20;
  border: 1px solid #d0d7de;
  background: #f6f8fa;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  color: inherit;
}
</style>