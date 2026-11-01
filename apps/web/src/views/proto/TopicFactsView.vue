<template>
  <div class="factsheet-root">
    <header class="topbar">
      <div class="topinner">
        <a class="brand" href="/" aria-label="返回首页">
          <span class="logo">温</span>
          <span>
            <span class="brand-cn">温州有据 · 可信事实</span><br />
            <span class="brand-en">WENZHOU · VERIFIED INFORMATION</span>
          </span>
        </a>
        <nav class="nav" aria-label="页面导航">
          <a href="#overview">事实概览</a>
          <a href="#facts">事实条目</a>
          <a href="#articles">来源文章</a>
          <a href="#evidence">来源与证据</a>
          <a href="#machine">机器读取</a>
        </nav>
        <div class="topright">
          <span class="draftpill">传播参考样稿 · 尚未编辑签发</span>
          <button class="printbtn" type="button" aria-label="打印页面" @click="print">打印 ↗</button>
        </div>
      </div>
    </header>

    <div v-if="loading" class="wrap"><p class="panel-intro" style="padding:40px 0">正在读取主题事实档案…</p></div>
    <div v-else-if="error" class="wrap"><p class="panel-intro" style="padding:40px 0">{{ error }}</p></div>

    <div v-else-if="data" class="wrap">
      <div class="crumb">
        <a href="/">温州有据</a><span>›</span><span>主题事实档案</span><span>›</span><b>{{ name }}</b>
      </div>

      <section class="hero" aria-labelledby="pagetitle">
        <div class="hero-body">
          <div class="eyebrow">TOPIC FACT SHEET / 主题事实档案</div>
          <h1 id="pagetitle">{{ name }}<br /><span>事实档案</span></h1>
          <p v-if="definition">{{ definition }}</p>
          <p v-else>
            该主题聚合 {{ articles.length }} 篇报道与 {{ facts.length }} 条事实；主题定义尚未由生产线生成。
          </p>
          <div class="hero-actions">
            <a class="button primary" href="#facts">查看事实条目　↗</a>
            <a class="button" href="#articles">查看来源文章　↗</a>
            <a v-if="articles[0]?.url" class="button" :href="articles[0].url" target="_blank" rel="noopener noreferrer">
              阅读最新报道　↗
            </a>
          </div>
        </div>
        <div class="hero-graphic" aria-hidden="true">
          <span class="hero-numeral">{{ articles.length }}</span>
          <i>{{ name }} · TOPIC FACT SHEET</i>
        </div>
      </section>

      <div class="subline">
        <div>
          <b>主题｜{{ name }}</b>
          <template v-if="aliases.length"><span class="subdot"></span><span>别名：{{ aliases.slice(0, 3).join('、') }}</span></template>
          <span class="subdot"></span><span>合并事实 {{ facts.length }} 条</span>
          <span class="subdot"></span><span>来源文章 {{ articles.length }} 篇</span>
          <template v-if="firstAt">
            <span class="subdot"></span><span>报道区间 {{ firstAt }} ~ {{ lastAt || firstAt }}</span>
          </template>
        </div>
        <span class="statusflag">本页为参考稿，不代表编辑部已签发</span>
      </div>

      <div class="layout">
        <nav class="toc" aria-label="内容目录">
          <div class="toc-h">ON THIS PAGE</div>
          <a v-for="t in toc" :key="t.href" :href="t.href" :class="{ active: activeToc === t.href }">{{ t.label }}</a>
          <div class="toc-note">同一主题的多篇报道会被合并去重。<br />每条事实都能回到具体文章与逐字原文。</div>
        </nav>

        <main class="maincol">
          <section id="overview" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">01 / TOPIC OVERVIEW</span>
                <h2>事实概览</h2>
                <p class="panel-intro">先说清这个主题是什么，再按事实单元列出跨文章的合并结果。</p>
              </div>
              <a class="sidelink" href="#articles">来源文章 {{ articles.length }} 篇 ↗</a>
            </div>
            <div class="abstract">
              {{ definition || `该主题聚合 ${articles.length} 篇报道、${facts.length} 条事实；主题定义尚未由生产线生成。` }}
            </div>
            <div class="stats">
              <div v-for="c in cards" :key="c.label" class="stat"><b>{{ c.value }}</b><small>{{ c.label }}</small></div>
            </div>
            <p class="captionnote">
              同一主体、同一陈述的多篇报道会被合并为一条事实，证据累加并标注「出自 N 篇文章」；数字保持来源原样表述，不做换算。
            </p>
            <div class="identitytable">
              <div class="identityitem"><small>主题</small><span>{{ name }}</span></div>
              <div class="identityitem"><small>主题编号</small><span>{{ topicCode }}（参考编号，非正式 ID）</span></div>
              <div class="identityitem"><small>别名</small><span>{{ aliases.length ? aliases.slice(0, 6).join('、') : '—' }}</span></div>
              <div class="identityitem"><small>报道区间</small><span>{{ firstAt ? `${firstAt} ~ ${lastAt || firstAt}` : '—' }}</span></div>
              <div class="identityitem"><small>覆盖文章</small><span>{{ articles.length }} 篇 / 合并事实 {{ facts.length }} 条</span></div>
              <div class="identityitem"><small>本页组织方式</small><span>主题定义 + 事实概览 + 逐项事实 + 来源文章 + 逐字证据</span></div>
            </div>
            <div v-if="relatedTopics.length" class="source-chips relatedchips">
              <router-link v-for="r in relatedTopics" :key="r.id" class="sourcechip" :to="`/facts/${r.id}`">
                {{ r.name }} · {{ r.factCount }} 条 ↗
              </router-link>
            </div>
          </section>

          <section id="facts" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">02 / MERGED FACT RECORDS</span>
                <h2>逐项事实</h2>
                <p class="panel-intro">同一主体、同一陈述跨文章合并为一条；展开可查看证据来自哪几篇文章。</p>
              </div>
              <span class="sidelink">{{ facts.length }} 条</span>
            </div>
            <div class="toolbar" role="group" aria-label="事实清单">
              <span class="filterbtn selected">已签发 {{ counts.published }} 条</span>
              <span class="counttext">候选 {{ counts.candidate }} 条（未公开）　·　合并自 {{ articles.length }} 篇文章</span>
            </div>

            <p v-if="!facts.length" class="panel-intro">该主题暂未抽取出可用事实。</p>
            <details
              v-for="(f, i) in facts"
              :id="'fact-' + f.id"
              :key="f.id"
              class="fact-card"
              :open="i === 0"
            >
              <summary>
                <div class="fact-head">
                  <span class="fact-code">{{ f.code || '#' + f.id }}</span><span>·</span><span>{{ f.entityName }}</span>
                  <span :class="['fact-st', (f.independence?.level ?? 'single') === 'single' ? 'pending' : '']">
                    {{ f.independence?.label || ((f.evidences || []).length >= 2 ? `引文 ${(f.evidences || []).length} 条` : '单条报道') }}
                  </span>
                  <span v-if="articleCount(f)" class="fact-st extra">出自 {{ articleCount(f) }} 篇文章</span>
                  <span v-if="f.participantCount" class="fact-st extra">同一引句另挂 {{ f.participantCount }} 个主体</span>
                </div>
                <div class="summary-row">
                  <div>
                    <div class="fact-name">{{ f.statement }}</div>
                    <div class="fact-short">
                      时间精度：{{ timeText(f) }}　·　证据 {{ (f.evidences || []).length }} 条　·　来源文章 {{ articleCount(f) }} 篇
                    </div>
                  </div>
                  <span class="chevron" aria-hidden="true">⌄</span>
                </div>
              </summary>
              <div class="fact-detail">
                <div class="triple">
                  <div><small>主体 / SUBJECT</small><b>{{ f.entityName }}</b></div>
                  <div><small>类型 / TYPE</small><b>{{ factTypeLabel(f.factType) }}</b></div>
                  <div><small>时间 / TIME</small><b>{{ timeText(f) }}</b></div>
                </div>
                <p class="fact-notes">
                  <strong>时间语义：</strong>{{ temporalLabel(f.temporalKind) }}（{{ timeText(f) }}）<br />
                  <strong>证据情况：</strong>{{ f.independence?.label || '未判定' }}（引文 {{ (f.evidences || []).length }} 条 / 来源家族 {{ f.independence?.familyCount ?? 1 }} 组 / 发布主体 {{ f.independence?.publisherCount ?? 1 }} 个）<br />
                  <strong>槽位：</strong>{{ slotText(f) }}<template v-if="(f.mergedFactIds || []).length > 1">
                    <br /><strong>合并事实：</strong>{{ f.mergedFactIds.map((x) => `#${x}`).join('、') }}
                  </template>
                </p>
                <div v-for="ev in f.evidences || []" :key="ev.evidenceId" style="border:1px solid #eef1f5;border-radius:7px;padding:10px 12px;margin-top:8px;background:#fff">
                  <div style="font-size:10px;color:#8d9c91">
                    {{ ev.articleTitle || ev.materialTitle || ev.sourceOrg || '来源' }}<template v-if="ev.publishedAt"> · {{ fmt(ev.publishedAt) }}</template>
                  </div>
                  <p style="margin:5px 0 0;font-size:12px;line-height:1.85;color:#3a4c42">「{{ ev.quote }}」</p>
                  <div style="font-size:10px;color:#8d9c91;margin-top:4px">
                    <template v-if="ev.articleId">
                      <router-link :to="`/articles/${ev.articleId}`">该条出自文章 #{{ ev.articleId }}</router-link> · 
                    </template>
                    逐字证据匹配（本地）
                    <template v-if="ev.sourceUrl">
                      · <a :href="ev.sourceUrl" target="_blank" rel="nofollow noopener">核对原文</a>
                    </template>
                  </div>
                </div>
                <div class="source-chips">
                  <template v-for="(ev, ei) in f.evidences || []" :key="'chip' + ei">
                    <a v-if="ev.sourceUrl" class="sourcechip" :href="ev.sourceUrl" target="_blank" rel="noopener noreferrer" :title="ev.materialTitle || ''">
                      {{ letter(ei) }} · {{ (ev.sourceOrg || '来源').split('/')[0].trim() }} ↗
                    </a>
                    <span v-else class="sourcechip">{{ letter(ei) }} · {{ ev.sourceOrg || '来源' }}</span>
                  </template>
                </div>
                <div v-for="(a, ai) in f.alerts || []" :key="'a' + ai" class="caution"><b>口径提示：</b>{{ a }}</div>
                <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="button xs" type="button" @click="copyFact(f)">复制本条事实引用</button>
                  <a class="button xs" :href="factHref(f)">单条事实页 ↗</a>
                  <a class="button xs" :href="entityHref(f)">主体档案 ↗</a>
                </div>
              </div>
            </details>
          </section>

          <section id="articles" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">03 / SOURCE ARTICLES</span>
                <h2>来源文章</h2>
                <p class="panel-intro">该主题下的每篇报道都可以单独打开，查看它抽出的全部事实。</p>
              </div>
              <span class="sidelink">{{ articles.length }} 篇</span>
            </div>
            <p v-if="!articles.length" class="panel-intro">该主题暂无可回溯的报道来源。</p>
            <div v-else class="article-list">
              <router-link v-for="a in articles" :key="a.id" class="articlecard" :to="`/articles/${a.id}`">
                <div class="art-head">
                  <span class="ev-type">ARTICLE #{{ a.id }}</span>
                  <span>{{ a.factCount }} 条事实</span>
                </div>
                <div class="art-title">{{ a.title || '（无标题）' }}</div>
                <div class="art-meta">
                  {{ a.sourceOrg || '—' }}<template v-if="a.publishedAt"> · {{ fmt(a.publishedAt) }}</template>
                </div>
                <span class="art-go">查看单篇事实稿 ↗</span>
              </router-link>
            </div>
          </section>

          <section id="evidence" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">04 / EVIDENCE &amp; PROVENANCE</span>
                <h2>来源与证据</h2>
                <p class="panel-intro">记录事实挂接的具体出处，转载页不计作新的独立证据。</p>
              </div>
            </div>
            <div v-if="!sources.length" class="panel-intro">该主题事实暂未挂接可定位的来源文档。</div>
            <div v-else class="evidence-list">
              <div v-for="(s, i) in sources" :key="s.key" class="evidence">
                <div class="ev-head">
                  <span class="ev-type">SOURCE {{ letter(i) }}</span>
                  <span class="ev-kind">{{ s.count >= 2 ? '多事实共用' : '单条事实' }}</span>
                </div>
                <div class="ev-title">{{ s.title }}</div>
                <div class="ev-by">{{ s.org }}<template v-if="s.publishedAt"> · {{ s.publishedAt }}</template></div>
                <a v-if="s.url" class="ev-open" :href="s.url" target="_blank" rel="noopener noreferrer">核对原始页面 ↗</a>
              </div>
            </div>
            <div class="method">
              核对分级：同一事实在两篇以上文章 / 来源相互印证，称为「来源交叉核对」；仅一篇报道有载，称为「单源待复核」。二者都不等于事实已被独立调查确认。
            </div>
          </section>

          <section id="times" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">05 / TEMPORAL SEMANTICS</span>
                <h2>时间语义</h2>
                <p class="panel-intro">事件何时发生、新闻何时报道、资料何时核对，是不同的时间。</p>
              </div>
            </div>
            <table class="time-table">
              <tbody>
                <tr><td>首篇报道</td><td>{{ firstAt || '未标注' }}</td><td>{{ firstAt ? '精确到日' : '未提供' }}</td></tr>
                <tr><td>最新报道</td><td>{{ lastAt || firstAt || '未标注' }}</td><td>{{ lastAt ? '精确到日' : '不推断' }}</td></tr>
                <tr><td>事实适用区间</td><td>{{ eventRange }}</td><td>按条判定</td></tr>
                <tr><td>最近核验时间</td><td>{{ verifiedAt || '未记录' }}</td><td>{{ verifiedAt ? '精确到日' : '不推断' }}</td></tr>
                <tr><td>正式编辑签发时间</td><td>未发生 / 未录入</td><td>不作推断</td></tr>
              </tbody>
            </table>
            <p class="captionnote">跨文章合并时，事实时间取其自身语义，不因最新报道日期而改变。</p>
          </section>

          <section id="issues" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">06 / EDITORIAL DISCREPANCIES</span>
                <h2>口径差异与待核对事项</h2>
                <p class="panel-intro">不掩盖来源差异，也不把编辑推测写成已证实结论。</p>
              </div>
            </div>
            <template v-if="alertList.length">
              <div v-for="(a, i) in alertList" :key="'al' + i" class="notice">
                <h3>逐条事实附带的口径提示</h3>
                <p>{{ a }}</p>
              </div>
            </template>
            <div v-else class="plainband">
              <strong>该主题暂未记录来源之间的口径差异</strong>
              事实集只保留来源原样表述；如后续出现数字、时间或表述冲突，将在此处逐条列出并标注各自出处。
            </div>
            <div v-if="singleSourceFacts" class="plainband">
              <strong>还有 {{ singleSourceFacts }} 条事实属于单源待复核</strong>
              这些事实只在一篇报道中出现，未取得可交叉核对的组织方数据，不进入默认可复用的已核对事实集。
            </div>
          </section>

          <section id="history" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">07 / REVISION &amp; ACCOUNTABILITY</span>
                <h2>版本与责任</h2>
                <p class="panel-intro">主题页由成员文章自动汇总，不虚构审核历史。</p>
              </div>
            </div>
            <div class="history">
              <div class="historyitem">
                <b>参考稿 v0.1<template v-if="lastAt"> · {{ lastAt }}</template></b>
                <p>
                  聚合 {{ articles.length }} 篇报道、合并 {{ facts.length }} 条事实；主题名、定义与核心数据由生产线大模型生成。未形成正式采编审核或业务签发记录。
                </p>
              </div>
            </div>
            <div class="identitytable">
              <div class="identityitem"><small>主题维护方</small><span>温州有据 · 事实档案（自动汇总）</span></div>
              <div class="identityitem"><small>成员文章</small><span>{{ articles.length }} 篇</span></div>
              <div class="identityitem"><small>审核状态</small><span>待人工复核、待编辑签发</span></div>
              <div class="identityitem"><small>更正 / 变更</small><span>暂无正式发布版本，因此无真实更正记录</span></div>
            </div>
          </section>

          <section id="machine" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">08 / MACHINE READABLE</span>
                <h2>机器读取</h2>
                <p class="panel-intro">页面可见文本与导出的 JSON 使用同一份合并事实清单。</p>
              </div>
            </div>
            <div class="codebox">
              <div class="codebar">
                <span>TOPIC FACT DATA · application/json</span>
                <span>{{ facts.length }} facts / {{ articles.length }} articles</span>
              </div>
              <pre id="json-display" aria-label="机器可读 JSON 示例">{{ previewJson }}</pre>
            </div>
            <div class="machineactions">
              <button type="button" class="button primary" @click="downloadJson">下载完整 JSON ↓</button>
              <button type="button" class="button" @click="copy(JSON.stringify(dataset, null, 2))">复制 JSON</button>
              <a class="button" :href="jsonUrl" target="_blank" rel="noopener">接口 JSON ↗</a>
            </div>
            <p class="machinehint">数据以静态形式嵌入，可直接解析与下载；页面并未声称已有线上 API、持久事实 URI 或自动纠错服务。</p>
          </section>

          <div class="plainband">
            <strong>设计原则：新闻讲述发生了什么，事实稿交代机器可以依据什么。</strong>
            主题聚合不裁剪报道差异，而是把同一主题的多篇文章合并成可核查的事实集合。
          </div>
        </main>

        <aside class="side">
          <div class="statuscard">
            <div>
              <div class="statuscap">PUBLICATION READINESS</div>
              <div class="statushead">待人工复核</div>
              <p>内容由生产线自动汇总，不能代替真实的采编审核与正式发布流程。</p>
            </div>
            <div class="statusdetails">
              <div class="statusitem"><span>合并事实</span><span>{{ facts.length }} 条</span></div>
              <div class="statusitem"><span>涉及主体</span><span>{{ entityIds.length }} 个</span></div>
              <div class="statusitem"><span>来源文章</span><span>{{ articles.length }} 篇</span></div>
              <div class="statusitem"><span>来源文档</span><span>{{ sources.length }} 份</span></div>
              <div class="statusitem"><span>逐字证据</span><span>{{ evidenceTotal }} 条</span></div>
              <div class="statusitem"><span>单源待复核</span><span>{{ singleSourceFacts }} 条</span></div>
              <div class="statusitem"><span>正式事实 ID</span><span>未分配</span></div>
            </div>
          </div>
          <div class="sidebox">
            <div class="sidetitle">主题档案</div>
            <label>主题编号（参考）</label>
            <p style="font-family:ui-monospace,Consolas,monospace;font-size:11px">{{ topicCode }}</p>
            <label>主题名</label>
            <p>{{ name }}</p>
            <label>别名</label>
            <p>{{ aliases.length ? aliases.slice(0, 4).join('、') : '—' }}</p>
            <label>报道区间</label>
            <p>{{ firstAt ? `${firstAt} ~ ${lastAt || firstAt}` : '—' }}</p>
            <label>聚合文章</label>
            <p>{{ articles.length }} 篇 / {{ facts.length }} 条事实</p>
          </div>
          <div class="sidebox">
            <div class="sidetitle">标准引用方式</div>
            <label>引用来源</label>
            <blockquote>{{ citation }}</blockquote>
            <button class="button" type="button" @click="copy(citation)">复制来源说明</button>
            <p class="limitation">正式发布后才应以主题页的稳定 URL 与版本号替换本样稿的临时标识。</p>
          </div>
        </aside>
      </div>

      <footer class="endfoot">
        <div><b>温州有据 · 主题事实档案参考版</b><br />同一主题，多篇报道，一套可核查的事实。</div>
        <div style="text-align:right">
          主题页由生产线自动生成<template v-if="lastAt"> · 最新报道 {{ lastAt }}</template><br />
          不是已经上线或签发的官方事实档案
        </div>
      </footer>
    </div>

    <div class="toast" :class="{ show: toastVisible }" role="status" aria-live="polite">{{ toastText }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
  import { useRoute, useRouter } from 'vue-router';
  import { factsRouteApi, topicFactsApi, type TopicFactItem, type TopicFactsPayload } from '@/api';
  import { setPageTitle } from '@/utils/pageTitle';
  import '@/styles/fact-sheet.css';

  const route = useRoute();
  const router = useRouter();
  const topicId = computed(() => Number(route.params.topicId));
  const data = ref<TopicFactsPayload | null>(null);
  const loading = ref(false);
  const error = ref('');
  const activeToc = ref('#overview');
  let observer: IntersectionObserver | null = null;

  const topic = computed(() => data.value?.topic ?? null);
  const name = computed(() => topic.value?.name?.trim() || '主题事实档案');
  const definition = computed(() => topic.value?.definition?.trim() ?? '');
  const aliases = computed(() => (topic.value?.aliases ?? []).filter((a) => a && a !== name.value));
  const facts = computed<TopicFactItem[]>(() => data.value?.facts ?? []);
  const articles = computed(() => data.value?.articles ?? []);
  const relatedTopics = computed(() => data.value?.relatedTopics ?? []);
  const keyStats = computed(() => data.value?.keyStats ?? []);
  const topicCode = computed(() => topic.value?.code || `TP-${topic.value?.id ?? topicId.value}`);
  const firstAt = computed(() => fmt(topic.value?.firstArticleAt));
  const lastAt = computed(() => fmt(topic.value?.lastArticleAt));
  const entityIds = computed(() => [...new Set(facts.value.map((f) => f.entityId))]);
  const evidenceTotal = computed(() => facts.value.reduce((n, f) => n + (f.evidences?.length ?? 0), 0));
  const alertList = computed(() => [
    ...new Set(facts.value.flatMap((f) => (f.alerts ?? []).map((x) => String(x).trim()).filter(Boolean))),
  ]);
  const singleSourceFacts = computed(() => facts.value.filter((f) => (f.evidences?.length ?? 0) < 2).length);
  /** 计数分离（PRD S01）：公开面只报已签发，候选单独披露 */
  const counts = computed(() => {
    const c = ((topic.value as Record<string, unknown> | null)?.counts ?? {}) as Record<string, unknown>;
    return {
      published: Number(c.published ?? facts.value.length) || 0,
      candidate: Number(c.candidate ?? 0) || 0,
    };
  });

  const toc = [
    { href: '#overview', label: '01　事实概览' },
    { href: '#facts', label: '02　逐项事实' },
    { href: '#articles', label: '03　来源文章' },
    { href: '#evidence', label: '04　来源与证据' },
    { href: '#times', label: '05　时间语义' },
    { href: '#issues', label: '06　口径与核对' },
    { href: '#history', label: '07　版本与责任' },
    { href: '#machine', label: '08　机器读取' },
  ];

  /** 核心数据卡：成员文章 key_stats 聚合优先，不足 4 张用主题统计补齐 */
  const cards = computed(() => {
    const out = keyStats.value.slice(0, 4).map((c) => ({ ...c }));
    const fallback = [
      { value: String(facts.value.length), label: '条合并事实' },
      { value: String(entityIds.value.length), label: '个涉及主体' },
      { value: String(articles.value.length), label: '篇来源文章' },
    ];
    for (const c of fallback) {
      if (out.length >= 4) break;
      if (out.some((x) => x.label === c.label)) continue;
      out.push(c);
    }
    return out;
  });

  const sources = computed(() => {
    const map = new Map<string, { key: string; title: string; org: string; url: string; publishedAt: string; count: number }>();
    for (const f of facts.value) {
      for (const ev of f.evidences ?? []) {
        const url = ev.sourceUrl ?? '';
        const title = (ev.materialTitle ?? '').trim() || (ev.sourceOrg ?? '').trim() || '未命名来源';
        const key = url || title;
        const hit = map.get(key);
        if (hit) hit.count += 1;
        else map.set(key, { key, title, org: ev.sourceOrg ?? '—', url, publishedAt: fmt(ev.publishedAt), count: 1 });
      }
    }
    return [...map.values()];
  });

  const eventRange = computed(() => {
    const froms = facts.value.map((f) => fmt(f.validFrom)).filter((x) => x !== '—').sort();
    const ends = facts.value
      .flatMap((f) => [fmt(f.asOf), fmt(f.validTo), fmt(f.eventEnd)])
      .filter((x) => x !== '—')
      .sort();
    if (!froms.length) return '未标注';
    return ends.length ? `${froms[0]} ~ ${ends[ends.length - 1]}` : `${froms[0]} 起`;
  });
  const verifiedAt = computed(() => {
    const list = facts.value.map((f) => fmt(f.lastVerifiedAt)).filter((x) => x !== '—').sort();
    return list.length ? list[list.length - 1] : '';
  });

  const citation = computed(
    () =>
      `温州有据主题事实档案《${name.value}》（${topicCode.value}，聚合 ${articles.value.length} 篇报道 / ${facts.value.length} 条事实）；主题、摘要与核心数据由事实生产线自动抽取，逐条事实附原文逐字证据。参考稿尚未编辑签发。`,
  );

  const jsonUrl = computed(() => `/api/archive/topic/${topic.value?.id ?? topicId.value}/facts`);

  const dataset = computed(() => ({
    schema_version: 'topic-facts-1.0',
    document_type: 'topic_fact_sheet',
    topic: {
      id: topic.value?.id ?? topicId.value,
      code: topicCode.value,
      name: name.value,
      definition: definition.value,
      aliases: aliases.value,
      first_article_at: firstAt.value !== '—' ? firstAt.value : null,
      last_article_at: lastAt.value !== '—' ? lastAt.value : null,
    },
    key_stats: cards.value,
    record_count: facts.value.length,
    article_count: articles.value.length,
    articles: articles.value.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      source_org: a.sourceOrg,
      published_at: a.publishedAt,
      fact_count: a.factCount,
    })),
    facts: facts.value.map((f) => ({
      record_id: f.code ?? String(f.id),
      merged_fact_ids: f.mergedFactIds ?? [],
      statement: f.statement,
      subject: f.entityName,
      fact_type: f.factType,
      temporal: {
        kind: f.temporalKind,
        as_of: f.asOf,
        event_start: f.eventStart,
        event_end: f.eventEnd,
        valid_from: f.validFrom,
        valid_to: f.validTo,
      },
      article_count: f.articleCount ?? (f.articles ?? []).length,
      evidences: (f.evidences ?? []).map((ev) => ({
        quote: ev.quote,
        source_org: ev.sourceOrg,
        material_title: ev.materialTitle,
        source_url: ev.sourceUrl,
        article_id: ev.articleId,
        article_title: ev.articleTitle,
        published_at: ev.publishedAt,
      })),
      caveat: f.alerts ?? [],
    })),
  }));

  const previewJson = computed(() =>
    JSON.stringify(
      {
        schema_version: dataset.value.schema_version,
        document_type: dataset.value.document_type,
        topic: dataset.value.topic,
        record_count: dataset.value.record_count,
        article_count: dataset.value.article_count,
        facts: dataset.value.facts.slice(0, 2),
        _preview_note: `仅展示前 2 条，点击下载获取全部 ${facts.value.length} 条合并事实。`,
      },
      null,
      2,
    ),
  );

  const TEMPORAL_LABEL: Record<string, string> = {
    unknown: '未标注',
    effective: '生效期',
    event: '事件时点',
    historical: '历史值',
    period: '期间',
    plan: '计划',
    as_of: '截至口径',
  };
  const FACT_TYPE_LABEL: Record<string, string> = {
    current_state: '现状陈述',
    source_claim: '来源披露',
    occurred: '已发生事件',
  };
  const temporalLabel = (k: string | null) => TEMPORAL_LABEL[k ?? 'unknown'] ?? '未标注';
  const factTypeLabel = (k: string | null) => FACT_TYPE_LABEL[k ?? ''] ?? '事实';
  const letter = (i: number) => String.fromCharCode(65 + (i % 26));

  /** 日期统一到 YYYY-MM-DD（后端已归一，这里兜底各种串形态） */
  function fmt(v: string | null | undefined): string {
    if (!v) return '—';
    const s = String(v).trim();
    const m = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
  }

  /** 逐条时间语义：区间 / 事件 / 截至 三档，缺失不外推 */
  function timeText(f: TopicFactItem): string {
    const parts: string[] = [];
    if (f.validFrom || f.validTo) parts.push(`适用 ${fmt(f.validFrom)} ~ ${fmt(f.validTo)}`);
    if (f.eventStart || f.eventEnd) parts.push(`事件 ${fmt(f.eventStart)} ~ ${fmt(f.eventEnd)}`);
    if (f.asOf) parts.push(`截至 ${fmt(f.asOf)}`);
    return parts.length ? parts.join('；') : '未标注';
  }

  const slotText = (f: TopicFactItem) =>
    [f.semanticRole, f.periodKey, f.subjectScope].filter(Boolean).join(' · ') || '未标注';
  const articleCount = (f: TopicFactItem) => f.articleCount ?? (f.articles ?? []).length;
  const entityHref = (f: TopicFactItem) => `/archive/${f.datasetCode}/${f.entitySlug}`;
  const factHref = (f: TopicFactItem) => `${entityHref(f)}/fact/${encodeURIComponent(f.code ?? '')}`;

  const toastText = ref('');
  const toastVisible = ref(false);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function notice(msg: string) {
    toastText.value = msg;
    toastVisible.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastVisible.value = false), 2700);
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notice('已复制到剪贴板');
    } catch {
      notice('复制受浏览器限制，请手动选择文字');
    }
  }
  function copyFact(f: TopicFactItem) {
    copy(
      `${f.statement}（主题：${name.value}；事实编号 ${f.code ?? f.id}；合并自 ${articleCount(f) || 1} 篇文章）\n注：参考稿，未获得正式编辑签发。`,
    );
  }
  function downloadJson() {
    const blob = new Blob([JSON.stringify(dataset.value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topic-${topic.value?.id ?? topicId.value}-facts.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('已生成参考 JSON 文件');
  }
  const print = () => window.print();

  function observeToc() {
    if (!('IntersectionObserver' in window)) return;
    observer?.disconnect();
    const sections = toc.map((t) => document.querySelector(t.href)).filter(Boolean) as Element[];
    if (!sections.length) return;
    observer = new IntersectionObserver(
      (entries) => {
        const active = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (active) activeToc.value = `#${active.target.id}`;
      },
      { rootMargin: '-95px 0px -68% 0px', threshold: 0 },
    );
    sections.forEach((s) => observer!.observe(s));
  }

  /** 旧链接兼容：主题不存在时回源解析，命中旧文章 id 就跳到它所属的主题页 */
  async function fallbackResolve(id: number) {
    try {
      const r = await factsRouteApi.resolve(id);
      const target = r.kind === 'redirect' ? r.location : r.kind === 'topic' ? `/facts/${r.topicId}` : '';
      if (target && target !== route.path) {
        await router.replace(target);
        return true;
      }
    } catch {
      // 解析本身失败：当作主题缺失处理
    }
    return false;
  }

  async function load() {
    const id = topicId.value;
    if (!Number.isFinite(id) || id <= 0) {
      error.value = '主题编号无效';
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      const payload = await topicFactsApi.get(id);
      data.value = payload;
      // 主题已被合并到别的主题：地址栏换成最终主题 id，保证链接可分享
      if (payload.topic?.id && payload.topic.id !== id) {
        await router.replace(`/facts/${payload.topic.id}`);
        return;
      }
      setPageTitle(payload.topic?.name ?? '主题事实档案');
      await nextTick();
      observeToc();
    } catch {
      const redirected = await fallbackResolve(id);
      if (!redirected) {
        data.value = null;
        error.value = '未找到该主题的事实档案：主题可能尚未建档，或其文章还没有抽取事实。';
      }
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    document.body.classList.add('factsheet-body');
    load();
  });
  onBeforeUnmount(() => {
    document.body.classList.remove('factsheet-body');
    observer?.disconnect();
    if (toastTimer) clearTimeout(toastTimer);
  });
  watch(topicId, load);
</script>
