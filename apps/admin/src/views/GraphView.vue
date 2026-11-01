<template>
  <div class="page" :class="{ dark }">
    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar">
        <el-select v-model="datasetId" placeholder="全部语料域" clearable style="width: 160px" @change="reload">
          <el-option v-for="d in datasets" :key="d.id" :label="d.name" :value="d.id" />
        </el-select>

        <el-select
          v-model="centerId"
          filterable
          remote
          clearable
          reserve-keyword
          placeholder="搜索实体/概念作为中心点"
          :remote-method="searchNodes"
          :loading="searching"
          style="width: 250px"
          @change="onCenterChange"
        >
          <el-option v-for="n in nodeHits" :key="n.id" :label="hitLabel(n)" :value="n.id" />
        </el-select>

        <el-select v-model="filter.predicate" placeholder="全部谓词" clearable style="width: 140px" @change="reload">
          <el-option v-for="p in predicates" :key="p.predicate" :label="`${p.label}（${p.count}）`" :value="p.predicate" />
        </el-select>

        <el-select v-model="filter.depth" style="width: 100px" @change="reload">
          <el-option label="一跳" :value="1" />
          <el-option label="两跳" :value="2" />
          <el-option label="三跳" :value="3" />
        </el-select>

        <el-select v-model="filter.direction" style="width: 110px" @change="reload">
          <el-option label="双向" value="both" />
          <el-option label="只看出边" value="out" />
          <el-option label="只看入边" value="in" />
        </el-select>

        <el-select v-model="filter.minConfidence" style="width: 130px" @change="reload">
          <el-option label="不限置信度" :value="0" />
          <el-option label="≥ 0.8" :value="0.8" />
          <el-option label="≥ 0.9" :value="0.9" />
        </el-select>

        <el-button @click="reload">刷新</el-button>
        <el-button text @click="resetCenter">回概览</el-button>
        <el-button :type="showAll ? 'primary' : ''" @click="toggleShowAll">{{ showAll ? '显示抽样' : '显示全部' }}</el-button>
        <el-button type="primary" plain @click="relDrawer = true">关系明细（{{ relTotal }}）</el-button>
      </div>

      <div class="toolbar second">
        <el-button-group>
          <el-button :type="physics ? 'primary' : ''" @click="setPhysics(!physics)">布局</el-button>
          <el-button :type="labels ? 'primary' : ''" @click="setLabels(!labels)">节点标签</el-button>
          <el-button :type="edgeLabels === 'all' ? 'primary' : ''" @click="cycleEdgeLabels()">
            边标签：{{ EDGE_LABEL_TEXT[edgeLabels] }}
          </el-button>
          <el-button @click="network?.fit({ animation: true })">适应</el-button>
        </el-button-group>
        <el-button :type="legendOpen ? 'primary' : ''" @click="legendOpen = !legendOpen">图例过滤</el-button>
        <el-button :type="statsOpen ? 'primary' : ''" @click="statsOpen = !statsOpen">统计</el-button>
        <el-button :type="physicsOpen ? 'primary' : ''" @click="physicsOpen = !physicsOpen">力学参数</el-button>
        <el-button @click="dark = !dark">{{ dark ? '浅色' : '深色' }}</el-button>
        <el-dropdown trigger="click" @command="onExport">
          <el-button>导出 ▾</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="png">PNG 图片</el-dropdown-item>
              <el-dropdown-item command="json">JSON（可见三元组）</el-dropdown-item>
              <el-dropdown-item command="csv">CSV（可见三元组）</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <span class="muted">节点 {{ visibleCount.nodes }} · 关系 {{ visibleCount.edges }}</span>
      </div>
    </el-card>

    <div class="body">
      <el-card shadow="never" class="graph-card" v-loading="loading">
        <div ref="graphEl" class="graph"></div>
        <el-empty
          v-if="!loading && !graph.edges.length"
          description="暂无关系数据：先到「生产线」跑批抽取，再到「发现审核」通过关系草稿"
          :image-size="70"
        />

        <div v-if="legendOpen" class="panel legend">
          <div class="panel-head">
            <span>类别 / 节点类型</span>
            <button class="x" @click="legendOpen = false">×</button>
          </div>
          <label v-for="c in legendCategories" :key="c.name" class="row">
            <input type="checkbox" :checked="!hiddenCategories.has(c.name)" @change="toggleCategory(c.name)" />
            <span class="dot" :style="{ background: c.color }"></span>
            <span class="name">{{ c.name }}</span>
            <span class="size">{{ c.count }}</span>
          </label>
          <div class="row types">
            <span class="name">节点类型</span>
          </div>
          <label v-for="t in legendTypes" :key="t.type" class="row">
            <input type="checkbox" :checked="!hiddenTypes.has(t.type)" @change="toggleType(t.type)" />
            <span class="glyph">{{ t.type === 'concept' ? '◆' : '●' }}</span>
            <span class="name">{{ t.label }}</span>
            <span class="size">{{ t.count }}</span>
          </label>
          <div class="control">
            <span>最小连接数</span>
            <input type="range" min="1" :max="maxDegree" v-model.number="minDegree" />
            <span>{{ minDegree }}</span>
          </div>
        </div>

        <div v-if="statsOpen" class="panel stats">
          <div class="panel-head">
            <span>统计</span>
            <button class="x" @click="statsOpen = false">×</button>
          </div>
          <table>
            <tr v-for="r in statsRows" :key="r.k"><td>{{ r.k }}</td><td>{{ r.v }}</td></tr>
          </table>
        </div>

        <div v-if="physicsOpen" class="panel physics">
          <div class="panel-head">
            <span>力学参数</span>
            <button class="x" @click="physicsOpen = false">×</button>
          </div>
          <label>求解器
            <select v-model="physicsCfg.solver">
              <option value="forceAtlas2Based">Force Atlas 2</option>
              <option value="barnesHut">Barnes-Hut</option>
              <option value="repulsion">Repulsion</option>
            </select>
          </label>
          <label>引力常数 {{ physicsCfg.gravitationalConstant }}
            <input type="range" min="-300" max="0" step="1" v-model.number="physicsCfg.gravitationalConstant" />
          </label>
          <label>中心引力 {{ physicsCfg.centralGravity }}
            <input type="range" min="0" max="1" step="0.01" v-model.number="physicsCfg.centralGravity" />
          </label>
          <label>弹簧长度 {{ physicsCfg.springLength }}
            <input type="range" min="10" max="500" step="5" v-model.number="physicsCfg.springLength" />
          </label>
          <label>弹簧刚度 {{ physicsCfg.springConstant }}
            <input type="range" min="0" max="0.5" step="0.005" v-model.number="physicsCfg.springConstant" />
          </label>
          <div class="control">
            <el-button size="small" type="primary" @click="applyPhysics">应用</el-button>
            <el-button size="small" @click="resetPhysics">重置</el-button>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="side-card">
        <template #header>
          <div class="side-head">
            <span>节点详情</span>
            <span v-if="node">
              <el-button size="small" type="primary" link @click="focusNode(node.id)">以此为中心</el-button>
              <el-button v-if="archiveHref" size="small" type="primary" link @click="openArchive">档案页</el-button>
            </span>
          </div>
        </template>
        <template v-if="node">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="名称">
              {{ node.name }}
              <el-button v-if="node.nodeType === 'concept'" link type="primary" size="small" style="margin-left:8px" @click="renameNode">
                改名
              </el-button>
            </el-descriptions-item>
            <el-descriptions-item label="类型">
              <el-tag size="small" :type="node.nodeType === 'concept' ? 'warning' : 'success'" effect="plain">
                {{ node.nodeType === 'concept' ? '概念' : '实体' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="类别">{{ node.categoryName ?? '-' }}</el-descriptions-item>
            <el-descriptions-item v-if="node.nodeType === 'entity'" label="状态">
              {{ STATUS_TEXT[node.status] ?? node.status }}
            </el-descriptions-item>
            <el-descriptions-item label="连接数">{{ degreeOf(node.id) }}</el-descriptions-item>
            <el-descriptions-item label="简介">{{ node.lede ?? '-' }}</el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">关联关系（{{ nodeEdges.length }}）</el-divider>
          <div class="rel-list">
            <div v-for="row in nodeEdges" :key="row.id" class="rel-item">
              <div class="rel-main">
                <span class="rel-dir" :class="{ tm: row.tail === node!.id }">{{ row.head === node!.id ? '顺' : '逆' }}</span>
                <span class="rel-arc">
                  <span class="muted-sm rel-name">{{ neighborName(row, 'head') }}</span>
                  <el-tag size="small" class="rel-pred">{{ row.label }}</el-tag>
                  <span class="muted-sm rel-name">{{ neighborName(row, 'tail') }}</span>
                </span>
                <span class="rel-conf">{{ row.confidence.toFixed(2) }}</span>
                <el-dropdown trigger="click" @command="(cmd: string) => onRelAction(cmd, row, 'node')">
                  <el-button link type="primary" size="small">操作 ▾</el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="focus">以另一侧为中心</el-dropdown-item>
                      <el-dropdown-item command="reverse">反转方向</el-dropdown-item>
                      <el-dropdown-item command="edit">修改关系名</el-dropdown-item>
                      <el-dropdown-item command="del" divided>删除关系</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div v-if="quoteShown.has(row.id) && row.quote" class="rel-quote">
                「{{ row.quote }}」
                <span v-if="row.verifyStatus" class="verify-tag" :class="row.verifyStatus">{{ verbLabelZH[row.verifyStatus] }}</span>
                <el-button link type="primary" size="small" @click="toggleQuote(row.id)">收起</el-button>
              </div>
              <el-button v-else link type="primary" size="small" :disabled="!row.quote" class="quote-toggle" @click="toggleQuote(row.id)">
                {{ row.quote ? '查看引句' : '无引句' }}
              </el-button>
            </div>
          </div>

          <el-divider content-position="left">到其它节点的路径</el-divider>
          <div class="path-form">
            <el-select v-model="pathTarget" filterable clearable placeholder="选目标节点" size="small" style="flex: 1">
              <el-option v-for="n in graph.nodes" :key="n.id" :label="n.name" :value="n.id" />
            </el-select>
            <el-button size="small" type="primary" @click="runPath">查找</el-button>
          </div>
          <div v-if="pathResult" class="path-result">
            <div v-if="!pathSteps.length" class="muted-sm">{{ pathResult }}</div>
            <div v-else>
              <div class="muted-sm">{{ pathSteps.length }} 步</div>
              <div v-for="(st, i) in pathSteps" :key="i" class="path-step" @click="focusNode(st.to)">
                <span>{{ nodeName(st.from) }}</span>
                <span class="pred">→ {{ st.label }} →</span>
                <span>{{ nodeName(st.to) }}</span>
              </div>
            </div>
          </div>
        </template>
        <el-empty v-else description="点击图中的节点查看详情" :image-size="60" />
      </el-card>
    </div>

    <el-drawer v-model="relDrawer" title="关系明细" size="62%" @open="loadRelations(1)">
      <el-form :inline="true" class="filters">
        <el-form-item>
          <el-input v-model="relFilter.keyword" placeholder="关键词（尾实体/陈述）" clearable style="width: 220px" />
        </el-form-item>
        <el-form-item>
          <el-select v-model="relFilter.predicate" placeholder="全部谓词" clearable style="width: 160px">
            <el-option v-for="p in predicates" :key="p.predicate" :label="p.label" :value="p.predicate" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadRelations(1)">查询</el-button>
        </el-form-item>
      </el-form>
      <el-table :data="relations" border stripe size="small" v-loading="relLoading">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="头实体" min-width="140">
          <template #default="{ row }">{{ row.headName ?? `#${row.head}` }}</template>
        </el-table-column>
        <el-table-column label="关系" width="110">
          <template #default="{ row }">
            <el-tag size="small">{{ row.label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="尾节点" min-width="150">
          <template #default="{ row }">
            {{ row.tailName ?? row.tailText }}
            <el-tag v-if="!row.tailName && row.tail" size="small" type="warning" effect="plain">新候选</el-tag>
            <el-tag v-else-if="row.tail < 0" size="small" type="info" effect="plain">概念</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="statement" label="陈述" min-width="220" show-overflow-tooltip />
        <el-table-column label="置信度" width="80">
          <template #default="{ row }">{{ row.confidence.toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="corroborateCount" label="印证次数" width="90" />
        <el-table-column prop="firstSeenAt" label="首次入图" width="160" :formatter="timeFmt" />
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-button link type="warning" @click="reverse(row)">反转</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        class="mt"
        size="small"
        background
        layout="prev, total, next"
        :total="relTotal"
        :page-size="relPageSize"
        :current-page="relPage"
        @current-change="(p: number) => loadRelations(p)"
      />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { DataSet, Network } from 'vis-network/standalone';
import type { Edge as VisEdge, Node as VisNode, Options as VisOptions } from 'vis-network/standalone';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  datasetApi,
  graphApi,
  type EntityGraph,
  type GraphEdge,
  type GraphNodeHit,
  type GraphNode,
  type RelationPredicateRow,
  type RelationRow,
} from '@/api';
import { download, toCsv, toPng } from '@/utils/export';
import { publicUrl } from '@/utils/publicUrl';

const STATUS_TEXT: Record<string, string> = { draft: '草稿', published: '已发布', archived: '归档' };
/** 引句逐字回查状态中文 */
const verbLabelZH: Record<string, string> = { pending: '待核验', passed: '引句PASS', failed: '引句FAIL' };
const PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
/** 概念节点统一用中性色，与实体的类别着色区分 */
const CONCEPT_COLOR = '#8a97a5';
const EDGE_LABEL_TEXT: Record<EdgeLabelMode, string> = { all: '全部', none: '隐藏', selection: '选中时' };
type EdgeLabelMode = 'all' | 'none' | 'selection';

const datasets = ref<{ id: number; name: string }[]>([]);
const datasetId = ref<number | undefined>();
const predicates = ref<RelationPredicateRow[]>([]);
const nodeHits = ref<GraphNodeHit[]>([]);
const searching = ref(false);
const centerId = ref<number | undefined>();
const filter = reactive<{ depth: number; direction: 'both' | 'out' | 'in'; minConfidence: number; predicate?: string }>({
  depth: 1,
  direction: 'both',
  minConfidence: 0,
});
const graph = ref<EntityGraph>({ center: 0, depth: 1, direction: 'both', nodes: [], edges: [] });
/** 全量概览开关：on = 显示全部节点/边（limit 放大），off = 抽样概览（前 60） */
const showAll = ref(false);
const loading = ref(false);
const graphEl = ref<HTMLDivElement | null>(null);
const selected = ref<number | null>(null);

// 显示开关
const dark = ref(false);
const labels = ref(true);
const edgeLabels = ref<EdgeLabelMode>('all');
const physics = ref(false);
const legendOpen = ref(false);
const statsOpen = ref(false);
const physicsOpen = ref(false);
const hiddenCategories = ref(new Set<string>());
const hiddenTypes = ref(new Set<'entity' | 'concept'>());
const minDegree = ref(1);
const physicsCfg = reactive({ solver: 'forceAtlas2Based', gravitationalConstant: -212, centralGravity: 0.02, springLength: 130, springConstant: 0.05 });

const pathTarget = ref<number | undefined>();
const pathSteps = ref<{ from: number; to: number; label: string }[]>([]);
const pathResult = ref('');

const relFilter = reactive<{ keyword: string; predicate?: string }>({ keyword: '' });
const relations = ref<RelationRow[]>([]);
const relTotal = ref(0);
const relPage = ref(1);
const relPageSize = ref(20);
const relLoading = ref(false);
const relDrawer = ref(false);

let network: Network | null = null;
let visNodes = new DataSet<VisNode>([]);
let visEdges = new DataSet<VisEdge>([]);
/** 关系 id → 画布边 id（同向多条边合并成一条，标签带 +N） */
let visualOf = new Map<number, string>();
/** 画布边 id → 该边承载的关系（tooltip / 路径用） */
let membersOf = new Map<string, GraphEdge[]>();

const node = computed(() => graph.value.nodes.find((n) => n.id === selected.value) ?? null);
const nodeById = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n])));
const nodeEdges = computed(() => graph.value.edges.filter((e) => e.head === selected.value || e.tail === selected.value));
const nodeName = (id: number) => nodeById.value.get(id)?.name ?? `#${id}`;
const neighborName = (e: GraphEdge, side: 'head' | 'tail') => nodeName(side === 'head' ? e.head : e.tail);
const timeFmt = (_row: unknown, _col: unknown, v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-');
const hitLabel = (n: GraphNodeHit) => `${n.name}（${n.nodeType === 'concept' ? '概念' : (n.categoryName ?? '实体')}）`;

const archiveHref = computed(() => {
  const n = node.value;
  return n?.nodeType === 'entity' && n.slug && n.datasetCode
    ? publicUrl(`/archive/${encodeURIComponent(n.datasetCode)}/${encodeURIComponent(n.slug)}`)
    : '';
});

/** 节点度数（按当前子图统计） */
const degreeMap = computed(() => {
  const deg = new Map<number, number>();
  for (const e of graph.value.edges) {
    deg.set(e.head, (deg.get(e.head) ?? 0) + 1);
    deg.set(e.tail, (deg.get(e.tail) ?? 0) + 1);
  }
  return deg;
});
const degreeOf = (id: number) => degreeMap.value.get(id) ?? 0;
const maxDegree = computed(() => Math.max(1, ...degreeMap.value.values()));

const categoryColor = (n: GraphNode) => {
  if (n.nodeType === 'concept') return CONCEPT_COLOR;
  const cats = [...new Set(graph.value.nodes.filter((x) => x.nodeType === 'entity').map((x) => x.categoryName ?? '未分类'))];
  return PALETTE[cats.indexOf(n.categoryName ?? '未分类') % PALETTE.length];
};
const legendCategories = computed(() => {
  const map = new Map<string, number>();
  for (const n of graph.value.nodes) {
    const k = n.nodeType === 'concept' ? '概念' : (n.categoryName ?? '未分类');
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({
    name,
    count,
    color: name === '概念' ? CONCEPT_COLOR : PALETTE[[...new Set(graph.value.nodes.filter((x) => x.nodeType === 'entity').map((x) => x.categoryName ?? '未分类'))].indexOf(name) % PALETTE.length],
  }));
});
const legendTypes = computed(() => [
  { type: 'entity' as const, label: '实体', count: graph.value.nodes.filter((n) => n.nodeType === 'entity').length },
  { type: 'concept' as const, label: '概念', count: graph.value.nodes.filter((n) => n.nodeType === 'concept').length },
]);
const visibleCount = computed(() => ({
  nodes: graph.value.nodes.filter((n) => !isNodeHidden(n)).length,
  edges: graph.value.edges.length,
}));
const statsRows = computed(() => [
  { k: '节点', v: `${visibleCount.value.nodes} / ${graph.value.nodes.length}` },
  { k: '关系', v: String(graph.value.edges.length) },
  { k: '实体', v: String(graph.value.nodes.filter((n) => n.nodeType === 'entity').length) },
  { k: '概念', v: String(graph.value.nodes.filter((n) => n.nodeType === 'concept').length) },
  { k: '类别', v: String(legendCategories.value.length) },
]);

const isNodeHidden = (n: GraphNode) => {
  const key = n.nodeType === 'concept' ? '概念' : (n.categoryName ?? '未分类');
  return hiddenCategories.value.has(key) || hiddenTypes.value.has(n.nodeType) || degreeOf(n.id) < minDegree.value;
};

/**
 * 星型摊开布局：中心节点固定圆心，其余节点按「谓词分组」等角分布在圆周上（同谓词的
 * 邻居相邻排列），从根本上避免节点/长标签在力导向初始化时挤成一团。无中心（概览）
 * 时退化为全员圆周排布。返回 nodeId → 归一化坐标（centered at 0,0，半径 1）。
 */
function starPositions(): Map<number, { x: number; y: number }> {
  const pos = new Map<number, { x: number; y: number }>();
  const center = selected.value ?? pageCenter();
  const relBy = new Map<string, { node: number }[]>();
  if (center != null) {
    pos.set(center, { x: 0, y: 0 });
    // 以中心为边相交点的谓词分组（同一谓词的邻居放同一弧段）
    for (const e of graph.value.edges) {
      const isHead: boolean = e.head === center;
      const isTail: boolean = e.tail === center;
      if (!isHead && !isTail) continue; // 不与该中心相邻的边忽略
      const other: number = isHead ? e.tail : e.head;
      if (other == null || other === center) continue;
      const arr = relBy.get(e.label) ?? [];
      arr.push({ node: other });
      relBy.set(e.label, arr);
    }
  }

  const n = graph.value.nodes.length;
  // 圆周排列序号：先中心，再各谓词组（组内按原边序），未与该中心直接相连的多跳远点放末尾兜底
  const order: number[] = [];
  const seen = new Set<number>(order);
  if (center != null) {
    seen.add(center);
    for (const [, members] of relBy) for (const m of members) if (!seen.has(m.node)) { seen.add(m.node); order.push(m.node); }
    for (const nd of graph.value.nodes) if (!seen.has(nd.id)) { seen.add(nd.id); order.push(nd.id); }
  } else {
    for (const nd of graph.value.nodes) { seen.add(nd.id); order.push(nd.id); }
  }

  const total = order.length || 1;
  const gap = 0.04; // 弧段间隔，避免组边界标签粘连
  const step = (2 * Math.PI * (1 - Math.min(gap * Math.max(relBy.size + 1, 4), 0.5))) / total;
  let angle = -Math.PI / 2;
  order.forEach((id, i) => {
    const a = angle + (i * step + step / 2);
    pos.set(id, { x: Math.cos(a), y: Math.sin(a) });
  });
  return pos;
}

/** 当前中心实体 id（有聚焦时返回，否则 null） */
function pageCenter(): number | null {
  const c = graph.value.center;
  return c && c > 0 ? c : null;
}

/**
 * 画布渲染：节点按度数定大小（概念为菱形），同向多条边合并为一条（标签带 +N，
 * 线宽随印证次数），一切样式（透明度/字号/线宽）都由 refreshStyles 统一驱动。
 */
function render() {
  const star = starPositions();
  const R = 320; // 星型半径（像素）：中心实体在圆点，邻居沿圆周摊开
  const center = selected.value ?? pageCenter();
  const visNodeList: VisNode[] = graph.value.nodes.map((n) => {
    const p = star.get(n.id);
    return {
      id: n.id,
      label: n.name,
      shape: n.nodeType === 'concept' ? 'diamond' : 'dot',
      x: (p?.x ?? 0) * R,
      y: (p?.y ?? 0) * R,
      // 中心实体固定在圆点，使布局呈星型；其余节点由物理引擎在预设位置附近微调
      physics: n.id === center ? false : true,
      fixed: n.id === center ? { x: true, y: true } : false,
      size: 14 + Math.min(degreeOf(n.id), 20) * 1.3,
      color: {
        background: categoryColor(n),
        border: n.nodeType === 'entity' && n.status !== 'published' ? '#f56c6c' : undefined,
      },
      borderWidth: n.nodeType === 'entity' && n.status !== 'published' ? 2 : 1,
      borderDashes: n.nodeType === 'concept' ? [4, 3] : false,
      title: tooltipOf(n),
    };
  });

  // 同向多条边合并：并行边在图上会叠成一团，合并后 label 记 +N
  const groups = new Map<string, GraphEdge[]>();
  for (const e of graph.value.edges) {
    const key = `${e.head}\u0000${e.tail}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const visEdgeList: VisEdge[] = [];
  visualOf = new Map();
  membersOf = new Map();
  const pairSet = new Set([...groups.keys()]);
  let seq = 0;
  for (const [key, members] of groups) {
    const id = `v${seq++}`;
    const first = members[0];
    const labels = [...new Set(members.map((m) => m.label))];
    for (const m of members) visualOf.set(m.id, id);
    membersOf.set(id, members);
    const [from, to] = key.split('\u0000').map(Number);
    visEdgeList.push({
      id,
      from,
      to,
      label: labels[0] + (members.length > 1 ? ` +${members.length - 1}` : ''),
      arrows: 'to',
      width: 1 + Math.min(Math.max(...members.map((m) => m.corroborateCount)), 3) * 0.6,
      title: members
        .map(
          (m) =>
            `${m.statement ?? `${nodeName(m.head)} ${m.label} ${nodeName(m.tail)}`}` +
            (m.quote ? `\n引句：「${m.quote}」` : '') +
            (m.evidenceCode ? `\n证据：${m.evidenceCode}${m.verifyStatus ? ` · ${verbLabelZH[m.verifyStatus] ?? m.verifyStatus}` : ''}` : ''),
        )
        .join('\n\n'),
      // 双向成对时用曲线，避免两条边重合
      smooth: pairSet.has(`${to}\u0000${from}`) ? { enabled: true, type: 'curvedCW', roundness: 0.15 } : false,
    });
  }

  visNodes = new DataSet<VisNode>(visNodeList);
  visEdges = new DataSet<VisEdge>(visEdgeList);

  const options: VisOptions = {
    autoResize: true,
    physics: physicsOptions(),
    interaction: { hover: true, navigationButtons: true, keyboard: false, tooltipDelay: 150, multiselect: false },
    nodes: { font: { size: 14, strokeWidth: 0 } },
    edges: { selectionWidth: 2, font: { size: 11, strokeWidth: 3 } },
    layout: { improvedLayout: true },
  };

  network?.destroy();
  if (!graphEl.value) return;
  network = new Network(graphEl.value, { nodes: visNodes, edges: visEdges }, options);
  // 星型布局依赖预设坐标，稳定后仅做一次边界校正（包裹所有节点），不强制缩放从而保留长标签可读
  let didFit = false;
  network.on('stabilizationIterationsDone', () => {
    if (!didFit) {
      didFit = true;
      network?.fit({ animation: false, maxZoomLevel: 1 });
    }
  });
  network.on('click', (params) => {
    const nodes = (params as { nodes: number[] }).nodes;
    if (nodes.length) selectNode(Number(nodes[0]));
    else clearSelection();
  });
  network.on('doubleClick', (params) => {
    const nodes = (params as { nodes: number[] }).nodes;
    if (nodes.length) network?.focus(Number(nodes[0]), { scale: 1.6, animation: true });
  });
  refreshStyles();
}

function tooltipOf(n: GraphNode): string {
  const lines = [n.name];
  lines.push(`类型：${n.nodeType === 'concept' ? '概念' : '实体'}`);
  if (n.categoryName) lines.push(`类别：${n.categoryName}`);
  if (n.lede) lines.push(n.lede);
  return lines.join('\n');
}

function physicsOptions(): VisOptions['physics'] {
  const { solver, centralGravity, springLength, springConstant, gravitationalConstant } = physicsCfg;
  const spring = { centralGravity, springLength, springConstant };
  return {
    enabled: physics.value,
    solver: solver as 'forceAtlas2Based',
    stabilization: { iterations: 300 },
    [solver]: solver === 'repulsion' ? { ...spring, nodeDistance: Math.abs(gravitationalConstant) } : { ...spring, gravitationalConstant },
  };
}

/** 选中/路径/最小连接数等所有样式变化都收敛到这里，避免多处 setOptions 打架 */
function refreshStyles() {
  if (!network) return;
  const nodeColor = dark.value ? '#e6edf3' : '#1f2328';
  const edgeColor = dark.value ? '#f0c000' : '#333333';
  const stroke = dark.value ? '#0d1117' : '#ffffff';

  let focusNodes: Set<number> | null = null;
  let focusEdges: Set<string> | null = null;
  let onPath = false;
  if (pathSteps.value.length) {
    focusNodes = new Set([pathSteps.value[0].from, ...pathSteps.value.map((s) => s.to)]);
    focusEdges = new Set(pathSteps.value.map((s) => `${s.from}\u0000${s.to}`));
    onPath = true;
  } else if (selected.value != null) {
    const ids = new Set<number>([selected.value]);
    const edges = new Set<string>();
    for (const e of graph.value.edges) {
      if (e.head === selected.value || e.tail === selected.value) {
        ids.add(e.head);
        ids.add(e.tail);
        edges.add(visualOf.get(e.id) ?? '');
      }
    }
    focusNodes = ids;
    focusEdges = edges;
  }
  const focused = focusNodes !== null;

  const hiddenNodes = new Set<number>(graph.value.nodes.filter((n) => isNodeHidden(n)).map((n) => n.id));
  // 标签自适应：节点越密字号越小，避免长名称相互覆盖（聚焦时仍放大到 15）
  const visibleN = graph.value.nodes.length - hiddenNodes.size;
  const fontSize = focused ? 15 : visibleN > 40 ? 9 : visibleN > 20 ? 11 : 14;
  visNodes.update(
    visNodes.get().map((n) => {
      const id = Number(n.id);
      const on = !focused || focusNodes!.has(id);
      return {
        id,
        hidden: hiddenNodes.has(id),
        opacity: on ? 1 : 0.15,
        font: { color: nodeColor, size: labels.value && on ? fontSize : 0, strokeWidth: 0 },
      };
    }),
  );
  visEdges.update(
    visEdges.get().map((e) => {
      const members = membersOf.get(String(e.id)) ?? [];
      const on = !focused || focusEdges!.has(String(e.id));
      const hidden = members.length > 0 && members.every((m) => hiddenNodes.has(m.head) || hiddenNodes.has(m.tail));
      const showLabel = edgeLabels.value !== 'none' && on && (edgeLabels.value === 'all' || focused);
      let color: VisEdge['color'] = edgeColor;
      let width = 1 + Math.min(Math.max(0, ...members.map((m) => m.corroborateCount)), 3) * 0.6;
      if (focused && !on) color = { color: '#999999', opacity: 0.08 };
      else if (onPath && on) {
        color = '#f5a623';
        width = 3;
      } else if (focused && on) width = 2;
      return { id: e.id, hidden, color, width, font: { size: showLabel ? 11 : 0, color: edgeColor, strokeColor: stroke, strokeWidth: 3 } };
    }),
  );
}

function selectNode(id: number) {
  selected.value = id;
  pathSteps.value = [];
  pathResult.value = '';
  pathTarget.value = undefined;
  refreshStyles();
  network?.selectNodes([id]);
  network?.focus(id, { scale: Math.max(network.getScale(), 1.2), animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
}

function clearSelection() {
  selected.value = null;
  pathSteps.value = [];
  pathResult.value = '';
  network?.unselectAll();
  refreshStyles();
}

function setLabels(on: boolean) {
  labels.value = on;
  refreshStyles();
}

function cycleEdgeLabels() {
  edgeLabels.value = { all: 'none', none: 'selection', selection: 'all' }[edgeLabels.value] as EdgeLabelMode;
  refreshStyles();
}

function setPhysics(on: boolean) {
  physics.value = on;
  network?.setOptions({ physics: physicsOptions() });
  if (on) network?.startSimulation();
  else network?.stopSimulation();
}

function applyPhysics() {
  network?.setOptions({ physics: physicsOptions() });
  setPhysics(true);
}

function resetPhysics() {
  Object.assign(physicsCfg, {
    solver: 'forceAtlas2Based',
    gravitationalConstant: -212,
    centralGravity: 0.02,
    springLength: 130,
    springConstant: 0.05,
  });
  applyPhysics();
}

function toggleCategory(name: string) {
  const s = new Set(hiddenCategories.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  hiddenCategories.value = s;
  refreshStyles();
}

function toggleType(t: 'entity' | 'concept') {
  const s = new Set(hiddenTypes.value);
  if (s.has(t)) s.delete(t);
  else s.add(t);
  hiddenTypes.value = s;
  refreshStyles();
}

/** 在已加载子图内做 BFS 最短路（跨数据集的全图最短路不在前端承诺） */
function runPath() {
  const from = selected.value;
  const to = pathTarget.value;
  if (from == null || to == null) return;
  if (from === to) {
    pathResult.value = '起点与终点相同';
    pathSteps.value = [];
    return;
  }
  const adj = new Map<number, { node: number; label: string }[]>();
  const push = (a: number, b: number, label: string) => {
    const arr = adj.get(a) ?? [];
    arr.push({ node: b, label });
    adj.set(a, arr);
  };
  for (const e of graph.value.edges) {
    push(e.head, e.tail, e.label);
    push(e.tail, e.head, e.label);
  }
  const prev = new Map<number, { from: number; label: string }>();
  const seen = new Set<number>([from]);
  const queue = [from];
  let found = false;
  while (queue.length && !found) {
    const cur = queue.shift() as number;
    for (const { node: next, label } of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { from: cur, label });
      if (next === to) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }
  if (!found) {
    pathSteps.value = [];
    pathResult.value = '当前子图内没有路径（可加大跳数或取消过滤后重试）';
    return;
  }
  const steps: { from: number; to: number; label: string }[] = [];
  for (let cur = to; prev.has(cur); ) {
    const p = prev.get(cur) as { from: number; label: string };
    steps.unshift({ from: p.from, to: cur, label: p.label });
    cur = p.from;
  }
  pathSteps.value = steps;
  pathResult.value = '';
  refreshStyles();
  network?.fit({ nodes: [from, ...steps.map((s) => s.to)], animation: true });
}

function onExport(cmd: string) {
  if (cmd === 'png') {
    const canvas = graphEl.value?.querySelector('canvas');
    if (canvas) toPng(canvas as HTMLCanvasElement, 'knowledge-graph.png');
    else ElMessage.warning('画布未就绪');
    return;
  }
  const triples = graph.value.edges
    .filter((e) => {
      const head = nodeById.value.get(e.head);
      const tail = nodeById.value.get(e.tail);
      return !(head && isNodeHidden(head)) && !(tail && isNodeHidden(tail));
    })
    .map((e) => ({
      subject: nodeName(e.head),
      predicate: e.label,
      object: nodeName(e.tail),
      confidence: e.confidence,
      corroborateCount: e.corroborateCount,
      statement: e.statement,
    }));
  if (cmd === 'json') {
    download('knowledge-graph.json', JSON.stringify(triples, null, 2), 'application/json');
    return;
  }
  toCsv(
    'knowledge-graph.csv',
    ['subject', 'predicate', 'object', 'confidence', 'corroborateCount', 'statement'],
    triples.map((t) => [t.subject, t.predicate, t.object, t.confidence, t.corroborateCount, t.statement]),
  );
}

function openArchive() {
  if (archiveHref.value) window.open(archiveHref.value, '_blank', 'noopener');
}

async function searchNodes(kw: string) {
  if (!kw) {
    nodeHits.value = [];
    return;
  }
  searching.value = true;
  try {
    nodeHits.value = await graphApi.nodes({ keyword: kw, datasetId: datasetId.value, limit: 20 });
  } catch {
    nodeHits.value = [];
  } finally {
    searching.value = false;
  }
}

async function loadOverview() {
  loading.value = true;
  try {
    const res = await graphApi.overview({ datasetId: datasetId.value, limit: showAll.value ? 100000 : 60 });
    graph.value = { center: 0, depth: 1, direction: 'both', nodes: res.nodes, edges: res.edges };
    selected.value = null;
    pathSteps.value = [];
    render();
  } catch {
    graph.value = { center: 0, depth: 1, direction: 'both', nodes: [], edges: [] };
    render();
  } finally {
    loading.value = false;
  }
}

/** 切换 抽样概览 / 全部概览 */
function toggleShowAll() {
  showAll.value = !showAll.value;
  void loadOverview();
}

async function loadNodeGraph(id: number) {
  loading.value = true;
  try {
    graph.value = await graphApi.entityGraph(id, {
      depth: filter.depth,
      direction: filter.direction,
      minConfidence: filter.minConfidence || undefined,
      predicate: filter.predicate || undefined,
    });
    selected.value = id;
    pathSteps.value = [];
    render();
  } catch {
    graph.value = { center: id, depth: filter.depth, direction: filter.direction, nodes: [], edges: [] };
    render();
  } finally {
    loading.value = false;
  }
}

async function focusNode(id: number) {
  centerId.value = id;
  await loadNodeGraph(id);
}

function onCenterChange(v?: number) {
  if (v != null) void focusNode(v);
  else void loadOverview();
}

function resetCenter() {
  centerId.value = undefined;
  void loadOverview();
}

async function loadPredicates() {
  try {
    predicates.value = await graphApi.predicates(datasetId.value);
  } catch {
    predicates.value = [];
  }
}

async function loadRelations(p: number) {
  relPage.value = p;
  relLoading.value = true;
  try {
    const res = await graphApi.relations({
      datasetId: datasetId.value,
      predicate: relFilter.predicate,
      keyword: relFilter.keyword || undefined,
      page: p,
      pageSize: relPageSize.value,
    });
    relations.value = res.items;
    relTotal.value = res.total;
  } catch {
    relations.value = [];
    relTotal.value = 0;
  } finally {
    relLoading.value = false;
  }
}

async function reload() {
  await Promise.allSettled([loadPredicates(), loadRelations(1)]);
  if (centerId.value != null) await loadNodeGraph(centerId.value);
  else await loadOverview();
}

/** 人工反转关系方向：确认后写库（head ⇄ tail），刷新图谱 */
async function reverse(row: GraphEdge & { headName?: string | null; tailName?: string | null; tailText?: string }) {
  const headName = row.headName ?? nodeName(row.head);
  const tailName = row.tailName ?? nodeName(row.tail);
  try {
    await ElMessageBox.confirm(
      `将「${headName} ${row.label} ${tailName}」改为「${tailName} ${row.label} ${headName}」？保存后图谱按新方向展示。`,
      '反转关系方向',
      { type: 'warning', confirmButtonText: '保存', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    const res = await graphApi.reverseRelation(row.id);
    if (res.reversed === false) ElMessage.warning(res.message ?? '已存在同向关系，本条已标记为被取代');
    else ElMessage.success('已反转并保存');
  } catch (e) {
    ElMessage.error((e as Error).message || '反转失败');
    return;
  }
  await reload();
}

/** 引句展开开关：默认收起，点「查看引句」展开该条引句 */
const quoteShown = ref(new Set<number>());
function toggleQuote(id: number) {
  const s = new Set(quoteShown.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  quoteShown.value = s;
}

/** 修改概念节点（非实体）名称 */
async function renameNode() {
  const n = node.value;
  if (!n || n.nodeType !== 'concept') return;
  const id = Math.abs(n.id); // 概念节点在图中为负 graph_node.id
  try {
    const { value } = await ElMessageBox.prompt('新的节点名称：', '修改概念节点', {
      inputValue: n.name,
      inputPlaceholder: '请输入新名称',
      inputValidator: (v) => (v && v.trim() ? true : '名称不能为空'),
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    const res = await graphApi.updateNodeName(id, value.trim());
    ElMessage.success(`已改名「${res.name}」`);
  } catch (e) {
    if ((e as { message?: string }).message?.includes('cancel') || e === 'cancel') return;
    ElMessage.error((e as Error).message || '改名失败');
    return;
  }
  await reload();
}

/** 修改关系名称（谓词） */
async function editRelation(row: GraphEdge) {
  const headName = nodeName(row.head);
  const tailName = nodeName(row.tail);
  try {
    const { value } = await ElMessageBox.prompt(`将「${headName} ${row.label} ${tailName}」的关系名称改为：`, '修改关系', {
      inputValue: row.predicate,
      inputPlaceholder: '请输入新的关系名称',
      inputValidator: (v) => (v && v.trim() ? true : '关系名称不能为空'),
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    const res = await graphApi.updateRelation(row.id, value.trim());
    if (res.updated === false) ElMessage.warning(res.message ?? '已存在同向等价关系，本条已标记为被取代');
    else ElMessage.success('关系名称已更新');
  } catch (e) {
    if ((e as { message?: string }).message?.includes('cancel') || e === 'cancel') return;
    ElMessage.error((e as Error).message || '修改失败');
    return;
  }
  await reload();
}

/** 删除关系（软删，不再显示在活跃子图） */
async function removeRelation(row: GraphEdge) {
  const headName = nodeName(row.head);
  const tailName = nodeName(row.tail);
  try {
    await ElMessageBox.confirm(`确认删除关系「${headName} ${row.label} ${tailName}」？删除后不再出现在图谱（后端保留证据与审计）。`, '删除关系', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await graphApi.deleteRelation(row.id);
    ElMessage.success('已删除关系');
  } catch (e) {
    ElMessage.error((e as Error).message || '删除失败');
    return;
  }
  await reload();
}

/** 关联关系下拉操作分发 */
function onRelAction(cmd: string, row: GraphEdge, _from: 'node' | 'drawer' = 'node') {
  if (cmd === 'focus') {
    void focusNode(row.head === node?.value?.id ? row.tail : row.head);
  } else if (cmd === 'reverse') {
    void reverse(row);
  } else if (cmd === 'edit') {
    void editRelation(row);
  } else if (cmd === 'del') {
    void removeRelation(row);
  }
}

const onResize = () => network?.redraw();

// 抽屉开合会改变可视区域，重算画布尺寸
watch(relDrawer, () => window.setTimeout(() => network?.redraw(), 260));

onMounted(async () => {
  try {
    const res = await datasetApi.list({ pageSize: 100 });
    datasets.value = res.items ?? [];
  } catch {
    datasets.value = [];
  }
  await reload();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  network?.destroy();
  network = null;
});
</script>

<style scoped>
.page {
  padding: 18px;
}
.toolbar-card {
  margin-bottom: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.toolbar.second {
  margin-top: 10px;
}
.body {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.graph-card {
  flex: 1;
  min-width: 0;
  position: relative;
}
.graph {
  width: 100%;
  height: calc(100vh - 290px);
  min-height: 520px;
  background: #fff;
}
.page.dark .graph {
  background: #0d1117;
}
.side-card {
  width: 400px;
  flex-shrink: 0;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rel-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rel-item {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 6px 8px;
}
.rel-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rel-dir {
  font-size: 11px;
  color: #0b5cab;
  background: #eaf2fb;
  border: 1px solid #cfe0f2;
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}
.rel-dir.tm {
  color: #8a5a00;
  background: #fdf5e6;
  border-color: #eedcb8;
}
.rel-arc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.rel-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}
.rel-pred {
  flex-shrink: 0;
}
.rel-conf {
  font-size: 11px;
  color: #8a97a5;
  flex-shrink: 0;
}
.rel-quote {
  font-size: 12px;
  color: #3c4654;
  background: #f6f8fa;
  border: 1px dashed #d0d7de;
  border-radius: 4px;
  padding: 4px 8px;
  margin-top: 5px;
  word-break: break-all;
  line-height: 1.5;
}
.quote-toggle {
  margin-top: 4px;
  padding-left: 0;
}
.mt {
  margin-top: 12px;
}
.muted {
  color: #8a97a5;
  font-size: 12px;
}
.muted-sm {
  color: #4e5969;
  font-size: 12px;
}
.mx {
  margin: 0 4px;
}
.quote-cell {
  color: #4e5969;
  line-height: 1.5;
}
.verify-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.verify-tag.passed {
  color: #22764a;
  background: #e7f4ec;
}
.verify-tag.failed {
  color: #b0522b;
  background: #fdf0e6;
}
.verify-tag.pending {
  color: #9c6b1d;
  background: #fdf5e6;
}
.filters {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* 浮动面板（图例/统计/力学参数），对齐 ai-knowledge-graph 的悬浮交互 */
.panel {
  position: absolute;
  z-index: 20;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  padding: 10px 12px;
  font-size: 13px;
  max-height: 60%;
  overflow: auto;
}
.page.dark .panel {
  background: #161b22;
  border-color: #30363d;
  color: #e6edf3;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
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
.panel .row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
}
.panel .row .dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
}
.panel .row .glyph {
  width: 14px;
  text-align: center;
  flex: none;
}
.panel .row .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel .row .size {
  color: #8a97a5;
  font-size: 12px;
}
.panel .row.types {
  margin-top: 8px;
  font-weight: 600;
  cursor: default;
}
.panel .control {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.panel .control input[type='range'] {
  flex: 1;
}
.panel.legend {
  left: 12px;
  top: 12px;
  width: 250px;
}
.panel.stats {
  left: 12px;
  bottom: 12px;
  min-width: 210px;
}
.panel.physics {
  right: 12px;
  bottom: 12px;
  width: 270px;
}
.panel.physics label {
  display: block;
  font-size: 12px;
  margin-top: 6px;
  color: #8a97a5;
}
.panel.physics select,
.panel.physics input[type='range'] {
  width: 100%;
}
.panel.stats table {
  border-collapse: collapse;
  font-size: 13px;
}
.panel.stats td {
  padding: 2px 8px 2px 0;
}
.panel.stats td:last-child {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.path-form {
  display: flex;
  gap: 6px;
  align-items: center;
}
.path-result {
  margin-top: 6px;
}
.path-step {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.path-step:hover {
  background: #f2f3f5;
}
.path-step .pred {
  color: #8a97a5;
  font-style: italic;
}
</style>