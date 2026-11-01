/**
 * 方法论 / 关于本站（E-E-A-T 页）：
 * 独立的完整静态 HTML（零 JS、内嵌样式），由 ssg.ts 静态化为 /methodology/index.html。
 * 目的：把已有的信源、抽取、人工核验、版本管理流程变成公开可读的信任资产，
 * 供搜索引擎 E-E-A-T 评估与 AI 引用核验。内容只描述系统真实存在的机制，不夸大。
 */
import { withBrand } from '@ssot/shared';

const esc = (v: unknown) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function renderMethodologyHtml(baseUrl: string): string {
  const org = {
    '@type': 'Organization',
    '@id': `${baseUrl}/#organization`,
    name: '温州网 · 事实档案',
    url: baseUrl,
    sameAs: ['https://www.66wz.com/', 'https://www.wzfood.net/'],
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'AboutPage',
        '@id': `${baseUrl}/methodology/#webpage`,
        url: `${baseUrl}/methodology/`,
        name: '方法论与核验 — 温州网 · 事实档案',
        description: '温州网事实档案的信源标准、抽取流程、逐字引句核验方法与版本策略。',
        inLanguage: 'zh-CN',
        isPartOf: { '@id': `${baseUrl}/#website` },
        about: { '@id': `${baseUrl}/#website` },
      },
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        url: baseUrl,
        name: '温州网 · 事实档案',
        inLanguage: 'zh-CN',
        publisher: org,
      },
      org,
    ],
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(withBrand('方法论与核验 — 温州网 · 事实档案'))}</title>
<meta name="description" content="温州网事实档案的方法论：信源标准（本地媒体公开报道）、五步生产流程、逐字引句与 span_hash 核验方法、版本与更正策略。每条事实可独立核验。">
<link rel="canonical" href="${esc(baseUrl)}/methodology/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="温州网 · 事实档案">
<meta property="og:title" content="${esc(withBrand('方法论与核验 — 温州网 · 事实档案'))}">
<meta property="og:description" content="信源标准、抽取流程、逐字引句核验与版本策略——每条事实可独立核验。">
<meta property="og:url" content="${esc(baseUrl)}/methodology/">
<meta property="og:image" content="${esc(baseUrl)}/og-cover.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(withBrand('方法论与核验 — 温州网 · 事实档案'))}">
<meta name="twitter:description" content="信源标准、抽取流程、逐字引句核验与版本策略——每条事实可独立核验。">
<meta name="twitter:image" content="${esc(baseUrl)}/og-cover.jpg">
<meta property="og:locale" content="zh_CN">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
:root { --ink:#1a2233; --muted:#5b6472; --line:#e3e7ee; --bg:#f7f8fa; --card:#ffffff; --accent:#0d6ef2; --accent2:#0d9463; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:var(--bg); }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.wrap { max-width:820px; margin:0 auto; padding:32px 20px 64px; }
header.site { display:flex; align-items:center; justify-content:space-between; margin-bottom:28px; }
.brand { font-weight:700; font-size:16px; color:var(--ink); }
.brand small { color:var(--muted); font-weight:400; margin-left:8px; }
header.site a.home { font-size:13.5px; }
h1 { font-size:26px; line-height:1.4; margin-bottom:6px; }
p.sub { color:var(--muted); font-size:14px; margin-bottom:26px; }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:22px 24px; margin-bottom:16px; }
h2 { font-size:17px; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
h2 .no { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:6px; background:var(--accent); color:#fff; font-size:12.5px; }
section p { margin-bottom:10px; }
section p:last-child { margin-bottom:0; }
ol.steps { margin:6px 0 0 2px; list-style:none; counter-reset:step; }
ol.steps li { counter-increment:step; position:relative; padding-left:34px; margin-bottom:10px; }
ol.steps li::before { content:counter(step); position:absolute; left:0; top:3px; width:22px; height:22px; border-radius:50%; background:var(--accent2); color:#fff; font-size:12px; font-weight:600; display:grid; place-items:center; }
code { font:13px/1.6 ui-monospace,Consolas,monospace; background:#eef2f7; border-radius:4px; padding:1px 6px; }
footer { margin-top:28px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); padding-top:16px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="site">
    <span class="brand">温州网 · 事实档案<small>温州有据</small></span>
    <a class="home" href="/">← 返回站点首页</a>
  </header>
  <h1>方法论与核验</h1>
  <p class="sub">本页说明事实档案的信源标准、生产流程、核验方法与版本策略。每条事实均可独立核验。</p>

  <section>
    <h2><span class="no">1</span>我们是谁</h2>
    <p>本站由温州网（66wz.com，温州市新闻传媒中心旗下）运营，是面向公众、搜索引擎与 AI 的城市可信事实档案。<strong>本站不生产事实</strong>——只对本地新闻媒体的公开报道做结构化抽取与溯源，原文怎么写，档案就怎么记。</p>
  </section>

  <section>
    <h2><span class="no">2</span>信源与边界</h2>
    <p>信源限于公开发布的本地媒体报道，当前主要为<strong>温州网（66wz.com）</strong>及其子频道（新闻、日报、商报、晚报、财经、健康、文旅等，含<strong>温州都市报 /wzdsb/</strong>），以及<strong>温州申创「世界美食之都」官网（wzfood.net）</strong>；收录域名由运营维护，范围外的站点不予收录。</p>
    <p>收录边界：<strong>每条事实必须挂在至少一条原文证据上，无证据不发布</strong>。报道入库时保存全文快照（<code>/api/archive/article/{id}/raw</code>），后续原文改动不影响已发布事实的溯源。</p>
  </section>

  <section>
    <h2><span class="no">3</span>生产流程</h2>
    <ol class="steps">
      <li><strong>报道入库</strong>——抓取公开报道，正文全文快照存档。</li>
      <li><strong>辅助抽取</strong>——大模型从报道中抽取实体、事实与关系，附带 0–1 模型置信度（confidence，非可信度，仅表示模型自评把握程度）。</li>
      <li><strong>逐字锚定</strong>——每条事实记录其在原文中的字符区间与引句哈希（span_hash），引句逐字摘自原文。</li>
      <li><strong>校验入档</strong>——系统按 span_hash 校验引句逐字锚定、去重并裁决冲突，通过后自动生效；异常与冲突转入人工复核。</li>
      <li><strong>发布与留痕</strong>——事实标记 <code>active</code> 生效；被新版本取代时转 <code>superseded</code>，保留备查。</li>
    </ol>
  </section>

  <section>
    <h2><span class="no">4</span>编辑与审核团队</h2>
    <p>档案内容由<strong>温州城市可信数据编辑部</strong>生产并承担审核责任。编辑部隶属温州网（温州市新闻传媒中心），按职能分为三个岗位：</p>
    <ol class="steps">
      <li><strong>语料采编</strong>——负责信源挑选与报道入库：只收录本地主流媒体公开报道，入库即存全文快照。</li>
      <li><strong>事实审核</strong>——负责复核与更正：对入档内容抽样复核，处理冲突仲裁与读者反馈；核验不通过的记录予以更正或退役。</li>
      <li><strong>技术保障</strong>——负责抽取管线、span_hash 锚点与机器出口（sitemap / JSON / feed）的稳定与可复核性。</li>
    </ol>
    <p>抽取入档以<strong>自动化管线</strong>为主：草稿经逐字引句锚定校验、去重与冲突裁决后自动生效，人工负责例外处理、仲裁与事后复核，<strong>并非每条内容发布前都经人工逐条审读</strong>。需特别说明：人工复核核对的是「引句是否逐字摘自原文、实体归属与关系方向是否正确」，即档案记录与原文的一致性——<strong>这属于溯源与归属核验，不等同于对事实本身真实性的独立核验</strong>；事实真伪取决于原始报道，本站只做如实转述与可复算的溯源，不做独立调查取证。每个实体档案页脚均署名「温州城市可信数据编辑部」，责任主体可追溯。</p>
  </section>

  <section>
    <h2><span class="no">5</span>核验方法（span_hash）</h2>
    <p>每条事实的证据都包含：逐字引句（quote）、原文区间（span）与哈希（span_hash）。核验方式：取该证据对应的原文快照，按 span 区间截取文本并重新计算哈希，与档案中的 span_hash 比对——<strong>一致则证明引句未被篡改、确系原文</strong>。</p>
    <p>全部数据公开只读：实体档案提供 <a href="/api/archive/catalog.json">机器可读目录</a>与实体级 JSON 端点（见 <a href="/llms.txt">llms.txt</a>），任何人均可复算核验。</p>
  </section>

  <section>
    <h2><span class="no">6</span>版本与更正</h2>
    <p>事实随报道更新：新版发布后旧版转 <code>superseded</code>，不删除；全部变更进入公开的变更流（<code>/api/archive/feed.json</code>，近 30 天），可订阅追踪。</p>
    <p>发现错误？请通过温州网官方渠道（66wz.com）反馈。核实后我们修正事实并保留修正痕迹，不做静默改动。</p>
  </section>

  <section>
    <h2><span class="no">7</span>引用规范</h2>
    <p>引用本站事实时，建议同时给出：事实 code、实体 URN（形如 <code>{dataset}:{category}:{name}</code>）与逐字证据引句，便于读者回查原文核验。</p>
  </section>

  <footer>
    运营：温州网（温州市新闻传媒中心） · 信源：温州网及子频道（含温州都市报）与温州申创「世界美食之都」官网公开报道 ·
    机器出口：<a href="/llms.txt">llms.txt</a> · <a href="/sitemap.xml">sitemap</a>
  </footer>
</div>
</body>
</html>`;
}
