/**
 * 文章事实稿页（/articles/{articleId}）—— 独立整页版式。
 *
 * 与站内其它档案页不同：本页不复用 archive-html 的 BASE_CSS 与站点框架，
 * 而是自带 topbar / 三栏布局 / 侧栏 / 页脚，视觉上与参考样稿（wyss-2026-fact-sheet）
 * 保持一致。页面内容全部来自数据库：
 *   - 标题位 = 文章主题 theme（LLM 抽取），缺失回落原文标题
 *   - 导语位 = 文章摘要 summary（LLM 抽取）
 *   - 事实概览指标卡 = 核心数据 keyStats（LLM 抽取）
 *   - 逐项事实 = 本篇抽取的全部事实（含逐字证据）
 *   - 所属主题 = 文章 topic_id 关联的主题实体（跳 /facts/{topicId} 聚合页）；
 *     事实主主题与文章主题不同的条目，额外标「主属主题」并说明归入哪个主题页
 * 与 /api/archive/article/:id/facts 的 JSON 同源。
 */

export const BRAND_CN = '温州有据 · 可信事实';
export const BRAND_EN = 'WENZHOU · VERIFIED INFORMATION';

/** 参考样稿原样式（自带 reset 与响应式，故不依赖 BASE_CSS） */
export const FACT_SHEET_CSS = `
:root{--ink:#172e29;--deep:#133a32;--deep2:#1d4b3e;--green:#33795a;--mint:#eaf2ec;--paper:#f7f8f5;--line:#dfe7df;--muted:#687c70;--white:#fff;--sand:#f9f2e8;--amber:#8c6639;--shadow:0 18px 40px rgba(16,47,35,.05)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:100px}body{margin:0;background:var(--paper);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft Yahei","Noto Sans CJK SC",sans-serif;line-height:1.7;color:var(--ink);-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}a:hover{color:var(--green)}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #8ebaa3;outline-offset:3px}svg{display:inline-block;vertical-align:middle}::selection{background:#dcebe0}
.topbar{position:sticky;top:0;z-index:99;backdrop-filter:blur(16px);background:rgba(249,250,247,.96);border-bottom:1px solid var(--line)}.topinner{max-width:1450px;margin:auto;height:76px;padding:0 48px;display:flex;align-items:center;gap:18px;justify-content:space-between}.brand{display:flex;align-items:center;gap:13px;min-width:240px}.logo{width:38px;height:38px;display:grid;place-items:center;background:var(--deep);color:white;border-radius:9px;font:bold 23px Georgia,serif}.brand-cn{font-size:15px;font-weight:800;letter-spacing:.055em}.brand-en{font-size:8px;letter-spacing:.22em;color:var(--muted);line-height:1.5}.nav{display:flex;gap:31px;margin-left:auto;font-size:12px;color:#66796d}.nav a:hover{color:var(--deep)}.topright{display:flex;align-items:center;gap:8px}.draftpill{font-size:10px;border:1px solid #e5d2b7;color:#8d6335;background:#fff7ec;border-radius:100px;padding:7px 11px;white-space:nowrap}.printbtn{background:white;border:1px solid var(--line);border-radius:9px;padding:7px 12px;color:var(--deep);font-size:12px}
.wrap{max-width:1450px;margin:0 auto;padding:0 48px 66px}.crumb{display:flex;align-items:center;flex-wrap:wrap;gap:10px;color:#87958d;font-size:11px;padding:29px 0 21px}.crumb b{font-weight:600;color:#506d5d}.hero{min-height:390px;display:grid;grid-template-columns:minmax(0,1fr) 275px;background:white;border:1px solid var(--line);border-radius:15px;overflow:hidden;box-shadow:var(--shadow)}.hero-body{padding:47px 58px 43px}.eyebrow{display:flex;align-items:center;gap:10px;font-size:10px;font-weight:800;letter-spacing:.14em;color:var(--green)}.eyebrow:before{content:"";width:23px;height:2px;background:#83b299}.hero h1{font-size:clamp(30px,3vw,43px);letter-spacing:-.045em;line-height:1.4;margin:22px 0 17px;font-weight:790;max-width:730px}.hero h1 span{color:var(--green)}.hero p{font-size:14px;line-height:2;color:#667c6e;max-width:680px;margin:0}.hero-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:25px}.button{border:1px solid #dce6dd;border-radius:8px;background:white;color:#2b5941;padding:11px 16px;display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:690;transition:.18s}.button:hover{border-color:#96b6a0;background:#edf5ee;transform:translateY(-1px)}.button.primary{background:var(--deep);color:white;border-color:var(--deep)}.button.primary:hover{background:#265343}.button.xs{padding:7px 10px;font-size:10px}.hero-graphic{position:relative;overflow:hidden;border-left:1px solid #e2eae2;background:linear-gradient(135deg,#eff6ee,#e2eee6)}.hero-graphic:before{content:"";position:absolute;left:-83px;top:22px;width:375px;height:375px;border-radius:50%;border:1px solid #bfd4c4;box-shadow:0 0 0 45px #edf5ed,0 0 0 46px #bcd3c3,0 0 0 101px #e9f3e8,0 0 0 102px #ccddcd}.hero-graphic:after{content:"";position:absolute;inset:0;background-image:linear-gradient(to right,rgba(72,124,93,.1) 1px,transparent 1px),linear-gradient(to bottom,rgba(72,124,93,.1) 1px,transparent 1px);background-size:48px 48px}.hero-numeral{position:absolute;bottom:29px;right:25px;font:normal 107px Georgia,serif;letter-spacing:-9px;color:rgba(38,95,58,.16);z-index:1}.hero-graphic i{font:normal 10px Georgia,serif;letter-spacing:.17em;position:absolute;right:24px;top:35px;writing-mode:vertical-rl;color:#688a78;z-index:1}.subline{margin:20px 0 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:#718278}.subline div{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.subline b{font-weight:700;color:#35634b}.subdot{height:3px;width:3px;border-radius:50%;background:#aab9ae}.statusflag{color:#8a6941;display:flex;gap:8px;align-items:center}.statusflag:before{content:"";width:7px;height:7px;border-radius:50%;background:#c68f59}
.layout{display:grid;grid-template-columns:174px minmax(0,1fr) 269px;gap:25px;align-items:start;margin-top:35px}.toc{position:sticky;top:110px}.toc-h{color:#87978b;font:700 10px Georgia,serif;letter-spacing:.17em;margin:4px 0 16px 13px}.toc a{display:block;font-size:12px;color:#748579;border-left:2px solid #dfe8df;padding:10px 11px}.toc a.active{color:#246343;background:#eaf2e9;border-color:#39845b;font-weight:700}.toc a:hover{color:#245a40;background:#eff5ef}.toc-note{border-top:1px solid var(--line);color:#88978b;font-size:11px;line-height:1.9;margin-top:26px;padding:17px 12px}.maincol{min-width:0}.panel{background:white;border:1px solid var(--line);border-radius:12px;padding:29px 30px;margin-bottom:18px;box-shadow:0 4px 20px rgba(15,40,30,.02)}.panel-head{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:21px}.smallcap{font:11px Georgia,serif;letter-spacing:.13em;color:#91a79a}.panel h2{font-size:21px;letter-spacing:-.035em;margin:3px 0 0}.panel-intro{color:#86958b;font-size:11px;line-height:1.9;margin:8px 0 0}.sidelink{font-size:11px;font-weight:650;color:#3c7957;white-space:nowrap}.abstract{padding:20px 21px;border-radius:9px;background:#f4f7f2;border:1px solid #e3eae1;font-size:15px;line-height:1.95;font-weight:620;letter-spacing:.005em}.abstract strong{color:#21734a}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}.stat{padding:14px 12px;border:1px solid var(--line);border-radius:9px;background:#fff;min-width:0}.stat b{display:block;font:normal 28px Georgia,serif;color:#275f44}.stat small{display:block;font-size:10px;color:#819188;margin-top:5px}.captionnote{font-size:11px;line-height:1.85;color:#819085;margin:16px 0 0}.identitytable{border-top:1px solid var(--line);margin-top:19px;display:grid;grid-template-columns:1fr 1fr}.identityitem{padding:14px 0;border-bottom:1px solid #e8eee8}.identityitem:nth-child(odd){padding-right:12px}.identityitem small{display:block;color:#90a094;font-size:10px}.identityitem span{display:block;font-size:12px;font-weight:620;margin-top:5px;line-height:1.8}
.toolbar{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:-5px 0 16px}.filterbtn{font-size:11px;color:#637d6c;background:#fff;border:1px solid var(--line);border-radius:7px;padding:8px 12px;white-space:nowrap}.filterbtn.selected{background:var(--deep);border-color:var(--deep);color:white}.counttext{font-size:11px;margin-left:auto;color:#95a296}.fact-card{border:1px solid var(--line);border-radius:10px;margin-top:10px;background:white;overflow:hidden}.fact-card[open]{border-color:#bbd2c2;box-shadow:0 6px 18px rgba(19,74,43,.035)}.fact-card>summary{display:block;list-style:none;cursor:pointer;padding:17px 18px}.fact-card>summary::-webkit-details-marker{display:none}.fact-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10px;color:#95a197;letter-spacing:.06em}.fact-code{font:600 11px ui-monospace,Consolas,monospace;color:#4d7b60}.fact-st{border-radius:99px;padding:3px 8px;font-size:9px;letter-spacing:0;border:1px solid #dbe9dc;color:#3e7856;background:#f1f7f0}.fact-st.extra{background:#edf3fc;border-color:#dce6f5;color:#536f91}a.fact-st.extra:hover{background:#e2ecfb;border-color:#b9cde8;color:#3b5c85}.fact-st.pending{background:#faf2e6;border-color:#ecdac0;color:#946e3e}.summary-row{display:flex;align-items:center;gap:12px;justify-content:space-between}.fact-name{font-size:14px;font-weight:670;line-height:1.75;margin:9px 0 5px}.chevron{font-size:14px;color:#829c8b;transition:transform .2s;flex:none}.fact-card[open] .chevron{transform:rotate(180deg)}.fact-short{font-size:10px;color:#91a094}.fact-detail{border-top:1px solid #e9efe8;padding:17px 19px 19px;background:#fbfcfa}.triple{display:grid;grid-template-columns:1.05fr .75fr 1.2fr;border:1px solid var(--line);border-radius:7px;overflow:hidden}.triple div{padding:12px 11px;border-right:1px solid var(--line);overflow-wrap:anywhere}.triple div:last-child{border-right:none}.triple small{display:block;color:#8d9c91;font-size:10px}.triple b{display:block;color:#355944;font-size:12px;margin-top:5px;font-weight:630}.fact-notes{margin:13px 0 0;font-size:11px;color:#647b6b;line-height:1.9}.fact-notes strong{color:#3d6950}.source-chips{margin-top:13px;display:flex;gap:7px;flex-wrap:wrap}.sourcechip{border:1px solid #d9e4da;background:white;color:#3b6d4d;font-size:10px;font-weight:600;padding:5px 8px;border-radius:5px}.sourcechip:hover{border-color:#80a68a;background:#eef5ee}.caution{background:#f9f5ed;padding:12px 15px;border-radius:6px;font-size:11px;color:#806947;margin-top:12px;line-height:1.9}.fact-card.hidden{display:none}
.evidence-list{display:grid;gap:11px}.evidence{border:1px solid var(--line);border-radius:9px;padding:15px 17px}.ev-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.ev-type{font:650 10px/1.5 ui-monospace,Consolas,monospace;color:#688878}.ev-kind{font-size:10px;color:#8e9c91}.ev-title{font-size:13px;font-weight:650;margin:7px 0 4px;line-height:1.7}.ev-by{color:#92a197;font-size:10px;line-height:1.8}.ev-open{display:inline-block;font-size:10px;color:#2c724b;margin-top:8px;font-weight:650}.method{margin-top:16px;border-left:3px solid #98b6a0;padding:4px 0 4px 15px;color:#728b78;font-size:11px;line-height:1.9}.time-table{width:100%;border-collapse:collapse;font-size:12px}.time-table td{padding:15px 4px;border-bottom:1px solid #eaf0e9;vertical-align:top}.time-table td:first-child{color:#647969;width:130px}.time-table td:nth-child(2){font-weight:650}.time-table td:last-child{color:#8d9c91;font-size:11px;text-align:right}.time-table tr:last-child td{border:0}.notice{border:1px solid #eddcc0;background:#fcf8f0;border-radius:9px;padding:17px 20px}.notice h3{color:#80623e;font-size:14px;margin:0 0 9px}.notice p{font-size:12px;line-height:1.95;color:#806d53;margin:0}.compare{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.compare div{background:white;border:1px solid #e8dbc9;border-radius:7px;padding:13px;font-size:11px;line-height:1.8}.compare small{display:block;color:#9b865f;font-size:10px}.compare span{display:block;margin-top:7px;font-weight:600;color:#6d593d}.notice .advice{font-size:11px;color:#7d6949}.history{padding-left:22px;border-left:1px solid #d3e2d6;position:relative;margin-left:6px}.historyitem{position:relative;margin-bottom:10px}.historyitem:before{content:"";position:absolute;left:-28px;top:6px;width:9px;height:9px;background:#d7e8da;border:2px solid #75a884;border-radius:50%}.historyitem b{font-size:12px}.historyitem p{font-size:11px;color:#819386;margin:6px 0 0;line-height:1.9}.codebox{border-radius:8px;overflow:hidden;background:#132923;color:#e4efdf}.codebar{background:#1b3930;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;color:#c2d7c7;font-size:10px;letter-spacing:.035em}.codebox pre{max-height:375px;overflow:auto;margin:0;padding:16px;font:11px/1.9 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;white-space:pre}.machineactions{display:flex;gap:9px;margin:13px 0 0;flex-wrap:wrap;align-items:center}.machinehint{font-size:11px;line-height:1.85;color:#899a8d;margin-top:12px}.plainband{background:#eef4ed;border:1px solid #dce9dd;border-radius:10px;padding:20px 24px;font-size:12px;color:#53715d;line-height:1.9;margin-top:14px}.plainband strong{display:block;color:#286346;font-size:14px;margin-bottom:3px}
.side{position:sticky;top:110px}.statuscard{background:#173b31;color:white;border-radius:11px;overflow:hidden}.statuscard>div:first-child{padding:23px 22px 20px;border-bottom:1px solid rgba(255,255,255,.15)}.statuscap{letter-spacing:.15em;font-size:10px;color:#a8cab4}.statushead{font-size:20px;font-weight:720;display:flex;align-items:center;gap:9px;margin:14px 0 7px}.statushead:before{content:"";height:9px;width:9px;border-radius:50%;background:#e5b879;box-shadow:0 0 0 5px rgba(229,184,121,.13)}.statuscard p{font-size:11px;line-height:1.9;color:#b6cfc0;margin:0}.statusdetails{padding:13px 22px 19px}.statusitem{display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.09)}.statusitem:last-child{border:none}.statusitem span:first-child{color:#adc9b7}.statusitem span:last-child{font-weight:650;color:#f2f7f1;text-align:right}.sidebox{border:1px solid var(--line);background:white;border-radius:10px;padding:19px 20px;margin-top:14px}.sidetitle{font-size:13px;font-weight:720;margin-bottom:11px}.sidebox label{display:block;color:#99a69b;font-size:10px;margin-top:11px}.sidebox p{font-size:12px;color:#4e7058;font-weight:620;line-height:1.9;margin:4px 0 0;overflow-wrap:anywhere}.sidebox blockquote{padding:11px 12px;background:#f1f7f1;border:1px solid #e2ece3;border-radius:7px;margin:9px 0 0;font-size:11px;line-height:1.95;color:#5b745e}.sidebox .button{width:100%;justify-content:center;margin-top:11px}.limitation{color:#839587!important;font-size:11px!important;font-weight:450!important}.endfoot{border-top:1px solid var(--line);margin-top:35px;padding-top:24px;display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#8da093;line-height:1.8}.endfoot b{color:#3f6851}.toast{position:fixed;bottom:27px;left:50%;transform:translate(-50%,18px);opacity:0;pointer-events:none;background:#173f32;color:white;border-radius:7px;padding:11px 18px;box-shadow:0 9px 28px rgba(0,0,0,.13);font-size:12px;transition:.22s;z-index:250}.toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:1220px){.topinner{padding:0 28px}.wrap{padding:0 28px 48px}.layout{grid-template-columns:143px minmax(0,1fr) 230px;gap:18px}.hero-body{padding:42px}.hero{grid-template-columns:minmax(0,1fr) 200px}.panel{padding:24px}.nav{gap:14px}}
@media(max-width:980px){.toc{display:none}.layout{grid-template-columns:minmax(0,1fr) 240px}.nav{display:none}.hero-graphic{display:none}.hero{display:block;min-height:auto}}
@media(max-width:730px){html{scroll-padding-top:76px}.topinner{height:63px;padding:0 16px}.brand{min-width:auto;gap:10px}.logo{width:32px;height:32px;font-size:19px}.brand-cn{font-size:13px}.brand-en{font-size:7px}.draftpill{display:none}.printbtn{padding:6px 9px}.wrap{padding:0 14px 36px}.crumb{padding:20px 0;font-size:10px;gap:6px}.hero{border-radius:11px}.hero-body{padding:29px 22px 31px}.hero h1{font-size:29px}.hero p{font-size:12px}.subline{font-size:10px}.layout{display:flex;flex-direction:column;gap:0;margin-top:22px}.side{position:static;width:100%;order:-1;margin-bottom:17px;display:grid;grid-template-columns:1fr 1fr;gap:10px}.sidebox{margin:0}.statuscard{grid-column:1/-1}.maincol{width:100%}.panel{padding:21px 18px;margin-bottom:14px}.panel h2{font-size:19px}.stats{grid-template-columns:repeat(2,1fr)}.abstract{font-size:14px}.identitytable{grid-template-columns:1fr}.identityitem{padding:11px 0}.fact-name{font-size:13px}.triple{grid-template-columns:1fr}.triple div{border-right:none;border-bottom:1px solid var(--line)}.triple div:last-child{border-bottom:0}.compare{grid-template-columns:1fr}.time-table td:first-child{width:79px}.time-table td{font-size:11px}.time-table td:last-child{font-size:10px}.endfoot{flex-direction:column}.counttext{margin-left:0}.toolbar{gap:7px}}
@media(max-width:460px){.side{grid-template-columns:1fr}.sidebox{margin:0}.hero h1{font-size:25px}.panel-head{gap:8px}.button{padding:10px 12px;font-size:10px}.stat b{font-size:25px}.stat{padding:12px}.identityitem span{font-size:11px}}
@media print{body{background:#fff}.topbar,.hero-actions,.toc,.toolbar,.machineactions,.button,.toast,.printbtn,.sidebox .button{display:none!important}.wrap{max-width:none;padding:0 8mm}.hero{border:0;box-shadow:none}.hero-body{padding:10px}.layout{display:block;margin-top:15px}.side{position:static;display:block}.statuscard{background:#edf4ef;color:#17432c}.statuscard p,.statuscap,.statusitem span:first-child,.statusitem span:last-child{color:#17432c!important}.panel,.fact-card{break-inside:avoid;box-shadow:none}.fact-card>summary{padding:10px}.fact-card .fact-detail{display:block!important}.panel{padding:13px}.hero-graphic{display:none}}
`;

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** 统一取「日」精度：Date / ISO 串 / MySQL 日期都能落到 YYYY-MM-DD */
export const isoDay = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const t = new Date(v.getTime() + 8 * 3600 * 1000); // 北京时间
    return t.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

export const TEMPORAL_LABEL: Record<string, string> = {
  unknown: '未标注',
  effective: '生效期',
  event: '事件时点',
  historical: '历史值',
  period: '期间',
  plan: '计划',
  as_of: '截至口径',
};
export const FACT_TYPE_LABEL: Record<string, string> = {
  current_state: '现状陈述',
  source_claim: '来源披露',
  occurred: '已发生事件',
};

interface KeyStat {
  value: string;
  label: string;
}

/** 逐条时间语义文案：区间 / 事件 / 期间口径 / 截至 四档，缺失不外推 */
export const timeText = (f: Record<string, unknown>): string => {
  const parts: string[] = [];
  if (f.validFrom || f.validTo) {
    parts.push(`适用 ${f.validFrom ? isoDay(f.validFrom) : '—'} ~ ${f.validTo ? isoDay(f.validTo) : '—'}`);
  }
  if (f.eventStart || f.eventEnd) {
    parts.push(`事件 ${f.eventStart ? isoDay(f.eventStart) : '—'} ~ ${f.eventEnd ? isoDay(f.eventEnd) : '—'}`);
  } else if (f.periodKey) {
    // 无精确日期时只展示 period_key 口径（YYYY / YYYY-MM / YYYY-Qn），不得把年份渲染成 1 月 1 日
    parts.push(`期间 ${f.periodKey}`);
  }
  if (f.asOf) parts.push(`截至 ${isoDay(f.asOf)}`);
  return parts.length ? parts.join('；') : '未标注';
};

export function renderArticleFactSheetHtml(
  data: {
    article: Record<string, unknown>;
    facts: Record<string, unknown>[];
    related?: Record<string, unknown>[];
  },
  baseUrl: string,
): string {
  const a = data.article;
  const id = Number(a.id);
  const rawTitle = String(a.title ?? `文章 ${id}`);
  const theme = String(a.theme ?? '').trim();
  const summary = String(a.summary ?? '').trim();
  const pageTitle = theme || rawTitle;
  // 文章事实稿已迁到 /articles/{id}；/facts/{id} 归主题聚合页所有
  const canonical = `${baseUrl}/articles/${id}`;
  const jsonUrl = `${baseUrl}/api/archive/article/${id}/facts`;
  const rawUrl = `${baseUrl}/api/archive/article/${id}/raw`;
  const originUrl = a.url ? String(a.url) : '';
  // 所属主题：文章 ↔ 主题实体的关联（生产线 topic-resolver 归并后的最终主题）
  const topicRaw = (a.topic ?? null) as { id?: unknown; name?: unknown } | null;
  const topicId = topicRaw?.id ? Number(topicRaw.id) : 0;
  const topicName = topicRaw?.name ? String(topicRaw.name) : '';
  const topicUrl = topicId ? `${baseUrl}/facts/${topicId}` : '';
  const sourceOrg = String(a.sourceOrg ?? '—');
  const sourceSite = a.sourceSite ? String(a.sourceSite) : '';
  const publishedAt = isoDay(a.publishedAt);
  const briefAt = isoDay(a.briefAt);
  const briefVersion = a.briefPromptVersion ? String(a.briefPromptVersion) : '';
  const facts = data.facts;

  const entityIds = [...new Set(facts.map((f) => Number(f.entityId)))];
  const evidenceTotal = facts.reduce((n, f) => n + (((f.evidences ?? []) as unknown[]).length ?? 0), 0);
  const alertList = [
    ...new Set(
      facts.flatMap((f) => ((f.alerts ?? []) as string[]).map((x) => String(x).trim()).filter(Boolean)),
    ),
  ];
  const singleSourceFacts = facts.filter((f) => (((f.evidences ?? []) as unknown[]).length ?? 0) < 2).length;

  // ---- 核心数据卡：LLM 抽取的 keyStats 优先，不足 4 张用本篇统计补齐 ----
  const keyStats = (Array.isArray(a.keyStats) ? a.keyStats : []) as KeyStat[];
  const cards: KeyStat[] = keyStats.slice(0, 4);
  const fallbackCards: KeyStat[] = [
    { value: String(facts.length), label: '条抽取事实' },
    { value: String(entityIds.length), label: '个涉及主体' },
    { value: String(evidenceTotal), label: '条逐字证据' },
  ];
  for (const c of fallbackCards) {
    if (cards.length >= 4) break;
    if (cards.some((x) => x.label === c.label)) continue;
    cards.push(c);
  }

  // ---- 来源文档：按「URL + 标题」去重，编号 A/B/C… ----
  const sourceMap = new Map<string, { title: string; org: string; url: string; publishedAt: string; count: number }>();
  for (const f of facts) {
    for (const ev of (f.evidences ?? []) as Record<string, unknown>[]) {
      const url = String(ev.sourceUrl ?? '');
      const title = String(ev.materialTitle ?? '').trim() || String(ev.sourceOrg ?? '').trim() || '未命名来源';
      const key = url || title;
      const hit = sourceMap.get(key);
      if (hit) hit.count += 1;
      else
        sourceMap.set(key, {
          title,
          org: String(ev.sourceOrg ?? sourceOrg),
          url,
          publishedAt: isoDay(ev.publishedAt),
          count: 1,
        });
    }
  }
  const sources = [...sourceMap.values()];
  const letter = (i: number) => String.fromCharCode(65 + (i % 26));

  // ---- 时间语义：只陈述有据可查的时间，不补齐不推断 ----
  const validFroms = facts.map((f) => isoDay(f.validFrom)).filter(Boolean).sort();
  const ends = facts.flatMap((f) => [isoDay(f.asOf), isoDay(f.validTo), isoDay(f.eventEnd)]).filter(Boolean).sort();
  const verifiedAts = facts.map((f) => isoDay(f.lastVerifiedAt)).filter(Boolean).sort();
  const eventRange = validFroms.length
    ? `${validFroms[0]}${ends.length ? ` ~ ${ends[ends.length - 1]}` : ' 起'}`
    : '未标注';

  const factCard = (f: Record<string, unknown>, index: number): string => {
    const evidences = (f.evidences ?? []) as Record<string, unknown>[];
    const entityUrl = `${baseUrl}/archive/${esc(f.datasetCode)}/${esc(f.entitySlug)}`;
    const factUrl = f.code ? `${entityUrl}/fact/${encodeURIComponent(String(f.code))}` : entityUrl;
    const code = esc(f.code ?? `#${f.id}`);
    // 文章页所有引文必来自本篇，天然同源，不得暗示"交叉核对"
    const badge =
      evidences.length >= 2
        ? `<span class="fact-st">同源多引文 ${evidences.length} 条</span>`
        : `<span class="fact-st pending">单条报道</span>`;
    // 事实级归属：本条以别的主题为主主题时，标注「主属主题」，说明它同时出现在该主题页
    const fTopicId = f.factTopicId == null ? 0 : Number(f.factTopicId);
    const fTopicName = String(f.factTopicName ?? '').trim();
    const offTopic = Boolean(fTopicId) && Boolean(topicId) && fTopicId !== topicId;
    const topicBadge = offTopic
      ? `<a class="fact-st extra" href="${esc(`${baseUrl}/facts/${fTopicId}`)}">主属主题 · ${esc(fTopicName || `#${fTopicId}`)}</a>`
      : '';
    const chips = evidences
      .map((ev, i) =>
        ev.sourceUrl
          ? `<a class="sourcechip" target="_blank" rel="noopener noreferrer" href="${esc(
              ev.sourceUrl,
            )}" title="${esc(ev.materialTitle ?? '')}">${letter(i)} · ${esc(
              String(ev.sourceOrg ?? '来源').split('/')[0].trim(),
            )} ↗</a>`
          : `<span class="sourcechip">${letter(i)} · ${esc(ev.sourceOrg ?? '来源')}</span>`,
      )
      .join('');
    const evBlock = evidences.length
      ? evidences
          .map(
            (ev) => `<div style="border:1px solid #eef1f5;border-radius:7px;padding:10px 12px;margin-top:8px;background:#fff">
        <div style="font-size:10px;color:#8d9c91">${esc(ev.materialTitle ?? ev.sourceOrg ?? '来源')}${
              ev.publishedAt ? ` · ${esc(isoDay(ev.publishedAt))}` : ''
            }</div>
        <p style="margin:5px 0 0;font-size:12px;line-height:1.85;color:#3a4c42">「${esc(ev.quote ?? '')}」</p>
        <div style="font-size:10px;color:#8d9c91;margin-top:4px">${
          ev.spanStart != null ? `区间 ${esc(ev.spanStart)}–${esc(ev.spanEnd)} · ` : ''
        }逐字证据匹配（本地）${
              ev.sourceUrl ? ` · <a href="${esc(ev.sourceUrl)}" target="_blank" rel="nofollow noopener">核对原文</a>` : ''
            }</div>
      </div>`,
          )
          .join('')
      : '<p class="fact-notes">本篇未附可定位的逐字证据。</p>';
    const alerts = ((f.alerts ?? []) as string[])
      .map((x) => `<div class="caution"><b>口径提示：</b>${esc(x)}</div>`)
      .join('');
    const rels = (f.relations ?? []) as Record<string, unknown>[];
    const relLine = rels.length
      ? `<p class="fact-notes"><strong>事实关系：</strong>${rels
          .map((r) => `${esc(r.type)} · 事实#${esc(r.peerFactId)}`)
          .join('；')}</p>`
      : '';
    const copyText = `${String(f.statement)}（${sourceOrg}${publishedAt ? ` ${publishedAt}` : ''}；事实编号 ${String(
      f.code ?? f.id,
    )}）`;
    return `<details class="fact-card" id="fact-${esc(f.id)}"${index === 0 ? ' open' : ''} data-status="${
      evidences.length >= 2 ? 'checked' : 'pending'
    }">
    <summary aria-label="展开或收起 ${code} ${esc(f.statement)}"><div class="fact-head"><span class="fact-code">${code}</span><span>·</span><span>${esc(
      f.entityName,
    )}</span>${badge}${topicBadge}</div><div class="summary-row"><div><div class="fact-name">${esc(f.statement)}</div><div class="fact-short">时间精度：${esc(
      timeText(f),
    )}　·　来源数：${evidences.length}（来源数不等于独立核验次数）</div></div><span class="chevron" aria-hidden="true">⌄</span></div></summary>
    <div class="fact-detail"><div class="triple"><div><small>主体 / SUBJECT</small><b>${esc(f.entityName)}</b></div><div><small>类型 / TYPE</small><b>${esc(
      FACT_TYPE_LABEL[String(f.factType ?? '')] ?? '事实',
    )}</b></div><div><small>时间 / TIME</small><b>${esc(timeText(f))}</b></div></div>
    <p class="fact-notes"><strong>适用时间：</strong>${esc(timeText(f))}<br><strong>出处核对：</strong>${esc(
      evidences.length >= 2 ? '本篇报道内多条引文（同一来源，不计独立印证）' : '仅本篇报道有载',
    )}<br><strong>槽位：</strong>${esc(
      [f.semanticRole, f.periodKey, f.subjectScope].filter(Boolean).join(' · ') || '未标注',
    )}${
      offTopic
        ? `<br><strong>主题归属：</strong>本条以「${esc(fTopicName || `主题 #${fTopicId}`)}」为主主题，汇总在该主题页；文章页保留全文抽取结果。`
        : ''
    }</p>
    ${evBlock}
    <div class="source-chips">${chips}</div>
    ${alerts}
    ${relLine}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="button xs copy-one" type="button" data-copy="${esc(
      copyText,
    )}">复制本条事实引用</button><a class="button xs" href="${esc(factUrl)}">单条事实页 ↗</a><a class="button xs" href="${esc(
      entityUrl,
    )}">主体档案 ↗</a></div></div></details>`;
  };

  const evidenceHtml = sources.length
    ? sources
        .map(
          (s, i) => `<div class="evidence"><div class="ev-head"><span class="ev-type">SOURCE ${letter(i)}</span><span class="ev-kind">${
            s.count >= 2 ? '多事实共用' : '单条事实'
          }</span></div><div class="ev-title">${esc(s.title)}</div><div class="ev-by">${esc(s.org)}${
            s.publishedAt ? ` · ${esc(s.publishedAt)}` : ''
          }</div>${s.url ? `<a class="ev-open" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">核对原始页面 ↗</a>` : ''}</div>`,
        )
        .join('')
    : '<p class="panel-intro">本篇事实暂未挂接可定位的来源文档。</p>';

  const dataset = {
    schema_version: 'article-facts-1.0',
    document_type: 'article_fact_sheet',
    title: pageTitle,
    article_title: rawTitle,
    theme,
    summary,
    topic: topicId ? { id: topicId, name: topicName, url: topicUrl } : null,
    key_stats: cards,
    compiled_on: briefAt || isoDay(a.fetchedAt),
    brief_prompt_version: briefVersion,
    source_article: originUrl,
    source_org: sourceOrg,
    published_at: publishedAt,
    record_count: facts.length,
    facts: facts.map((f) => ({
      record_id: String(f.code ?? f.id),
      statement: f.statement,
      subject: f.entityName,
      fact_type: f.factType,
      temporal: {
        kind: f.temporalKind,
        as_of: isoDay(f.asOf) || null,
        event_start: isoDay(f.eventStart) || null,
        event_end: isoDay(f.eventEnd) || null,
        valid_from: isoDay(f.validFrom) || null,
        valid_to: isoDay(f.validTo) || null,
      },
      slot: { semantic_role: f.semanticRole, period_key: f.periodKey, subject_scope: f.subjectScope },
      confidence: f.confidence,
      primary_topic: f.factTopicId ? { id: Number(f.factTopicId), name: f.factTopicName ?? null } : null,
      evidences: ((f.evidences ?? []) as Record<string, unknown>[]).map((ev) => ({
        quote: ev.quote,
        source_org: ev.sourceOrg,
        material_title: ev.materialTitle,
        source_url: ev.sourceUrl,
        published_at: isoDay(ev.publishedAt) || null,
        span_start: ev.spanStart,
        span_end: ev.spanEnd,
      })),
      caveat: (f.alerts ?? []) as string[],
    })),
  };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${pageTitle}｜新闻事实稿参考数据`,
    description: summary || `依据${sourceOrg}报道整理的文章事实集，共 ${facts.length} 条事实。`,
    ...(originUrl ? { isBasedOn: originUrl } : {}),
    ...(publishedAt ? { temporalCoverage: publishedAt } : {}),
    ...(sourceOrg !== '—' ? { creator: { '@type': 'Organization', name: sourceOrg } } : {}),
    variableMeasured: cards.map((c) => ({
      '@type': 'PropertyValue',
      name: c.label,
      value: c.value,
    })),
    url: canonical,
    conditionsOfAccess: 'Reference only. Editorial approval required before official publication.',
  };

  // 封面数字：取发布日的「日」，形如 "26."；无发布日期时退回事实条数
  const dateStamp = publishedAt ? `${publishedAt.slice(8, 10)}.` : String(facts.length);

  const citation = `${sourceOrg}${publishedAt ? `${publishedAt.replaceAll('-', '.')}报道` : '报道'}《${rawTitle}》；主题、摘要与核心数据由事实生产线自动抽取，逐条事实附原文逐字证据。参考稿尚未编辑签发。`;

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#133a32"><meta name="robots" content="index,follow"><title>${esc(
    pageTitle,
  )}｜事实档案 · 温州有据</title><meta name="description" content="${esc(
    summary || `本文抽取 ${facts.length} 条事实，涉及 ${entityIds.length} 个主体，附逐字原文证据。来源：${sourceOrg}。`,
  )}"><link rel="canonical" href="${esc(
    canonical,
  )}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta property="og:type" content="article"><meta property="og:title" content="${esc(
    pageTitle,
  )}"><meta property="og:description" content="${esc(summary)}"><meta property="og:url" content="${esc(
    canonical,
  )}"><style>${FACT_SHEET_CSS}</style><script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll(
    '</',
    '<\\/',
  )}</script></head><body>
<header class="topbar"><div class="topinner"><a class="brand" href="${esc(baseUrl)}/" aria-label="返回首页"><span class="logo">温</span><span><span class="brand-cn">${esc(
    BRAND_CN,
  )}</span><br><span class="brand-en">${esc(
    BRAND_EN,
  )}</span></span></a><nav class="nav" aria-label="页面导航"><a href="#overview">事实概览</a><a href="#facts">事实条目</a><a href="#evidence">来源与证据</a><a href="#issues">口径说明</a><a href="#machine">机器读取</a></nav><div class="topright"><span class="draftpill">传播参考样稿 · 尚未编辑签发</span><button class="printbtn" type="button" onclick="window.print()" aria-label="打印页面">打印 ↗</button></div></div></header>
<div class="wrap"><div class="crumb"><a href="${esc(baseUrl)}/">温州有据</a><span>›</span><span>可信事实稿</span><span>›</span><b>${esc(
    pageTitle,
  )}</b></div>
<section class="hero" aria-labelledby="pagetitle"><div class="hero-body"><div class="eyebrow">ARTICLE FACT SHEET / 文章事实稿</div><h1 id="pagetitle">${esc(
    pageTitle,
  )}<br><span>事实档案</span></h1><p>${
    summary ? esc(summary).replaceAll('\n', '<br>') : `本文抽取 ${facts.length} 条事实、涉及 ${entityIds.length} 个主体；摘要尚未由生产线生成。`
  }</p><div class="hero-actions"><a class="button primary" href="#facts">查看事实条目　↗</a><a class="button" href="#evidence">查看来源与证据　↗</a>${
    topicUrl ? `<a class="button" href="${esc(topicUrl)}">所属主题　↗</a>` : ''
  }${
    originUrl
      ? `<a class="button" href="${esc(originUrl)}" target="_blank" rel="noopener noreferrer">阅读新闻原文　↗</a>`
      : ''
  }</div></div><div class="hero-graphic" aria-hidden="true"><span class="hero-numeral">${esc(
    dateStamp,
  )}</span><i>${esc(sourceOrg)} · ARTICLE FACT SHEET</i></div></section>
<div class="subline"><div><b>文章｜${esc(theme || rawTitle)}</b><span class="subdot"></span>${
    publishedAt ? `<span>原报道：${esc(publishedAt)}</span><span class="subdot"></span>` : ''
  }<span>抽取事实 ${facts.length} 条</span><span class="subdot"></span><span>涉及主体 ${entityIds.length} 个</span></div><span class="statusflag">本页为参考稿，不代表编辑部已签发</span></div>
<div class="layout"><nav class="toc" aria-label="内容目录"><div class="toc-h">ON THIS PAGE</div><a href="#overview" class="active">01　事实概览</a><a href="#facts">02　逐项事实</a><a href="#evidence">03　来源与证据</a><a href="#times">04　时间语义</a><a href="#issues">05　口径与核对</a><a href="#history">06　版本与责任</a><a href="#machine">07　机器读取</a><div class="toc-note">这不是把长新闻拆成短句。<br>每项陈述都保留主体、时间、出处和引用边界。</div></nav>
<main class="maincol">
<section class="panel" id="overview"><div class="panel-head"><div><span class="smallcap">01 / ARTICLE OVERVIEW</span><h2>事实概览</h2><p class="panel-intro">先确认这篇文章讲了什么，再按事实单元列出可核查的陈述。</p></div>${
    originUrl ? `<a class="sidelink" href="${esc(originUrl)}" target="_blank" rel="noopener noreferrer">新闻原文 ↗</a>` : ''
  }</div><div class="abstract">${
    summary
      ? esc(summary)
      : `本文抽取 ${facts.length} 条事实，涉及 ${entityIds.length} 个主体；摘要尚未由生产线生成，以下仅列事实统计。`
  }</div><div class="stats">${cards
    .map((c) => `<div class="stat"><b>${esc(c.value)}</b><small>${esc(c.label)}</small></div>`)
    .join('')}</div><p class="captionnote">指标值均取自正文原样表述，不做换算或四舍五入；「约数」保留约数含义。${
    keyStats.length ? '' : '当前指标卡为本篇抽取统计（正文未提供可用的量化数据）。'
  }</p><div class="identitytable">${
    topicUrl
      ? `<div class="identityitem"><small>所属主题</small><span><a href="${esc(topicUrl)}">${esc(topicName || `主题 #${topicId}`)} ↗</a></span></div>`
      : ''
  }<div class="identityitem"><small>文章主题</small><span>${esc(
    theme || '未生成（沿用原文标题）',
  )}</span></div><div class="identityitem"><small>原文标题</small><span>${esc(
    rawTitle,
  )}</span></div><div class="identityitem"><small>来源</small><span>${esc(sourceOrg)}${
    sourceSite ? `（${esc(sourceSite)}）` : ''
  }</span></div><div class="identityitem"><small>发布时间</small><span>${esc(
    publishedAt || '—',
  )}</span></div><div class="identityitem"><small>主题与摘要来源</small><span>${
    briefVersion ? `大模型抽取 · ${esc(briefVersion)}${briefAt ? ` · ${esc(briefAt)}` : ''}` : '未生成'
  }</span></div><div class="identityitem"><small>本页组织方式</small><span>主题摘要 + 事实概览 + 逐项事实 + 逐字证据</span></div></div></section>
<section class="panel" id="facts"><div class="panel-head"><div><span class="smallcap">02 / ATOMIC FACT RECORDS</span><h2>逐项事实</h2><p class="panel-intro">每条事实独立编号、独立引用。展开可查看主体—类型—时间及证据边界。</p></div><span class="sidelink">${facts.length} 条</span></div><div class="toolbar" role="group" aria-label="事实清单"><span class="filterbtn selected">全部 ${facts.length}</span><span class="counttext" id="visible-count" aria-live="polite">显示 ${facts.length} 条</span></div>${
    facts.map(factCard).join('') || '<p class="panel-intro">这篇文章暂未抽取出可用事实。</p>'
  }</section>
<section class="panel" id="evidence"><div class="panel-head"><div><span class="smallcap">03 / EVIDENCE &amp; PROVENANCE</span><h2>来源与证据</h2><p class="panel-intro">记录本篇事实挂接的具体出处，而不是把转载页计作新的独立证据。</p></div></div><div class="evidence-list">${evidenceHtml}</div><div class="method">证据说明：本页所有引文都取自同一篇报道，属同一来源家族，不能计作独立印证；独立来源需由主题页按来源家族另行判定。任何标注都不等于事实已被独立调查确认。</div></section>
<section class="panel" id="times"><div class="panel-head"><div><span class="smallcap">04 / TEMPORAL SEMANTICS</span><h2>时间语义</h2><p class="panel-intro">事件何时发生、新闻何时报道、资料何时核对，是不同的时间。</p></div></div><table class="time-table"><tbody><tr><td>原新闻发布时间</td><td>${
    publishedAt || '未标注'
  }</td><td>${publishedAt ? '精确到日' : '未提供'}</td></tr><tr><td>事实适用区间</td><td>${esc(
    eventRange,
  )}</td><td>按条判定</td></tr><tr><td>最近核验时间</td><td>${
    verifiedAts.length ? verifiedAts[verifiedAts.length - 1] : '未记录'
  }</td><td>${verifiedAts.length ? '精确到日' : '不推断'}</td></tr><tr><td>主题/摘要生成时间</td><td>${
    briefAt || '未生成'
  }</td><td>${briefAt ? '精确到日' : '不推断'}</td></tr><tr><td>事实生效时间</td><td>不适用或按条另行界定</td><td>不得自动补值</td></tr><tr><td>正式编辑签发时间</td><td>未发生 / 未录入</td><td>不作推断</td></tr></tbody></table><p class="captionnote">「活动已经发生」不等于「数字永久有效」。统计口径应保留来源的统计时间，不把发布日期伪装成统计发生日。</p></section>
<section class="panel" id="issues"><div class="panel-head"><div><span class="smallcap">05 / EDITORIAL DISCREPANCIES</span><h2>口径差异与待核对事项</h2><p class="panel-intro">不掩盖来源差异，也不把编辑推测写成已证实结论。</p></div></div>${
    alertList.length
      ? alertList
          .map(
            (x) => `<div class="notice"><h3>逐条事实附带的口径提示</h3><p>${esc(x)}</p></div>`,
          )
          .join('')
      : '<div class="plainband"><strong>本篇暂未记录来源之间的口径差异</strong>事实集只保留来源原样表述；如后续出现数字、时间或表述冲突，将在此处逐条列出并标注各自出处。</div>'
  }${singleSourceFacts ? `<div class="plainband"><strong>还有 ${singleSourceFacts} 条事实只有一条引文</strong>这些事实只在本篇报道中出现，本页无法提供第二个来源家族作对照；引用时应注明来源，不能表述为"多方印证"。</div>` : ''}</section>
<section class="panel" id="history"><div class="panel-head"><div><span class="smallcap">06 / REVISION &amp; ACCOUNTABILITY</span><h2>版本与责任</h2><p class="panel-intro">事实版本是可审计的发布记录，不能因为页面已生成就虚构审核历史。</p></div></div><div class="history"><div class="historyitem"><b>参考稿 v0.1 · ${esc(
    briefAt || publishedAt || isoDay(a.fetchedAt) || '未记录日期',
  )}</b><p>依据原文自动抽取 ${facts.length} 条事实；主题、摘要与核心数据由生产线大模型生成${
    briefVersion ? `（${esc(briefVersion)}）` : ''
  }。未形成正式采编审核或业务签发记录。</p></div></div><div class="identitytable"><div class="identityitem"><small>新闻提供方</small><span>${esc(
    sourceOrg,
  )}</span></div><div class="identityitem"><small>新闻刊载平台</small><span>${esc(
    sourceSite || sourceOrg,
  )}</span></div><div class="identityitem"><small>事实稿审核状态</small><span>待人工复核、待编辑签发</span></div><div class="identityitem"><small>更正 / 变更</small><span>暂无正式发布版本，因此无真实更正记录</span></div></div><p class="captionnote">正式部署后，每次更正应保留原值、修订值、原因、审核主体及修订时间。事件本身发生新变化时，应新建变更记录，不覆盖原历史事实。</p></section>
<section class="panel" id="machine"><div class="panel-head"><div><span class="smallcap">07 / MACHINE READABLE</span><h2>机器读取</h2><p class="panel-intro">页面可见文本与导出的 JSON 使用同一份事实清单。</p></div></div><div class="codebox"><div class="codebar"><span>REFERENCE FACT DATA · application/json</span><span>${
    facts.length
  } records / v0.1</span></div><pre id="json-display" aria-label="机器可读 JSON 示例"></pre></div><div class="machineactions"><button type="button" class="button primary" id="save-json">下载完整 JSON ↓</button><button type="button" class="button" id="copy-json">复制 JSON</button><a class="button" href="${esc(
    jsonUrl,
  )}" target="_blank" rel="noopener">接口 JSON ↗</a><a class="button" href="${esc(
    rawUrl,
  )}" rel="nofollow">本地原文快照 ↗</a></div><p class="machinehint">这些数据以静态形式嵌入，可直接解析与下载；页面并未声称已有线上 API、持久事实 URI 或自动纠错服务。</p></section>
<div class="plainband"><strong>设计原则：新闻讲述发生了什么，事实稿交代机器可以依据什么。</strong>对外可信发布的基础不是把不确定性藏起来，而是准确表达数据的来源、适用时间、边界和责任。</div>
</main>
<aside class="side"><div class="statuscard"><div><div class="statuscap">PUBLICATION READINESS</div><div class="statushead">待人工复核</div><p>内容已由生产线自动抽取，不能代替真实的采编审核与正式发布流程。</p></div><div class="statusdetails"><div class="statusitem"><span>抽取事实</span><span>${facts.length} 条</span></div><div class="statusitem"><span>涉及主体</span><span>${entityIds.length} 个</span></div><div class="statusitem"><span>来源文档</span><span>${
    sources.length
  } 份</span></div><div class="statusitem"><span>逐字证据</span><span>${evidenceTotal} 条</span></div><div class="statusitem"><span>单条引文</span><span>${singleSourceFacts} 条</span></div><div class="statusitem"><span>审核记录</span><span>未提供</span></div><div class="statusitem"><span>正式事实 ID</span><span>未分配</span></div></div></div><div class="sidebox"><div class="sidetitle">事实稿档案</div><label>参考档案号（非正式 ID）</label><p style="font-family:ui-monospace,Consolas,monospace;font-size:11px">REF-A${id}-${esc(
    publishedAt.replaceAll('-', '') || 'NA',
  )}</p><label>新闻来源</label><p>${esc(sourceOrg)}${sourceSite ? ` / ${esc(sourceSite)}` : ''}</p><label>报道标题</label><p>${esc(
    rawTitle,
  )}</p><label>原新闻时间</label><p>${esc(publishedAt || '—')}</p>${
    originUrl
      ? `<a class="button" href="${esc(originUrl)}" target="_blank" rel="noopener noreferrer">核对新闻原文 ↗</a>`
      : ''
  }</div><div class="sidebox"><div class="sidetitle">标准引用方式</div><label>引用来源</label><blockquote>${esc(
    citation,
  )}</blockquote><button class="button" type="button" id="copy-citation">复制来源说明</button><p class="limitation">正式发布后才应以事实页的稳定 URL 和版本号替换本样稿的临时标识。</p></div></aside></div>
<footer class="endfoot"><div><b>温州有据 · 可信事实稿参考版</b><br>信息有来源，数字有口径，时间有精度，发布有责任。</div><div style="text-align:right">事实稿由生产线自动生成${
    briefAt ? ` · 内容生成 ${esc(briefAt)}` : ''
  }<br>不是已经上线或签发的官方事实档案</div></footer></div><div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="dataset">${JSON.stringify(dataset).replaceAll('</', '<\\/')}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('dataset').textContent);
  var pre = document.getElementById('json-display');
  var preview = { schema_version: data.schema_version, document_type: data.document_type, record_count: data.record_count, facts: data.facts.slice(0, 2), _preview_note: '仅展示前 2 条，点击下载获取全部 ' + data.record_count + ' 条事实。' };
  if (pre) pre.textContent = JSON.stringify(preview, null, 2);
  var notice = function (msg) { var t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(window.__noticeTimer); window.__noticeTimer = setTimeout(function () { t.classList.remove('show'); }, 2700); };
  var copy = function (text) { try { if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(function(){notice('已复制到剪贴板');}, function(){notice('复制受浏览器限制，请手动选择文字');}); return; } var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); notice(ok ? '已复制到剪贴板' : '复制受浏览器限制，请手动选择文字'); } catch (e) { notice('复制受浏览器限制，请手动选择文字'); } };
  var citationBtn = document.getElementById('copy-citation');
  if (citationBtn) citationBtn.addEventListener('click', function () { copy(${JSON.stringify(citation).replaceAll(
    '</',
    '<\\/',
  )}); });
  var copyJson = document.getElementById('copy-json');
  if (copyJson) copyJson.addEventListener('click', function () { copy(JSON.stringify(data, null, 2)); });
  var saveJson = document.getElementById('save-json');
  if (saveJson) saveJson.addEventListener('click', function () { var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }); var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = 'article-${id}-facts-reference.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); notice('已生成参考 JSON 文件'); });
  document.querySelectorAll('.copy-one').forEach(function (btn) { btn.addEventListener('click', function () { copy(btn.getAttribute('data-copy') + '\\n注：参考稿，未获得正式编辑签发。'); }); });
  if ('IntersectionObserver' in window) {
    var links = [].slice.call(document.querySelectorAll('.toc a'));
    var sections = links.map(function (a) { return document.querySelector(a.getAttribute('href')); }).filter(Boolean);
    var io = new IntersectionObserver(function (entries) {
      var active = entries.filter(function (e) { return e.isIntersecting; }).sort(function (x, y) { return x.boundingClientRect.top - y.boundingClientRect.top; })[0];
      if (!active) return;
      links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + active.target.id); });
    }, { rootMargin: '-95px 0px -68% 0px', threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }
})();
</script>
</body></html>`;

  return html;
}
