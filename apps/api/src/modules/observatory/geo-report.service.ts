import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { entities, facts, llmSettings, probeQuestions, probeResults, systemSettings } from '../../db/schema';
import { LlmConfigService } from '../llm-config/llm-config.service';
import { LlmLogService } from '../llm-log/llm-log.service';
import { ProbeModelConfigService } from './probe-model-config.service';
import { OBSERVATORY_CONFIG } from './observatory.config';
import { withBrand } from '@ssot/shared';

/** websearch 子通道展示名（与 probe.service 的 WS_CHANNELS 对齐） */
const CH_LABELS: Record<string, string> = {
  doubao: '豆包',
  yuanbao: '元宝',
  trae: '字节TRAE',
  codebuddy: '腾讯CodeBuddy',
  unified: '统一联网搜索',
};

/** 最近一次报告缓存（落在 system_setting，避免新增迁移） */
const REPORT_SETTING_KEY = 'GEO_REPORT_LATEST';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface ReportAnswerRow {
  model: string;
  cited: string;
  matchedUrl: string | null;
  urls: string[];
  answer: string;
  probedAt: Date | null;
}

export interface ReportQuestionRow {
  id: number;
  question: string;
  expectedAnswer: string;
  factCode: string | null;
  factStatement: string | null;
  entity: string | null;
  dimension: string | null;
  answers: ReportAnswerRow[];
}

export interface ReportModelStat {
  model: string;
  total: number;
  factPage: number;
  sameDomain: number;
  other: number;
  none: number;
  citedRate: number;
  answerCaptured: number;
}

export interface GeoReportResult {
  title: string;
  generatedAt: string;
  modelName: string;
  questionCount: number;
  answerCount: number;
  llmOk: boolean;
  llmError?: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  latencyMs: number;
  html: string;
}

/**
 * GEO 效果分析报告：
 * 取「最近几条」被探测过的提问记录（问题 + 各大模型/通道的引用判定与原文摘录），
 * 连同确定性统计一起交给生产线文本模型（后台「大模型设置」里 kind=text 的配置），
 * 输出多维度分析与整改建议，并渲染成自包含 HTML。
 */
@Injectable()
export class GeoReportService {
  private readonly logger = new Logger(GeoReportService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly modelConfig: ProbeModelConfigService,
    private readonly llmConfig: LlmConfigService,
    private readonly llmLog: LlmLogService,
  ) {}

  /** 最近一次生成的报告（缓存于 system_setting） */
  async latest(): Promise<GeoReportResult | null> {
    const [row] = await this.db
      .select()
      .from(systemSettings)
      .where(sql`${systemSettings.skey} = ${REPORT_SETTING_KEY}`)
      .limit(1);
    if (!row) return null;
    try {
      return JSON.parse(row.svalue) as GeoReportResult;
    } catch {
      return null;
    }
  }

  async generate(opts: { questionLimit?: number } = {}): Promise<GeoReportResult> {
    const limit = Math.min(Math.max(opts.questionLimit ?? 10, 1), 30);
    const models = await this.modelConfig.list();
    const labelOf = (modelId: string): string => {
      const i = modelId.indexOf(':');
      if (i > 0) {
        const parent = models.find((m) => m.id === modelId.slice(0, i));
        if (parent) return `${parent.label} · ${CH_LABELS[modelId.slice(i + 1)] ?? modelId.slice(i + 1)}`;
      }
      return models.find((m) => m.id === modelId)?.label ?? modelId;
    };

    const { questions, stats, competitors, ownUrls, answerCount } = await this.collect(limit, labelOf);
    if (!questions.length) throw new NotFoundException('还没有探测记录，请先跑一轮探针');

    const analysis = await this.analyze(questions, stats, competitors, ownUrls, limit);
    const result: GeoReportResult = {
      title: analysis.title ?? 'AI 引用 / GEO 效果分析报告',
      generatedAt: new Date().toISOString(),
      modelName: analysis.modelName,
      questionCount: questions.length,
      answerCount,
      llmOk: analysis.llmOk,
      llmError: analysis.llmError,
      usage: analysis.usage,
      latencyMs: analysis.latencyMs,
      html: this.render({
        questions,
        stats,
        competitors,
        ownUrls,
        analysis,
        answerCount,
        generatedAt: new Date(),
        title: analysis.title ?? 'AI 引用 / GEO 效果分析报告',
        modelName: analysis.modelName,
      }),
    };

    // 缓存最近一次报告
    await this.db
      .insert(systemSettings)
      .values({ skey: REPORT_SETTING_KEY, svalue: JSON.stringify(result) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(result) } });
    return result;
  }

  // ------------------------------------------------------------ 数据采集

  private async collect(
    limit: number,
    labelOf: (id: string) => string,
  ): Promise<{
    questions: ReportQuestionRow[];
    stats: ReportModelStat[];
    competitors: { domain: string; count: number }[];
    ownUrls: { url: string; count: number }[];
    answerCount: number;
  }> {
    // 最近被探测过的 N 个问题（按最近一次探测时间倒序）
    const recent = await this.db
      .select({
        questionId: probeResults.questionId,
        lastAt: sql<string>`max(${probeResults.probedAt})`.as('last_at'),
      })
      .from(probeResults)
      .groupBy(probeResults.questionId)
      .orderBy(sql`max(${probeResults.probedAt}) desc`)
      .limit(limit);
    const qids = recent.map((r) => r.questionId);
    if (!qids.length) return { questions: [], stats: [], competitors: [], ownUrls: [], answerCount: 0 };

    const rows = await this.db
      .select()
      .from(probeResults)
      .where(inArray(probeResults.questionId, qids))
      .orderBy(desc(probeResults.probedAt));
    const qs = await this.db.select().from(probeQuestions).where(inArray(probeQuestions.id, qids));
    const factIds = [...new Set(qs.map((q) => q.factId).filter((v): v is number => v != null))];
    const factRows = factIds.length
      ? await this.db
          .select({
            id: facts.id,
            code: facts.code,
            statement: facts.statement,
            dimension: facts.dimension,
            entityId: facts.entityId,
            entityName: entities.name,
          })
          .from(facts)
          .leftJoin(entities, sql`${entities.id} = ${facts.entityId}`)
          .where(inArray(facts.id, factIds))
      : [];
    const factMap = new Map(factRows.map((f) => [f.id, f]));

    const questions: ReportQuestionRow[] = [];
    for (const q of qs) {
      // 只取该题最近一次探测批次：同一批各通道的 probed_at 在同一秒内
      const mine0 = rows.filter((r) => r.questionId === q.id);
      const lastMs = Math.max(0, ...mine0.map((r) => r.probedAt?.getTime() ?? 0));
      const mine = mine0.filter((r) => Math.abs((r.probedAt?.getTime() ?? 0) - lastMs) <= 1000);
      const f = q.factId ? factMap.get(q.factId) : undefined;
      questions.push({
        id: q.id,
        question: q.question,
        expectedAnswer: q.expectedAnswer,
        factCode: f?.code ?? null,
        factStatement: f?.statement ?? null,
        entity: f?.entityName ?? null,
        dimension: f?.dimension ?? null,
        answers: mine.map((r) => ({
          model: labelOf(r.modelId),
          cited: r.cited,
          matchedUrl: r.matchedUrl ?? null,
          urls: (r.sourceUrls ?? []).slice(0, 5),
          answer: clamp((r.rawAnswer ?? '').replace(/\s+/g, ' ').trim(), 260),
          probedAt: r.probedAt,
        })),
      });
    }
    questions.sort((a, b) => (b.answers[0]?.probedAt?.getTime() ?? 0) - (a.answers[0]?.probedAt?.getTime() ?? 0));
    const answerCount = questions.reduce((n, q) => n + q.answers.length, 0);

    // 模型维度统计
    const statMap = new Map<string, ReportModelStat>();
    const domainMap = new Map<string, number>();
    const ownMap = new Map<string, number>();
    for (const q of questions) {
      for (const a of q.answers) {
        const s = statMap.get(a.model) ?? { model: a.model, total: 0, factPage: 0, sameDomain: 0, other: 0, none: 0, citedRate: 0, answerCaptured: 0 };
        s.total += 1;
        if (a.cited === 'fact_page') s.factPage += 1;
        else if (a.cited === 'same_domain') s.sameDomain += 1;
        else if (a.cited === 'other') s.other += 1;
        else s.none += 1;
        if (a.answer) s.answerCaptured += 1;
        statMap.set(a.model, s);
        for (const u of a.urls) {
          const h = hostOf(u);
          if (!h) continue;
          if (h.endsWith(OBSERVATORY_CONFIG.domainSuffix)) ownMap.set(u, (ownMap.get(u) ?? 0) + 1);
          else domainMap.set(h, (domainMap.get(h) ?? 0) + 1);
        }
      }
    }
    const stats = [...statMap.values()]
      .map((s) => ({ ...s, citedRate: s.total ? Math.round(((s.factPage + s.sameDomain) / s.total) * 100) : 0 }))
      .sort((a, b) => b.citedRate - a.citedRate);
    const competitors = [...domainMap.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count).slice(0, 12);
    const ownUrls = [...ownMap.entries()].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count).slice(0, 12);
    return { questions, stats, competitors, ownUrls, answerCount };
  }

  // ------------------------------------------------------------ 大模型分析

  private async analyze(
    questions: ReportQuestionRow[],
    stats: ReportModelStat[],
    competitors: { domain: string; count: number }[],
    ownUrls: { url: string; count: number }[],
    limit: number,
  ): Promise<{
    title?: string;
    modelName: string;
    llmOk: boolean;
    llmError?: string;
    usage: GeoReportResult['usage'];
    latencyMs: number;
    data?: LlmReport;
  }> {
    // 生产线文本模型 = 后台「大模型设置」里列出的文本模型，优先默认那条，其次第一条启用的
    const fallback = await this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.kind, 'text'), eq(llmSettings.enabled, true)))
      .orderBy(desc(llmSettings.isDefault), desc(llmSettings.id))
      .limit(1);
    const setting = (await this.llmConfig.getActiveConfig()) ?? fallback[0] ?? null;
    if (!setting?.baseUrl) {
      throw new NotFoundException('未配置生产线文本模型：请在后台「大模型设置」里新增/启用一条文本模型');
    }
    const modelName = `${setting.name}（${setting.model}）`;

    const payload = {
      '我方事实页域名后缀': OBSERVATORY_CONFIG.domainSuffix,
      '引用判定口径': {
        fact_page: '模型命中我方事实页（站内 /fact/ 页）',
        same_domain: '模型命中我方站内的其他页面（新闻等）',
        other: '模型只引用了外部第三方来源',
        none: '未捕获到任何可判定来源',
      },
      '各模型命中统计': stats,
      '竞争来源域名': competitors,
      '被引用我方URL': ownUrls,
      '最近提问明细': questions.map((q) => ({
        问题: q.question,
        我方口径: q.expectedAnswer,
        关联事实: q.factCode,
        各模型回答: q.answers.map((a) => ({
          模型: a.model,
          判定: a.cited,
          命中URL: a.matchedUrl,
          引用来源: a.urls,
          回答摘录: a.answer,
        })),
      })),
    };

    const prompt = [
      '你是 GEO（生成式引擎优化）/ AI 搜索可见性领域的资深顾问。',
      `以下是一家地方门户（${OBSERVATORY_CONFIG.domainSuffix}）用固定提问集对多个 AI 模型做引用监测的实测数据（最近 ${limit} 条提问记录），请站在“内容方如何提升被 AI 引用率”的角度做全面分析。`,
      '要求：',
      '1. 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字；整份输出控制在 1500 字以内，避免冗长；',
      '2. JSON 必须是以下结构（字段名保持完全一致，数组至少给 2 项，字符串用中文）：',
      JSON.stringify(
        {
          title: '报告标题（一句话概括结论）',
          summary: '总体结论，150~260 字，要出现关键数字（引用率/命中条数）',
          highlights: ['关键发现1', '关键发现2', '关键发现3'],
          dimensions: [
            {
              name: '维度名（如：事实页命中能力）',
              score: 0,
              analysis: '该维度的分析，120~220 字，必须结合数据中的具体数字或具体案例',
              findings: ['要点1', '要点2'],
            },
          ],
          modelComparison: [{ model: '模型名（严格和数据里的“模型”字段一致）', verdict: '表现评估', advice: '针对性建议' }],
          risks: ['风险1', '风险2'],
          actions: [{ priority: 'P0', title: '动作', detail: '怎么做', measure: '用什么指标衡量效果' }],
          conclusion: '收尾结论，100~160 字',
        },
        null,
        1,
      ),
      '3. dimensions 请覆盖这些维度：站外可见覆盖率、我方事实页命中能力、站内资源被采用的占比、竞争来源与替代源、模型间差异、内容口径与 AI 表述的差异、时效性与稳定性；score 为 0~100 的评分。',
      '4. actions 按 P0/P1/P2 排优先级，必须是可执行动作（涉及事实页口径、证据链、结构化数据、多源分发、问题集扩充等），不要空话。',
      '5. 严格依据提供的数据，不得杜撰未在数据中出现的域名、URL、百分比或案例；若某维度数据不足，明确写“数据不足，建议补充探测”。',
      '',
      '数据如下：',
      JSON.stringify(payload),
    ].join('\n');

    const cfg = {
      baseUrl: setting.baseUrl,
      apiKey: setting.apiKey,
      model: setting.model,
      temperature: Number(setting.temperature ?? 0.3) || 0.3,
      maxTokens: setting.maxTokens ?? 4096,
    };
    const t0 = Date.now();
    const res = await this.callLlm(cfg, prompt);
    const latencyMs = Date.now() - t0;
    const usage = res.usage
      ? {
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.promptTokens + res.usage.completionTokens,
        }
      : null;

    void this.llmLog
      .logCall({
        settingId: setting.id,
        model: setting.model,
        endpoint: setting.baseUrl,
        purpose: 'geo-report',
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        latencyMs,
        status: res.error ? 'error' : 'success',
        errorMessage: res.error ?? null,
        createdBy: null,
      })
      .catch((e: Error) => this.logger.warn(`[geo-report] 写调用日志失败：${e.message}`));

    let data: LlmReport | undefined;
    if (res.content) {
      try {
        data = JSON.parse(this.extractJson(res.content)) as LlmReport;
      } catch {
        this.logger.warn('[geo-report] 大模型返回非严格 JSON，改用降级渲染');
      }
    }
    return {
      title: data?.title,
      modelName,
      llmOk: Boolean(data),
      llmError: res.error || (data ? undefined : '大模型未返回可解析的 JSON'),
      usage,
      latencyMs,
      data,
    };
  }

  /**
   * OpenAI 兼容 chat 调用（报告专用）。
   * 注意：不能带 thinking:{type:'disabled'} —— 智谱 GLM-5.x 会 400「该模型始终思考，不支持关闭思考」；
   * 同时这类「始终思考」的模型会把思考 token 计入 max_tokens，故给足额度。
   */
  private async callLlm(
    cfg: { baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number },
    prompt: string,
    retries = 2,
  ): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } | null; error?: string }> {
    const url = /chat\/completions\/?$/i.test(cfg.baseUrl)
      ? cfg.baseUrl
      : cfg.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    // 「始终思考」的模型会把思考 token 计入 max_tokens，正文很容易被挤空：
    // 先尝试 thinking=low + 大额度，失败再退回不带 thinking 的通用写法
    const variants: unknown[] = [{ type: 'low' }, null];
    let lastErr = '';
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const thinking = variants[Math.min(attempt - 1, variants.length - 1)];
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300_000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey ?? ''}` },
          body: JSON.stringify({
            model: cfg.model,
            temperature: cfg.temperature,
            max_tokens: 16384,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(thinking ? { thinking } : {}),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = json.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) throw new Error('empty');
        return {
          content,
          usage: json.usage
            ? {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
              }
            : null,
        };
      } catch (err) {
        lastErr = (err as Error).message;
        this.logger.warn(`[geo-report] 大模型调用失败(第${attempt}次)：${lastErr}`);
        if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    return { content: '', usage: null, error: lastErr };
  }

  private extractJson(text: string): string {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('no json');
    return text.slice(s, e + 1);
  }

  // ------------------------------------------------------------ HTML 渲染

  private render(ctx: {
    questions: ReportQuestionRow[];
    stats: ReportModelStat[];
    competitors: { domain: string; count: number }[];
    ownUrls: { url: string; count: number }[];
    analysis: {
      llmOk: boolean;
      llmError?: string;
      modelName: string;
      usage: GeoReportResult['usage'];
      latencyMs: number;
      data?: LlmReport;
    };
    answerCount: number;
    generatedAt: Date;
    title: string;
    modelName: string;
  }): string {
    const { questions, stats, competitors, ownUrls, analysis: an, answerCount } = ctx;
    const d = an.data;
    const overallHit = questions.filter((q) => q.answers.some((a) => a.cited === 'fact_page' || a.cited === 'same_domain')).length;
    const overallRate = questions.length ? Math.round((overallHit / questions.length) * 100) : 0;
    const factPageCount = questions.reduce((n, q) => n + q.answers.filter((a) => a.cited === 'fact_page').length, 0);
    const sameDomainCount = questions.reduce((n, q) => n + q.answers.filter((a) => a.cited === 'same_domain').length, 0);
    const fmtTime = (v: Date | string | null): string => {
      const dt = typeof v === 'string' ? new Date(v) : v;
      return dt ? new Date(dt).toLocaleString('zh-CN', { hour12: false }) : '—';
    };
    const citeLabel: Record<string, string> = {
      fact_page: '事实页',
      same_domain: '同域命中',
      other: '外部来源',
      none: '未引用',
    };
    const citeClass: Record<string, string> = {
      fact_page: 'ok',
      same_domain: 'mid',
      other: 'warn',
      none: 'bad',
    };

    const kpis = [
      { k: '覆盖提问', v: questions.length, s: '本次纳入分析的提问数' },
      { k: '回答记录', v: answerCount, s: '各模型/通道的回答条数' },
      { k: '被引用题数', v: `${overallHit} / ${questions.length}`, s: `引用率 ${overallRate}%` },
      { k: '事实页命中', v: factPageCount, s: `同域命中 ${sameDomainCount} 条` },
    ];

    const parts: string[] = [];
    parts.push(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(withBrand(ctx.title))}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f5f6f8;color:#1d2430;font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
.hero{background:linear-gradient(135deg,#0b2f56,#0b5cab);color:#fff;border-radius:12px;padding:26px 28px}
.hero h1{margin:0 0 8px;font-size:24px;line-height:1.35}
.hero .meta{font-size:12.5px;opacity:.85}
.hero .meta span{margin-right:14px}
.summary{margin-top:14px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:12px 14px;font-size:13.5px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:18px}
.kpi{grid-column:span 1}
.card{background:#fff;border:1px solid #e3e7ec;border-radius:10px;padding:16px 18px;margin-top:14px}
.kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kv{background:#fff;border:1px solid #e3e7ec;border-radius:8px;padding:14px 16px}
.kv .n{font-size:26px;font-weight:800;color:#0b3f7d;font-family:Consolas,Menlo,monospace}
.kv .l{font-size:12.5px;color:#5a6572;margin-top:2px}
h2.sec{font-size:17px;margin:24px 0 10px;padding-left:10px;border-left:4px solid #0b5cab}
.hl{margin:0;padding-left:20px}
.hl li{margin:4px 0}
.dim{border-left:3px solid #0b5cab}
.dim .dh{display:flex;justify-content:space-between;align-items:center;gap:10px}
.dim .sc{font-family:Consolas,Menlo,monospace;font-weight:700;color:#0b3f7d}
.bar{height:6px;background:#eef1f5;border-radius:4px;overflow:hidden;margin:8px 0 10px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#0b5cab,#3d8bd4)}
ul.tight{margin:6px 0 0;padding-left:20px}
ul.tight li{margin:3px 0;color:#3c4654}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
th,td{border:1px solid #e3e7ec;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f3f6fa;color:#2a3542;font-weight:600}
td.num,th.num{text-align:center;font-family:Consolas,Menlo,monospace}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;color:#fff}
.tag.ok{background:#22764a}.tag.mid{background:#2f80ed}.tag.warn{background:#b7791f}.tag.bad{background:#8a8f98}
.mono{font-family:Consolas,Menlo,monospace;font-size:12px;color:#0b3f7d;word-break:break-all}
.muted{color:#6b7481;font-size:12.5px}
.risk{border-left:3px solid #b7791f}
.act{border-left:3px solid #22764a}
.p0{background:#c0392b}.p1{background:#b7791f}.p2{background:#2f80ed}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.q{border-left:3px solid #9aa5b1}
.q .qq{font-weight:600;font-size:14px}
.q .exp{color:#5a6572;font-size:12.5px;margin:4px 0 8px}
.src{margin-top:6px;font-size:12px;color:#5a6572;word-break:break-all}
.foot{margin-top:26px;text-align:center;color:#8b93a0;font-size:12px}
.warn-box{background:#fff7e6;border:1px dashed #e3c687;color:#8a5a00;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px}
</style></head><body><div class="wrap">`);

    parts.push(`<div class="hero"><h1>${esc(ctx.title)}</h1>
<div class="meta"><span>生成时间：${esc(fmtTime(ctx.generatedAt))}</span><span>分析模型：${esc(ctx.modelName)}</span><span>提问 ${questions.length} 条 / 回答 ${answerCount} 条</span></div>
${d?.summary ? `<div class="summary">${esc(d.summary)}</div>` : ''}</div>`);

    parts.push(`<div class="kvs">${kpis
      .map((x) => `<div class="kv"><div class="n">${esc(x.v)}</div><div class="l">${esc(x.k)} · ${esc(x.s)}</div></div>`)
      .join('')}</div>`);

    if (an.llmError) {
      parts.push(
        `<div class="warn-box">大模型输出未解析成功（${esc(an.llmError)}）。以下统计部分为系统依据实测数据自动生成，诊断建议部分可能缺失。</div>`,
      );
    }

    if (d?.highlights?.length) {
      parts.push(`<h2 class="sec">关键发现</h2><div class="card"><ul class="hl">${d.highlights
        .map((h) => `<li>${esc(h)}</li>`)
        .join('')}</ul></div>`);
    }

    if (d?.dimensions?.length) {
      parts.push('<h2 class="sec">多维度分析</h2>');
      for (const dim of d.dimensions) {
        const score = Math.max(0, Math.min(100, Number(dim.score) || 0));
        parts.push(`<div class="card dim"><div class="dh"><b>${esc(dim.name)}</b><span class="sc">${score} / 100</span></div>
<div class="bar"><i style="width:${score}%"></i></div>
<div>${esc(dim.analysis ?? '')}</div>
${dim.findings?.length ? `<ul class="tight">${dim.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>`);
      }
    }

    // 模型/通道统计表（系统计算，永远有）
    parts.push(
      `<h2 class="sec">各模型 / 通道命中统计</h2><div class="card"><table><thead><tr>
<th>模型 / 通道</th><th class="num">回答数</th><th class="num">事实页</th><th class="num">同域</th><th class="num">外部</th><th class="num">未引用</th><th class="num">引用率</th><th class="num">抓到原文</th>
</tr></thead><tbody>${stats
        .map(
          (s) => `<tr><td>${esc(s.model)}</td><td class="num">${s.total}</td><td class="num">${s.factPage}</td><td class="num">${s.sameDomain}</td><td class="num">${s.other}</td><td class="num">${s.none}</td><td class="num">${s.citedRate}%</td><td class="num">${s.answerCaptured}</td></tr>`,
        )
        .join('')}</tbody></table>
<div class="muted" style="margin-top:8px">引用率 =（事实页命中 + 同域命中）/ 回答数；「抓到原文」表示该通道这次确实返回了回答正文（仅搜索型通道可能为空）。</div></div>`,
    );

    if (d?.modelComparison?.length) {
      parts.push(
        `<h2 class="sec">模型横向对比与建议</h2><div class="card"><table><thead><tr><th>模型 / 通道</th><th>表现评估</th><th>针对性建议</th></tr></thead><tbody>${d.modelComparison
          .map((m) => `<tr><td>${esc(m.model)}</td><td>${esc(m.verdict ?? '')}</td><td>${esc(m.advice ?? '')}</td></tr>`)
          .join('')}</tbody></table></div>`,
      );
    }

    if (competitors.length || ownUrls.length) {
      parts.push('<h2 class="sec">来源竞争与被引用清单</h2><div class="grid2">');
      parts.push(
        `<div class="card"><b>主要竞争来源域名</b><table><thead><tr><th>域名</th><th class="num">出现次数</th></tr></thead><tbody>${
          competitors.length
            ? competitors.map((c) => `<tr><td>${esc(c.domain)}</td><td class="num">${c.count}</td></tr>`).join('')
            : '<tr><td colspan="2" class="muted">暂无外部来源数据</td></tr>'
        }</tbody></table></div>`,
      );
      parts.push(
        `<div class="card"><b>被 AI 引用的我方 URL</b><table><thead><tr><th>URL</th><th class="num">次数</th></tr></thead><tbody>${
          ownUrls.length
            ? ownUrls.map((c) => `<tr><td class="mono">${esc(c.url)}</td><td class="num">${c.count}</td></tr>`).join('')
            : '<tr><td colspan="2" class="muted">本次未命中我方页面</td></tr>'
        }</tbody></table></div>`,
      );
      parts.push('</div>');
    }

    if (d?.risks?.length) {
      parts.push(
        `<h2 class="sec">风险与短板</h2><div class="card risk"><ul class="tight">${d.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`,
      );
    }

    if (d?.actions?.length) {
      const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
      const acts = [...d.actions].sort((a, b) => (order[a.priority ?? 'P2'] ?? 2) - (order[b.priority ?? 'P2'] ?? 2));
      parts.push(
        `<h2 class="sec">整改建议清单</h2><div class="card act"><table><thead><tr><th class="num">优先级</th><th>动作</th><th>怎么做</th><th>衡量指标</th></tr></thead><tbody>${acts
          .map(
            (a) => `<tr><td class="num"><span class="tag ${esc((a.priority ?? 'P2').toLowerCase())}">${esc(a.priority ?? 'P2')}</span></td><td><b>${esc(a.title ?? '')}</b></td><td>${esc(a.detail ?? '')}</td><td>${esc(a.measure ?? '')}</td></tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    }

    // 附录：逐题明细
    parts.push('<h2 class="sec">附录 · 逐题回答明细</h2>');
    for (const q of questions) {
      parts.push(`<div class="card q">
<div class="qq">#${q.id} ${esc(q.question)}</div>
<div class="exp">我方口径：${esc(q.expectedAnswer)}</div>
<div class="muted">关联事实：${esc(q.factCode ?? '—')}${q.dimension ? ` · 维度 ${esc(q.dimension)}` : ''}${q.entity ? ` · 实体 ${esc(q.entity)}` : ''} · 探测时间 ${esc(fmtTime(q.answers[0]?.probedAt ?? null))}</div>
<table><thead><tr><th>模型 / 通道</th><th class="num">判定</th><th>命中 URL</th><th>回答摘录</th></tr></thead><tbody>${
        q.answers.length
          ? q.answers
              .map(
                (a) => `<tr><td>${esc(a.model)}</td><td class="num"><span class="tag ${citeClass[a.cited] ?? 'bad'}">${esc(citeLabel[a.cited] ?? a.cited)}</span></td><td class="mono">${esc(a.matchedUrl ?? '—')}</td><td>${a.answer ? esc(a.answer) : '<span class="muted">（该通道未返回正文）</span>'}</td></tr>`,
              )
              .join('')
          : '<tr><td colspan="4" class="muted">暂无记录</td></tr>'
      }</tbody></table></div>`);
    }

    if (d?.conclusion) {
      parts.push(`<h2 class="sec">结论</h2><div class="card">${esc(d.conclusion)}</div>`);
    }

    parts.push(
      `<div class="foot">本报告由温州有据观测台依据实测探测数据自动生成 · 分析模型 ${esc(ctx.modelName)} · ${esc(
        an.usage ? `消耗 token ${an.usage.totalTokens}` : 'token 统计不可用',
      )} · 耗时 ${Math.round(an.latencyMs / 1000)}s</div></div></body></html>`,
    );
    return parts.join('');
  }
}

/** 大模型输出的分析结构（宽松取值，缺失不影响渲染） */
interface LlmReport {
  title?: string;
  summary?: string;
  highlights?: string[];
  dimensions?: { name?: string; score?: number; analysis?: string; findings?: string[] }[];
  modelComparison?: { model?: string; verdict?: string; advice?: string }[];
  risks?: string[];
  actions?: { priority?: string; title?: string; detail?: string; measure?: string }[];
  conclusion?: string;
}
