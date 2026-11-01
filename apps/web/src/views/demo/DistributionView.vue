<template>
  <section class="page active" aria-label="机器发布中心">
    <div class="page-head">
      <div>
        <p class="eyebrow">MACHINE-READABLE PUBLICATION</p>
        <h1>机器发布中心</h1>
        <p>同一个事实版本，派生为不同机器出口。以下产物由真实实体与事实数据即时派生。</p>
      </div>
      <span class="page-head-tag">HTML · JSON · JSON-LD · FEED · MCP</span>
    </div>

    <div class="distribution-layout">
      <div class="panel">
        <div class="panel-heading">
          <h3>选择发布实体</h3>
          <span v-if="entity" class="pick-current" :title="entity.name">{{ entity.name }}</span>
        </div>
        <div class="entity-picker">
          <label class="pick-input">
            <DemoIcon name="search" />
            <input
              v-model="keyword"
              placeholder="搜索实体名称 / 类别…"
              aria-label="搜索实体"
              @focus="openList = true"
              @blur="closeListSoon"
            />
          </label>
          <div v-if="openList" class="pick-list">
            <button
              v-for="e in results"
              :key="e.id"
              type="button"
              :class="{ active: entity?.id === e.id }"
              @mousedown.prevent="pick(e)"
            >
              <span class="pick-name">{{ e.name }}</span>
              <span class="pick-meta">{{ e.categoryName || '未分类' }} · {{ e.factCount ?? 0 }} 条事实</span>
            </button>
            <div v-if="loadingList" class="pick-empty">搜索中…</div>
            <div v-else-if="!results.length" class="pick-empty">没有匹配的实体</div>
          </div>
        </div>

        <div class="panel-heading pick-heading">
          <h3>选择发布出口</h3>
        </div>
        <div class="output-list">
          <button v-for="o in outlets" :key="o.key" :class="{ active: output === o.key }" @click="output = o.key">
            <DemoIcon :name="o.icon" />
            <span>{{ o.title }}<small>{{ o.desc }}</small></span>
            <b>↗</b>
          </button>
        </div>
      </div>

      <div class="panel code-panel">
        <div class="code-top">
          <div>
            <div class="eyebrow">OUTPUT PREVIEW · LIVE DERIVED</div>
            <h3>{{ current.title }}</h3>
            <p class="helper">{{ current.desc }}</p>
          </div>
          <button class="small-btn" @click="copy"><DemoIcon name="copy" /> 复制内容</button>
        </div>
        <div class="endpoint">
          <span class="mini-dot teal"></span>
          <code>{{ current.endpoint }}</code>
          <span>{{ entity ? '基于 ' + entity.name : '未选到实体' }}</span>
        </div>

        <div v-if="output === 'mcp'" class="mcp-block">
          <div class="mcp-subhead">
            可用工具 · tools/list（实时）
            <span v-if="mcpLoading" class="mcp-hint">读取中…</span>
            <span v-else class="mcp-hint">{{ mcpTools.length }} 个工具</span>
          </div>
          <div class="mcp-tools">
            <button
              v-for="t in mcpTools"
              :key="t.name"
              type="button"
              :class="{ active: mcpPick === t.name }"
              :disabled="t.name === 'get_fact' && !facts.length"
              @click="mcpPick = t.name"
            >
              <code>{{ t.name }}</code>
              <span>{{ t.description }}</span>
            </button>
          </div>
        </div>

        <pre class="code-area">{{ code }}</pre>

        <template v-if="output === 'mcp'">
          <div class="mcp-subhead">
            真实调用响应 · POST /mcp
            <span v-if="mcpCalling" class="mcp-hint">调用中…</span>
            <span v-else-if="mcpError" class="mcp-hint err">{{ mcpError }}</span>
            <span v-else class="mcp-hint ok">已返回</span>
          </div>
          <pre class="code-area response">{{ mcpResponseText }}</pre>
        </template>
      </div>
    </div>

    <div class="publish-principles">
      <DemoIcon name="shield" />
      <div>
        <b>发布守门原则</b>
        <p>只有满足人工审核、使用授权和公开条件的事实版本可以对外发布。MCP 不是对数据库的直接访问，失效与撤回应同步反映到所有机器出口。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import DemoIcon from '@/demo/DemoIcon.vue';
import { demoToast } from '@/demo/demoUi';
import { entityApi, factApi, mcpApi, type FactItem, type McpTool } from '@/api';
import type { EntityDetail, EntityListItem } from '@/types';

const outlets = [
  { key: 'json', title: 'JSON Fact API', desc: '实体事实结构化访问', icon: 'brackets', endpoint: 'GET /fact/{slug}.json' },
  { key: 'jsonld', title: 'JSON-LD', desc: '搜索引擎结构化描述', icon: 'code', endpoint: 'GET /fact/{slug}/ · application/ld+json' },
  { key: 'html', title: 'HTML 事实页面', desc: '可引用的公开网页', icon: 'globe', endpoint: 'GET /archive/{datasetCode}/{slug}' },
  { key: 'feed', title: 'RSS / JSON Feed', desc: '变更订阅与通知', icon: 'rss', endpoint: 'GET /fact/feed.json' },
  { key: 'mcp', title: 'MCP 工具服务', desc: 'AI Agent 只读调用', icon: 'cpu', endpoint: 'POST /mcp · tools/call' },
] as const;

type OutletKey = (typeof outlets)[number]['key'];
const output = ref<OutletKey>('json');

const entity = ref<EntityListItem | null>(null);
const detail = ref<EntityDetail | null>(null);
const facts = ref<FactItem[]>([]);

// 实体选择器
const keyword = ref('');
const results = ref<EntityListItem[]>([]);
const loadingList = ref(false);
const openList = ref(false);

const current = computed(() => outlets.find((o) => o.key === output.value)!);

const code = computed(() => {
  const e = entity.value;
  if (!e) return '// 正在读取实体与事实数据…';
  const site = location.origin;
  const factsPayload = facts.value.map((f) => ({
    fact_id: f.code ?? `F-${f.id}`,
    dimension: f.dimension,
    statement: f.statement,
    status: f.status,
    version: f.version,
    confidence: f.confidence,
    last_verified_at: f.lastVerifiedAt,
  }));

  switch (output.value) {
    case 'json':
      return JSON.stringify(
        {
          entity_id: e.urn,
          name: e.name,
          slug: e.slug,
          category: e.categoryName,
          statement_count: factsPayload.length,
          facts: factsPayload,
        },
        null,
        2,
      );
    case 'jsonld':
      return JSON.stringify(
        {
          '@context': 'https://schema.org',
          '@type': 'Thing',
          '@id': `${site}/archive/${e.datasetCode}/${e.slug}`,
          name: e.name,
          description: detail.value?.lede ?? '',
          identifier: e.urn,
          dateModified: e.updatedAt,
          additionalProperty: factsPayload.map((f) => ({
            '@type': 'PropertyValue',
            name: f.dimension,
            value: f.statement,
            propertyID: f.fact_id,
          })),
        },
        null,
        2,
      );
    case 'html':
      return [
        `<article itemscope itemtype="https://schema.org/Thing">`,
        `  <h1 itemprop="name">${e.name}</h1>`,
        `  <p itemprop="description">${detail.value?.lede ?? ''}</p>`,
        ...factsPayload
          .slice(0, 5)
          .map(
            (f) =>
              `  <p data-fact-id="${f.fact_id}" data-status="${f.status}">${f.statement}</p>`,
          ),
        `  <a href="${site}/archive/${e.datasetCode}/${e.slug}">实体档案页</a>`,
        `</article>`,
      ].join('\n');
    case 'feed':
      return JSON.stringify(
        {
          version: 'https://jsonfeed.org/version/1.1',
          title: `${e.name} 事实变更订阅`,
          home_page_url: `${site}/archive/${e.datasetCode}/${e.slug}`,
          items: factsPayload.slice(0, 5).map((f, i) => ({
            id: `${e.urn}-${f.fact_id}-${i}`,
            title: f.dimension,
            date_published: f.last_verified_at ?? e.updatedAt,
            content_text: f.statement,
            _status: f.status,
          })),
        },
        null,
        2,
      );
    case 'mcp':
      return JSON.stringify(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: mcpPick.value, arguments: mcpArgs.value },
        },
        null,
        2,
      );
  }
});

// ---------------------------------------------------------------- MCP 只读工具服务（真实调用）

const mcpTools = ref<McpTool[]>([]);
const mcpLoading = ref(false);
const mcpPick = ref('get_fact');
const mcpCalling = ref(false);
const mcpError = ref('');
const mcpResponse = ref<unknown>(null);

/** 请求参数按当前实体与所选工具生成，示例即真实请求 */
const mcpArgs = computed<Record<string, unknown>>(() => {
  const e = entity.value;
  if (!e) return {};
  switch (mcpPick.value) {
    case 'get_fact': {
      const f = facts.value[0];
      return f ? { fact_id: f.code ?? `F-${f.id}` } : {};
    }
    case 'get_entity':
      return { entity_id: e.id };
    case 'search_facts':
      return { keyword: e.name, limit: 5 };
    case 'search_entities':
      return { keyword: e.name, limit: 5 };
    case 'list_changes':
      return { limit: 5 };
    default:
      return {};
  }
});

const mcpResponseText = computed(() =>
  mcpResponse.value == null ? '// 等待调用结果…' : JSON.stringify(mcpResponse.value, null, 2),
);

async function loadMcpTools() {
  if (mcpTools.value.length) return;
  mcpLoading.value = true;
  try {
    mcpTools.value = (await mcpApi.tools()).tools;
  } catch {
    mcpTools.value = [];
  } finally {
    mcpLoading.value = false;
  }
}

async function runMcpCall() {
  if (output.value !== 'mcp' || !entity.value) return;
  mcpCalling.value = true;
  mcpError.value = '';
  try {
    const res = await mcpApi.call(mcpPick.value, mcpArgs.value);
    mcpResponse.value = res.error ? { error: res.error } : res.result;
  } catch (err) {
    mcpResponse.value = null;
    mcpError.value = err instanceof Error ? err.message : '调用失败';
  } finally {
    mcpCalling.value = false;
  }
}

watch([output, mcpPick, () => entity.value?.id, () => facts.value.length], async () => {
  if (output.value !== 'mcp') return;
  await loadMcpTools();
  await runMcpCall();
});

async function copy() {
  try {
    await navigator.clipboard.writeText(code.value);
    demoToast('内容已复制');
  } catch {
    demoToast('浏览器限制复制，请手动选中');
  }
}

/** 拉取候选实体列表（默认按事实数倒序） */
async function searchEntities() {
  loadingList.value = true;
  try {
    const res = await entityApi.list({
      pageSize: 12,
      sort: 'factCount',
      order: 'desc',
      keyword: keyword.value.trim() || undefined,
    });
    results.value = res.items;
  } catch {
    results.value = [];
  } finally {
    loadingList.value = false;
  }
}

let searchTimer: number | undefined;
watch(keyword, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    openList.value = true;
    void searchEntities();
  }, 250);
});

/** 失焦后延迟关闭，保证列表项 mousedown 先触发 */
const closeListSoon = () => {
  window.setTimeout(() => (openList.value = false), 150);
};

async function pick(e: EntityListItem) {
  entity.value = e;
  openList.value = false;
  detail.value = null;
  facts.value = [];
  try {
    const [d, f] = await Promise.all([
      entityApi.detail(e.id),
      factApi.list({ entityId: e.id, pageSize: 20 }),
    ]);
    detail.value = d;
    facts.value = f.items;
    // 该实体没有生效事实时，get_fact 无参可传，退回实体查询
    if (mcpPick.value === 'get_fact' && !f.items.length) mcpPick.value = 'get_entity';
  } catch {
    // 交由顶部空态提示
  }
}

onMounted(async () => {
  await searchEntities();
  // 默认选中事实最多的实体
  const first = results.value.find((e) => (e.factCount ?? 0) > 0) ?? results.value[0] ?? null;
  if (first) await pick(first);
});
</script>

<style scoped>
.pick-current {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: #467787;
  background: #edf4f6;
  border-radius: 6px;
  padding: 3px 8px;
}
.entity-picker {
  position: relative;
  margin-bottom: 4px;
}
.pick-input {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
  background: #fff;
  border: 1px solid #dfe7ed;
  border-radius: 9px;
}
.pick-input svg {
  width: 15px;
  flex: none;
  color: #8fa2b1;
}
.pick-input input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 12px;
  color: #253b4b;
}
.pick-input input::placeholder {
  color: #a8b5bf;
}
.pick-list {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 264px;
  overflow: auto;
  padding: 5px;
  background: #fff;
  border: 1px solid #dbe5ec;
  border-radius: 10px;
  box-shadow: 0 12px 28px #14304a1f;
}
.pick-list button {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
}
.pick-list button:hover,
.pick-list button.active {
  background: #eff8f7;
}
.pick-name {
  font-size: 12px;
  font-weight: 700;
  color: #233e50;
}
.pick-meta {
  font-size: 10px;
  color: #8fa1ae;
}
.pick-empty {
  padding: 12px;
  font-size: 11px;
  color: #93a5b2;
  text-align: center;
}
.pick-heading {
  margin-top: 18px;
}

/* MCP 出口：真实工具清单 + 真实调用响应 */
.mcp-subhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 25px;
  margin: 14px 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6c8998;
}
.mcp-hint {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: #93a5b2;
}
.mcp-hint.err {
  color: #c05a4a;
}
.mcp-hint.ok {
  color: #2f8a6a;
}
.mcp-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 25px;
  margin-bottom: 14px;
}
.mcp-tools button {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 46%;
  min-width: 200px;
  padding: 8px 10px;
  text-align: left;
  background: #fff;
  border: 1px solid #dfe7ed;
  border-radius: 8px;
}
.mcp-tools button:hover:not(:disabled) {
  border-color: #9fd0c9;
  background: #f7fbfa;
}
.mcp-tools button.active {
  border-color: #138577;
  background: #eff8f7;
}
.mcp-tools button:disabled {
  opacity: 0.5;
}
.mcp-tools button code {
  font-size: 11px;
  font-weight: 700;
  color: #1d5f57;
}
.mcp-tools button span {
  font-size: 10px;
  color: #8fa1ae;
}
.code-area.response {
  margin-top: 4px;
  max-height: 260px;
  overflow: auto;
}
</style>
