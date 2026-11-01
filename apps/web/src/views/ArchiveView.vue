<template>
  <div class="archive-page">
    <!-- 加载中（原生状态位，替代 v-loading 指令） -->
    <div v-if="loading" class="state-loading">加载中…</div>

    <!-- 404 / 未发布 -->
    <div v-if="notFound" class="state-empty">
      <p class="state-desc">档案不存在或未发布</p>
      <button class="state-btn" @click="router.replace('/')">返回首页</button>
    </div>

    <!-- 加载失败（网络 / 服务未就绪 / 5xx）：不是「档案不存在」，给重试 -->
    <div v-else-if="loadError" class="state-empty">
      <p class="state-desc">{{ loadError }}</p>
      <button class="state-btn" @click="load">重试</button>
    </div>

    <template v-else-if="page">
      <!-- ============ 站点蓝条 ============ -->
      <header class="site">
        <div class="wrap">
          <div class="bar">
            <div class="brand">
              <a class="logo-link" href="/overview" @click.prevent="goSiteHome">
                <span class="logo">温州在线 · <b>瓯菜事实</b></span>
              </a>
              <span class="sub">基线+增量 · 事实如何被新闻驱动更新</span>
            </div>
            <nav>
              <a href="#current" @click.prevent="scrollTo('current')">当前事实</a>
              <a href="#graph" @click.prevent="scrollTo('graph')">关系图谱</a>
              <a href="#events" @click.prevent="scrollTo('events')">事件时间线</a>
              <a href="#evidence" @click.prevent="scrollTo('evidence')">证据链</a>
              <a href="#news" @click.prevent="scrollTo('news')">相关新闻</a>
              <a href="#machine" @click.prevent="scrollTo('machine')">数据出口</a>
            </nav>
          </div>
          <div class="crumbs">{{ entity.datasetCode }} / assets / {{ typeLabel }} / <b>{{ identifier }}</b></div>
        </div>
      </header>

      <!-- ============ 实体头部 ============ -->
      <div class="pagehead">
        <div class="wrap">
          <div class="kicker">事实档案 · FACT SHEET</div>
          <h1 class="name">{{ entity.name }}</h1>
          <div class="entid">{{ identifier }} · {{ entity.categoryName }} · 种子来源：{{ entity.seedSource }}</div>
          <p v-if="entity.lede" class="lede">{{ entity.lede }}</p>

          <div class="statrow">
            <div class="stat"><div class="n">{{ s.facts }}</div><div class="l">公开事实</div></div>
            <div class="stat"><div class="n">{{ s.active }}</div><div class="l">现行事实</div></div>
            <div class="stat"><div class="n">{{ s.superseded }}</div><div class="l">已被替代</div></div>
            <div class="stat"><div class="n">{{ s.pendingArbitration }}</div><div class="l">待仲裁</div></div>
            <div class="stat"><div class="n">{{ s.events }}</div><div class="l">事件</div></div>
            <div class="stat"><div class="n">{{ s.evidences }}</div><div class="l">证据条目</div></div>
            <div class="stat"><div class="n">{{ s.articles }}</div><div class="l">相关报道</div></div>
          </div>

          <div class="verify">
            <span>基线：<b>{{ s.baseline }} 篇（{{ baseRange }}）</b>建立初始事实库</span>
            <span>增量：<b>{{ s.incremental }} 篇（{{ incRange }}）</b></span>
            <span>校验：<b>引句逐字回查 {{ s.evidencePassed }}/{{ s.evidences }} PASS</b></span>
            <span>最后核验：<b>{{ lastVerified }}</b></span>
          </div>
        </div>
      </div>

      <div class="wrap">
        <!-- ============ 事实条目（仅现行；按来源发布日倒序，最近报道在前） ============ -->
        <section id="current">
          <h2 class="sec">事实条目</h2>
          <p class="secdesc">
            共 {{ factsAll.length }} 条现行事实，按<b>来源发布日期</b>倒序（最近报道在前，无发布日期的排最后）；
            每条事实值为完整陈述句（LLM 语义组装），证据编号可点击下钻到原文引句锚点。
            已被替代的历史版本不再展示（在库内保留备查）。
          </p>
          <div
            v-for="f in factsAll"
            :key="f.id"
            class="factcard"
            :id="'fact-' + f.code"
          >
            <div class="pred">{{ dimLabel(f.dimension) }} · {{ f.code }}
              <span v-if="!isCurrent(f)" class="stchip supx">{{ statusLabelZh(f.status) }}</span>
              <button
                class="perma"
                :title="'复制该事实的稳定链接（可直接引用/收藏）'"
                @click="copyFactLink(f)"
              >{{ copiedCode === f.code ? '已复制 ✓' : '链接' }}</button>
            </div>
            <div class="claim">{{ f.statement }}</div>
            <div class="meta meta-lines">
              <div v-if="f.validFrom || f.validTo"><b>生效：</b>{{ fmt(f.validFrom) }} ～ {{ fmt(f.validTo) }}</div>
              <div v-if="srcPubAt(f)"><b>来源发布：</b>{{ fmt(srcPubAt(f)) }}</div>
              <div
                title="系统抽取入档并完成引句逐字回查的时间；若后续有新的报道再次支持同一说法，会刷新为那一次的时间"
              >
                <b>入库/核验：</b>
                <template v-if="f.reviewedByName">{{ f.reviewedByName }} · {{ f.reviewedAt || '—' }}</template>
                <template v-else>自动管线（抽取入库） · {{ fmt(f.lastVerifiedAt) }}</template>
              </div>
              <div class="evs"><b>证据：</b>
                <template v-if="factEvidence(f).length">
                  <a v-for="ev in factEvidence(f)" :key="ev.id" :href="'#ev-' + (ev.id ?? ev.code)" :title="'证据 id=' + (ev.id ?? '') + ' · 归属：' + ((ev.entities||[]).map((e:any)=>e.name).join('、') || '—')" @click.prevent="scrollTo('ev-' + (ev.id ?? ev.code))">{{ ev.code }}</a>
                </template>
                <span v-else class="muted">无</span>
              </div>
            </div>
          </div>
          <div v-if="!factsAll.length" class="state-inline">暂无事实</div>
        </section>

        <!-- ============ 关系图谱 ============ -->
        <section id="graph">
          <h2 class="sec">关系图谱（一跳）</h2>
          <p class="secdesc">
            以「{{ entity.name }}」为中心的实体关系。边来自事实推导与生产线关系抽取
            （支持缩放/拖拽，点击节点高亮邻近，右侧列表可跳转对应档案页）。
          </p>
          <div v-show="hasGraph" class="graphbox">
            <div ref="graphEl" class="graphcanvas"></div>
            <div class="graphside">
              <div class="gshead">关联关系（{{ (page.graph?.edges ?? []).length }}）</div>
              <div v-for="e in (page.graph?.edges ?? []).slice(0, 12)" :key="e.id" class="graphrow">
                <div class="gr-top">
                  <span class="gn">{{ edgeName(e.head) }}</span>
                  <span class="gp">{{ e.label }}</span>
                  <a class="gn link" :href="nodeHref(e.tail)" @click.prevent="goNode(e.tail)">{{ edgeName(e.tail) }}</a>
                  <span class="gc">{{ Number(e.confidence).toFixed(2) }}</span>
                </div>
                <div v-if="e.quote" class="gr-quote">
                  「{{ e.quote }}」
                  <span v-if="e.verifyStatus" class="gr-v" :class="e.verifyStatus">{{ verbLabelZH[e.verifyStatus] }}</span>
                </div>
              </div>
              <div v-if="(page.graph?.edges ?? []).length > 12" class="gmore">
                仅列出前 12 条，完整明细见后台「知识图谱」页
              </div>
            </div>
          </div>
          <p v-if="!hasGraph" class="secdesc">暂无关系数据（该实体还没有入图的关联关系）。</p>
        </section>

        <!-- ============ 事件时间线 ============ -->
        <section id="events">
          <h2 class="sec">事件时间线</h2>
          <p class="secdesc">
            只收录真实事件（时间+地点+主体+动作的语义组装）；状态描述与主体错配的提及不进时间线。
          </p>
          <div v-if="page.events.length" class="timeline">
            <div v-for="ev in page.events" :key="ev.id" class="tl-item">
              <div class="tl-date">
                {{ ev.timeText }}
                <span style="color:#8896a6;font-weight:400">[{{ precisionZh(ev.timePrecision) }}]</span>
              </div>
              <div class="tl-title">{{ ev.description }}</div>
              <div class="tl-detail">地点：{{ ev.location }} · 主体：{{ ev.subject }} · 类型：{{ ev.eventType }}</div>
              <div v-if="ev.quote" class="tl-quote">{{ ev.quote }}</div>
              <div class="tl-refs">
                证据：
                <template v-if="ev.evLinks && ev.evLinks.length">
                  <a v-for="l in ev.evLinks" :key="l.id" :href="'#ev-' + l.code">{{ l.code }}</a>
                </template>
                <span v-else class="muted">—</span>
                <template v-if="ev.articleUrl">
                  · 报道：<a :href="ev.articleUrl" target="_blank" style="color:#0b5cab;text-decoration:none">{{ ev.articleTitle }}</a>
                </template>
                <span v-if="ev.articleBatch === 'incremental'"> · 增量</span>
              </div>
            </div>
          </div>
          <p v-else class="secdesc">暂无事件。</p>
        </section>

        <!-- ============ 证据链 ============ -->
        <section id="evidence">
          <h2 class="sec">证据链（凭什么？）</h2>
          <p class="secdesc">
            每条证据给出：来源机构、材料标题、原始发布时间、原文引用片段、物理锚点 [start, end) 与 span 哈希。
            锚点偏移相对 DB 存储的正文切片（实体相关段落窗口）。
          </p>
          <div v-for="ev in sortedEvidence" :key="ev.id" class="evcard" :id="'ev-' + (ev.id ?? ev.code)">
            <div class="evhead">
              <span class="evno">{{ ev.code }}</span>
              <span>{{ ev.sourceOrg }}</span>
              <span>发布：{{ ev.publishedAt }}</span>
              <span>证据 {{ relTime(ev.publishedAt) }}前</span>
              <span class="chip gradeA">质量 {{ ev.qualityGrade || 'A' }} · {{ batchZh(ev.batch) }}</span>
              <span class="chip prec">正文引用（物理锚点）</span>
              <span class="chip prec">{{ ev.verifyStatus === 'passed' ? '规则核验通过' : (ev.verifyStatus || '') }}</span>
              <span class="chip ownership">归属：{{ ev.entities && ev.entities.length ? ev.entities.map((e: any) => e.name).join('、') : '—' }}</span>
            </div>
            <div class="evtitle">
              <a :href="evUrl(ev)" target="_blank" rel="noopener">{{ ev.materialTitle || ev.articleTitle }}</a>
            </div>
            <div v-if="claimLine(ev)" style="font-size:12.5px;color:var(--sub);margin-top:4px">
              抽取主张：【{{ entity.name }}】{{ claimLine(ev) }}
            </div>
            <blockquote>{{ ev.quote }}</blockquote>
            <div class="anchors">
              物理锚点 [{{ ev.spanStart }}, {{ ev.spanEnd }}) · span_hash {{ ev.spanHash }} · urn:{{ ev.assetUrn }}
            </div>
            <div class="evlinks">
              <a :href="evUrl(ev)" target="_blank" rel="noopener">查看原始报道 ↗</a>
              <a
                v-if="ev.articleId"
                :href="`/api/archive/article/${ev.articleId}/raw`"
                target="_blank"
                rel="noopener"
                style="margin-left:12px"
              >本地快照（存档）</a>
              <span style="color:var(--sub);margin-left:10px">
                支撑事实：
                <template v-if="supportMap[ev.id] && supportMap[ev.id].length">
                  <a v-for="fc in supportMap[ev.id]" :key="fc" :href="'#fact-' + fc" @click.prevent="scrollTo('fact-' + fc)">{{ fc }}</a>
                </template>
                <span v-else class="muted">—</span>
              </span>
            </div>
          </div>
          <div v-if="!page.evidence.length" class="state-inline">暂无证据</div>
        </section>

        <!-- ============ 相关新闻 ============ -->
        <section id="news">
          <h2 class="sec">相关新闻（原 CMS 报道）</h2>
          <p class="secdesc">历史报道不重新发布，作为证据与事实页互相链接；下列为原始新闻页面（66wz.com）。</p>
          <div v-if="page.articles.length" class="newslist">
            <div v-for="a in page.articles" :key="a.id" class="newsrow">
              <span class="nd">{{ a.publishedAt }}</span>
              <span class="nm">{{ a.sourceOrg }}</span>
              <span><a :href="a.url" target="_blank" rel="noopener">{{ a.title }}</a></span>
              <span class="chip" :class="a.batch === 'incremental' ? 'gradeA' : 'prec'">
                {{ a.batch === 'incremental' ? '增量' : '基线' }}
              </span>
              <a :href="`/api/archive/article/${a.id}/raw`" target="_blank" rel="noopener" class="chip">快照</a>
            </div>
          </div>
          <p v-else class="secdesc">暂无报道。</p>
        </section>

        <!-- ============ 机器出口 ============ -->
        <section id="machine">
          <h2 class="sec">机器出口</h2>
          <p class="secdesc">实体 URN、结构化数据端点与订阅源。全部公开只读，供搜索引擎 / AI 引用核验。</p>

          <div class="machine-card">
            <div class="machine-card-head">
              <span class="machine-card-title">机器出口</span>
              <span class="machine-card-sub">Machine-readable outputs</span>
            </div>
            <div class="machine-card-body">

              <div class="machine-line">
                <span class="machine-tag">Fact:</span>
                <span class="machine-cells">
                  <a class="machine-path" :href="`/archive/${entity.datasetCode}/${entity.slug}`" target="_blank" rel="noopener">/archive/{{ entity.datasetCode }}/<b>{{ entity.slug }}</b>/</a> HTML <span class="machine-note">(服务端直出)</span>
                  <span class="machine-sep">·</span>
                  <a class="machine-path" :href="`/api/archive/${entity.datasetCode}/${entity.slug}.json`" target="_blank" rel="noopener">{{ entity.slug }}.json</a> JSON API
                  <span class="machine-sep">·</span>
                  <span class="machine-path" style="cursor:help">页面内嵌 JSON-LD</span>
                </span>
              </div>

              <div class="machine-line">
                <span class="machine-tag">URN:</span>
                <span class="machine-cells"><code class="machine-code">{{ entity.urn }}</code></span>
              </div>

              <div class="machine-line">
                <span class="machine-tag">变化流:</span>
                <span class="machine-cells">
                  <a class="machine-path" href="/api/archive/feed.json" target="_blank" rel="noopener">feed.json</a> <span class="machine-note">(近 30 天事实变更)</span>
                </span>
              </div>

              <div class="machine-line">
                <span class="machine-tag">索引与订阅:</span>
                <span class="machine-cells">
                  <a class="machine-path" href="/api/archive/sitemap.xml" target="_blank" rel="noopener">sitemap.xml</a>
                  <span class="machine-sep">·</span>
                  <a class="machine-path" href="/api/archive/feed.xml" target="_blank" rel="noopener">feed.xml</a>
                  <span class="machine-sep">·</span>
                  <a class="machine-path" href="/api/archive/feed.json" target="_blank" rel="noopener">feed.json</a>
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

          <JsonLd :data="jsonLd" />
        </section>

        <footer class="page-footer">
          管线：本页由温州有据档案前端直出，数据来自后端 archive 接口（facts / evidence / changes / events / articles），纯只读聚合、无 LLM 调用。
        </footer>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DataSet, Network } from 'vis-network/standalone';
import type { Edge as VisEdge, Node as VisNode, Options as VisOptions } from 'vis-network/standalone';
import http from '@/api/http';
import { isPrerenderedBoot, setPageTitle, withBrand } from '@/utils/pageTitle';

const PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
/** 引句逐字回查状态中文 */
const verbLabelZH: Record<string, string> = { pending: '待核验', passed: '引句PASS', failed: '引句FAIL' };

/** JSON-LD：模板里不允许直接写 <script>，用渲染函数产出（type 非 JS，不会被浏览器执行） */
const JsonLd = (props: { data: string }) => h('script', { type: 'application/ld+json' }, props.data);

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const notFound = ref(false);
/** 非 404 的加载失败（网络/5xx），与「档案不存在」区分开 */
const loadError = ref<string | null>(null);

/* eslint-disable @typescript-eslint/no-explicit-any */
const page = ref<any>(null);

const entity = computed<any>(() => page.value?.entity ?? {});
const s = computed<any>(() => page.value?.stats ?? {});
const typeLabel = computed(() => entity.value.categoryName || 'Entity');
const identifier = computed(() => entity.value.urn ?? `${entity.value.datasetCode}:${entity.value.name}`);

/** 现行 = active / pending_arbitration；其余（superseded / archived）为历史版本，只在「事实变化」里备查 */
const isCurrent = (f: any) => f?.status === 'active' || f?.status === 'pending_arbitration';

/** 事实编号末段序号（用于排序：编号补零只有两位，超 99 条后按字符串比较会乱序） */
const codeSeqOf = (code: any) => Number(String(code ?? '').match(/(\d+)\s*$/)?.[1] ?? 0);

/** 「事实条目」只列现行事实，按**来源发布日倒序**（最近报道在前）；无发布日期的排最后，同日按编号倒序兜底 */
const factsAll = computed<any[]>(() => {
  const dayOf = (f: any) => {
    const v = srcPubAt(f);
    return v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '';
  };
  const all = [...(page.value?.facts ?? []), ...(page.value?.superseded ?? [])];
  return all
    .filter((f: any) => isCurrent(f))
    .sort((a: any, b: any) => {
      const da = dayOf(a);
      const db = dayOf(b);
      if (da !== db) {
        if (!da) return 1; // 无来源发布日期的排最后
        if (!db) return -1;
        return da < db ? 1 : -1; // 日期大的在前
      }
      return codeSeqOf(b.code) - codeSeqOf(a.code);
    });
});

/** 证据 id（唯一）→ 支撑的事实 code[]（反向映射）。
 *  evidence.code 现为全网唯一编号，但 key 仍用 id 最稳。 */
const supportMap = computed<Record<number, string[]>>(() => {
  const m: Record<number, string[]> = {};
  for (const f of [...(page.value?.facts ?? []), ...(page.value?.superseded ?? [])]) {
    for (const ev of (f.evidences ?? []) as any[]) {
      if (!ev.id) continue;
      (m[ev.id] = m[ev.id] ?? []).push(f.code);
    }
  }
  return m;
});

/** 事实 code → { dimension, statement }，供证据卡“抽取主张” */
const factMeta = computed<Record<string, { dim: string; statement: string }>>(() => {
  const m: Record<string, { dim: string; statement: string }> = {};
  for (const f of [...(page.value?.facts ?? []), ...(page.value?.superseded ?? [])]) {
    if (f.code) m[f.code] = { dim: f.dimension, statement: f.statement };
  }
  return m;
});

/** 维度 code → 中文名（来自后端 fact_dimension 字典，避免直接显示 banquet_status 之类英文） */
const dimMap = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const d of (page.value?.dimensions ?? []) as any[]) {
    if (d?.code) m[d.code] = d.name ?? d.code;
  }
  return m;
});
const dimLabel = (code: string) => dimMap.value[code] ?? code ?? '';

const lastVerified = computed(() => {
  let m: string | null = null;
  for (const f of [...(page.value?.facts ?? []), ...(page.value?.superseded ?? [])]) {
    if (f.lastVerifiedAt && (!m || f.lastVerifiedAt > m)) m = f.lastVerifiedAt;
  }
  return m ?? '-';
});

const baseRange = computed(() => rangeOf((page.value?.articles ?? []).filter((a: any) => a.batch === 'baseline')));
const incRange = computed(() => rangeOf((page.value?.articles ?? []).filter((a: any) => a.batch === 'incremental')));

const jsonLd = computed(() => {
  if (!page.value) return '';
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Thing',
    name: entity.value.name,
    identifier: identifier.value,
    description: entity.value.lede ?? '',
    numberOfFacts: s.value.facts,
    numberOfChanges: s.value.changes,
    numberOfEvents: s.value.events,
    numberOfEvidences: s.value.evidences,
  });
});

/* ------------------------------------------------------------------ head 元数据
   档案页在 SPA 里是纯客户端渲染，服务端预渲染只对爬虫 UA 生效；
   真浏览器（及后续放行的 AI 浏览器）需要 JS 自己补上 description / canonical / og。
   只做「存在则更新、不存在则新增」，不引入额外依赖。 */
/** robots meta：content 为 null 时移除标记。
 *  404 时写 noindex，让渲染型引擎把普通 UA 的 soft-404（服务端仍回 200 壳）排除出索引；
 *  正常档案页 applyHead() 复位，覆盖 SPA 内部 404 → 正常页的导航。 */
const upsertRobots = (content: string | null) => {
  let el = document.head.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  if (!content) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', 'robots');
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
};

const applyHead = () => {
  const e = entity.value;
  if (!e?.name) return;
  // 预渲染页首屏：服务端已写好 title/description/canonical/og，运行时整段跳过——
  // 否则通用标题会覆盖掉预渲染的专属 SEO 标题（爬虫渲染 JS 后取到的标题就变了）
  if (isPrerenderedBoot()) return;
  upsertRobots(null);
  const canonical = `${location.origin}/archive/${e.datasetCode}/${e.slug}`;
  const desc = e.lede ?? `${e.name}的机器可读档案页，事实均附逐字原文证据。`;
  const upsertMeta = (attr: 'name' | 'property', key: string, content: string) => {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  };
  const title = `${e.name} — ${e.datasetName ?? ''}档案`;
  setPageTitle(title);
  upsertMeta('name', 'description', desc);
  upsertMeta('property', 'og:title', withBrand(title));
  upsertMeta('property', 'og:description', desc);
  upsertMeta('property', 'og:type', 'article');
  upsertMeta('property', 'og:url', canonical);
  let link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  link.setAttribute('href', canonical);
};

// ---------------------------------------------------------------- 辅助函数

const STATUS_ZH: Record<string, string> = {
  active: '现行',
  pending_arbitration: '待仲裁',
  superseded: '已被替代',
  archived: '已归档',
};
const statusLabelZh = (st: string) => STATUS_ZH[st] ?? st;

const PREC_ZH: Record<string, string> = {
  year: '年', month: '月', decade: '年代', dynasty: '朝代', year_inferred: '年(推算)', date: '日',
};
const precisionZh = (p: string) => PREC_ZH[p] ?? p ?? '';

const batchZh = (b: string) => (b === 'incremental' ? '增量' : '基线');

const relTime = (dateStr: string) => {
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const days = (Date.now() - then) / 86400000;
  if (days < 30) return `${Math.round(days)} 天`;
  if (days < 365) return `${(days / 30.4).toFixed(1)} 个月`;
  return `${(days / 365).toFixed(1)} 年`;
};

const rangeOf = (arr: any[]) => {
  const ds = arr.map((a) => a.publishedAt).filter(Boolean).sort();
  return ds.length ? `${ds[0]} ~ ${ds[ds.length - 1]}` : '—';
};

const fmt = (v: any) => {
  if (!v) return '-';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** 来源发布：取第一条证据的报道发布时间（无证据则为空） */
const srcPubAt = (f: any) => f.evidences?.[0]?.publishedAt ?? null;

const evUrl = (ev: any) => ev.sourceUrl || ev.articleUrl || '#';

const scrollTo = (id: string) => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** 单条事实的稳定公开链接：/archive/{dataset}/{slug}/fact/{code}（可引用、可收藏） */
const factHref = (f: any) => {
  const e = page.value?.entity;
  if (!e) return `#fact-${f.code}`;
  return `/archive/${encodeURIComponent(e.datasetCode)}/${encodeURIComponent(e.slug)}/fact/${encodeURIComponent(f.code)}`;
};

/** 复制链接反馈：按钮短暂变为「已复制 ✓」，不弹提示 */
const copiedCode = ref('');
let copiedTimer: number | undefined;
const copyFactLink = async (f: any) => {
  const url = `${window.location.origin}${factHref(f)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // 非安全上下文/无剪贴板权限时降级：把稳定地址写入地址栏，用户可自行复制
    window.history.replaceState(null, '', factHref(f));
  }
  copiedCode.value = f.code;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copiedCode.value = ''), 1500);
};

/** 站点首页：/overview（与站内其他页面的品牌标识一致） */
const goSiteHome = () => {
  router.push('/overview');
};

/** 证据 code 的末段序号（wenzhou-city-trust-E-000512-01 → 1），用于证据链升序 */
const codeNum = (code: any) => {
  const m = String(code ?? '').match(/(\d+)$/);
  return m ? Number(m[1]) : 1e9;
};
/** 证据链按编号末段序号升序（编号现已全网唯一） */
const sortedEvidence = computed<any[]>(() =>
  [...(page.value?.evidence ?? [])].sort((a: any, b: any) => codeNum(a.code) - codeNum(b.code)),
);

/** 证据 id → 归属实体名[]（来自证据链 page.evidence，chain 已带 entities）。事实卡用它判定归属 */
const evEntities = computed<Map<number, string[]>>(() => {
  const m = new Map<number, string[]>();
  for (const ev of page.value?.evidence ?? []) {
    m.set(ev.id, (ev.entities ?? []).map((en: any) => en.name));
  }
  return m;
});

/** 该事实的证据：只显示「归属当前实体」的（去掉脏挂到别的实体/文章的证据），
 *  按 E 编号升序、按 id 去重。若无本实体证据则回退显示全部（去重+排序）避免一片乱码。 */
const factEvidence = (f: any) => {
  const all = f?.evidences ?? [];
  const ownName = page.value?.entity?.name;
  const own = all.filter((ev: any) => ownName && (evEntities.value.get(ev.id) ?? []).includes(ownName));
  const src = own.length ? own : all;
  const seen = new Set<number>();
  const list: any[] = [];
  for (const ev of src) {
    if (ev.id == null || seen.has(ev.id)) continue;
    seen.add(ev.id);
    list.push(ev);
  }
  return list.sort((a: any, b: any) => codeNum(a.code) - codeNum(b.code));
};

const claimLine = (ev: any) => {
  const codes = supportMap.value[ev.id];
  if (!codes || !codes.length) return '';
  const m = factMeta.value[codes[0]];
  return m ? `${dimLabel(m.dim)}：${m.statement}` : '';
};

/* ---------------- 关系图谱（一跳） ---------------- */
const graphEl = ref<HTMLDivElement | null>(null);
let network: Network | null = null;
let visNodes = new DataSet<VisNode>([]);
let visEdges = new DataSet<VisEdge>([]);

const hasGraph = computed(() => ((page.value?.graph?.edges ?? []) as unknown[]).length > 0);
const edgeName = (id: number) =>
  ((page.value?.graph?.nodes ?? []) as { id: number; name: string }[]).find((n) => n.id === id)?.name ?? `#${id}`;
const nodeOf = (id: number) =>
  ((page.value?.graph?.nodes ?? []) as { id: number; name: string; slug?: string; datasetCode?: string }[]).find(
    (x) => x.id === id,
  );
const nodeHref = (id: number) => {
  const n = nodeOf(id);
  return n?.slug && n?.datasetCode
    ? `/archive/${encodeURIComponent(n.datasetCode)}/${encodeURIComponent(n.slug)}`
    : '#';
};

/** 点节点跳档案：走 SPA 路由（用 <a href> 会整页重新加载，且会丢掉当前页状态） */
const goNode = (id: number) => {
  const n = nodeOf(id);
  if (!n?.slug || !n?.datasetCode) return;
  if (Number(page.value?.entity?.id) === id) return; // 点的是当前实体本身，不动
  void router.push(`/archive/${encodeURIComponent(n.datasetCode)}/${encodeURIComponent(n.slug)}`);
};

const renderGraph = () => {
  const g = page.value?.graph as
    | {
        center: number;
        nodes: {
          id: number; name: string; slug: string | null; datasetCode: string | null;
          categoryName: string | null; nodeType?: 'entity' | 'concept'; lede?: string | null;
        }[];
        edges: {
          id: number; head: number; tail: number; label: string; statement: string | null;
          quote?: string | null; evidenceCode?: string | null; verifyStatus?: 'pending' | 'passed' | 'failed' | null;
        }[];
      }
    | undefined;
  if (!graphEl.value) return;
  if (!g?.edges?.length) {
    network?.destroy();
    network = null;
    return;
  }
  // 星型预置坐标：中心实体在圆点（fixed 锁死），其余节点按谓词分组等角铺在圆周，避免初始挤成一团
  const star = new Map<number, { x: number; y: number }>();
  const R = 240; // 半径（像素）
  const center = g.center;
  star.set(center, { x: 0, y: 0 });
  const relBy = new Map<string, number[]>();
  for (const e of g.edges) {
    const isHead = e.head === center;
    const isTail = e.tail === center;
    if (!isHead && !isTail) continue;
    const other = isHead ? e.tail : e.head;
    if (other == null || other === center) continue;
    const arr = relBy.get(e.label) ?? [];
    arr.push(other);
    relBy.set(e.label, arr);
  }
  const order: number[] = [];
  const seen = new Set<number>([center]);
  for (const [, arr] of relBy) for (const id of arr) if (!seen.has(id)) { seen.add(id); order.push(id); }
  for (const nd of g.nodes) if (!seen.has(nd.id)) { seen.add(nd.id); order.push(nd.id); }
  const total = order.length || 1;
  const step = (2 * Math.PI) / total;
  order.forEach((id, i) => {
    const a = -Math.PI / 2 + i * step;
    star.set(id, { x: Math.cos(a) * R, y: Math.sin(a) * R });
  });

  const nodeName = (id: number) => (g.nodes.find((n) => n.id === id)?.name ?? `#${id}`);
  const cats = [...new Set(g.nodes.map((n) => n.categoryName ?? '未分类'))];
  const visNodeList: VisNode[] = g.nodes.map((n) => {
    const p = star.get(n.id);
    return {
      id: n.id,
      label: n.name,
      shape: 'dot',
      x: p?.x ?? 0,
      y: p?.y ?? 0,
      // 中心实体固定在圆点；其余节点由物理引擎在预设位置附近微调（数据量小、稳定不动）
      physics: n.id === center ? false : true,
      fixed: n.id === center ? { x: true, y: true } : false,
      size: n.id === center ? 24 : 18,
      color: {
        background: n.id === center ? '#0b5cab' : PALETTE[cats.indexOf(n.categoryName ?? '未分类') % PALETTE.length],
        border: n.id === center ? '#fff' : undefined,
      },
      borderWidth: n.id === center ? 2 : 1,
      title: [
        n.name,
        n.nodeType ? `类型：${n.nodeType === 'concept' ? '概念' : '实体'}` : '',
        n.categoryName ? `类别：${n.categoryName}` : '',
        n.lede || undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });
  const visEdgeList: VisEdge[] = g.edges.map((e) => ({
    id: e.id,
    from: e.head,
    to: e.tail,
    label: e.label,
    arrows: 'to',
    width: 2,
    color: '#333333',
    title:
      (e.statement ?? `${nodeName(e.head)} ${e.label} ${nodeName(e.tail)}`) +
      (e.quote ? `\n引句：「${e.quote}」` : '') +
      (e.evidenceCode ? `\n证据：${e.evidenceCode}${e.verifyStatus ? ` · ${verbLabelZH[e.verifyStatus] ?? e.verifyStatus}` : ''}` : ''),
  }));

  visNodes = new DataSet<VisNode>(visNodeList);
  visEdges = new DataSet<VisEdge>(visEdgeList);

  const options: VisOptions = {
    autoResize: true,
    // 与后台知识图谱一致的默认力学参数（Force Atlas 2）：物理引擎在跑，边路径才会被绘制
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      stabilization: { iterations: 300 },
      forceAtlas2Based: { gravitationalConstant: -212, centralGravity: 0.02, springLength: 130, springConstant: 0.05 },
    },
    interaction: { hover: true, navigationButtons: true, keyboard: false, tooltipDelay: 150, multiselect: false },
    nodes: { font: { size: 14, strokeWidth: 0 } },
    edges: { selectionWidth: 2, font: { size: 11, strokeWidth: 3 } },
    // 坐标已由 star() 预置，且物理引擎接管布局：关闭 improvedLayout 重排
    layout: { improvedLayout: false },
  };

  network?.destroy();
  network = new Network(graphEl.value, { nodes: visNodes, edges: visEdges }, options);
  // 物理稳定后框住全图，保留预设星型的同时确保所有节点/边可见
  let didFit = false;
  network.on('stabilizationIterationsDone', () => {
    if (!didFit) {
      didFit = true;
      network?.fit({ animation: false, maxZoomLevel: 1 });
    }
  });
  // 点击节点：实体→新窗口打开档案页；否则(概念/当前实体)高亮邻近。
  network.on('click', (params) => {
    const nodes = (params as { nodes: number[] }).nodes;
    if (!nodes.length) {
      visNodes.update(visNodes.get().map((n) => ({ id: Number(n.id), opacity: 1, font: { size: 14, strokeWidth: 0 } })));
      visEdges.update(visEdges.get().map((e) => ({ id: Number(e.id), opacity: 1 })));
      return;
    }
    const id = Number(nodes[0]);
    const nn = g.nodes.find((x) => x.id === id);
    // 实体节点（有 slug+datasetCode）且非当前实体 → 新窗口开档案页
    if (nn?.slug && nn?.datasetCode && Number(page.value?.entity?.id) !== id) {
      window.open(`/archive/${encodeURIComponent(nn.datasetCode)}/${encodeURIComponent(nn.slug)}`, '_blank', 'noopener');
      return;
    }
    const ids = new Set<number>([id]);
    for (const e of g.edges) if (e.head === id || e.tail === id) { ids.add(e.head); ids.add(e.tail); }
    visNodes.update(
      visNodes.get().map((n) => ({
        id: Number(n.id),
        opacity: ids.has(Number(n.id)) ? 1 : 0.15,
        font: { size: ids.has(Number(n.id)) ? 15 : 0, strokeWidth: 0 },
      })),
    );
    visEdges.update(
      visEdges.get().map((e) => ({
        id: Number(e.id),
        opacity: e.from === id || e.to === id ? 1 : 0.08,
      })),
    );
  });
  network.on('doubleClick', (params) => {
    const nodes = (params as { nodes: number[] }).nodes;
    if (nodes.length) network?.focus(Number(nodes[0]), { scale: 1.8, animation: true });
  });
};

/** 请求序号：组件复用（/archive/a → /archive/b）时，旧响应不得覆盖新状态 */
let loadSeq = 0;

const load = async () => {
  const dataset = String(route.params.dataset ?? '');
  const slug = String(route.params.slug ?? '');
  if (!dataset || !slug) return;
  const seq = ++loadSeq;
  loading.value = true;
  notFound.value = false;
  loadError.value = null;
  try {
    const data = await http.get<never, any>(
      `/archive/${encodeURIComponent(dataset)}/${encodeURIComponent(slug)}?format=ui`,
    );
    if (seq !== loadSeq) return;
    page.value = data;
    applyHead();
    await nextTick();
    if (seq !== loadSeq) return;
    renderGraph();
  } catch (err) {
    if (seq !== loadSeq) return;
    // 只有真 404 才是「档案不存在」：网络/超时/5xx（如服务正在重启）应提示重试，避免误判
    const status = (err as { statusCode?: number } | null)?.statusCode;
    if (status === 404) {
      notFound.value = true;
      upsertRobots('noindex');
      setPageTitle('档案不存在');
    } else {
      loadError.value = status ? `加载失败（HTTP ${status}），请重试` : '加载失败：无法连接服务，请稍后重试';
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
  // 深链定位必须在 loading 结束、内容挂载之后执行：加载中的状态位占据文档流、
  // 图谱与图片又异步改变布局，提前定位必然偏移。
  if (seq !== loadSeq || notFound.value || loadError.value) return;
  await nextTick();
  await scrollToDeepLink(seq);
};

/** 深链定位（单条事实 /fact/:code）；无深链或目标已不展示则回到页首 */
const scrollToDeepLink = async (seq: number) => {
  const factCode = String(route.params.code ?? '');
  const target = factCode ? `fact-${factCode}` : '';
  if (!target) {
    window.scrollTo({ top: 0 });
    return;
  }
  // 页面高度会因图片/字体/图谱画布异步加载而继续变化，一次定位会被后到的内容挤走；
  // 这里按帧校正到目标停稳（连续两次位置一致）为止，最多约 3 秒。
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let stable = 0;
  let found = false;
  for (let i = 0; i < 12 && stable < 2; i++) {
    if (seq !== loadSeq) return;
    const el = document.getElementById(target);
    if (el) {
      found = true;
      const want = el.getBoundingClientRect().top + window.scrollY - 16;
      if (Math.abs(window.scrollY - want) > 6) {
        window.scrollTo({ top: want });
        stable = 0;
      } else stable++;
    }
    await sleep(250);
  }
  // 目标不在本页（如已被替代的事实编号、或已下线的变更深链）→ 回到页首，避免停在半空
  if (!found) window.scrollTo({ top: 0 });
};

const onResize = () => network?.redraw();

onMounted(async () => {
  await load();
  window.addEventListener('resize', onResize);
});
watch(() => route.fullPath, load);

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  network?.destroy();
  network = null;
});
</script>

<style scoped>
/* ---- 原生状态位（替代 el-empty / el-button / v-loading）---- */
.state-loading {
  padding: 60px 16px;
  text-align: center;
  color: #5a6572;
  font-size: 14px;
}
.state-empty {
  padding: 72px 16px;
  text-align: center;
}
.state-desc {
  color: #5a6572;
  font-size: 14px;
  margin: 0 0 14px;
}
.state-btn {
  height: 32px;
  padding: 0 16px;
  border: 1px solid #409eff;
  border-radius: 4px;
  background: #409eff;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.state-btn:hover {
  background: #3a8ee6;
  border-color: #3a8ee6;
}
.state-inline {
  padding: 18px 0;
  color: #8a94a6;
  font-size: 13px;
}
.archive-page {
  --ink: #1c2430;
  --sub: #5a6572;
  --line: #e3e7ec;
  --paper: #f6f7f9;
  --card: #fff;
  --blue: #0b5cab;
  --green: #22764a;
  --green-bg: #e7f4ec;
  --amber: #9c6b1d;
  --amber-bg: #fdf5e6;
  --gray: #66707d;
  --gray-bg: #eceff3;
  min-height: 100%;
  background: var(--paper);
  font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ink);
}
.wrap {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 24px;
}
header.site {
  background: linear-gradient(135deg, #0d3f7d, #0b5cab);
  color: #fff;
  padding: 14px 0;
}
header.site .bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.brand {
  font-size: 17px;
}
.logo-link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.logo-link:hover .logo {
  opacity: 0.85;
}
.brand b {
  font-weight: 700;
}
.brand .sub {
  font-size: 12px;
  opacity: 0.85;
  margin-left: 10px;
}
nav a {
  color: #d8e6f7;
  font-size: 13px;
  text-decoration: none;
  margin-left: 14px;
}
nav a:hover {
  color: #fff;
}
.crumbs {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 6px;
  font-family: Consolas, monospace;
}
.pagehead {
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 34px 0 26px;
}
.kicker {
  font-size: 12px;
  letter-spacing: 0.18em;
  color: var(--blue);
  font-weight: 700;
}
h1.name {
  font-size: 30px;
  margin: 6px 0 4px;
  font-weight: 800;
}
.entid {
  font-family: Consolas, monospace;
  font-size: 13px;
  color: var(--sub);
}
.lede {
  margin-top: 12px;
  font-size: 15px;
  color: #2a3542;
  max-width: 880px;
}
/* ---- 关系图谱 ---- */
.graphbox {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.graphcanvas {
  flex: 1;
  min-width: 0;
  height: 420px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.graphside {
  width: 330px;
  flex-shrink: 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  max-height: 420px;
  overflow: auto;
}
.gshead {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--ink);
}
.graphrow {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--line);
}
.graphrow .gr-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.graphrow .gn {
  color: var(--ink);
}
.graphrow .gn.link {
  color: var(--blue);
  text-decoration: none;
}
.graphrow .gp {
  background: #eef3fb;
  color: var(--blue);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
  white-space: nowrap;
}
.graphrow .gc {
  margin-left: auto;
  color: var(--sub);
  font-family: Consolas, monospace;
}
.graphrow .gr-quote {
  font-size: 12px;
  color: var(--sub);
  line-height: 1.5;
  padding: 1px 2px;
}
.graphrow .gr-v {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.graphrow .gr-v.passed {
  color: #22764a;
  background: #e7f4ec;
}
.graphrow .gr-v.failed {
  color: #b0522b;
  background: #fdf0e6;
}
.graphrow .gr-v.pending {
  color: #9c6b1d;
  background: #fdf5e6;
}
.gmore {
  margin-top: 8px;
  font-size: 12px;
  color: var(--sub);
}
.statrow {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 18px;
}
.stat {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 22px;
  min-width: 110px;
}
.stat .n {
  font-size: 26px;
  font-weight: 800;
  color: var(--blue);
}
.stat .l {
  font-size: 12px;
  color: var(--sub);
}
.verify {
  margin-top: 16px;
  font-size: 12.5px;
  color: var(--sub);
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
.verify b {
  color: var(--ink);
}
section {
  padding: 34px 0 6px;
}
h2.sec {
  font-size: 20px;
  font-weight: 800;
  border-left: 4px solid var(--blue);
  padding-left: 12px;
  margin-bottom: 6px;
}
.secdesc {
  font-size: 13px;
  color: var(--sub);
  margin-bottom: 16px;
  max-width: 900px;
}
.chip {
  display: inline-block;
  font-size: 11.5px;
  border: 1px solid transparent;
  border-radius: 20px;
  padding: 1px 10px;
  margin-left: 6px;
  vertical-align: 2px;
}
.chip.ty {
  background: #e8f0fb;
  color: var(--blue);
}
.chip.st-active {
  background: var(--green-bg);
  color: var(--green);
}
.chip.st-uncertain {
  background: var(--amber-bg);
  color: var(--amber);
}
.chip.st-stat {
  background: var(--gray-bg);
  color: var(--gray);
}
.chip.gradeA {
  background: var(--green-bg);
  color: var(--green);
}
.chip.prec {
  color: var(--sub);
  background: var(--gray-bg);
}
.chip.ownership {
  color: #7a4fd0;
  background: #f1ecfb;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.changecard {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px 22px;
  margin-bottom: 12px;
}
.chead {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  scroll-margin-top: 16px;
}
.cdate {
  font-family: Consolas, monospace;
  font-size: 13px;
  color: var(--blue);
  font-weight: 700;
}
.ctitle {
  font-size: 15.5px;
  font-weight: 650;
}
.ceffect {
  font-size: 12.5px;
  color: var(--sub);
  margin-top: 4px;
}
.oldnew {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.onbox {
  flex: 1 1 300px;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
}
.onbox .tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin-bottom: 2px;
}
.onbox.old {
  background: #faf4f4;
  border: 1px solid #e5d5d5;
}
.onbox.old .tag {
  color: #b23b3b;
}
/* 并列结局里的「原有事实」：未被取代，用中性蓝而非红色，避免误读成已废弃 */
.onbox.keep {
  background: #f3f6fb;
  border: 1px solid #dde6f2;
}
.onbox.keep .tag {
  color: var(--blue);
}
.onbox.new {
  background: var(--green-bg);
  border: 1px solid #cfe6da;
}
.onbox.new .tag {
  color: var(--green);
}
.csrc {
  font-size: 12px;
  color: var(--sub);
  margin-top: 8px;
}
.factcard {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 18px 22px;
  margin-bottom: 14px;
  scroll-margin-top: 16px;
}
.stchip {
  margin-left: 8px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  vertical-align: middle;
}
/* 列表只列现行事实，徽章仅在非 active（待仲裁）时出现 */
.stchip.supx {
  color: #8a8f98;
  background: #f1f2f4;
}
.pred {
  font-size: 12px;
  color: var(--blue);
  font-weight: 700;
  letter-spacing: 0.05em;
}
/* 单条事实的稳定链接按钮：轻量、hover 显现，复制后短暂显示「已复制 ✓」 */
.perma {
  margin-left: 8px;
  padding: 1px 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--blue);
  background: #eef4fd;
  border: 1px solid #d6e3f7;
  border-radius: 999px;
  cursor: pointer;
  vertical-align: middle;
}
.perma:hover {
  background: #e2edfb;
}
.claim {
  font-size: 16.5px;
  font-weight: 650;
  margin: 4px 0 8px;
  line-height: 1.6;
}
.meta {
  font-size: 12.5px;
  color: var(--sub);
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.meta-lines {
  display: block;
  line-height: 1.9;
}
.meta-lines .evs {
  margin-top: 0;
}
.meta-lines b {
  color: var(--sub);
  font-weight: 600;
}
.evs {
  font-size: 13px;
  margin-top: 6px;
}
.evs a {
  font-family: Consolas, monospace;
  color: var(--blue);
  text-decoration: none;
  font-weight: 700;
  margin-right: 4px;
}
.evs a:hover {
  text-decoration: underline;
}
.note {
  margin-top: 8px;
  font-size: 12.5px;
  color: #7a5b18;
  background: var(--amber-bg);
  border-radius: 6px;
  padding: 6px 12px;
}
.note a {
  color: #0b5cab;
}
.timeline {
  position: relative;
  margin: 10px 0 30px 8px;
  padding-left: 26px;
  border-left: 2px solid #cfd8e2;
}
.tl-item {
  position: relative;
  margin-bottom: 22px;
}
.tl-item::before {
  content: "";
  position: absolute;
  left: -31px;
  top: 6px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 0 3px #dce8f7;
}
.tl-date {
  font-family: Consolas, monospace;
  font-size: 13px;
  color: var(--blue);
  font-weight: 700;
}
.tl-title {
  font-size: 15.5px;
  font-weight: 650;
  margin: 2px 0;
}
.tl-detail {
  font-size: 13px;
  color: var(--sub);
}
.tl-quote {
  font-size: 12.5px;
  color: #3a4656;
  background: #f8fafc;
  border-left: 3px solid var(--blue);
  padding: 6px 12px;
  margin-top: 5px;
  border-radius: 0 5px 5px 0;
  max-width: 820px;
}
.tl-refs {
  font-size: 12px;
  color: var(--sub);
  margin-top: 4px;
}
.tl-refs a {
  font-family: Consolas, monospace;
  color: var(--blue);
  text-decoration: none;
  font-weight: 700;
}
.evcard {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 15px 18px;
  margin-bottom: 14px;
}
.evcard .evhead {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  font-size: 13px;
  color: var(--sub);
}
.evcard .evno {
  font-family: Consolas, monospace;
  font-weight: 700;
  color: var(--blue);
  font-size: 13.5px;
}
.evcard .evtitle {
  font-weight: 600;
  font-size: 14.5px;
  margin-top: 6px;
}
.evcard .evtitle a {
  color: var(--ink);
  text-decoration: none;
}
.evcard .evtitle a:hover {
  color: var(--blue);
}
.evcard blockquote {
  margin: 9px 0;
  padding: 10px 14px;
  background: #f8fafc;
  border-left: 3px solid var(--blue);
  color: #2a3542;
  font-size: 14px;
  border-radius: 0 5px 5px 0;
}
.evcard .anchors {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--sub);
  margin-top: 6px;
  word-break: break-all;
}
.evcard .evlinks {
  margin-top: 7px;
  font-size: 13px;
}
.evcard .evlinks a {
  color: var(--blue);
  text-decoration: none;
}
.newslist {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px 18px;
}
.newsrow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  align-items: baseline;
  padding: 9px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 13.5px;
}
.newsrow:last-child {
  border-bottom: none;
}
.newsrow .nd {
  font-family: Consolas, monospace;
  font-size: 12.5px;
  color: var(--sub);
  min-width: 86px;
}
.newsrow .nm {
  font-size: 12.5px;
  color: var(--sub);
  min-width: 150px;
}
.newsrow a {
  color: var(--blue);
  text-decoration: none;
  font-weight: 600;
}
.newsrow a:hover {
  text-decoration: underline;
}
.page-footer {
  margin: 44px 0 30px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--sub);
}
.urn {
  font-family: Consolas, monospace;
  background: var(--gray-bg);
  padding: 2px 8px;
  border-radius: 4px;
}
.muted {
  color: #aaa;
}
.machine-card {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.28);
  padding: 18px 20px;
  margin: 12px 0;
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
.machine-card-title {
  font-weight: 700;
  font-size: 15px;
  color: #fff;
}
.machine-card-sub {
  font-size: 12px;
  color: #94a3b8;
}
.machine-card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.machine-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.7;
}
.machine-tag {
  flex: 0 0 auto;
  min-width: 72px;
  color: #94a3b8;
  font-weight: 600;
  font-size: 13px;
}
.machine-cells {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 13px;
}
.machine-path {
  color: #fff;
  font-family: Consolas, 'JetBrains Mono', monospace;
  font-size: 12.5px;
  text-decoration: none;
  border-bottom: 1px dashed transparent;
}
a.machine-path:hover {
  color: #38bdf8;
  border-bottom: 1px dashed #38bdf8;
}
.machine-path b {
  color: #38bdf8;
  font-weight: 600;
}
.machine-sep {
  color: #64748b;
}
.machine-note {
  color: #64748b;
  font-size: 12px;
}
.machine-code {
  color: #e2e8f0;
  background: #1e293b;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: Consolas, monospace;
  font-size: 12px;
}
</style>
