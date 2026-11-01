/**
 * 主题聚合页（/facts/{topicId}）—— 与文章事实稿同一套整页版式，信息层级扩展为「多篇文章」。
 *
 * 与文章页的差异：
 * - 标题位 = 主题规范名，导语位 = 主题定义（topic.definition）
 * - 逐项事实是**跨文章合并去重**后的结果，每条带「出自 N 篇文章」
 * - 新增「来源文章」板块：每篇文章可回跳 /articles/{articleId} 看单篇全量事实
 * - 指标卡来自主题级核心数据（成员文章 key_stats 聚合）
 */

import {
  BRAND_CN,
  BRAND_EN,
  FACT_SHEET_CSS,
  FACT_TYPE_LABEL,
  TEMPORAL_LABEL,
  esc,
  isoDay,
  timeText,
} from './article-factsheet';

interface TopicData {
  topic: Record<string, unknown>;
  facts: Record<string, unknown>[];
  articles: Record<string, unknown>[];
  keyStats: { value: string; label: string; sub?: string; approx?: boolean; legacy?: boolean }[];
  keyStatsPending?: { value: string; label: string; scope?: string }[];
  relatedTopics: { id: number; name: string; factCount: number }[];
}

export function renderTopicFactSheetHtml(data: TopicData, baseUrl: string): string {
  const t = data.topic;
  const topicId = Number(t.id);
  const name = String(t.name ?? `主题 ${topicId}`);
  const definition = String(t.definition ?? '').trim();
  const aliases = (Array.isArray(t.aliases) ? (t.aliases as string[]) : []).filter((a) => a && a !== name);
  const facts = data.facts ?? [];
  const articles = data.articles ?? [];
  const firstAt = isoDay(t.firstArticleAt);
  const lastAt = isoDay(t.lastArticleAt);
  const jsonUrl = `${baseUrl}/api/archive/topic/${topicId}/facts`;
  const topicCode = t.code ? String(t.code) : `TP-${topicId}`;

  // ---- 发布门禁（PRD R05）：未签发 / 无已签发事实 / 内网域名，一律不可索引 ----
  const counts = (t.counts ?? {}) as { published?: number; candidate?: number; total?: number };
  const publishedCount = Number(counts.published ?? 0);
  const candidateCount = Number(counts.candidate ?? 0);
  const publicationStatus = String(t.publicationStatus ?? 'private');
  const isPublicBase =
    /^https?:\/\//.test(baseUrl) && !/\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(baseUrl);
  const indexable = publicationStatus === 'published' && publishedCount > 0 && isPublicBase;
  const robotsMeta = indexable ? 'index,follow' : 'noindex,nofollow';
  const canonical = indexable ? `${baseUrl}/facts/${topicId}` : `/facts/${topicId}`;
  const signPill =
    publicationStatus !== 'published'
      ? '<span class="draftpill">内部预览 · 未签发（不可索引）</span>'
      : isPublicBase
        ? '<span class="draftpill signed" style="border-color:#b9d7c6;color:#1d5b3d;background:#eef7f1">已签发 · 可公开引用</span>'
        : '<span class="draftpill">已签发 · 当前为非正式域名（不可索引）</span>';

  const entityIds = [...new Set(facts.map((f) => Number(f.entityId)))];
  const evidenceTotal = facts.reduce((n, f) => n + (((f.evidences ?? []) as unknown[]).length ?? 0), 0);
  const alertList = [
    ...new Set(facts.flatMap((f) => ((f.alerts ?? []) as string[]).map((x) => String(x).trim()).filter(Boolean))),
  ];
  const singleSourceFacts = facts.filter((f) => (((f.evidences ?? []) as unknown[]).length ?? 0) < 2).length;

  // ---- 指标卡：主题级核心数据优先，不足用聚合统计补齐 ----
  const cards = (data.keyStats ?? []).slice(0, 4).map((c) => ({ ...c }));
  const pendingStats = (data.keyStatsPending ?? []).slice(0, 4);
  for (const c of [
    { value: String(facts.length), label: '条合并事实' },
    { value: String(entityIds.length), label: '个涉及主体' },
    { value: String(articles.length), label: '篇来源文章' },
  ]) {
    if (cards.length >= 4) break;
    if (cards.some((x) => x.label === c.label)) continue;
    cards.push(c);
  }

  // ---- 来源文档：跨文章去重，编号 A/B/C… ----
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
          org: String(ev.sourceOrg ?? '—'),
          url,
          publishedAt: isoDay(ev.publishedAt),
          count: 1,
        });
    }
  }
  const sources = [...sourceMap.values()];
  const letter = (i: number) => String.fromCharCode(65 + (i % 26));

  // ---- 时间语义：只列可核对的报道时间，不推断事实生效时间 ----
  const verifiedAts = facts.map((f) => isoDay(f.lastVerifiedAt)).filter(Boolean).sort();
  const validFroms = facts.map((f) => isoDay(f.validFrom)).filter(Boolean).sort();
  const ends = facts.flatMap((f) => [isoDay(f.asOf), isoDay(f.validTo), isoDay(f.eventEnd)]).filter(Boolean).sort();
  const rangeText = validFroms.length ? `${validFroms[0]}${ends.length ? ` ~ ${ends[ends.length - 1]}` : ' 起'}` : '未标注';
  // 时间精度分布（PRD S06）：只陈述 period_key 的形状，不把年份写成 01-01
  const precCount = facts.reduce<Record<string, number>>((m, f) => {
    const p = String(f.timePrecision ?? 'unknown');
    m[p] = (m[p] ?? 0) + 1;
    return m;
  }, {});
  const precisionText =
    [
      ['year', '年'],
      ['quarter', '季度'],
      ['month', '月'],
    ]
      .filter(([k]) => precCount[k])
      .map(([k, label]) => `${precCount[k]} 条${label}精度`)
      .join(' · ') || '未标注时间口径';

  const factCard = (f: Record<string, unknown>, index: number): string => {
    const evidences = (f.evidences ?? []) as Record<string, unknown>[];
    const fArticles = (f.articles ?? []) as Record<string, unknown>[];
    const entityUrl = `${baseUrl}/archive/${esc(f.datasetCode)}/${esc(f.entitySlug)}`;
    const factUrl = f.code ? `${entityUrl}/fact/${encodeURIComponent(String(f.code))}` : entityUrl;
    const code = esc(f.code ?? `#${f.id}`);
    // 证据口径（PRD R01/S02）：按来源家族判定，不再以引文条数暗示独立性
    const ind = (f.independence ?? {}) as { label?: string; level?: string };
    const indLabel = String(ind.label ?? (evidences.length >= 2 ? `引文 ${evidences.length} 条` : '单条报道'));
    const badge =
      ind.level && ind.level !== 'single'
        ? `<span class="fact-st">${esc(indLabel)}</span>`
        : `<span class="fact-st pending">${esc(indLabel)}</span>`;
    const articleBadge = fArticles.length
      ? `<span class="fact-st extra">出自 ${fArticles.length} 篇文章</span>`
      : '';
    // 同一引句被多个主体引用时，只在规范条上标注，避免读者以为重复收录
    const participantBadge =
      Number(f.participantCount ?? 0) > 0
        ? `<span class="fact-st extra">同一引句另挂 ${Number(f.participantCount)} 个主体</span>`
        : '';
    const chips = evidences
      .map((ev, i) => {
        const label = String(ev.sourceOrg ?? '来源').split('/')[0].trim();
        return ev.sourceUrl
          ? `<a class="sourcechip" target="_blank" rel="noopener noreferrer" href="${esc(ev.sourceUrl)}" title="${esc(
              ev.materialTitle ?? '',
            )}">${letter(i)} · ${esc(label)} ↗</a>`
          : `<span class="sourcechip">${letter(i)} · ${esc(label)}</span>`;
      })
      .join('');
    const evBlock = evidences
      .map(
        (ev) => `<div style="border:1px solid #eef1f5;border-radius:7px;padding:10px 12px;margin-top:8px;background:#fff">
        <div style="font-size:10px;color:#8d9c91">${esc(ev.articleTitle ?? ev.materialTitle ?? ev.sourceOrg ?? '来源')}${
          ev.publishedAt ? ` · ${esc(isoDay(ev.publishedAt))}` : ''
        }</div>
        <p style="margin:5px 0 0;font-size:12px;line-height:1.85;color:#3a4c42">「${esc(ev.quote ?? '')}」</p>
        <div style="font-size:10px;color:#8d9c91;margin-top:4px">${
          ev.articleId ? `<a href="${baseUrl}/articles/${esc(ev.articleId)}">该条出自文章 #${esc(ev.articleId)}</a> · ` : ''
        }逐字证据匹配（本地）${
          ev.sourceUrl ? ` · <a href="${esc(ev.sourceUrl)}" target="_blank" rel="nofollow noopener">核对原文</a>` : ''
        }</div>
      </div>`,
      )
      .join('');
    const alerts = ((f.alerts ?? []) as string[])
      .map((x) => `<div class="caution"><b>口径提示：</b>${esc(x)}</div>`)
      .join('');
    const copyText = `${String(f.statement)}（主题：${name}；事实编号 ${String(f.code ?? f.id)}；合并自 ${
      fArticles.length || 1
    } 篇文章）`;
    return `<details class="fact-card" id="fact-${esc(f.id)}"${index === 0 ? ' open' : ''}>
    <summary aria-label="展开或收起 ${code} ${esc(f.statement)}"><div class="fact-head"><span class="fact-code">${code}</span><span>·</span><span>${esc(
      f.entityName,
    )}</span>${badge}${articleBadge}${participantBadge}</div><div class="summary-row"><div><div class="fact-name">${esc(
      f.statement,
    )}</div><div class="fact-short">时间精度：${esc(timeText(f))}　·　证据 ${evidences.length} 条　·　来源文章 ${
      fArticles.length
    } 篇</div></div><span class="chevron" aria-hidden="true">⌄</span></div></summary>
    <div class="fact-detail"><div class="triple"><div><small>主体 / SUBJECT</small><b>${esc(f.entityName)}</b></div><div><small>类型 / TYPE</small><b>${esc(
      FACT_TYPE_LABEL[String(f.factType ?? '')] ?? '事实',
    )}</b></div><div><small>时间 / TIME</small><b>${esc(timeText(f))}</b></div></div>
    <p class="fact-notes"><strong>时间语义：</strong>${esc(TEMPORAL_LABEL[String(f.temporalKind ?? 'unknown')] ?? '未标注')}（${esc(
      timeText(f),
    )}）<br><strong>出处核对：</strong>${esc(
      `${indLabel}（引文 ${evidences.length} 条 / 来源家族 ${Number((ind as { familyCount?: number }).familyCount ?? 1)} 组 / 发布主体 ${Number((ind as { publisherCount?: number }).publisherCount ?? 1)} 个）`,
    )}<br><strong>槽位：</strong>${esc([f.semanticRole, f.periodKey, f.subjectScope].filter(Boolean).join(' · ') || '未标注')}${
      (f.mergedFactIds as number[] | undefined)?.length
        ? `<br><strong>合并事实：</strong>${(f.mergedFactIds as number[]).map((x) => `#${x}`).join('、')}`
        : ''
    }</p>
    ${evBlock}
    <div class="source-chips">${chips}</div>
    ${alerts}
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
    : '<p class="panel-intro">该主题事实暂未挂接可定位的来源文档。</p>';

  const relatedHtml = data.relatedTopics.length
    ? `<div class="source-chips" style="margin-top:14px">${data.relatedTopics
        .map(
          (r) =>
            `<a class="sourcechip" href="${baseUrl}/facts/${r.id}">${esc(r.name)} · ${r.factCount} 条 ↗</a>`,
        )
        .join('')}</div>`
    : '';

  const dataset = {
    schema_version: 'topic-facts-1.0',
    document_type: 'topic_fact_sheet',
    topic: {
      id: topicId,
      code: topicCode,
      name,
      definition,
      aliases,
      first_article_at: firstAt || null,
      last_article_at: lastAt || null,
    },
    key_stats: cards,
    record_count: facts.length,
    article_count: articles.length,
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      source_org: a.sourceOrg,
      published_at: isoDay(a.publishedAt) || null,
      fact_count: a.factCount,
    })),
    facts: facts.map((f) => ({
      record_id: String(f.code ?? f.id),
      merged_fact_ids: f.mergedFactIds ?? [],
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
      article_count: f.articleCount ?? (f.articles as unknown[] | undefined)?.length ?? 0,
      evidences: ((f.evidences ?? []) as Record<string, unknown>[]).map((ev) => ({
        quote: ev.quote,
        source_org: ev.sourceOrg,
        material_title: ev.materialTitle,
        source_url: ev.sourceUrl,
        article_id: ev.articleId,
        article_title: ev.articleTitle,
        published_at: isoDay(ev.publishedAt) || null,
      })),
      caveat: (f.alerts ?? []) as string[],
    })),
  };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${name}｜主题事实档案`,
    description: definition || `聚合 ${articles.length} 篇报道、${facts.length} 条事实的主题事实档案。`,
    url: canonical,
    variableMeasured: cards.map((c) => ({
      '@type': 'PropertyValue',
      name: c.label,
      value: c.value,
      ...(c.sub ? { description: c.sub } : {}),
    })),
    ...(articles.length ? { isBasedOn: articles.map((a) => a.url).filter(Boolean).slice(0, 20) } : {}),
    conditionsOfAccess: 'Reference only. Editorial approval required before official publication.',
  };

  const citation = `温州有据主题事实档案《${name}》（${topicCode}，聚合 ${articles.length} 篇报道 / ${facts.length} 条事实）；主题、摘要与核心数据由事实生产线自动抽取，逐条事实附原文逐字证据。参考稿尚未编辑签发。`;

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#133a32"><meta name="robots" content="${robotsMeta}"><title>${esc(
    name,
  )}｜主题事实档案 · 温州有据</title><meta name="description" content="${esc(
    definition || `聚合 ${articles.length} 篇报道的 ${facts.length} 条事实，附逐字原文证据与来源文章清单。`,
  )}"><link rel="canonical" href="${esc(
    canonical,
  )}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta property="og:type" content="article"><meta property="og:title" content="${esc(
    name,
  )}"><meta property="og:description" content="${esc(definition)}"><meta property="og:url" content="${esc(
    canonical,
  )}"><style>${FACT_SHEET_CSS}</style><script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll(
    '</',
    '<\\/',
  )}</script></head><body>
<header class="topbar"><div class="topinner"><a class="brand" href="${esc(baseUrl)}/" aria-label="返回首页"><span class="logo">温</span><span><span class="brand-cn">${esc(
    BRAND_CN,
  )}</span><br><span class="brand-en">${esc(
    BRAND_EN,
  )}</span></span></a><nav class="nav" aria-label="页面导航"><a href="#overview">事实概览</a><a href="#facts">事实条目</a><a href="#evidence">来源与证据</a><a href="#machine">机器读取</a></nav><div class="topright">${signPill}<button class="printbtn" type="button" onclick="window.print()" aria-label="打印页面">打印 ↗</button></div></div></header>
<div class="wrap"><div class="crumb"><a href="${esc(baseUrl)}/">温州有据</a><span>›</span><span>主题事实档案</span><span>›</span><b>${esc(
    name,
  )}</b></div>
<section class="hero" aria-labelledby="pagetitle"><div class="hero-body"><div class="eyebrow">TOPIC FACT SHEET / 主题事实档案</div><h1 id="pagetitle">${esc(
    name,
  )}<br><span>事实档案</span></h1><p>${
    definition ? esc(definition) : `该主题聚合 ${articles.length} 篇报道与 ${facts.length} 条事实；主题定义尚未由生产线生成。`
  }</p><div class="hero-actions"><a class="button primary" href="#facts">查看事实条目　↗</a>${
    articles[0]?.url
      ? `<a class="button" href="${esc(articles[0].url)}" target="_blank" rel="noopener noreferrer">阅读最新报道　↗</a>`
      : ''
  }</div></div><div class="hero-graphic" aria-hidden="true"><span class="hero-numeral">${esc(
    String(articles.length),
  )}</span><i>${esc(name)} · TOPIC FACT SHEET</i></div></section>
<div class="subline"><div><b>主题｜${esc(name)}</b>${aliases.length ? `<span class="subdot"></span><span>别名：${esc(aliases.slice(0, 3).join('、'))}</span>` : ''}<span class="subdot"></span><span>已签发 ${
    publishedCount
  } 条</span>${
    candidateCount
      ? `<span class="subdot"></span><span>候选 ${candidateCount} 条（未公开）</span>`
      : ''
  }${
    firstAt ? `<span class="subdot"></span><span>报道区间 ${esc(firstAt)} ~ ${esc(lastAt || firstAt)}</span>` : ''
  }</div><span class="statusflag">${
    indexable ? '已签发，可对外引用' : '内部预览稿，不代表编辑部已签发'
  }</span></div>
<div class="layout"><nav class="toc" aria-label="内容目录"><div class="toc-h">ON THIS PAGE</div><a href="#overview" class="active">01　事实概览</a><a href="#facts">02　逐项事实</a><a href="#evidence">03　来源与证据</a><a href="#times">04　时间语义</a><a href="#issues">05　口径与核对</a><a href="#history">06　版本与责任</a><a href="#machine">07　机器读取</a><div class="toc-note">同一主题的多篇报道会被合并去重。<br>每条事实都能回到具体文章与逐字原文。</div></nav>
<main class="maincol">
<section class="panel" id="overview"><div class="panel-head"><div><span class="smallcap">01 / TOPIC OVERVIEW</span><h2>事实概览</h2><p class="panel-intro">先说清这个主题是什么，再按事实单元列出跨文章的合并结果。</p></div></div><div class="abstract">${
    definition ? esc(definition) : `该主题聚合 ${articles.length} 篇报道、${facts.length} 条事实；主题定义尚未由生产线生成。`
  }</div><div class="stats">${cards
    .map(
    (c) =>
      `<div class="stat"><b>${esc(c.value)}</b><small>${esc(c.label)}</small>${
        c.sub
          ? `<em class="stat-sub" style="display:block;font-style:normal;font-size:10px;color:#687c70;margin-top:3px">${esc(
              c.sub,
            )}</em>`
          : ''
      }</div>`,
  )
    .join('')}</div>${
    pendingStats.length
      ? `<p class="captionnote" style="color:#8c6639">待补统计口径（暂不作为核心指标）：${pendingStats
          .map((p) => `${esc(p.value)} ${esc(p.label)}`)
          .join('；')}</p>`
      : ''
  }<p class="captionnote">同一主体、同一陈述的多篇报道会被合并为一条事实，证据累加并标注「出自 N 篇文章」；数字保持来源原样表述，不做换算。</p><div class="identitytable"><div class="identityitem"><small>主题</small><span>${esc(
    name,
  )}</span></div><div class="identityitem"><small>主题编号</small><span>${esc(
    topicCode,
  )}（参考编号，非正式 ID）</span></div><div class="identityitem"><small>别名</small><span>${esc(
    aliases.length ? aliases.slice(0, 6).join('、') : '—',
  )}</span></div><div class="identityitem"><small>报道区间</small><span>${
    firstAt ? `${esc(firstAt)} ~ ${esc(lastAt || firstAt)}` : '—'
  }</span></div><div class="identityitem"><small>覆盖文章</small><span>${articles.length} 篇 / 合并事实 ${
    facts.length
  } 条</span></div><div class="identityitem"><small>本页组织方式</small><span>主题定义 + 事实概览 + 逐项事实 + 来源文章 + 逐字证据</span></div></div>${relatedHtml}</section>
<section class="panel" id="facts"><div class="panel-head"><div><span class="smallcap">02 / MERGED FACT RECORDS</span><h2>逐项事实</h2><p class="panel-intro">同一主体、同一陈述跨文章合并为一条；展开可查看证据来自哪几篇文章。</p></div><span class="sidelink">${facts.length} 条</span></div><div class="toolbar" role="group" aria-label="事实清单"><span class="filterbtn selected">全部 ${facts.length}</span><span class="counttext">合并自 ${articles.length} 篇文章</span></div>${
    facts.map(factCard).join('') || '<p class="panel-intro">该主题暂未抽取出可用事实。</p>'
  }</section>

<section class="panel" id="evidence"><div class="panel-head"><div><span class="smallcap">03 / EVIDENCE &amp; PROVENANCE</span><h2>来源与证据</h2><p class="panel-intro">记录事实挂接的具体出处，转载页不计作新的独立证据。</p></div></div><div class="evidence-list">${evidenceHtml}</div><div class="method">证据说明：每条事实标明所挂接的引文条数与来源文章数。同一篇报道内的多段引文可能重复计数；转载页不计作新的独立来源，来源独立性与证据支持关系仍在逐条判定中，均不等同于事实已被独立调查确认。</div></section>
<section class="panel" id="times"><div class="panel-head"><div><span class="smallcap">04 / TEMPORAL SEMANTICS</span><h2>时间语义</h2><p class="panel-intro">事件何时发生、新闻何时报道、资料何时核对，是不同的时间。</p></div></div><table class="time-table"><tbody><tr><td>首篇报道</td><td>${
    firstAt || '未标注'
  }</td><td>${firstAt ? '精确到日' : '未提供'}</td></tr><tr><td>最新报道</td><td>${
    lastAt || firstAt || '未标注'
  }</td><td>${lastAt ? '精确到日' : '不推断'}</td></tr><tr><td>事实适用区间</td><td>${esc(
    rangeText,
  )}</td><td>按条判定</td></tr><tr><td>时间精度分布</td><td>${esc(
    precisionText,
  )}</td><td>按 period_key 形状判定，不推断到日</td></tr><tr><td>最近核验时间</td><td>${
    verifiedAts.length ? verifiedAts[verifiedAts.length - 1] : '未记录'
  }</td><td>${verifiedAts.length ? '精确到日' : '不推断'}</td></tr><tr><td>正式编辑签发时间</td><td>未发生 / 未录入</td><td>不作推断</td></tr></tbody></table><p class="captionnote">跨文章合并时，事实时间取其自身语义，不因最新报道日期而改变。</p></section>
<section class="panel" id="issues"><div class="panel-head"><div><span class="smallcap">05 / EDITORIAL DISCREPANCIES</span><h2>口径差异与待核对事项</h2><p class="panel-intro">不掩盖来源差异，也不把编辑推测写成已证实结论。</p></div></div>${
    alertList.length
      ? alertList.map((x) => `<div class="notice"><h3>逐条事实附带的口径提示</h3><p>${esc(x)}</p></div>`).join('')
      : '<div class="plainband"><strong>该主题暂未记录来源之间的口径差异</strong>事实集只保留来源原样表述；如后续出现数字、时间或表述冲突，将在此处逐条列出并标注各自出处。</div>'
  }${
    singleSourceFacts
      ? `<div class="plainband"><strong>还有 ${singleSourceFacts} 条事实只有一条引文</strong>这些事实只在单篇报道中出现，尚无第二个来源家族可对照；单源不等于不成立，但引用时应注明来源。</div>`
      : ''
  }</section>
<section class="panel" id="history"><div class="panel-head"><div><span class="smallcap">06 / REVISION &amp; ACCOUNTABILITY</span><h2>版本与责任</h2><p class="panel-intro">主题页由成员文章自动汇总，不虚构审核历史。</p></div></div><div class="history"><div class="historyitem"><b>参考稿 v0.1${
    lastAt ? ` · ${esc(lastAt)}` : ''
  }</b><p>聚合 ${articles.length} 篇报道、合并 ${facts.length} 条事实；主题名、定义与核心数据由生产线大模型生成。未形成正式采编审核或业务签发记录。</p></div></div><div class="identitytable"><div class="identityitem"><small>主题维护方</small><span>温州有据 · 事实档案（自动汇总）</span></div><div class="identityitem"><small>成员文章</small><span>${articles.length} 篇</span></div><div class="identityitem"><small>审核状态</small><span>待人工复核、待编辑签发</span></div><div class="identityitem"><small>更正 / 变更</small><span>暂无正式发布版本，因此无真实更正记录</span></div></div></section>
<section class="panel" id="machine"><div class="panel-head"><div><span class="smallcap">07 / MACHINE READABLE</span><h2>机器读取</h2><p class="panel-intro">页面可见文本与导出的 JSON 使用同一份合并事实清单。</p></div></div><div class="codebox"><div class="codebar"><span>TOPIC FACT DATA · application/json</span><span>${
    facts.length
  } facts / ${articles.length} articles</span></div><pre id="json-display" aria-label="机器可读 JSON 示例"></pre></div><div class="machineactions"><button type="button" class="button primary" id="save-json">下载完整 JSON ↓</button><button type="button" class="button" id="copy-json">复制 JSON</button><a class="button" href="${esc(
    jsonUrl,
  )}" target="_blank" rel="noopener">接口 JSON ↗</a></div><p class="machinehint">数据以静态形式嵌入，可直接解析与下载。</p></section>
<div class="plainband"><strong>设计原则：新闻讲述发生了什么，事实稿交代机器可以依据什么。</strong>主题聚合不裁剪报道差异，而是把同一主题的多篇文章合并成可核查的事实集合。</div>
</main>
<aside class="side"><div class="statuscard"><div><div class="statuscap">PUBLICATION READINESS</div><div class="statushead">待人工复核</div><p>内容由生产线自动汇总，不能代替采编审核与正式发布流程。</p></div><div class="statusdetails"><div class="statusitem"><span>合并事实</span><span>${facts.length} 条</span></div><div class="statusitem"><span>涉及主体</span><span>${entityIds.length} 个</span></div><div class="statusitem"><span>来源文章</span><span>${articles.length} 篇</span></div><div class="statusitem"><span>来源文档</span><span>${sources.length} 份</span></div><div class="statusitem"><span>逐字证据</span><span>${evidenceTotal} 条</span></div><div class="statusitem"><span>单条引文</span><span>${singleSourceFacts} 条</span></div><div class="statusitem"><span>正式事实 ID</span><span>未分配</span></div></div></div><div class="sidebox"><div class="sidetitle">主题档案</div><label>主题编号（参考）</label><p style="font-family:ui-monospace,Consolas,monospace;font-size:11px">${esc(
    topicCode,
  )}</p><label>主题名</label><p>${esc(name)}</p><label>别名</label><p>${esc(aliases.length ? aliases.slice(0, 4).join('、') : '—')}</p><label>报道区间</label><p>${
    firstAt ? `${esc(firstAt)} ~ ${esc(lastAt || firstAt)}` : '—'
  }</p><label>聚合文章</label><p>${articles.length} 篇 / ${facts.length} 条事实</p></div><div class="sidebox"><div class="sidetitle">标准引用方式</div><label>引用来源</label><blockquote>${esc(
    citation,
  )}</blockquote><button class="button" type="button" id="copy-citation">复制来源说明</button><p class="limitation">正式发布后才应以主题页的稳定 URL 与版本号替换本样稿的临时标识。</p></div></aside></div>
<footer class="endfoot"><div><b>温州有据 · 主题事实档案参考版</b><br>同一主题，多篇报道，一套可核查的事实。</div><div style="text-align:right">主题页由生产线自动生成${
    lastAt ? ` · 最新报道 ${esc(lastAt)}` : ''
  }<br>不是已经上线或签发的官方事实档案</div></footer></div><div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="dataset">${JSON.stringify(dataset).replaceAll('</', '<\\/')}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('dataset').textContent);
  var pre = document.getElementById('json-display');
  var preview = { schema_version: data.schema_version, document_type: data.document_type, topic: data.topic, record_count: data.record_count, article_count: data.article_count, facts: data.facts.slice(0, 2), _preview_note: '仅展示前 2 条，点击下载获取全部 ' + data.record_count + ' 条合并事实。' };
  if (pre) pre.textContent = JSON.stringify(preview, null, 2);
  var notice = function (msg) { var t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(window.__noticeTimer); window.__noticeTimer = setTimeout(function () { t.classList.remove('show'); }, 2700); };
  var copy = function (text) { try { if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(function(){notice('已复制到剪贴板');}, function(){notice('复制受浏览器限制，请手动选择文字');}); return; } var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); notice(ok ? '已复制到剪贴板' : '复制受浏览器限制，请手动选择文字'); } catch (e) { notice('复制受浏览器限制，请手动选择文字'); } };
  var citationBtn = document.getElementById('copy-citation');
  if (citationBtn) citationBtn.addEventListener('click', function () { copy(${JSON.stringify(citation).replaceAll('</', '<\\/')}); });
  var copyJson = document.getElementById('copy-json');
  if (copyJson) copyJson.addEventListener('click', function () { copy(JSON.stringify(data, null, 2)); });
  var saveJson = document.getElementById('save-json');
  if (saveJson) saveJson.addEventListener('click', function () { var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }); var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = 'topic-${topicId}-facts.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); notice('已生成参考 JSON 文件'); });
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
