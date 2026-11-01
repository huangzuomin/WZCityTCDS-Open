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
          <a href="#evidence">来源与证据</a>
          <a href="#issues">口径说明</a>
          <a href="#machine">机器读取</a>
        </nav>
        <div class="topright">
          <span class="draftpill">传播参考样稿 · 尚未编辑签发</span>
          <button class="printbtn" type="button" aria-label="打印页面" @click="print">打印 ↗</button>
        </div>
      </div>
    </header>

    <div v-if="loading" class="wrap"><p class="panel-intro" style="padding:40px 0">正在读取文章事实稿…</p></div>
    <div v-else-if="error" class="wrap"><p class="panel-intro" style="padding:40px 0">{{ error }}</p></div>

    <div v-else-if="data" class="wrap">
      <div class="crumb">
        <a href="/">温州有据</a><span>›</span><span>可信事实稿</span><span>›</span><b>{{ pageTitle }}</b>
      </div>

      <section class="hero" aria-labelledby="pagetitle">
        <div class="hero-body">
          <div class="eyebrow">ARTICLE FACT SHEET / 文章事实稿</div>
          <h1 id="pagetitle">{{ pageTitle }}<br /><span>事实档案</span></h1>
          <p v-if="summary">{{ summary }}</p>
          <p v-else>
            本文抽取 {{ facts.length }} 条事实、涉及 {{ entityIds.length }} 个主体；摘要尚未由生产线生成。
          </p>
          <div class="hero-actions">
            <a class="button primary" href="#facts">查看事实条目　↗</a>
            <a class="button" href="#evidence">查看来源与证据　↗</a>
            <router-link v-if="topic" class="button" :to="`/facts/${topic.id}`">所属主题　↗</router-link>
            <a v-if="article?.url" class="button" :href="article.url" target="_blank" rel="noopener noreferrer">
              阅读新闻原文　↗
            </a>
          </div>
        </div>
        <div class="hero-graphic" aria-hidden="true">
          <span class="hero-numeral">{{ dayStamp }}</span>
          <i>{{ article?.sourceOrg || '—' }} · ARTICLE FACT SHEET</i>
        </div>
      </section>

      <div class="subline">
        <div>
          <b>文章｜{{ theme || article?.title }}</b>
          <span class="subdot"></span>
          <span v-if="publishedAt">原报道：{{ publishedAt }}</span>
          <span v-if="publishedAt" class="subdot"></span>
          <span>抽取事实 {{ facts.length }} 条</span><span class="subdot"></span>
          <span>涉及主体 {{ entityIds.length }} 个</span>
        </div>
        <span class="statusflag">本页为参考稿，不代表编辑部已签发</span>
      </div>

      <div class="layout">
        <nav class="toc" aria-label="内容目录">
          <div class="toc-h">ON THIS PAGE</div>
          <a v-for="t in toc" :key="t.href" :href="t.href" :class="{ active: activeToc === t.href }">{{ t.label }}</a>
          <div class="toc-note">这不是把长新闻拆成短句。<br />每项陈述都保留主体、时间、出处和引用边界。</div>
        </nav>

        <main class="maincol">
          <section id="overview" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">01 / ARTICLE OVERVIEW</span>
                <h2>事实概览</h2>
                <p class="panel-intro">先确认这篇文章讲了什么，再按事实单元列出可核查的陈述。</p>
              </div>
              <a v-if="article?.url" class="sidelink" :href="article.url" target="_blank" rel="noopener noreferrer">新闻原文 ↗</a>
            </div>
            <div class="abstract">
              {{ summary || `本文抽取 ${facts.length} 条事实，涉及 ${entityIds.length} 个主体；摘要尚未由生产线生成，以下仅列事实统计。` }}
            </div>
            <div class="stats">
              <div v-for="c in cards" :key="c.label" class="stat"><b>{{ c.value }}</b><small>{{ c.label }}</small></div>
            </div>
            <p class="captionnote">
              指标值均取自正文原样表述，不做换算或四舍五入；「约数」保留约数含义。{{
                keyStats.length ? '' : '当前指标卡为本篇抽取统计（正文未提供可用的量化数据）。'
              }}
            </p>
            <div class="identitytable">
              <div v-if="topic" class="identityitem">
                <small>所属主题</small>
                <span><router-link :to="`/facts/${topic.id}`">{{ topic.name }} ↗</router-link></span>
              </div>
              <div class="identityitem"><small>文章主题</small><span>{{ theme || '未生成（沿用原文标题）' }}</span></div>
              <div class="identityitem"><small>原文标题</small><span>{{ article?.title || '—' }}</span></div>
              <div class="identityitem">
                <small>来源</small>
                <span>{{ article?.sourceOrg || '—' }}<template v-if="article?.sourceSite">（{{ article.sourceSite }}）</template></span>
              </div>
              <div class="identityitem"><small>发布时间</small><span>{{ publishedAt || '—' }}</span></div>
              <div class="identityitem">
                <small>主题与摘要来源</small>
                <span>{{ briefSource }}</span>
              </div>
              <div class="identityitem"><small>本页组织方式</small><span>主题摘要 + 事实概览 + 逐项事实 + 逐字证据</span></div>
            </div>
          </section>

          <section id="facts" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">02 / ATOMIC FACT RECORDS</span>
                <h2>逐项事实</h2>
                <p class="panel-intro">每条事实独立编号、独立引用。展开可查看主体—类型—时间及证据边界。</p>
              </div>
              <span class="sidelink">{{ facts.length }} 条</span>
            </div>
            <div class="toolbar" role="group" aria-label="事实清单">
              <span class="filterbtn selected">全部 {{ facts.length }}</span>
              <span class="counttext" aria-live="polite">显示 {{ facts.length }} 条</span>
            </div>

            <p v-if="!facts.length" class="panel-intro">这篇文章暂未抽取出可用事实。</p>
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
                  <span :class="['fact-st', (f.evidences || []).length >= 2 ? '' : 'pending']">
                    {{ (f.evidences || []).length >= 2 ? '来源交叉核对' : '单源待复核' }}
                  </span>
                  <router-link v-if="offTopic(f)" class="fact-st extra" :to="`/facts/${f.factTopicId}`">
                    主属主题 · {{ f.factTopicName || `#${f.factTopicId}` }}
                  </router-link>
                </div>
                <div class="summary-row">
                  <div>
                    <div class="fact-name">{{ f.statement }}</div>
                    <div class="fact-short">
                      时间精度：{{ timeText(f) }}　·　来源数：{{ (f.evidences || []).length }}（来源数不等于独立核验次数）
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
                  <strong>适用时间：</strong>{{ timeText(f) }}<br />
                  <strong>出处核对：</strong>{{ (f.evidences || []).length >= 2 ? '本篇报道与其它来源相互印证' : '仅本篇报道有载，未取得独立交叉核对' }}<br />
                  <strong>槽位：</strong>{{ slotText(f) }}<br v-if="offTopic(f)" />
                  <template v-if="offTopic(f)">
                    <strong>主题归属：</strong>本条以「{{ f.factTopicName || `主题 #${f.factTopicId}` }}」为主主题，汇总在该主题页；文章页保留全文抽取结果。
                  </template>
                </p>
                <div v-for="ev in f.evidences || []" :key="ev.evidenceId" style="border:1px solid #eef1f5;border-radius:7px;padding:10px 12px;margin-top:8px;background:#fff">
                  <div style="font-size:10px;color:#8d9c91">
                    {{ ev.materialTitle || ev.sourceOrg || '来源' }}<template v-if="ev.publishedAt"> · {{ fmt(ev.publishedAt) }}</template>
                  </div>
                  <p style="margin:5px 0 0;font-size:12px;line-height:1.85;color:#3a4c42">「{{ ev.quote }}」</p>
                  <div style="font-size:10px;color:#8d9c91;margin-top:4px">
                    <template v-if="ev.spanStart !== null">区间 {{ ev.spanStart }}–{{ ev.spanEnd }} · </template>逐字证据匹配（本地）
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
                <p v-if="(f.relations || []).length" class="fact-notes">
                  <strong>事实关系：</strong>
                  <template v-for="(r, ri) in f.relations" :key="'r' + ri">
                    {{ r.type }} · 事实#{{ r.peerFactId }}<template v-if="ri < f.relations.length - 1">；</template>
                  </template>
                </p>
                <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="button xs" type="button" @click="copyFact(f)">复制本条事实引用</button>
                  <a class="button xs" :href="factHref(f)">单条事实页 ↗</a>
                  <a class="button xs" :href="entityHref(f)">主体档案 ↗</a>
                </div>
              </div>
            </details>
          </section>

          <section id="evidence" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">03 / EVIDENCE &amp; PROVENANCE</span>
                <h2>来源与证据</h2>
                <p class="panel-intro">记录本篇事实挂接的具体出处，而不是把转载页计作新的独立证据。</p>
              </div>
            </div>
            <div v-if="!sources.length" class="panel-intro">本篇事实暂未挂接可定位的来源文档。</div>
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
              核对分级：同一事实在本文与其它来源相互印证，称为「来源交叉核对」；仅本篇报道有载，称为「单源待复核」。二者都不自动等于事实已被独立调查确认，更不代表已通过单位编辑签发。
            </div>
          </section>

          <section id="times" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">04 / TEMPORAL SEMANTICS</span>
                <h2>时间语义</h2>
                <p class="panel-intro">事件何时发生、新闻何时报道、资料何时核对，是不同的时间。</p>
              </div>
            </div>
            <table class="time-table">
              <tbody>
                <tr><td>原新闻发布时间</td><td>{{ publishedAt || '未标注' }}</td><td>{{ publishedAt ? '精确到日' : '未提供' }}</td></tr>
                <tr><td>事实适用区间</td><td>{{ eventRange }}</td><td>按条判定</td></tr>
                <tr><td>最近核验时间</td><td>{{ verifiedAt || '未记录' }}</td><td>{{ verifiedAt ? '精确到日' : '不推断' }}</td></tr>
                <tr><td>主题/摘要生成时间</td><td>{{ briefAt || '未生成' }}</td><td>{{ briefAt ? '精确到日' : '不推断' }}</td></tr>
                <tr><td>事实生效时间</td><td>不适用或按条另行界定</td><td>不得自动补值</td></tr>
                <tr><td>正式编辑签发时间</td><td>未发生 / 未录入</td><td>不作推断</td></tr>
              </tbody>
            </table>
            <p class="captionnote">
              「活动已经发生」不等于「数字永久有效」。统计口径应保留来源的统计时间，不把发布日期伪装成统计发生日。
            </p>
          </section>

          <section id="issues" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">05 / EDITORIAL DISCREPANCIES</span>
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
              <strong>本篇暂未记录来源之间的口径差异</strong>
              事实集只保留来源原样表述；如后续出现数字、时间或表述冲突，将在此处逐条列出并标注各自出处。
            </div>
            <div v-if="singleSourceFacts" class="plainband">
              <strong>还有 {{ singleSourceFacts }} 条事实属于单源待复核</strong>
              这些事实只在本篇报道中出现，未取得可交叉核对的组织方数据，标注为「单源待复核」，不进入默认可复用的已核对事实集。
            </div>
          </section>

          <section id="history" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">06 / REVISION &amp; ACCOUNTABILITY</span>
                <h2>版本与责任</h2>
                <p class="panel-intro">事实版本是可审计的发布记录，不能因为页面已生成就虚构审核历史。</p>
              </div>
            </div>
            <div class="history">
              <div class="historyitem">
                <b>参考稿 v0.1 · {{ briefAt || publishedAt || '未记录日期' }}</b>
                <p>
                  依据原文自动抽取 {{ facts.length }} 条事实；主题、摘要与核心数据由生产线大模型生成<template v-if="briefVersion">（{{ briefVersion }}）</template>。未形成正式采编审核或业务签发记录。
                </p>
              </div>
            </div>
            <div class="identitytable">
              <div class="identityitem"><small>新闻提供方</small><span>{{ article?.sourceOrg || '—' }}</span></div>
              <div class="identityitem"><small>新闻刊载平台</small><span>{{ article?.sourceSite || article?.sourceOrg || '—' }}</span></div>
              <div class="identityitem"><small>事实稿审核状态</small><span>待人工复核、待编辑签发</span></div>
              <div class="identityitem"><small>更正 / 变更</small><span>暂无正式发布版本，因此无真实更正记录</span></div>
            </div>
            <p class="captionnote">
              正式部署后，每次更正应保留原值、修订值、原因、审核主体及修订时间。事件本身发生新变化时，应新建变更记录，不覆盖原历史事实。
            </p>
          </section>

          <section id="machine" class="panel">
            <div class="panel-head">
              <div>
                <span class="smallcap">07 / MACHINE READABLE</span>
                <h2>机器读取</h2>
                <p class="panel-intro">页面可见文本与导出的 JSON 使用同一份事实清单。</p>
              </div>
            </div>
            <div class="codebox">
              <div class="codebar">
                <span>REFERENCE FACT DATA · application/json</span>
                <span>{{ facts.length }} records / v0.1</span>
              </div>
              <pre id="json-display" aria-label="机器可读 JSON 示例">{{ previewJson }}</pre>
            </div>
            <div class="machineactions">
              <button type="button" class="button primary" @click="downloadJson">下载完整 JSON ↓</button>
              <button type="button" class="button" @click="copy(JSON.stringify(dataset, null, 2))">复制 JSON</button>
              <a class="button" :href="jsonUrl" target="_blank" rel="noopener">接口 JSON ↗</a>
              <a class="button" :href="rawUrl" rel="nofollow">本地原文快照 ↗</a>
            </div>
            <p class="machinehint">
              这些数据以静态形式嵌入，可直接解析与下载；页面并未声称已有线上 API、持久事实 URI 或自动纠错服务。
            </p>
          </section>

          <div class="plainband">
            <strong>设计原则：新闻讲述发生了什么，事实稿交代机器可以依据什么。</strong>
            对外可信发布的基础不是把不确定性藏起来，而是准确表达数据的来源、适用时间、边界和责任。
          </div>
        </main>

        <aside class="side">
          <div class="statuscard">
            <div>
              <div class="statuscap">PUBLICATION READINESS</div>
              <div class="statushead">待人工复核</div>
              <p>内容已由生产线自动抽取，不能代替真实的采编审核与正式发布流程。</p>
            </div>
            <div class="statusdetails">
              <div class="statusitem"><span>抽取事实</span><span>{{ facts.length }} 条</span></div>
              <div class="statusitem"><span>涉及主体</span><span>{{ entityIds.length }} 个</span></div>
              <div class="statusitem"><span>来源文档</span><span>{{ sources.length }} 份</span></div>
              <div class="statusitem"><span>逐字证据</span><span>{{ evidenceTotal }} 条</span></div>
              <div class="statusitem"><span>单源待复核</span><span>{{ singleSourceFacts }} 条</span></div>
              <div class="statusitem"><span>审核记录</span><span>未提供</span></div>
              <div class="statusitem"><span>正式事实 ID</span><span>未分配</span></div>
            </div>
          </div>
          <div class="sidebox">
            <div class="sidetitle">事实稿档案</div>
            <label>参考档案号（非正式 ID）</label>
            <p style="font-family:ui-monospace,Consolas,monospace;font-size:11px">{{ archiveRef }}</p>
            <label>新闻来源</label>
            <p>{{ article?.sourceOrg || '—' }}<template v-if="article?.sourceSite"> / {{ article.sourceSite }}</template></p>
            <label>报道标题</label>
            <p>{{ article?.title }}</p>
            <label>原新闻时间</label>
            <p>{{ publishedAt || '—' }}</p>
            <a v-if="article?.url" class="button" :href="article.url" target="_blank" rel="noopener noreferrer">核对新闻原文 ↗</a>
          </div>
          <div class="sidebox">
            <div class="sidetitle">标准引用方式</div>
            <label>引用来源</label>
            <blockquote>{{ citation }}</blockquote>
            <button class="button" type="button" @click="copy(citation)">复制来源说明</button>
            <p class="limitation">正式发布后才应以事实页的稳定 URL 和版本号替换本样稿的临时标识。</p>
          </div>
        </aside>
      </div>

      <footer class="endfoot">
        <div><b>温州有据 · 可信事实稿参考版</b><br />信息有来源，数字有口径，时间有精度，发布有责任。</div>
        <div style="text-align:right">
          事实稿由生产线自动生成<template v-if="briefAt"> · 内容生成 {{ briefAt }}</template><br />
          不是已经上线或签发的官方事实档案
        </div>
      </footer>
    </div>

    <div class="toast" :class="{ show: toastVisible }" role="status" aria-live="polite">{{ toastText }}</div>
  </div>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
  import { useRoute } from 'vue-router';
  import { articleFactsApi, type ArticleFactItem, type ArticleFactsPayload } from '@/api';
  import { setPageTitle } from '@/utils/pageTitle';
  import '@/styles/fact-sheet.css';

  const route = useRoute();
  const articleId = computed(() => Number(route.params.articleId));
  const data = ref<ArticleFactsPayload | null>(null);
  const loading = ref(false);
  const error = ref('');
  const activeToc = ref('#overview');
  let observer: IntersectionObserver | null = null;

  const article = computed(() => data.value?.article ?? null);
  const facts = computed<ArticleFactItem[]>(() => data.value?.facts ?? []);
  const theme = computed(() => article.value?.theme?.trim() ?? '');
  /** 所属主题（生产线 topic-resolver 归并后的最终主题） */
  const topic = computed(() => article.value?.topic ?? null);
  const summary = computed(() => article.value?.summary?.trim() ?? '');
  const pageTitle = computed(() => theme.value || article.value?.title || '文章事实稿');
  const keyStats = computed(() => article.value?.keyStats ?? []);
  const briefVersion = computed(() => article.value?.briefPromptVersion ?? '');
  const briefAt = computed(() => fmt(article.value?.briefAt));
  const publishedAt = computed(() => fmt(article.value?.publishedAt));
  const entityIds = computed(() => [...new Set(facts.value.map((f) => f.entityId))]);
  const evidenceTotal = computed(() => facts.value.reduce((n, f) => n + (f.evidences?.length ?? 0), 0));
  const alertList = computed(() => [
    ...new Set(facts.value.flatMap((f) => (f.alerts ?? []).map((x) => String(x).trim()).filter(Boolean))),
  ]);
  const singleSourceFacts = computed(() => facts.value.filter((f) => (f.evidences?.length ?? 0) < 2).length);

  const toc = [
    { href: '#overview', label: '01　事实概览' },
    { href: '#facts', label: '02　逐项事实' },
    { href: '#evidence', label: '03　来源与证据' },
    { href: '#times', label: '04　时间语义' },
    { href: '#issues', label: '05　口径与核对' },
    { href: '#history', label: '06　版本与责任' },
    { href: '#machine', label: '07　机器读取' },
  ];

  /** 核心数据卡：LLM 抽取优先，不足 4 张用本篇统计补齐 */
  const cards = computed(() => {
    const out = keyStats.value.slice(0, 4).map((c) => ({ ...c }));
    const fallback = [
      { value: String(facts.value.length), label: '条抽取事实' },
      { value: String(entityIds.value.length), label: '个涉及主体' },
      { value: String(evidenceTotal.value), label: '条逐字证据' },
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
        else
          map.set(key, {
            key,
            title,
            org: ev.sourceOrg ?? article.value?.sourceOrg ?? '—',
            url,
            publishedAt: fmt(ev.publishedAt),
            count: 1,
          });
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
  const briefSource = computed(() =>
    briefVersion.value ? `大模型抽取 · ${briefVersion.value}${briefAt.value !== '—' ? ` · ${briefAt.value}` : ''}` : '未生成',
  );
  const archiveRef = computed(
    () => `REF-A${articleId.value}-${publishedAt.value.replaceAll('-', '') || 'NA'}`,
  );

  const dayNumeral = computed(() => publishedAt.value.slice(8, 10));
  const dayStamp = computed(() => (dayNumeral.value ? `${dayNumeral.value}.` : String(facts.value.length)));

  const citation = computed(() => {
    const d = publishedAt.value !== '—' ? `${publishedAt.value.replaceAll('-', '.')}报道` : '报道';
    return `${article.value?.sourceOrg ?? '来源'}${d}《${article.value?.title ?? ''}》；主题、摘要与核心数据由事实生产线自动抽取，逐条事实附原文逐字证据。参考稿尚未编辑签发。`;
  });

  const jsonUrl = computed(() => `/api/archive/article/${articleId.value}/facts`);
  const rawUrl = computed(() => `/api/archive/article/${articleId.value}/raw`);

  const dataset = computed(() => ({
    schema_version: 'article-facts-1.0',
    document_type: 'article_fact_sheet',
    title: pageTitle.value,
    article_title: article.value?.title ?? '',
    theme: theme.value,
    topic: topic.value ? { id: topic.value.id, name: topic.value.name, url: `/facts/${topic.value.id}` } : null,
    summary: summary.value,
    key_stats: cards.value,
    compiled_on: briefAt.value !== '—' ? briefAt.value : fmt(article.value?.fetchedAt),
    brief_prompt_version: briefVersion.value,
    source_article: article.value?.url ?? '',
    source_org: article.value?.sourceOrg ?? '',
    published_at: publishedAt.value !== '—' ? publishedAt.value : null,
    record_count: facts.value.length,
    facts: facts.value.map((f) => ({
      record_id: f.code ?? String(f.id),
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
      slot: { semantic_role: f.semanticRole, period_key: f.periodKey, subject_scope: f.subjectScope },
      confidence: f.confidence,
      primary_topic: f.factTopicId ? { id: f.factTopicId, name: f.factTopicName ?? null } : null,
      evidences: (f.evidences ?? []).map((ev) => ({
        quote: ev.quote,
        source_org: ev.sourceOrg,
        material_title: ev.materialTitle,
        source_url: ev.sourceUrl,
        published_at: ev.publishedAt,
        span_start: ev.spanStart,
        span_end: ev.spanEnd,
      })),
      caveat: f.alerts ?? [],
    })),
  }));

  const previewJson = computed(() =>
    JSON.stringify(
      {
        schema_version: dataset.value.schema_version,
        document_type: dataset.value.document_type,
        record_count: dataset.value.record_count,
        facts: dataset.value.facts.slice(0, 2),
        _preview_note: `仅展示前 2 条，点击下载获取全部 ${facts.value.length} 条事实。`,
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
  function timeText(f: ArticleFactItem): string {
    const parts: string[] = [];
    if (f.validFrom || f.validTo) parts.push(`适用 ${fmt(f.validFrom)} ~ ${fmt(f.validTo)}`);
    if (f.eventStart || f.eventEnd) parts.push(`事件 ${fmt(f.eventStart)} ~ ${fmt(f.eventEnd)}`);
    if (f.asOf) parts.push(`截至 ${fmt(f.asOf)}`);
    return parts.length ? parts.join('；') : '未标注';
  }

  const slotText = (f: ArticleFactItem) =>
    [f.semanticRole, f.periodKey, f.subjectScope].filter(Boolean).join(' · ') || '未标注';
  const entityHref = (f: ArticleFactItem) => `/archive/${f.datasetCode}/${f.entitySlug}`;
  const factHref = (f: ArticleFactItem) => `${entityHref(f)}/fact/${encodeURIComponent(f.code ?? '')}`;
  /** 事实主主题与文章主题不同：说明该条同时归入别的主题页 */
  const offTopic = (f: ArticleFactItem) =>
    Boolean(f.factTopicId) && Boolean(topic.value?.id) && Number(f.factTopicId) !== Number(topic.value?.id);

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
  function copyFact(f: ArticleFactItem) {
    const src = `${article.value?.sourceOrg ?? '来源'}${publishedAt.value !== '—' ? ` ${publishedAt.value}` : ''}`;
    copy(`${f.statement}（${src}；事实编号 ${f.code ?? f.id}）\n注：参考稿，未获得正式编辑签发。`);
  }
  function downloadJson() {
    const blob = new Blob([JSON.stringify(dataset.value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `article-${articleId.value}-facts-reference.json`;
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

  async function load() {
    if (!Number.isFinite(articleId.value) || articleId.value <= 0) {
      error.value = '文章编号无效';
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      data.value = await articleFactsApi.get(articleId.value);
      setPageTitle(pageTitle.value);
      await nextTick();
      observeToc();
    } catch (e) {
      data.value = null;
      error.value = (e as Error).message || '读取失败';
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
  watch(articleId, load);
</script>
