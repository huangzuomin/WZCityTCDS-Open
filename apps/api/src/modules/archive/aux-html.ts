/**
 * 辅助路由 SSG 渲染（第三阶段）：/overview /catalog /news /changes 与语料域首页
 * /archive/home/:dataset 的静态 HTML，以及真 404 页。
 *
 * 设计要点：
 * - 零 JS 可读：完整 TDK + canonical + JSON-LD + 全量内容，任何 UA（含禁 JS）直读；
 * - 交互升级：注入前台 SPA 的构建产物标签（<link>/<script>，由 ssg.js 从 web dist 提取），
 *   启用 JS 的浏览器由 Vue 挂载 #app 替换静态内容，无缝升级为交互版（搜索/筛选/分页）；
 * - 与档案页同一视觉体系（复用 archive-html 的 head/BASE_CSS）。
 */
import { head, orgNode, editorialOrg, ORG_NAME } from './archive-html';

export const esc = (v: unknown) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export const fmtDate = (v: unknown) => String(v ?? '').replace('T', ' ').replace(/\.\d+/, '').slice(0, 16);

/** 类型宽松的行数据（与 archive-html 同风格：SSG 侧只读展示，不做严格契约） */
export type Row = Record<string, unknown>;

/** 页面骨架：静态内容放 #app 内，JS 启用时被 Vue 挂载替换（升级为交互版） */
export function shell(opts: {
  title: string;
  desc: string;
  canonical: string;
  jsonLd?: object;
  spaAssets?: string;
  body: string;
  noindex?: boolean;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    opts.title,
    opts.desc,
    opts.canonical,
    (opts.noindex ? '<meta name="robots" content="noindex">' : '') +
      (opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>` : ''),
  )}</head>
<body>
<div id="app">
${opts.body}
</div>
${opts.spaAssets ?? ''}
</body>
</html>`;
}

export const siteHeader = (kicker: string, title: string, lede: string) => `
<header class="site"><div class="bar">
  <div class="meta">${esc(kicker)} · <a style="color:#fff" href="/overview">${esc(ORG_NAME)}</a></div>
  <h1>${esc(title)}</h1>
  <p class="lede">${esc(lede)}</p>
</div></header>`;

export const bylineFoot = `
<p class="byline">
  内容生产与审核责任：<strong>温州城市可信数据编辑部</strong>（温州网 · 事实档案；自动抽取入档，人工抽检复核）·
  编辑流程、信源边界与更正机制见<a href="/methodology/">方法论页</a>
</p>`;

// ---------------------------------------------------------------- 实体目录 /catalog

export function renderCatalogHtml(
  baseUrl: string,
  entries: Row[],
  spaAssets = '',
  stats?: { publishedEntities: number },
): string {
  const canonical = `${baseUrl}/catalog`;
  // 实体总数统一取 siteStats() 的唯一口径（全部已发布实体），避免与 entries.length 各自定义而漂移；
  // 列表本身仍按顺序渲染 entries。
  const total = stats?.publishedEntities ?? entries.length;
  // 按一级类别分组（categoryCode 首段），组内按现行事实数倒序——目录页是全站抓取枢纽
  // 分组标题取「代码等于根段」的类别自身名称（如 culture → 文化），
  // 避免用组内任一实体的子类别名（饮食/艺术工艺…）当标题造成误导。
  const rootNames = new Map<string, string>();
  for (const e of entries) {
    const code = String(e.categoryCode ?? '');
    if (code && !code.includes('.')) rootNames.set(code, String(e.categoryName ?? '').trim());
  }
  const groups = new Map<string, { label: string; items: Row[] }>();
  for (const e of entries) {
    const code = String(e.categoryCode ?? '');
    const root = code.split('.')[0] || 'other';
    const label =
      rootNames.get(root) || String(e.categoryName ?? '').trim() || (root === 'other' ? '未分类' : root);
    if (!groups.has(root)) groups.set(root, { label, items: [] });
    groups.get(root)!.items.push(e);
  }
  const order = [...groups.keys()];
  const sections = order
    .map((root) => {
      const g = groups.get(root)!;
      g.items.sort((a, b) => Number(b.currentFactCount ?? 0) - Number(a.currentFactCount ?? 0));
      const rows = g.items
        .map(
          (e) =>
            `<tr><td><a href="/archive/${esc(e.datasetCode)}/${esc(e.slug)}">${esc(e.name)}</a></td>` +
            `<td><code>${esc(e.urn)}</code></td>` +
            `<td>${Number(e.currentFactCount ?? 0)}</td><td>${Number(e.evidenceCount ?? 0)}</td>` +
            `<td>${esc(fmtDate(e.lastChangeAt)) || '—'}</td></tr>`,
        )
        .join('');
      return `<h2>${esc(g.label)}（${g.items.length}）</h2>
<div class="card"><table><thead><tr><th>实体</th><th>URN</th><th>现行事实</th><th>证据</th><th>最近变更</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: '城市事实目录',
        description: `温州城市可信数据的全量实体目录，共 ${total} 个实体，按类别分组并附现行事实数、证据数与最近变更时间。`,
        url: canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: baseUrl },
        numberOfItems: total,
        publisher: orgNode(baseUrl),
        author: editorialOrg(baseUrl),
      },
      orgNode(baseUrl),
    ],
  };

  return shell({
    title: '城市事实目录 — 温州网事实档案',
    desc: `温州城市可信数据全量实体目录（${total} 个实体）：统一实体 ID、类别、现行事实数与证据链，为外部知识服务提供稳定锚点。`,
    canonical,
    jsonLd,
    spaAssets,
    body: `${siteHeader('CITY FACT REGISTRY', '城市事实目录', `统一实体 ID、事实状态、时间版本与证据链，为外部知识服务提供稳定锚点。共 ${total} 个实体。`)}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${total}</b><span>已发布实体</span></div>
    <div class="stat"><b>${groups.size}</b><span>类别分组</span></div>
    <div class="stat"><b>${entries.reduce((s, e) => s + Number(e.currentFactCount ?? 0), 0).toLocaleString()}</b><span>现行事实合计</span></div>
  </div>
  ${sections}
  <div class="foot">机器可读版本：<a href="/catalog.json">catalog.json</a> · 本页零 JS 可读，启用 JavaScript 后自动升级为可搜索的交互版目录。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 实时新闻流 /news

export function renderNewsHtml(baseUrl: string, records: Row[], spaAssets = ''): string {
  const canonical = `${baseUrl}/news`;
  const rows = records
    .map(
      (r) =>
        `<tr><td>${esc(fmtDate(r.pubDate ?? r.createdAt))}</td>` +
        `<td><strong>${esc(r.title ?? '（无标题）')}</strong><div class="meta">${esc(r.sourceOrg ?? '未知来源')} · 正文 ${Number(r.bodyChars ?? 0)} 字 · 阶段 ${esc(r.stage ?? '')}</div></td>` +
        `<td>${esc(String(r.status ?? ''))}</td></tr>`,
    )
    .join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: '实时新闻流',
        description: '新闻发布即触发 Fast Lane；涉及城市实体的内容同时进入 Fact Lane。展示生产线已入库的新闻记录。',
        url: canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: baseUrl },
        publisher: orgNode(baseUrl),
      },
      orgNode(baseUrl),
    ],
  };
  return shell({
    title: '实时新闻流 — 温州网事实档案',
    desc: '温州城市可信数据生产线的实时新闻流：新闻入库记录、抽取阶段与事实草稿产出，新闻发布即触发事实抽取。',
    canonical,
    jsonLd,
    spaAssets,
    body: `${siteHeader('EVENT DISTRIBUTION', '实时新闻流', '新闻发布即触发 Fast Lane；涉及城市实体的内容同时进入 Fact Lane。以下为生产线已入库的新闻记录。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${records.length}</b><span>本页展示记录</span></div>
    <div class="stat"><b>${records.filter((r) => Number((r.stats as Row | undefined)?.factDrafts ?? 0) > 0).length}</b><span>产出事实草稿</span></div>
  </div>
  <h2>入库记录</h2>
  ${rows ? `<div class="card"><table><thead><tr><th>发布时间</th><th>标题 / 来源</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="meta">暂无记录。</p>'}
  <div class="foot">本页零 JS 可读，启用 JavaScript 后自动升级为可搜索的交互版新闻流。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 事实变更 /changes

export function renderChangesHtml(baseUrl: string, changes: Row[], spaAssets = ''): string {
  const canonical = `${baseUrl}/changes`;
  const typeLabel: Record<string, string> = {
    new: '新增',
    create: '新增',
    update: '更新',
    corroborate: '佐证',
    retire: '退役',
    supersede: '退役',
  };
  const rows = changes
    .map(
      (c) =>
        `<tr><td><strong>${esc(c.summary ?? `变更 #${c.id}`)}</strong>` +
        `<div class="meta">${esc(c.articleTitle ?? c.articleUrl ?? '（无来源文章）')}</div></td>` +
        `<td><a href="/archive/${esc(c.datasetCode)}/${esc(c.entitySlug)}">${esc(c.entityName)}</a></td>` +
        `<td>${esc(typeLabel[String(c.changeType)] ?? String(c.changeType))}</td>` +
        `<td>${esc(fmtDate(c.occurredAt ?? c.createdAt))}</td></tr>`,
    )
    .join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: '事实变更',
        description: '记录每次抽取对城市事实的影响，区分新增、更新、佐证与退役，保留旧口径到新主张的完整轨迹。',
        url: canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: baseUrl },
        publisher: orgNode(baseUrl),
        author: editorialOrg(baseUrl),
      },
      orgNode(baseUrl),
    ],
  };
  return shell({
    title: '事实变更 — 温州网事实档案',
    desc: '温州城市可信数据的事实变更流：每次抽取对城市事实的影响（新增/更新/佐证/退役），保留旧口径到新主张的完整轨迹。',
    canonical,
    jsonLd,
    spaAssets,
    body: `${siteHeader('FACT CHANGE TRACKER', '事实变更', '记录每次抽取对城市事实的影响，区分新增、更新、佐证与退役，并保留旧口径到新主张的完整轨迹。')}
<div class="wrap">
  <h2>最近变更（${changes.length}）</h2>
  ${rows ? `<div class="card"><table><thead><tr><th>变更 / 来源文章</th><th>影响实体</th><th>类型</th><th>发生时间</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="meta">暂无变更。</p>'}
  <div class="foot">机器可读版本：<a href="/api/changes.json">changes.json</a> · 订阅源 <a href="/feed.xml">feed.xml</a> · 本页零 JS 可读，启用 JavaScript 后自动升级为交互版。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 语料域首页 /archive/home/:dataset

export function renderDatasetHomeHtml(
  baseUrl: string,
  data: {
    dataset: { code: string; name: string; description: string | null };
    directories: {
      name: string;
      description: string | null;
      entityTotal: number;
      entities: { name: string; slug: string; lede: string | null; factCount: number; evidenceCount: number }[];
    }[];
    stats: { entities: number; facts: number; todayNews: number; todayChanges: number };
    changes: { entityName: string; entitySlug: string; summary: string | null; occurredAt: string | null }[];
  },
  spaAssets = '',
): string {
  const canonical = `${baseUrl}/archive/home/${data.dataset.code}`;
  const dirs = data.directories
    .map(
      (d) => `<h2>${esc(d.name)}（${d.entityTotal}）</h2>
<div class="card"><table><thead><tr><th>实体</th><th>导语</th><th>现行事实</th><th>证据</th></tr></thead><tbody>
${d.entities
  .map(
    (e) =>
      `<tr><td><a href="/archive/${esc(data.dataset.code)}/${esc(e.slug)}">${esc(e.name)}</a></td>` +
      `<td>${esc(e.lede ?? '')}</td><td>${e.factCount}</td><td>${e.evidenceCount}</td></tr>`,
  )
  .join('')}
</tbody></table></div>`,
    )
    .join('');
  const recentChanges = data.changes
    .slice(0, 10)
    .map(
      (c) =>
        `<li>${esc(fmtDate(c.occurredAt))} — <a href="/archive/${esc(data.dataset.code)}/${esc(c.entitySlug)}">${esc(c.entityName)}</a>：${esc(c.summary ?? '')}</li>`,
    )
    .join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `${data.dataset.name} · 语料首页`,
        description: data.dataset.description ?? `${data.dataset.name}专题事实档案首页。`,
        url: canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: baseUrl },
        publisher: orgNode(baseUrl),
        author: editorialOrg(baseUrl),
        about: {
          '@type': 'Dataset',
          name: `${data.dataset.name}事实档案`,
          url: canonical,
          creator: { '@id': `${baseUrl}/#organization` },
        },
      },
      orgNode(baseUrl),
    ],
  };
  return shell({
    title: `${data.dataset.name} — 温州网事实档案`,
    desc:
      data.dataset.description ??
      `${data.dataset.name}专题的机器可读事实档案首页：${data.stats.entities} 个实体、${data.stats.facts} 条现行事实，每条附逐字原文证据。`,
    canonical,
    jsonLd,
    spaAssets,
    body: `${siteHeader(data.dataset.name, `${data.dataset.name}档案首页`, data.dataset.description ?? '')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${data.stats.entities}</b><span>已发布实体</span></div>
    <div class="stat"><b>${data.stats.facts}</b><span>现行事实</span></div>
    <div class="stat"><b>${data.stats.todayNews}</b><span>今日新闻</span></div>
    <div class="stat"><b>${data.stats.todayChanges}</b><span>今日变更</span></div>
  </div>
  ${dirs}
  ${recentChanges ? `<h2>最近变更</h2><div class="card"><ul>${recentChanges}</ul></div>` : ''}
  <div class="foot">交互版（含知识图谱）：<a href="${esc(canonical)}">本页</a>（启用 JS 自动升级） · <a href="/archive/${esc(data.dataset.code)}/graph">知识图谱</a> · 全量目录见 <a href="/catalog">城市事实目录</a>。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 站点总览 /overview

export function renderOverviewHtml(
  baseUrl: string,
  s: { datasetCode?: string; datasetName?: string; entityCount: number; indexedEntityCount?: number },
  spaAssets = '',
): string {
  const canonical = `${baseUrl}/overview`;
  const datasetName = s.datasetName ?? '温州城市可信数据';
  const title = `温州事实档案 · ${datasetName}`;
  // entityCount = 全部已发布实体（唯一口径，与 /catalog、DB 一致）；indexedEntityCount 仅用于解释 sitemap 差异
  const desc = `基于温州本地新闻报道抽取的机器可读事实档案：${datasetName}专题 ${s.entityCount} 个已发布实体${
    s.indexedEntityCount ? `（其中 ${s.indexedEntityCount} 个已有现行事实并进入站点索引）` : ''
  }，每条事实均附逐字原文证据、模型置信度（非可信度）与可核验锚点。`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: title, url: baseUrl, inLanguage: 'zh-CN', publisher: { '@id': `${baseUrl}/#organization` } },
      orgNode(baseUrl),
      {
        '@type': 'Dataset',
        name: `${datasetName}事实档案`,
        url: s.datasetCode ? `${baseUrl}/archive/home/${s.datasetCode}` : canonical,
        creator: { '@id': `${baseUrl}/#organization` },
        ...(s.entityCount ? { size: String(s.entityCount) } : {}),
      },
    ],
  };
  const links = [
    ['城市事实目录', `/catalog`, '全量实体目录（含事实数与证据链）'],
    ['实体与主题', `/topics`, '按一级主题组织的实体索引'],
    ['事实与证据', `/facts`, '逐字原文证据与核验锚点'],
    ['实时新闻流', `/news`, '生产线入库新闻记录'],
    ['事实变更', `/changes`, '新增 / 更新 / 佐证 / 退役轨迹'],
    ['事实发布记录', `/publications`, '按来源文章归集的发布记录'],
    ['机器发布中心', `/distribution`, 'HTML · JSON · JSON-LD · FEED · MCP 出口'],
    ['AI 引用观察', `/observatory`, '固定问题集的真实探测与引用判定'],
    ...(s.datasetCode ? [[`${datasetName}档案首页`, `/archive/home/${s.datasetCode}`, '按分类目录组织的实体卡片']] : []),
    ['方法论与核验', `/methodology/`, '信源、生产流程、span_hash 核验与更正机制'],
  ] as [string, string, string][];
  return shell({
    title: `${title} — 温州网事实档案`,
    desc,
    canonical,
    jsonLd,
    spaAssets,
    body: `${siteHeader('温州有据 · 机器可读事实档案', title, '基于温州本地新闻公开报道抽取的城市可信事实库，每条事实附逐字原文证据与可核验锚点。')}
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${s.entityCount.toLocaleString()}</b><span>已发布实体</span></div>
    <div class="stat"><b>1</b><span>语料域</span></div>
  </div>
  <h2>站点导航</h2>
  <div class="card"><table><tbody>
    ${links.map(([n, u, d]) => `<tr><th><a href="${esc(u)}">${esc(n)}</a></th><td>${esc(d)}</td></tr>`).join('')}
  </tbody></table></div>
  <h2>机器出口（公开只读）</h2>
  <div class="card">
    <div>sitemap：<a href="/sitemap.xml">/sitemap.xml</a> · robots：<a href="/robots.txt">/robots.txt</a></div>
    <div>目录：<a href="/catalog.json">catalog.json</a> · 变更流：<a href="/feed.json">feed.json</a> · <a href="/feed.xml">feed.xml</a></div>
    <div>AI 索引说明：<a href="/llms.txt">llms.txt</a> · 实体 JSON：<code>/api/archive/{dataset}/{slug}.json</code></div>
  </div>
  <div class="foot">本页零 JS 可读，启用 JavaScript 后自动升级为交互版总览。</div>
  ${bylineFoot}
</div>`,
  });
}

// ---------------------------------------------------------------- 真 404 页

/** 真 404（soft-404 收紧）：不存在/未发布实体的 SPA 兜底预检失败时返回 */
export function renderNotFoundHtml(baseUrl: string, path: string): string {
  return shell({
    title: '404 — 档案不存在 · 温州网事实档案',
    desc: '您访问的事实档案不存在或未发布。',
    canonical: baseUrl,
    noindex: true,
    body: `${siteHeader('404 NOT FOUND', '档案不存在', '您访问的档案不存在或尚未发布。')}
<div class="wrap">
  <div class="card">
    <p>路径 <code>${esc(path)}</code> 没有对应的事实档案。可能原因：实体已下线、slug 有误，或该实体尚未发布。</p>
    <ul>
      <li>浏览 <a href="/catalog">城市事实目录</a> 查找实体</li>
      <li>从 <a href="/overview">站点总览</a> 进入各专题</li>
      <li>查看 <a href="/sitemap.xml">sitemap</a> 获取全部有效页面</li>
    </ul>
  </div>
  ${bylineFoot}
</div>`,
  });
}
