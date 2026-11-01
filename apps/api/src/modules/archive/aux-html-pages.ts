/**
 * 内容视图 SSG 渲染（第四阶段）：/topics /facts /publications /distribution /observatory
 * 的静态 HTML。
 *
 * 背景（技术债清偿）：这 5 条路由此前只在 SPA 内渲染，对不执行 JS 的爬虫返回约 1.4KB
 * 空壳（#app 为空、无 canonical / og / JSON-LD），搜索引擎与 AI 抓取者读不到任何内容。
 * 此处与 /overview /catalog /news /changes 同源预渲染：零 JS 全量可读，
 * 注入前台 SPA 构建产物标签后，启用 JS 的浏览器由 Vue 挂载 #app 自动升级为交互版。
 *
 * 这 5 个页面均为可索引页（与左侧菜单入口一一对应），不写 noindex。
 */
import { editorialOrg, orgNode, ORG_NAME } from './archive-html';
import { bylineFoot, esc, fmtDate, shell, siteHeader, type Row } from './aux-html';
import type { ObservatorySnapshot } from '../observatory/observatory.types';

/** 集合页 JSON-LD 骨架：CollectionPage + Organization（与辅助路由同构） */
function collectionJsonLd(opts: {
  baseUrl: string;
  canonical: string;
  name: string;
  description: string;
  extra?: Record<string, unknown>;
}) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: opts.name,
        description: opts.description,
        url: opts.canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: opts.baseUrl },
        publisher: orgNode(opts.baseUrl),
        author: editorialOrg(opts.baseUrl),
        ...(opts.extra ?? {}),
      },
      orgNode(opts.baseUrl),
    ],
  };
}

/** 按一级类别（categoryCode 根段）分组：实体与主题页用 */
function groupByTopic(entries: Row[]) {
  const rootOf = (e: Row) => String(e.categoryCode ?? '').split('.')[0] || 'other';
  // 一级主题名取「代码等于根段」的那个类别自身（如 culture → 文化），
  // 而不是组内任一实体的类别名——后者可能是子类别（饮食/艺术工艺…），会让分组标题误导。
  const rootNames = new Map<string, string>();
  for (const e of entries) {
    const code = String(e.categoryCode ?? '');
    if (code && code === rootOf(e)) rootNames.set(code, String(e.categoryName ?? '').trim());
  }
  const groups = new Map<
    string,
    { label: string; items: Row[]; factSum: number; sub: Map<string, number> }
  >();
  for (const e of entries) {
    const root = rootOf(e);
    if (!groups.has(root)) {
      groups.set(root, {
        label:
          rootNames.get(root) ||
          String(e.categoryName ?? '').trim() ||
          (root === 'other' ? '未分类' : root),
        items: [],
        factSum: 0,
        sub: new Map(),
      });
    }
    const g = groups.get(root)!;
    g.items.push(e);
    g.factSum += Number(e.currentFactCount ?? 0);
    const sub = String(e.categoryName ?? '').trim() || '未分类';
    g.sub.set(sub, (g.sub.get(sub) ?? 0) + 1);
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => Number(b.currentFactCount ?? 0) - Number(a.currentFactCount ?? 0));
  }
  // 主题按实体数倒序（内容重的主题排前），保证静态页首屏就是最实的内容
  return [...groups.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
}

// ---------------------------------------------------------------- 实体与主题 /topics

export function renderTopicsHtml(baseUrl: string, entries: Row[], spaAssets = ''): string {
  const canonical = `${baseUrl}/topics`;
  const topics = groupByTopic(entries);
  const factSum = entries.reduce((s, e) => s + Number(e.currentFactCount ?? 0), 0);

  const summary = topics
    .map(
      ([, g]) =>
        `<tr><td><a href="#topic-${esc(slugify(g.label))}">${esc(g.label)}</a></td>` +
        `<td>${g.items.length}</td><td>${g.factSum.toLocaleString()}</td></tr>`,
    )
    .join('');

  const sections = topics
    .map(([, g]) => {
      const rows = g.items
        .map(
          (e) =>
            `<tr><td><a href="/archive/${esc(e.datasetCode)}/${esc(e.slug)}">${esc(e.name)}</a></td>` +
            `<td>${Number(e.currentFactCount ?? 0)}</td>` +
            `<td>${Number(e.evidenceCount ?? 0)}</td></tr>`,
        )
        .join('');
      const sub = [...g.sub.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${esc(n)} ${c}`)
        .join(' · ');
      return `<h2 id="topic-${esc(slugify(g.label))}">${esc(g.label)}（${g.items.length} 个实体 · ${g.factSum.toLocaleString()} 条现行事实）</h2>
<div class="card">
  <p class="meta">子类别分布：${sub}</p>
  <table><thead><tr><th>实体</th><th>现行事实</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    })
    .join('');

  return shell({
    title: '实体与主题 — 温州网事实档案',
    desc: `温州城市可信数据的主题索引：${topics.length} 个一级主题、${entries.length} 个实体、${factSum.toLocaleString()} 条现行事实，按主题列出实体与事实数。`,
    canonical,
    jsonLd: collectionJsonLd({
      baseUrl,
      canonical,
      name: '实体与主题',
      description: `按一级主题组织的实体索引，共 ${topics.length} 个主题、${entries.length} 个实体。`,
      extra: { numberOfItems: entries.length },
    }),
    spaAssets,
    body: `${siteHeader('ENTITY & COLLECTIONS', '实体与主题', '实体是稳定的索引，主题负责相关性。同一事实可被多个主题视图引用，主题按系统的一级实体类别动态生成。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${topics.length}</b><span>一级主题</span></div>
    <div class="stat"><b>${entries.length.toLocaleString()}</b><span>已发布实体</span></div>
    <div class="stat"><b>${factSum.toLocaleString()}</b><span>现行事实合计</span></div>
  </div>
  <h2>主题一览</h2>
  <div class="card"><table><thead><tr><th>主题</th><th>实体数</th><th>现行事实</th></tr></thead><tbody>${summary}</tbody></table></div>
  ${sections}
  <div class="foot">机器可读版本：<a href="/catalog.json">catalog.json</a> · 全量实体目录见 <a href="/catalog">城市事实目录</a> · 本页零 JS 可读，启用 JavaScript 后自动升级为可搜索的交互版。</div>
  ${bylineFoot}
</div>`,
  });
}

/** 锚点用 slug：仅保留中日韩字符与字母数字，其余转连字符 */
function slugify(v: string): string {
  return (
    v
      .trim()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'topic'
  );
}

// ---------------------------------------------------------------- 事实与证据 /facts

export function renderFactsHtml(baseUrl: string, facts: Row[], spaAssets = ''): string {
  const canonical = `${baseUrl}/facts`;
  const entityIds = new Set(facts.map((f) => String(f.entityId ?? '')));
  const rows = facts
    .map((f) => {
      const stmt = String(f.statement ?? '');
      return (
        `<tr><td><code>${esc(f.code ?? `#${f.id}`)}</code></td>` +
        `<td>${esc(stmt)}` +
        (f.code
          ? `<div class="meta"><a href="/archive/${esc(f.datasetCode)}/${esc(f.entitySlug)}/fact/${esc(f.code)}">单条事实页</a></div>`
          : '') +
        `</td>` +
        `<td><a href="/archive/${esc(f.datasetCode)}/${esc(f.entitySlug)}">${esc(f.entityName)}</a></td>` +
        `<td>${esc(f.dimension ?? '—')}</td>` +
        `<td>${esc(f.status ?? '')}</td>` +
        `<td>${esc(String(f.confidence ?? ''))}</td>` +
        `<td>${esc(fmtDate(f.lastVerifiedAt)) || '—'}</td></tr>`
      );
    })
    .join('');
  const avgConfidence = facts.length
    ? (facts.reduce((s, f) => s + Number(f.confidence ?? 0), 0) / facts.length).toFixed(3)
    : '—';

  return shell({
    title: '事实与证据 — 温州网事实档案',
    desc: `温州城市可信数据的现行事实与逐字证据：本页展示最近核验的 ${facts.length} 条现行事实，每条附事实编号、来源实体、维度、模型置信度与核验时间。`,
    canonical,
    jsonLd: collectionJsonLd({
      baseUrl,
      canonical,
      name: '事实与证据',
      description: `全站现行事实列表，每条事实附逐字原文证据与核验锚点。本页展示其中 ${facts.length} 条。`,
      extra: { numberOfItems: facts.length },
    }),
    spaAssets,
    body: `${siteHeader('FACT REGISTRY', '事实与证据', '事实是可持续维护的对象：核验内容是什么、来源说了什么、哪些时间已经确认、有哪些版本，逐项分清。以下为最近核验的现行事实。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${facts.length}</b><span>本页事实</span></div>
    <div class="stat"><b>${entityIds.size}</b><span>涉及实体</span></div>
    <div class="stat"><b>${avgConfidence}</b><span>平均模型置信度</span></div>
  </div>
  <h2>现行事实</h2>
  ${
    rows
      ? `<div class="card"><table><thead><tr><th>事实编号</th><th>陈述 / 证据</th><th>来源实体</th><th>维度</th><th>状态</th><th>置信度</th><th>最近核验</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="meta">暂无现行事实。</p>'
  }
  <div class="foot">机器可读版本：<a href="/api/changes.json">changes.json</a> · 变更流 <a href="/changes">事实变更</a> · 本页零 JS 可读，启用 JavaScript 后自动升级为可搜索的交互版。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 事实发布记录 /publications

export function renderPublicationsHtml(baseUrl: string, groups: Row[], spaAssets = ''): string {
  const canonical = `${baseUrl}/publications`;
  const typeLabel: Record<string, string> = {
    new: '新增',
    update: '更新',
    corroborate: '佐证',
    retire: '退役',
  };
  let itemTotal = 0;
  const rows = groups
    .map((g) => {
      const items = (Array.isArray(g.items) ? g.items : []) as Row[];
      itemTotal += items.length;
      const counts = new Map<string, number>();
      const entityNames = new Map<string, string>();
      for (const i of items) {
        const t = String(i.changeType ?? '');
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (i.entityName) {
          entityNames.set(
            `${String(i.datasetCode ?? '')}/${String(i.entitySlug ?? '')}`,
            String(i.entityName),
          );
        }
      }
      const typeText = [...counts.entries()]
        .map(([t, n]) => `${typeLabel[t] ?? t} ${n}`)
        .join(' · ');
      const entities = [...entityNames.entries()]
        .map(([path, name]) => `<a href="/archive/${esc(path)}">${esc(name)}</a>`)
        .join('、');
      const title = String(g.articleTitle ?? '（无来源文章）');
      const head = g.articleUrl
        ? `<a href="${esc(g.articleUrl)}" target="_blank" rel="noopener">${esc(title)}</a>`
        : esc(title);
      return (
        `<tr><td>${head}<div class="meta">${esc(g.sourceOrg ?? '未知来源')} · ${esc(fmtDate(g.createdAt)) || '—'}</div></td>` +
        `<td>${entities || '—'}</td><td>${esc(typeText) || '—'}</td><td>${items.length}</td></tr>`
      );
    })
    .join('');

  return shell({
    title: '事实发布记录 — 温州网事实档案',
    desc: `温州城市可信数据的发布记录流：本页按来源文章归集 ${groups.length} 组发布记录、${itemTotal} 条事实变更，保留旧口径到新主张的完整轨迹。`,
    canonical,
    jsonLd: collectionJsonLd({
      baseUrl,
      canonical,
      name: '事实发布记录',
      description: `按来源文章归集的事实发布记录，保留旧口径到新主张的完整轨迹。本页展示 ${groups.length} 组。`,
      extra: { numberOfItems: groups.length },
    }),
    spaAssets,
    body: `${siteHeader('PUBLICATION RECORDS', '事实发布记录', '每篇报道带来一次发布：按来源文章归集该次抽取对城市事实的影响，区分新增、更新、佐证与退役。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${groups.length}</b><span>本页发布记录</span></div>
    <div class="stat"><b>${itemTotal}</b><span>涉及事实变更</span></div>
  </div>
  <h2>发布记录</h2>
  ${
    rows
      ? `<div class="card"><table><thead><tr><th>来源文章 / 发布时间</th><th>影响实体</th><th>变更类型</th><th>变更条数</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="meta">暂无发布记录。</p>'
  }
  <div class="foot">变更流订阅：<a href="/feed.json">feed.json</a> · <a href="/feed.xml">feed.xml</a> · 相邻视图 <a href="/changes">事实变更</a> · 本页零 JS 可读，启用 JavaScript 后自动升级为交互版。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 机器发布中心 /distribution

export interface DistributionData {
  entityCount: number;
  factCount: number;
  tools: { name: string; description: string }[];
}

export function renderDistributionHtml(
  baseUrl: string,
  data: DistributionData,
  spaAssets = '',
): string {
  const canonical = `${baseUrl}/distribution`;
  const outlets: [string, string, string][] = [
    ['JSON Fact API', 'GET /api/archive/{dataset}/{slug}.json', '实体事实结构化访问，含事实编号与核验时间'],
    ['JSON-LD', 'GET /archive/{dataset}/{slug} · application/ld+json', '搜索引擎与 AI 的结构化描述'],
    ['HTML 事实页面', 'GET /archive/{dataset}/{slug}', '可引用的公开事实档案页'],
    ['单条事实页', 'GET /archive/{dataset}/{slug}/fact/{code}', '单条事实的稳定公开地址与逐字证据'],
    ['RSS / JSON Feed', 'GET /feed.xml · GET /feed.json', '变更订阅与通知'],
    ['MCP 工具服务', 'POST /api/mcp · tools/call', 'AI Agent 只读调用（JSON-RPC 2.0）'],
  ];
  const outletRows = outlets
    .map(
      ([n, ep, d]) =>
        `<tr><td>${esc(n)}</td><td><code>${esc(ep)}</code></td><td>${esc(d)}</td></tr>`,
    )
    .join('');
  const toolRows = data.tools
    .map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.description)}</td></tr>`)
    .join('');

  return shell({
    title: '机器发布中心 — 温州网事实档案',
    desc: `同一个事实版本派生为不同机器出口：HTML 事实页、JSON API、JSON-LD、RSS/JSON Feed 与 MCP 只读工具服务，共 ${data.tools.length} 个 MCP 工具。`,
    canonical,
    jsonLd: collectionJsonLd({
      baseUrl,
      canonical,
      name: '机器发布中心',
      description: '事实的机器可读出口清单：HTML / JSON / JSON-LD / Feed / MCP，全部公开只读。',
      extra: { numberOfItems: outlets.length },
    }),
    spaAssets,
    body: `${siteHeader('MACHINE-READABLE PUBLICATION', '机器发布中心', '同一个事实版本，派生为不同机器出口。以下产物由真实实体与事实数据即时派生，全部公开只读。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${data.entityCount.toLocaleString()}</b><span>已发布实体</span></div>
    <div class="stat"><b>${data.factCount.toLocaleString()}</b><span>现行事实</span></div>
    <div class="stat"><b>${data.tools.length}</b><span>MCP 工具</span></div>
  </div>
  <h2>发布出口</h2>
  <div class="card"><table><thead><tr><th>出口</th><th>端点</th><th>说明</th></tr></thead><tbody>${outletRows}</tbody></table></div>
  <h2>MCP 可用工具（tools/list）</h2>
  ${
    toolRows
      ? `<div class="card"><table><thead><tr><th>工具</th><th>说明</th></tr></thead><tbody>${toolRows}</tbody></table></div>`
      : '<p class="meta">工具清单读取失败时，可直接请求 <code>POST /api/mcp</code> 的 <code>tools/list</code>。</p>'
  }
  <h2>全量机器出口</h2>
  <div class="card">
    <div>目录：<a href="/catalog.json">catalog.json</a> · 变更流：<a href="/feed.json">feed.json</a> · <a href="/feed.xml">feed.xml</a></div>
    <div>索引：<a href="/sitemap.xml">sitemap.xml</a> · <a href="/llms.txt">llms.txt</a></div>
    <div>MCP：<code>POST /api/mcp</code>（JSON-RPC 2.0，支持 initialize / ping / tools/list / tools/call）</div>
  </div>
  <h2>发布守门原则</h2>
  <div class="card">
    <p>只有满足审核条件、来源可溯、可公开的事实版本才对外发布。MCP 不是对数据库的直接访问；事实的失效与撤回应同步反映到所有机器出口，避免同一事实在不同出口之间出现口径分叉。</p>
  </div>
  <div class="foot">本页零 JS 可读，启用 JavaScript 后自动升级为可交互的出口预览器。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- AI 引用观察 /observatory

export function renderObservatoryHtml(
  baseUrl: string,
  snapshot: ObservatorySnapshot,
  spaAssets = '',
): string {
  const canonical = `${baseUrl}/observatory`;
  const m = snapshot.metrics;
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const citeLabel: Record<string, string> = {
    fact_page: '命中事实页',
    same_domain: '命中同域',
    other: '其他源',
    none: '未引用',
  };
  /** 一个问题行取「首个非未引用」的模型判定作为代表结论 */
  const questionVerdict = (byModel: Record<string, string>) => {
    const vals = Object.values(byModel ?? {});
    if (vals.includes('fact_page') || vals.includes('same_domain')) return 'fact_page';
    if (vals.includes('other')) return 'other';
    return 'none';
  };
  const weekRows = snapshot.weeklyStats
    .map(
      (w) =>
        `<tr><td>${esc(w.label)}</td><td>${w.rate == null ? '—' : pct(w.rate)}</td><td>${w.base}</td></tr>`,
    )
    .join('');
  const questionRows = snapshot.questions
    .slice(0, 12)
    .map(
      (q) =>
        `<tr><td>${esc(q.question)}</td><td>${esc(q.expectedAnswer)}</td>` +
        `<td>${esc(citeLabel[questionVerdict(q.byModel)] ?? '—')}</td><td>${q.answerCount}</td></tr>`,
    )
    .join('');
  const last = m.lastCitation;

  return shell({
    title: 'AI 引用观察 — 温州网事实档案',
    desc: `温州城市可信数据的 AI 引用观测：固定问题集 ${m.citationRateBase} 题的引用正确率 ${pct(m.citationRate)}，逐题记录各模型对事实页的引用判定与命中来源。`,
    canonical,
    jsonLd: collectionJsonLd({
      baseUrl,
      canonical,
      name: 'AI 引用观察',
      description: `固定问题集的真实探测：引用正确率 ${pct(m.citationRate)}，样本 ${m.citationRateBase} 题，逐题记录模型引用判定。`,
      extra: { numberOfItems: snapshot.questions.length },
    }),
    spaAssets,
    body: `${siteHeader('AI CITATION OBSERVATORY', 'AI 引用观察', '从外部模型答案里检查城市事实有没有被正确理解与引用。数据来自固定问题集的真实探测跑批。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${pct(m.citationRate)}</b><span>引用正确率</span></div>
    <div class="stat"><b>${m.citationRateBase}</b><span>样本题数</span></div>
    <div class="stat"><b>${snapshot.questions.length}</b><span>固定问题</span></div>
    <div class="stat"><b>${esc(fmtDate(snapshot.generatedAt)) || '—'}</b><span>快照生成时间</span></div>
  </div>
  <h2>近 4 周引用变化</h2>
  ${
    weekRows
      ? `<div class="card"><table><thead><tr><th>观测周</th><th>引用正确率</th><th>参与判定题数</th></tr></thead><tbody>${weekRows}</tbody></table></div>`
      : '<p class="meta">暂无分周探测数据。</p>'
  }
  <h2>固定问题集观测</h2>
  ${
    questionRows
      ? `<div class="card"><table><thead><tr><th>问题</th><th>期望答案</th><th>引用判定</th><th>回答次数</th></tr></thead><tbody>${questionRows}</tbody></table></div>`
      : '<p class="meta">暂无固定问题集数据。</p>'
  }
  ${
    last
      ? `<h2>最近一次引用</h2>
  <div class="card">
    <table><tbody>
      <tr><th>时间</th><td>${esc(fmtDate(last.at)) || '—'}</td></tr>
      <tr><th>模型</th><td>${esc(last.model)}</td></tr>
      <tr><th>问题</th><td>${esc(last.question)}</td></tr>
      <tr><th>判定</th><td>${esc(citeLabel[last.cited] ?? last.cited)}</td></tr>
      <tr><th>命中 URL</th><td><a href="${esc(last.url)}" target="_blank" rel="noopener">${esc(last.url)}</a></td></tr>
      <tr><th>关联事实页</th><td><a href="${esc(last.factUrl)}">${esc(last.factUrl)}</a></td></tr>
    </tbody></table>
  </div>`
      : ''
  }
  <div class="foot">判定口径：命中的是本站事实页或同域内容记为「命中」，其他来源记为「其他源」，模型答案未引用任何来源记为「未引用」。本页零 JS 可读，启用 JavaScript 后自动升级为交互版观测台。</div>
  ${bylineFoot}
</div>`,
  });
}
