/**
 * 服务端渲染（机器优先）：
 * - renderArchiveHtml：把档案页数据渲染成完整静态 HTML（无 JS），供搜索引擎/AI 爬虫直接读取
 * - renderArticleSnapshotHtml：原文快照页（证据溯源用，noindex）
 * 与前端 Vue 档案页共用同一数据源（ArchiveService.page），不含交互。
 */
import type { ArchivePage } from './archive.service';
import { withBrand } from '@ssot/shared';

const esc = (v: unknown) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/**
 * 取"墙钟时间"文本 `YYYY-MM-DD HH:mm:ss`。
 * DB 的 timestamp 列经驱动回来可能是 Date 对象，也可能是字符串，两种都要正确处理：
 *   - Date：用 UTC 分量还原库里的原始存储值（驱动把它当 UTC 装载，故原值 == UTC 分量）；
 *     直接用 String(date) 会得到 "Wed Oct 14 ..." 这种英文周几，slice(0,10) 就废了。
 *   - 字符串：去掉 'T'、毫秒与尾部时区标记后截取 19 位。
 * 业务时区固定为北京时间（无夏令时），见 isoDay / isoDateTime。
 */
const wallClock = (v: unknown): string => {
  if (!v) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ${p(v.getUTCHours())}:${p(
      v.getUTCMinutes(),
    )}:${p(v.getUTCSeconds())}`;
  }
  return String(v)
    .replace('T', ' ')
    .replace(/\.\d+/, '')
    .replace(/([+-]\d{2}:?\d{2}|Z)$/, '')
    .trim()
    .slice(0, 19);
};

/** 人类可读展示（页面上显示用） */
const fmtDate = (v: unknown) => wallClock(v);

/** ISO-8601 日期（datePublished 等只到日精度） */
const isoDay = (v: unknown) => wallClock(v).slice(0, 10);

/** ISO-8601 日期时间 + 北京时间偏移（dateModified / 快照时间，P1-7） */
const isoDateTime = (v: unknown) => {
  const s = wallClock(v);
  return s ? `${s.replace(' ', 'T')}+08:00` : '';
};

/** 品牌实体：同一 @id 在首页与档案页复用，让积累的权威可归因到母品牌（P1-6） */
export const ORG_NAME = '温州网 · 事实档案';
export const orgNode = (baseUrl: string) => ({
  '@type': 'Organization',
  '@id': `${baseUrl}/#organization`,
  name: ORG_NAME,
  url: baseUrl,
  sameAs: ['https://www.66wz.com/', 'https://www.wzfood.net/'],
});

/**
 * 编辑部实体（E-E-A-T 署名）：内容生产与人工审核的责任主体。
 * 挂在 WebPage 的 author/editor 上，并链接到方法论页（流程可信 → 人格可信）。
 */
export const editorialOrg = (baseUrl: string) => ({
  '@type': 'Organization',
  '@id': `${baseUrl}/#editorial`,
  name: '温州城市可信数据编辑部',
  url: `${baseUrl}/methodology/`,
  parentOrganization: { '@id': `${baseUrl}/#organization` },
});

/**
 * 类别 → schema.org 类型映射（实体属性细填充）：
 * 让 mainEntity 从泛化 Thing 升级为带类型的语义节点，AI 引擎可按类型消费属性。
 */
const SCHEMA_TYPE_BY_CATEGORY: Record<string, string> = {
  'geo.region': 'AdministrativeArea',
  'geo.nature': 'Place',
  'geo.road': 'Place',
  'geo.landmark': 'LandmarksOrHistoricalBuildings',
  'org.company': 'Organization',
  'org.gov': 'GovernmentOrganization',
  'org.school': 'EducationalOrganization',
  'org.media': 'NewsMediaOrganization',
  'org.restaurant': 'Restaurant',
  person: 'Person',
  event: 'Event',
  product: 'Product',
  'culture.food': 'FoodProduct',
  'culture.banquet': 'FoodProduct',
};

/** 从陈述中抽年份（foundingDate / startDate），800–2100 视为有效 */
const yearOf = (s: string): string => {
  const m = s.match(/(\d{3,4})\s*年/);
  const y = m ? Number(m[1]) : NaN;
  return Number.isFinite(y) && y >= 800 && y <= 2100 ? String(y) : '';
};

/** 人口陈述 → 数值（支持「万 / 亿」单位与千分位） */
const parsePopulation = (s: string): number | null => {
  const m = s.match(/([\d,，]+(?:\.\d+)?)\s*(万|亿)?/);
  if (!m) return null;
  const base = Number(m[1].replaceAll(/[，,]/g, ''));
  if (!Number.isFinite(base) || base <= 0) return null;
  const n = m[2] === '亿' ? base * 1e8 : m[2] === '万' ? base * 1e4 : base;
  return Number.isInteger(n) ? n : Math.round(n);
};

/**
 * 是否"自称爬虫 / 非浏览器"。这是宽松启发式：覆盖 UA 里带 bot/crawl/spider 的绝大多数
 * （OAI-SearchBot、Applebot、Amazonbot、Google-CloudVertexBot 等均含 "bot"），
 * 以及 curl / wget / 脚本客户端；另显式补上几个不含上述词根的 AI 爬虫。
 * 注意：Google-Extended 不是 UA（是 robots.txt 指令），不在本名单。
 * 该函数只决定"是否走服务端渲染"，不代表信任——真实身份由 BotVerifyService 反向 DNS 复核。
 */
export const isBotUa = (ua: string | undefined): boolean =>
  !!ua &&
  /bot|crawl|spider|slurp|preview|curl|wget|python-requests|httpclient|httpx|go-http|chatgpt-user|googleother|cohere-ai|meta-externalagent/i.test(
    ua,
  );

/** 变更类型 → 中文标签：变更页与事实页的「知识变化历史」共用同一份映射，避免两处各写一套 */
const changeLabel: Record<string, string> = {
  new: '新增事实',
  update: '事实更新',
  corroborate: '佐证',
  retire: '退役',
};

const BASE_CSS = `
  :root { --ink:#1c2430; --sub:#5a6572; --line:#e3e7ec; --paper:#f6f7f9; --card:#fff; --blue:#0b5cab; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif; line-height:1.7; }
  .wrap { max-width:960px; margin:0 auto; padding:24px; }
  header.site { background:linear-gradient(135deg,#0d3f7d,#0b5cab); color:#fff; padding:16px 0; }
  header.site .bar { max-width:960px; margin:0 auto; padding:0 24px; }
  h1 { margin:0; font-size:26px; } h2 { font-size:17px; border-left:4px solid var(--blue); padding-left:10px; margin:34px 0 12px; }
  .lede { color:#dbe7f5; margin:6px 0 0; }
  .meta { color:var(--sub); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin:12px 0; }
  /* 表格规则必须收窄到 .card 作用域：这份内联样式在 SPA 接管（Vue 挂载替换 #app 内容）后仍留在 <head> 里，
     若用元素选择器 table/th/td 会泄漏到 SPA 渲染的表格上（表现为服务器出现全网格边框、而本地 dev 没有）。 */
  .card table { width:100%; border-collapse:collapse; font-size:14px; }
  .card table th,.card table td { border:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  .card table th { background:#eef2f7; font-weight:600; white-space:nowrap; }
  .quote { color:var(--sub); font-size:13px; margin-top:4px; border-left:3px solid var(--line); padding-left:8px; }
  .faq .qa { padding:10px 0; border-bottom:1px solid var(--line); }
  .faq .qa:last-child { border-bottom:0; padding-bottom:2px; }
  .faq .q { margin:0 0 6px; }
  .faq .a { margin:0; color:var(--sub); line-height:1.8; }
  .tag { display:inline-block; background:#e7f0fb; color:var(--blue); border-radius:4px; padding:1px 8px; font-size:12px; margin-right:6px; }
  a { color:var(--blue); text-decoration:none; } a:hover { text-decoration:underline; }
  .foot { color:var(--sub); font-size:12px; margin:26px 0; padding-top:12px; border-top:1px solid var(--line); }
  code { background:#eef2f7; border-radius:4px; padding:1px 6px; font-size:12px; }
  pre { white-space:pre-wrap; word-break:break-word; font-family:inherit; margin:0; }
  .byline { color:var(--sub); font-size:13px; margin:10px 0 0; }
  .byline a { color:var(--blue); }
  .stats { display:flex; flex-wrap:wrap; gap:12px; margin:14px 0; }
  .stats .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 18px; min-width:120px; }
  .stats .stat b { display:block; font-size:22px; color:var(--blue); }
  .stats .stat span { color:var(--sub); font-size:12.5px; }
  .btn { display:inline-block; background:var(--blue); color:#fff !important; border-radius:8px;
    padding:7px 16px; font-size:14px; text-decoration:none !important; }
  .btn.ghost { background:#fff; color:var(--blue) !important; border:1px solid var(--blue); }
  .btnrow { display:flex; flex-wrap:wrap; gap:10px; margin:12px 0 4px; }
  .reledge { margin:6px 0 2px; color:var(--sub); font-size:13px; }
`;

/** 从 canonical 取站点源（scheme+host），用于拼默认分享图 */
const originOf = (url: string): string => (/^https?:\/\/[^/]+/.exec(url) ?? [''])[0];

/**
 * 全站统一的 head 生成：标题/描述/canonical/分享卡片/图标/JSON-LD 都在这一处，
 * 任何内容型页面（实体页、事实页、变更页、辅助页）都走这里，避免各页各写一套导致元数据缺项。
 * 分享图未显式指定时统一用站点封面 /og-cover.jpg——有图才会被判定为 summary_large_image。
 */
export const head = (title: string, desc: string, canonical: string, extra = '', image = '') => {
  // 标题统一带上对外品牌：<title>、og:title、twitter:title 必须同源，避免分享卡片与索引标题不一致
  const pageTitle = withBrand(title);
  const origin = originOf(canonical);
  const img = image || (origin ? `${origin}/og-cover.jpg` : '');
  return `
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:site_name" content="${esc(ORG_NAME)}">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(pageTitle)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${esc(canonical)}">
  ${img ? `<meta property="og:image" content="${esc(img)}">\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">\n  <meta property="og:image:alt" content="${esc(pageTitle)}">` : ''}
  <meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${esc(pageTitle)}">
  <meta name="twitter:description" content="${esc(desc)}">
  ${img ? `<meta name="twitter:image" content="${esc(img)}">\n  <meta name="twitter:image:alt" content="${esc(pageTitle)}">` : ''}
  <style>${BASE_CSS}</style>
  ${extra}`;
};

/**
 * 档案页服务端渲染版：与 /api/archive/:dataset/:slug 同一数据源。
 * 机器（搜索引擎 / LLM 爬虫）访问 /archive/:dataset/:slug 时由部署层把请求交给本端点。
 *
 * @param spaAssets SSG 场景注入的前台 SPA 资源标签（<link>/<script>）：
 *   静态内容包在 #app 内，启用 JS 的浏览器由 Vue 挂载替换，自动升级为交互版；
 *   爬虫 / 禁 JS 环境直读静态全量内容。SSR（bot 实时）路径不传，保持零 JS 纯静态。
 */
export function renderArchiveHtml(page: ArchivePage, baseUrl: string, spaAssets = ''): string {
  const e = page.entity;
  const canonical = `${baseUrl}/archive/${e.datasetCode}/${e.slug}`;

  // 证据回链：每条证据指向原始报道（subjectOf，供 AI/搜索引擎把事实主张回链到源）
  const subjectOf = (page.evidence as { sourceUrl?: string | null; articleTitle?: string | null; materialTitle?: string | null; publishedAt?: string | null }[])
    .map((ev) => ({
      '@type': 'WebPage' as const,
      name: ev.materialTitle ?? ev.articleTitle ?? undefined,
      url: ev.sourceUrl ?? undefined,
      ...(isoDay(ev.publishedAt) ? { datePublished: isoDay(ev.publishedAt) } : {}),
    }))
    .filter((x) => x.url);

  // JSON-LD：机器可直接消费的结构化描述。
  // @graph 双节点：WebPage（页面元数据）+ FAQPage（问答形态，AI 引擎直接摘引友好）
  const factRows = page.facts as Record<string, unknown>[];
  // FAQ 自动生成：直接由高置信现行事实生成问答，不按维度硬套模板。
  // 首问「{name}是什么？」用导语（或最高置信事实）作答；其余逐条取现行事实陈述为答，
  // 维度用中文名做自然引导，答案去重，上限 5 条。
  const dimNameMap = new Map(
    (page.dimensions as { code?: string; name?: string }[]).map((d) => [String(d.code), d.name ?? String(d.code)]),
  );
  const faqItems: { q: string; a: string }[] = [];
  const usedAnswers = new Set<string>();
  const usedQuestions = new Set<string>();
  const pushFaq = (q: string, a: string) => {
    if (!a || usedAnswers.has(a) || usedQuestions.has(q)) return false;
    usedAnswers.add(a);
    usedQuestions.add(q);
    faqItems.push({ q, a });
    return true;
  };
  const activeFacts = factRows
    .filter((f) => f.status === 'active' && String(f.statement ?? '').trim())
    .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
  if (e.lede || activeFacts.length) {
    pushFaq(`${e.name}是什么？`, e.lede || String(activeFacts[0]?.statement ?? ''));
  }
  // 同维度有多条事实时问题会撞名，用 subjectScope 区分、再退回维度序号；都区分不出则跳过，避免重复问答。
  const dimSeq = new Map<string, number>();
  for (const f of activeFacts) {
    if (faqItems.length >= 5) break;
    const stmt = String(f.statement ?? '').trim();
    if (!stmt || usedAnswers.has(stmt)) continue;
    const dimCode = String(f.dimension ?? '').trim();
    const dimName = dimNameMap.get(dimCode) || dimCode;
    const scope = String(f.subjectScope ?? '').trim();
    const candidates = dimName
      ? [`${e.name}的${dimName}？`, scope ? `${e.name}在「${scope}」中的${dimName}？` : '']
      : [`关于${e.name}，档案记录了什么？`];
    let done = candidates.filter(Boolean).some((q) => pushFaq(q, stmt));
    if (!done && dimName) {
      // 再退回维度序号（第 N 条），既能区分又是自然问法
      const n = (dimSeq.get(dimCode) ?? 1) + 1;
      dimSeq.set(dimCode, n);
      done = pushFaq(`${e.name}的${dimName}（第 ${n} 条）？`, stmt);
    }
    if (!done) continue;
  }
  // ---- 实体属性细填充（第三阶段）：按类别定 schema 类型，并从现行事实/属性中
  // 抽取强语义属性（foundingDate / population / elevation / startDate…），
  // 其余维度以 additionalProperty（PropertyValue）透出，供 AI 按维度消费。
  const catCode = (e.categoryCode ?? '') as string;
  const schemaType = SCHEMA_TYPE_BY_CATEGORY[catCode] ?? 'Thing';
  const factBy = (dim: string) => factRows.find((f) => String(f.dimension ?? '') === dim);
  const attrMap = (e.attrsJson ?? {}) as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  if (schemaType === 'Event') {
    const t = factBy('举办时间');
    const y = t ? yearOf(String(t.statement ?? '')) : '';
    if (y) props.startDate = y;
    const loc = factBy('举办地点');
    if (loc?.statement) props.location = { '@type': 'Place', name: String(loc.statement) };
  }
  if (catCode.startsWith('org.')) {
    const t = factBy('成立时间') ?? factBy('创办时间') ?? factBy('起源由来');
    const y = t ? yearOf(String(t.statement ?? '')) : '';
    if (y) props.foundingDate = y;
  }
  if (catCode === 'geo.region') {
    const p = factBy('人口');
    if (p) {
      const n = parsePopulation(String(p.statement ?? ''));
      if (n != null) props.population = n;
    }
  }
  if (catCode.startsWith('geo.')) {
    const el = factBy('海拔');
    if (el) {
      const m = String(el.statement ?? '').match(/([\d,，]+(?:\.\d+)?)\s*米/);
      if (m) {
        const n = Number(m[1].replaceAll(/[，,]/g, ''));
        if (Number.isFinite(n)) props.elevation = n;
      }
    }
  }
  if (attrMap.region) {
    props.address = { '@type': 'PostalAddress', addressLocality: String(attrMap.region), addressCountry: 'CN' };
  }
  if (schemaType === 'Person') {
    if (attrMap.role) props.jobTitle = String(attrMap.role);
    if (attrMap.org) props.worksFor = { '@type': 'Organization', name: String(attrMap.org) };
  }
  if (factRows.length) {
    props.additionalProperty = factRows.slice(0, 10).map(
      (f) => ({
        '@type': 'PropertyValue',
        name: String(f.dimension ?? ''),
        value: String(f.statement ?? ''),
      }),
    );
  }

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: `${e.name} — 档案`,
        description: e.lede ?? '',
        inLanguage: 'zh-CN',
        url: canonical,
        isPartOf: {
          '@type': 'WebSite',
          name: e.datasetName,
          url: `${baseUrl}/archive/home/${e.datasetCode}`,
        },
        datePublished: isoDay(e.publishedAt) || undefined,
        dateModified: isoDateTime(e.publishedAt) || undefined,
        author: editorialOrg(baseUrl),
        editor: editorialOrg(baseUrl),
        publisher: orgNode(baseUrl),
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: '事实档案首页', item: `${baseUrl}/overview` },
            {
              '@type': 'ListItem',
              position: 2,
              name: e.datasetName ?? '语料域',
              item: `${baseUrl}/archive/home/${e.datasetCode}`,
            },
            { '@type': 'ListItem', position: 3, name: e.name, item: canonical },
          ],
        },
        ...(subjectOf.length ? { subjectOf } : {}),
        mainEntity: {
          '@type': schemaType,
          '@id': `${canonical}#entity`,
          name: e.name,
          identifier: e.urn,
          description: e.lede ?? '',
          additionalType: e.categoryName ?? undefined,
          url: canonical,
          ...props,
        },
      },
      ...(faqItems.length
        ? [
            {
              '@type': 'FAQPage',
              mainEntity: faqItems.map((it) => ({
                '@type': 'Question',
                name: it.q,
                acceptedAnswer: { '@type': 'Answer', text: it.a },
              })),
            },
          ]
        : []),
    ],
  });

  const attrs = Object.entries((e.attrsJson ?? {}) as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
    .join('');

  const facts = (page.facts as Record<string, unknown>[])
    .map((f) => {
      const evs = ((f.evidences ?? []) as Record<string, unknown>[])
        .map((ev) => `<div class="quote">证据 ${esc(ev.code)}：${esc(ev.quote ?? '')}</div>`)
        .join('');
      // 单条事实的稳定公开地址：编号锚点 + 永久链接（可被引用/收藏/机器读取）
      const permalink = `${baseUrl}/archive/${e.datasetCode}/${e.slug}/fact/${encodeURIComponent(String(f.code))}`;
      return `<tr id="fact-${esc(f.code)}">
        <td><a class="perma" href="${esc(permalink)}">${esc(f.code)}</a></td>
        <td>${esc(f.dimension)}</td><td>${esc(f.statement)}</td>
        <td>${Number(f.confidence ?? 0).toFixed(2)}</td>
        <td>${evs}</td></tr>`;
    })
    .join('');

  const events = (page.events as Record<string, unknown>[])
    .map(
      (ev) => `<div class="card">
        <div><span class="tag">${esc(ev.timeText)}</span>${esc(ev.description)}</div>
        <div class="meta">地点：${esc(ev.location ?? '—')} · 主体：${esc(ev.subject ?? '—')} · 类型：${esc(ev.eventType ?? '—')}</div>
        ${ev.quote ? `<div class="quote">「${esc(ev.quote)}」</div>` : ''}
      </div>`,
    )
    .join('');

  const nodes = new Map((page.graph?.nodes ?? []).map((n) => [n.id, n]));
  const relations = (page.graph?.edges ?? [])
    .map((rel) => {
      const h = nodes.get(rel.head);
      const t = nodes.get(rel.tail);
      const link = (n?: { slug: string | null; datasetCode: string | null; name: string }) =>
        n?.slug && n.datasetCode
          ? `<a href="${esc(baseUrl)}/archive/${esc(n.datasetCode)}/${esc(n.slug)}">${esc(n.name)}</a>`
          : esc(n?.name ?? '—');
      return `<tr><td>${link(h)}</td><td>${esc(rel.label)}</td><td>${link(t)}</td>
        <td>${Number(rel.confidence).toFixed(2)}</td><td>${esc(rel.statement ?? '')}</td></tr>`;
    })
    .join('');

  const evidence = (page.evidence as Record<string, unknown>[])
    .map((ev) => {
      const snap =
        ev.articleId != null
          ? ` <a href="${esc(baseUrl)}/api/archive/article/${esc(ev.articleId)}/raw">本地快照</a>`
          : '';
      const outer = ev.sourceUrl ? ` <a href="${esc(ev.sourceUrl)}" rel="nofollow">原文</a>` : '';
      return `<tr><td>${esc(ev.code)}</td><td>${esc(ev.materialTitle ?? ev.articleTitle ?? '')}</td>
        <td>${esc(ev.sourceOrg ?? '')}</td><td>${esc(fmtDate(ev.publishedAt))}</td>
        <td>${outer}${snap}</td><td>${esc(ev.quote ?? '')}</td></tr>`;
    })
    .join('');

  const articles = (page.articles as Record<string, unknown>[])
    .map((a) => {
      const snap = ` <a href="${esc(baseUrl)}/api/archive/article/${esc(a.id)}/raw">本地快照</a>`;
      const outer = a.url ? ` <a href="${esc(a.url)}" rel="nofollow">原文</a>` : '';
      return `<tr><td>${esc(a.title)}</td><td>${esc(a.sourceOrg ?? '')}</td>
        <td>${esc(fmtDate(a.publishedAt))}</td><td>${esc(a.batch)}</td><td>${outer}${snap}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    `${e.name} — ${e.datasetName}档案`,
    e.lede ?? `${e.name}的机器可读档案页，事实均附逐字原文证据。`,
    canonical,
    `<script type="application/ld+json">${jsonLd}</script>`,
    `${baseUrl}/og-cover.jpg`,
  )}</head>
<body>
<div id="app">
<header class="site"><div class="bar">
  <div class="meta">${esc(e.datasetName)} · ${esc(e.categoryName ?? '')} · <a style="color:#fff" href="${esc(canonical)}">${esc(canonical)}</a></div>
  <h1>${esc(e.name)}</h1>
  <p class="lede">${esc(e.lede ?? '')}</p>
</div></header>
<div class="wrap">
  ${attrs ? `<h2>关键属性</h2><div class="card"><table><tbody>${attrs}</tbody></table></div>` : ''}
  ${
    faqItems.length
      ? `<h2>常见问题</h2><div class="card faq">${faqItems
          .map(
            (it) =>
              `<div class="qa"><p class="q"><strong>问：${esc(it.q)}</strong></p><p class="a">答：${esc(it.a)}</p></div>`,
          )
          .join('')}</div>`
      : ''
  }
  <h2>现行事实（${(page.facts as unknown[]).length}）</h2>
  ${
    facts
      ? `<div class="card"><table><thead><tr><th>编号</th><th>维度</th><th>陈述</th><th>模型置信度（非可信度）</th><th>逐字证据</th></tr></thead><tbody>${facts}</tbody></table></div>`
      : '<p class="meta">暂无现行事实。</p>'
  }
  ${events ? `<h2>事件时间线</h2>${events}` : ''}
  ${
    relations
      ? `<h2>关系图谱（一跳）</h2><div class="card"><table><thead><tr><th>头实体</th><th>关系</th><th>尾实体</th><th>模型置信度（非可信度）</th><th>陈述</th></tr></thead><tbody>${relations}</tbody></table></div>`
      : ''
  }
  ${
    evidence
      ? `<h2>证据链（${(page.evidence as unknown[]).length}）</h2><div class="card"><table><thead><tr><th>编号</th><th>材料</th><th>来源</th><th>发布时间</th><th>链接</th><th>引句</th></tr></thead><tbody>${evidence}</tbody></table></div>`
      : ''
  }
  ${
    articles
      ? `<h2>来源文章（${(page.articles as unknown[]).length}）</h2><div class="card"><table><thead><tr><th>标题</th><th>来源</th><th>发布时间</th><th>批次</th><th>链接</th></tr></thead><tbody>${articles}</tbody></table></div>`
      : ''
  }
  <div class="foot">
    本页由系统自动生成（机器可读版，revision ${esc(e.revision)}，生成于 ${esc(fmtDate(page.generatedAt))}）。
    事实与关系均来自新闻语料的抽取结果并附逐字原文证据；本地快照为入库时存档的原文副本，供证据溯源。
    交互版：<a href="${esc(canonical)}">${esc(canonical)}</a>
  </div>
  <p class="byline">
    内容生产与审核责任：<strong>温州城市可信数据编辑部</strong>（温州网 · 事实档案；自动抽取入档，人工抽检复核）·
    编辑流程、信源边界与更正机制见<a href="${esc(baseUrl)}/methodology/">方法论页</a>
  </p>
</div>
</div>
${spaAssets}
</body>
</html>`;
}

/**
 * 单条事实页（可抓取 HTML）：事实本身、状态、时间与槽位、逐字证据、机器可读入口。
 * 与 `/api/archive/:dataset/:slug/fact/:code` 的 JSON 同源；供搜索引擎/AI 爬虫直接读取，也可被稳定引用。
 */
export function renderFactHtml(
  data: {
    entity: {
      name: string;
      urn: string;
      slug: string;
      datasetCode: string;
      categoryName?: string | null;
      lede?: string | null;
    };
    fact: Record<string, unknown>;
    sources: Record<string, unknown>[];
    /** 该事实的知识变化历史（fact_change 记录，供「知识变化历史」表渲染） */
    history: Record<string, unknown>[];
  },
  baseUrl: string,
  spaAssets = '',
): string {
  const e = data.entity;
  const f = data.fact;
  const code = String(f.code ?? '');
  const canonical = `${baseUrl}/archive/${esc(e.datasetCode)}/${esc(e.slug)}/fact/${encodeURIComponent(code)}`;
  const entityUrl = `${baseUrl}/archive/${e.datasetCode}/${e.slug}`;
  const entityJsonUrl = `${baseUrl}/api/archive/${e.datasetCode}/${e.slug}.json`;
  const jsonUrl = `${baseUrl}/api/archive/${e.datasetCode}/${e.slug}/fact/${encodeURIComponent(code)}`;
  const evidences = data.sources
    .map((ev) => {
      const src = ev.sourceUrl ? ` · <a href="${esc(ev.sourceUrl)}" rel="nofollow">原文</a>` : '';
      const snap =
        ev.articleId != null
          ? ` · <a href="${esc(baseUrl)}/api/archive/article/${esc(ev.articleId)}/raw">本地快照</a>` +
            ` · <a href="${esc(baseUrl)}/articles/${esc(ev.articleId)}">本篇抽取的全部事实</a>`
          : '';
      return `<div class="card">
      <div class="quote">「${esc(ev.quote ?? '')}」</div>
      <div class="meta">证据 ${esc(ev.code ?? '')} · 校验 ${esc(ev.verifyStatus ?? '')} · 区间 ${esc(ev.spanStart ?? '')}–${esc(
        ev.spanEnd ?? '',
      )} · span_hash <code>${esc(String(ev.spanHash ?? '').slice(0, 16))}</code></div>
      <div class="meta">来源：${esc(ev.sourceOrg ?? '—')}${ev.materialTitle ? ` · ${esc(ev.materialTitle)}` : ''}${
        ev.publishedAt ? ` · 发布 ${esc(ev.publishedAt)}` : ''
      }${src}${snap}</div>
    </div>`;
    })
    .join('');

  const kv = (rows: [string, unknown][]) =>
    rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`).join('');

  const history = data.history.length
    ? `<div class="card"><table><thead><tr><th>时间</th><th>变化</th><th>说明</th></tr></thead><tbody>${data.history
        .map(
          (h) =>
            `<tr><td>${esc(isoDay(h.created_at))}</td><td>${esc(
              changeLabel[String(h.change_type)] ?? String(h.change_type ?? ''),
            )}</td><td>${esc(h.summary ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="meta">该事实暂无可追溯的知识变化记录。</p>';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Claim',
    '@id': canonical,
    identifier: code,
    name: String(f.statement ?? ''),
    text: String(f.statement ?? ''),
    datePublished: isoDay(f.createdAt),
    ...(isoDateTime(f.updatedAt) ? { dateModified: isoDateTime(f.updatedAt) } : {}),
    about: { '@type': 'Thing', name: e.name, identifier: e.urn, url: entityUrl },
    publisher: orgNode(baseUrl),
    ...(data.sources.some((s) => s.sourceUrl) ? { citation: data.sources.map((s) => s.sourceUrl).filter(Boolean) } : {}),
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    `${String(f.statement ?? code)} · ${e.name} · 事实档案`,
    String(f.statement ?? ''),
    canonical,
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('</', '<\\/')}</script>`,
  )}</head>
<body>
<div id="app">
<div class="wrap">
  <p class="meta"><a href="${esc(entityUrl)}">${esc(e.name)}</a> 的单条事实 <code>${esc(code)}</code></p>
  <h1>${esc(String(f.statement ?? ''))}</h1>
  <div class="card">
    <table><tbody>${kv([
      ['状态', f.status],
      ['维度', f.dimension],
      ['语义角色（semantic_role）', f.semanticRole],
      ['时间键（period_key）', f.periodKey],
      ['主体范围（subject_scope）', f.subjectScope],
      ['版本', `v${f.version ?? 1}`],
      ['模型置信度（非可信度）', Number(f.confidence ?? 0).toFixed(2)],
      ['佐证源数', f.corroborateCount ?? 1],
      ['事实类型', f.factType],
    ])}</tbody></table>
  </div>
  <h2>时间口径</h2>
  <div class="card">
    <table><tbody>${kv([
      ['适用时间', [f.validFrom, f.validTo].filter(Boolean).join(' → ') || '未知（原报道未给出）'],
      ['系统首次知悉', f.firstSeenAt],
      ['最近核验', f.lastVerifiedAt],
      ['来源发布时间', data.sources[0]?.publishedAt],
    ])}</tbody></table>
    <p class="meta">来源发布时间来自原报道，不冒充统计截止时间或核验时间。</p>
  </div>
  <h2>逐字证据（${data.sources.length}）</h2>
  ${evidences || '<p class="meta">无</p>'}
  <h2>知识变化历史</h2>
  ${history}
  <h2>机器可读入口</h2>
  <div class="card">
    <ul>
      <li>本条事实 JSON：<a href="${esc(jsonUrl)}">${esc(jsonUrl)}</a></li>
      <li>实体 JSON：<a href="${esc(entityJsonUrl)}">${esc(entityJsonUrl)}</a></li>
      <li>实体档案页：<a href="${esc(entityUrl)}">${esc(entityUrl)}</a></li>
      <li>URN：<code>${esc(e.urn)}</code></li>
    </ul>
  </div>
  <p class="byline">
    内容生产与审核责任：<strong>温州城市可信数据编辑部</strong>（温州网 · 事实档案；自动抽取入档，人工抽检复核）·
    编辑流程、信源边界与更正机制见<a href="${esc(baseUrl)}/methodology/">方法论页</a>
  </p>
</div>
</div>
${spaAssets}
</body>
</html>`;
}

/**
 * 单条变更记录页（可抓取 HTML）：变化类型、变更前后状态事实、机制判定、来源报道、机器可读入口。
 * 与 `/api/archive/:dataset/:slug/change/:id` 的 JSON 同源，供稳定引用与爬虫读取。
 */
export function renderChangeHtml(
  data: {
    entity: { name: string; urn: string; slug: string; datasetCode: string };
    change: Record<string, unknown>;
  },
  baseUrl: string,
  spaAssets = '',
): string {
  const e = data.entity;
  const c = data.change;
  const id = String(c.id ?? '');
  const canonical = `${baseUrl}/archive/${esc(e.datasetCode)}/${esc(e.slug)}/change/${encodeURIComponent(id)}`;
  const entityUrl = `${baseUrl}/archive/${e.datasetCode}/${e.slug}`;
  const entityJsonUrl = `${baseUrl}/api/archive/${e.datasetCode}/${e.slug}.json`;
  const jsonUrl = `${baseUrl}/api/archive/${e.datasetCode}/${e.slug}/change/${encodeURIComponent(id)}`;
  const label = changeLabel[String(c.changeType ?? '')] ?? String(c.changeType ?? '变更');
  const mech = (c.mechanismJson ?? {}) as Record<string, unknown>;
  // 审计/裁决写入的是 verdict（coexist/replace/append/duplicate），新写入的变更机制是 kind（new/corroborate…）
  const verdict = mech.verdict ?? mech.kind ?? null;
  const summary = String(c.summary ?? '');

  const factRow = (f: unknown, name: string) => {
    const o = f as { code?: unknown; statement?: unknown; status?: unknown; version?: unknown; dimension?: unknown } | null;
    if (!o) return `<tr><th>${esc(name)}</th><td class="meta">—</td></tr>`;
    const code = String(o.code ?? '');
    const url = `${baseUrl}/archive/${e.datasetCode}/${e.slug}/fact/${encodeURIComponent(code)}`;
    return `<tr><th>${esc(name)}</th><td>
      <a href="${esc(url)}"><code>${esc(code)}</code></a>
      <span class="tag">${esc(o.status ?? '')}</span>
      <span class="tag">v${esc(o.version ?? 1)}</span>
      ${o.dimension ? `<span class="tag">${esc(o.dimension)}</span>` : ''}
      <div>${esc(o.statement ?? '')}</div></td></tr>`;
  };

  const article = c.articleId
    ? `<div class="card"><table><tbody>
        <tr><th>报道标题</th><td>${esc(c.articleTitle ?? '—')}</td></tr>
        <tr><th>发布时间</th><td>${esc(isoDay(c.articlePublishedAt))}</td></tr>
        <tr><th>原文链接</th><td>${
          c.articleUrl ? `<a href="${esc(c.articleUrl)}" rel="nofollow">${esc(c.articleUrl)}</a>` : '—'
        } · <a href="${esc(baseUrl)}/api/archive/article/${esc(c.articleId)}/raw">本地快照</a></td></tr>
      </tbody></table></div>`
    : '<p class="meta">本条变更未关联报道。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    `${summary || `${label} · 变更 #${id}`} · ${e.name} · 事实变更记录`,
    summary,
    canonical,
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      '@id': canonical,
      name: summary || `变更 #${id}`,
      identifier: `change-${id}`,
      additionalType: 'https://schema.org/UpdateAction',
      dateCreated: isoDay(c.createdAt),
      about: { '@type': 'Thing', name: e.name, identifier: e.urn, url: entityUrl },
      publisher: orgNode(baseUrl),
    }).replaceAll('</', '<\\/')}</script>`,
  )}</head>
<body>
<div id="app">
<div class="wrap">
  <p class="meta"><a href="${esc(entityUrl)}">${esc(e.name)}</a> 的事实变更记录 <code>#${esc(id)}</code></p>
  <h1>${esc(summary || `${label} · 变更 #${id}`)}</h1>
  <div class="card">
    <table><tbody>
      <tr><th>变更类型（change_type）</th><td><span class="tag">${esc(label)}</span></td></tr>
      <tr><th>机制（verdict / kind）</th><td>${verdict ? `<span class="tag">${esc(verdict)}</span>` : '<span class="meta">—</span>'}</td></tr>
      <tr><th>入库时间</th><td>${esc(fmtDate(c.createdAt))}</td></tr>
      <tr><th>变化发生时间（occurred_at）</th><td>${esc(fmtDate(c.occurredAt) || '—')}</td></tr>
      <tr><th>处理说明（rationale）</th><td>${esc(c.rationale ?? '—')}</td></tr>
    </tbody></table>
  </div>
  <h2>变更前后状态事实</h2>
  <div class="card"><table><tbody>
    ${factRow(c.fromFact, '变更前（from_fact）')}
    ${factRow(c.toFact, '变更后（to_fact）')}
  </tbody></table></div>
  <h2>触发本条变更的报道</h2>
  ${article}
  <h2>机器可读入口</h2>
  <div class="card">
    <ul>
      <li>本条变更 JSON：<a href="${esc(jsonUrl)}">${esc(jsonUrl)}</a></li>
      <li>实体 JSON：<a href="${esc(entityJsonUrl)}">${esc(entityJsonUrl)}</a></li>
      <li>实体档案页：<a href="${esc(entityUrl)}">${esc(entityUrl)}</a></li>
      <li>URN：<code>${esc(e.urn)}</code></li>
    </ul>
  </div>
  <p class="byline">
    内容生产与审核责任：<strong>温州城市可信数据编辑部</strong>（温州网 · 事实档案；自动抽取入档，人工抽检复核）·
    编辑流程、信源边界与更正机制见<a href="${esc(baseUrl)}/methodology/">方法论页</a>
  </p>
</div>
</div>
${spaAssets}
</body>
</html>`;
}

/** 原文快照页（证据溯源）：noindex，避免与原站竞争收录 */
export function renderArticleSnapshotHtml(a: {
  title: string;
  url: string | null;
  sourceOrg: string | null;
  sourceSite: string | null;
  publishedAt: string | null;
  fetchedAt: Date | null;
  body: string;
}): string {
  const canonical = a.url ?? '';
  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    `【快照】${a.title}`,
    `原文快照（存档于 ${fmtDate(a.fetchedAt)}），仅供事实证据溯源。`,
    canonical,
    '<meta name="robots" content="noindex, nofollow">',
  )}</head>
<body>
<header class="site"><div class="bar">
  <div class="meta">原文快照 · 本系统存档 · <a style="color:#fff" href="${esc(canonical)}" rel="nofollow">查看原文</a></div>
  <h1 style="font-size:20px">${esc(a.title)}</h1>
</div></header>
<div class="wrap">
  <div class="card meta">
    来源机构：${esc(a.sourceOrg ?? '—')} · 来源站点：${esc(a.sourceSite ?? '—')} ·
    发布时间：${esc(fmtDate(a.publishedAt))} · 入库存档：${esc(fmtDate(a.fetchedAt))} ·
    正文 ${a.body.length} 字
  </div>
  <div class="card"><pre>${esc(a.body)}</pre></div>
  <div class="foot">本页为系统入库时存档的原文副本（noindex），用于事实证据溯源；内容以原站为准，原站可能已更新或删除。</div>
</div>
</body>
</html>`;
}

/**
 * 站点首页服务端渲染版：搜索引擎与 AI 需要一个可索引的顶层节点，
 * 用来挂载 WebSite + Organization（品牌实体归因）+ Dataset。
 * 由部署层把 /overview 的爬虫请求交给 /api/archive/site。
 */
export function renderSiteHomeHtml(
  baseUrl: string,
  opts: { datasetName?: string; datasetCode?: string; entityCount?: number; indexedEntityCount?: number } = {},
): string {
  const canonical = `${baseUrl}/overview`;
  const datasetName = opts.datasetName ?? '瓯菜';
  const title = `温州事实档案 · ${datasetName}`;
  // entityCount = 全部已发布实体（唯一口径）；indexedEntityCount 仅用于解释 sitemap 索引差异
  const stat = opts.entityCount
    ? `现有 ${opts.entityCount} 个实体${
        opts.indexedEntityCount ? `（其中 ${opts.indexedEntityCount} 个已有现行事实并进入站点索引）` : ''
      }`
    : '';
  const desc = `基于温州本地新闻报道抽取的机器可读事实档案：${datasetName}专题${stat}，每条事实均附逐字原文证据、模型置信度（非可信度）与可核验锚点。`;
  const org = orgNode(baseUrl);
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: title, url: baseUrl, inLanguage: 'zh-CN', publisher: { '@id': org['@id'] } },
      org,
      {
        '@type': 'Dataset',
        name: `${datasetName}事实档案`,
        url: opts.datasetCode ? `${baseUrl}/archive/home/${opts.datasetCode}` : canonical,
        creator: { '@id': org['@id'] },
        ...(opts.entityCount ? { size: String(opts.entityCount) } : {}),
      },
    ],
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>${head(
    title,
    desc,
    canonical,
    `<script type="application/ld+json">${jsonLd}</script>`,
    `${baseUrl}/og-cover.jpg`,
  )}</head>
<body>
<header class="site"><div class="bar">
  <div class="meta">温州有据 · 机器可读事实档案 · <a style="color:#fff" href="${esc(canonical)}">${esc(canonical)}</a></div>
  <h1 style="font-size:20px">${esc(title)}</h1>
</div></header>
<div class="wrap">
  <div class="card">${esc(desc)}</div>
  <h2>语料域</h2>
  <div class="card">${
    opts.datasetCode
      ? `<a href="${esc(baseUrl)}/archive/home/${esc(opts.datasetCode)}">${esc(datasetName)}档案首页</a>`
      : esc(datasetName)
  }</div>
  <h2>机器出口（公开只读）</h2>
  <div class="card">
    <div>sitemap：<a href="${esc(baseUrl)}/sitemap.xml">${esc(baseUrl)}/sitemap.xml</a></div>
    <div>目录：<a href="${esc(baseUrl)}/api/archive/catalog.json">catalog.json</a></div>
    <div>变更流：<a href="${esc(baseUrl)}/api/archive/feed.json">feed.json</a> · <a href="${esc(baseUrl)}/api/archive/feed.xml">feed.xml</a></div>
  </div>
  <div class="foot">全部公开只读，供搜索引擎 / AI 引用核验。每条事实附逐字原文证据与物理锚点。</div>
</div>
</body>
</html>`;
}


/**
 * 文章事实稿页（/articles/{articleId}）：独立整页版式，不复用本文件的 BASE_CSS 与站点框架，
 * 实现见 ./article-factsheet.ts（自带 topbar / 三栏布局 / 侧栏 / 页脚 / 打印与复制脚本）。
 */
export { renderArticleFactSheetHtml as renderArticleFactsHtml } from './article-factsheet';
