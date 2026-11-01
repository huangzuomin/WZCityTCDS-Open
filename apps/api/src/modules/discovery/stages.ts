import { Logger } from '@nestjs/common';
import { extractJson, TYPE_DESC, TYPES, gazetteerHit, ruleReject, geoAnchor, norm } from './lexicon';

/**
 * 各阶段的 LLM 调用与结果解析。
 * prompt 全部来自试点验证过的版本（evidence 逐字率 94~100%）。
 */

const logger = new Logger('DiscoveryStages');

export interface LlmCfg {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 取消信号：取消排队时中断在途请求（由 runQueue 的 AbortController 注入） */
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

interface ChatResult {
  content: string;
  usage: LlmUsage | null;
  latencyMs: number;
  error?: string;
}

interface ChatJson {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
}

/**
 * 思考开关（按模型名配置，逗号分隔，写在 apps/api/.env）：
 * - `LLM_THINKING_DISABLED=deepseek-flash` → 该模型传 thinking:{type:'disabled'}
 *   实测：deepseek-flash 关思考后 0.8s 出结果且 content 直接就是 JSON；不关则 4.7s 且
 *   token 全烧在 reasoning_content 上、content 为空（触发回退，质量与速度双输）。
 * - `LLM_THINKING_ENABLED=xxx` → 显式开启思考。
 * - 两者都没配 → 不传该参数。GLM 必须走这条：glm-5.3-flash「始终思考」，
 *   传任何 thinking 值（low/disabled）都会被 400 拒绝（错误码 1210）。
 */
function thinkingParamFor(model: string): Record<string, string> | null {
  const list = (name: string) =>
    (process.env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (list('LLM_THINKING_DISABLED').includes(model)) return { type: 'disabled' };
  if (list('LLM_THINKING_ENABLED').includes(model)) return { type: 'enabled' };
  return null;
}

/**
 * OpenAI 兼容 chat 调用。
 * 兼容性处理（踩过的坑）：
 * - 思考开关按模型名走环境变量，见 thinkingParamFor；默认不传，避免 GLM 被 400 拒。
 * - 思考型模型会把过程写入 reasoning_content、结论写入 content；token 不足时 content 为空，
 *   此时回退使用 reasoning_content，避免误判为失败（关思考的模型不会走到这一步）。
 */
export async function chat(cfg: LlmCfg, prompt: string, retries = 3): Promise<ChatResult> {
  const url = /chat\/completions\/?$/i.test(cfg.baseUrl) ? cfg.baseUrl : cfg.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  const thinking = thinkingParamFor(cfg.model);

  const callOnce = async (): Promise<ChatJson> => {
    const ctrl = new AbortController();
    // 思考型模型（glm-5.3-flash）单次可跑数分钟；超时可配，默认 7 分钟
    const timeoutMs = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? 420000);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // 外部取消（取消排队）→ 立即中断本次请求
    const onAbort = () => ctrl.abort();
    cfg.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (cfg.signal?.aborted) throw new Error('已取消');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey ?? ''}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: cfg.temperature ?? 0.2,
          max_tokens: cfg.maxTokens ?? 4096,
          stream: false,
          ...(thinking ? { thinking } : {}),
          // deepseek（火山 ark）默认带隐藏思考，一次调用能拖 5-8 分钟；同 python 脚本，显式关掉
          // （LLM_THINKING_ENABLED 显式开启时不加 reasoning_effort，走 ark 默认思考）
          ...(cfg.model?.toLowerCase().includes('deepseek') && thinking?.type !== 'enabled' ? { reasoning_effort: 'none' } : {}),
          // 豆包 seed 系列（火山 ark）默认带思考：关思考走 thinking 参数（{type:'disabled'}），
          // 格式与 deepseek 的 reasoning_effort 不同；环境变量已显式配置时不覆盖
          ...(cfg.model?.toLowerCase().includes('doubao-seed') && !thinking ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as ChatJson;
    } finally {
      clearTimeout(timer);
      cfg.signal?.removeEventListener('abort', onAbort);
    }
  };

  let lastErr = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    // 已取消：不再重试，立即返回
    if (cfg.signal?.aborted) return { content: '', usage: null, latencyMs: 0, error: '已取消' };
    const t0 = Date.now();
    try {
      const json = await callOnce();
      const choice = json.choices?.[0];
      const content = (choice?.message?.content ?? '').trim();
      const reasoning = (choice?.message?.reasoning_content ?? '').trim();
      const text = content || reasoning;
      if (!text) {
        throw new Error(
          `空响应（finish=${choice?.finish_reason ?? '-'}，推理已占满 token，请在「大模型设置」调大最大 Token）`,
        );
      }
      return {
        content: text,
        usage: {
          promptTokens: Number(json.usage?.prompt_tokens ?? 0),
          completionTokens: Number(json.usage?.completion_tokens ?? 0),
        },
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      lastErr = (err as Error).message;
      logger.warn(`LLM 调用失败(第${attempt}次)：${lastErr}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { content: '', usage: null, latencyMs: 0, error: lastErr };
}

// ---------------------------------------------------------------- 容错 JSON 解析

/** 提示词追加：上一次输出不是合法 JSON 时，重试时附上纠错要求 */
const JSON_FIX_HINT = `

【上次输出不是合法 JSON，请重试】
- 必须输出严格合法的 JSON：字符串内不要出现未转义的引号或换行
- 属性之间必须有逗号，不要有多余逗号
- 不要输出注释、解释或 markdown 代码块`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 容错提取 JSON 对象数组。
 * 顺序：① 整体解析（含 {"facts":[...]} 这类包装）→ ② 花括号配平扫描 → ③ 逐行解析。
 * 目的：模型偶发输出非法 JSON 时，坏一段只丢一段，而不是整篇作废。
 */
function parseLooseObjects(text: string): Record<string, unknown>[] {
  const t = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  if (!t) return [];
  const out: Record<string, unknown>[] = [];
  const wrapperKeys = ['facts', 'events', 'relations', 'results', 'entities'];

  // ① 整体解析
  try {
    const v = JSON.parse(t) as unknown;
    if (Array.isArray(v)) out.push(...v.filter(isObj));
    else if (isObj(v)) {
      const nested = wrapperKeys.flatMap((k) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter(isObj) : []));
      if (nested.length) out.push(...nested);
      else out.push(v);
    }
    if (out.length) return out;
  } catch {
    /* 落到兜底 */
  }

  // ② 花括号配平扫描（可跨行，字符串内的括号不计数）
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const seg = t.slice(start, i + 1);
        try {
          const o = JSON.parse(seg) as unknown;
          if (isObj(o)) out.push(o);
        } catch {
          /* 这一段坏了就丢这一段 */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  if (out.length) return out;

  // ③ 逐行解析（JSONL：一行一条）
  for (const raw of t.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/, '').replace(/,$/, '');
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (isObj(o)) out.push(o);
    } catch {
      /* 丢这一行 */
    }
  }
  return out;
}

const isFactLike = (o: Record<string, unknown>) =>
  typeof o.dimension === 'string' && typeof o.statement === 'string' && typeof o.quote === 'string';
const isEventLike = (o: Record<string, unknown>) => typeof o.description === 'string' && typeof o.quote === 'string';
const isRelationLike = (o: Record<string, unknown>) =>
  typeof o.head === 'string' && typeof o.predicate === 'string' && typeof o.tail === 'string' && typeof o.quote === 'string';

/** 把容错解析出的对象归类为 facts / events */
function toFactsEvents(objs: Record<string, unknown>[]): { facts: FactCandidate[]; events: EventCandidate[] } {
  const facts: FactCandidate[] = [];
  const events: EventCandidate[] = [];
  const push = (o: Record<string, unknown>) => {
    if (isFactLike(o)) facts.push(o as unknown as FactCandidate);
    else if (isEventLike(o)) events.push(o as unknown as EventCandidate);
  };
  for (const o of objs) {
    if (Array.isArray(o.facts) || Array.isArray(o.events)) {
      (Array.isArray(o.facts) ? (o.facts as unknown[]) : []).filter(isObj).forEach(push);
      (Array.isArray(o.events) ? (o.events as unknown[]) : []).filter(isObj).forEach(push);
      continue;
    }
    push(o);
  }
  return { facts, events };
}

// ---------------------------------------------------------------- Stage 1 实体发现

export interface RawEntity {
  name: string;
  type: string;
  aliases?: string[];
  wenzhou_link?: string;
  inference_reason?: string | null;
  evidence: string;
  confidence?: number;
}

/** v2：语料域关联分类清单（type 的权威来源，由 discovery 动态注入） */
export interface CategoryHint {
  code: string;
  name: string;
  description?: string | null;
}

const categoryHintLines = (list: CategoryHint[]): string =>
  list.length
    ? list
        .map((t) => `${t.code}（${t.name}${t.description ? `：${t.description}` : ''}）`)
        .join('\n')
    : TYPE_DESC;

export async function stageDiscover(
  cfg: LlmCfg,
  body: string,
  typeList: CategoryHint[],
): Promise<{ entities: RawEntity[]; usage: LlmUsage | null; error?: string }> {
  const prompt = `你是一个"温州元素"实体抽取器。请从下面这篇新闻正文中，抽出所有与温州相关的实体。

【判定】
1. wenzhou_link="explicit"：文中直接出现，本身就是温州的事物。
2. wenzhou_link="inferred"：文中没写"温州"，但常识上与温州强关联（如"正泰"总部在乐清），必须给 inference_reason。
3. 不要抽：与温州无关的外地事物、全国性机构品牌、纯泛指词（类别词）。

【类型（type 严格取以下值之一）】
${categoryHintLines(typeList)}

【硬性要求】
- evidence 必须是原文逐字复制的连续片段（10~40字），禁止改写、禁止省略号拼接。
- 同一实体只输出一次，别名放 aliases。
- 只输出 JSON。

【正文】
${body}

{"entities":[{"name":"实体名","type":"类型","aliases":["别名"],"wenzhou_link":"explicit或inferred","inference_reason":"推断原因或null","evidence":"原文逐字片段","confidence":0.95}]}`;

  // 思考型模型输出 JSON 偶发截断/括号不配平，解析失败重试一次（重跑通常恢复正常）
  const validTypes = new Set<string>([...typeList.map((t) => t.code), ...TYPES]);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await chat(cfg, prompt);
    if (r.error) return { entities: [], usage: r.usage, error: r.error };
    try {
      const list = (extractJson<{ entities?: RawEntity[] }>(r.content).entities ?? []).filter(
        (e) => e.name && validTypes.has(e.type),
      );
      return { entities: list, usage: r.usage };
    } catch (err) {
      if (attempt < 2) {
        logger.warn(`[discover] 解析失败(第${attempt}次)，重试：${(err as Error).message}`);
        continue;
      }
      return { entities: [], usage: r.usage, error: `解析失败: ${(err as Error).message}` };
    }
  }
  return { entities: [], usage: null };
}

// ---------------------------------------------------------------- Stage 1.5 入库审核

export interface AuditItem {
  name: string;
  type: string;
  evidence: string;
  confidence?: number;
}

export interface AuditResult {
  name: string;
  verdict: 'accept' | 'c_layer' | 'reject';
  rejectReason: string | null;
  description: string;
  role: string;
  attrs: { region: string; org: string; role: string };
  /** 命中来源：rule=确定性规则, gaz=种子词典直通, llm=模型判定 */
  by: 'rule' | 'gaz' | 'llm';
}

/**
 * 审核三段式：确定性规则 → 种子词典直通 → LLM 三判据。
 * 前两段零成本，把 LLM 调用压到真正需要判断的实体上。
 */
export async function stageAudit(
  cfg: LlmCfg,
  items: AuditItem[],
  body: string,
  typeList: CategoryHint[] = [],
): Promise<{ results: AuditResult[]; usage: LlmUsage | null; error?: string }> {
  const results: AuditResult[] = [];
  const pending: AuditItem[] = [];

  for (const it of items) {
    const rej = ruleReject(it);
    if (rej) {
      results.push({
        name: it.name, verdict: 'reject', rejectReason: rej, description: '', role: '',
        attrs: { region: '', org: '', role: '' }, by: 'rule',
      });
      continue;
    }
    const g = gazetteerHit(it.name);
    if (g) {
      results.push({
        name: it.name,
        verdict: 'accept',
        rejectReason: null,
        description: `地域锚：${geoAnchor(it.evidence, body) ?? '温州'}；特征：温州特色（种子词典：${g}）`,
        role: '',
        attrs: { region: geoAnchor(it.evidence, body) ?? '温州', org: '', role: '' },
        by: 'gaz',
      });
      continue;
    }
    pending.push(it);
  }

  if (!pending.length) return { results, usage: null };

  const list = pending.map((e) => `- ${e.name}（${e.type}）证据：${e.evidence}`).join('\n');
  const prompt = `你是"温州元素"知识库的收录审核员。对下列实体逐一判定收录级别。

【类型清单（实体 type 从下列取值）】
${categoryHintLines(typeList)}

【三判据（全部满足才 accept）】
1. 专名性：必须是特定事物的名字。检验：把这个词拿到外地城市，含义是否不变？不变则是类别词 → reject(generic)。名称自带地域限定的可收（楠溪麦饼、五凤乡茶园）；纯类别词拒（鲨鱼、鸭脖、绿豆汤）。
2. 温州可定位性：全国泛在事物（跨省国道/高速/全国性品牌）除非文中明确限定温州段且有本地事件 → reject(not_local)。
3. 人物收录资格（仅 person）：有可定位的机构职务/头衔/成就 → accept 并填 role；仅"村民/学生/顾客/阿婆"级别 → c_layer；完全无身份（含记者署名）→ reject(non_notable)。

【松紧度】拿不准一律从严：拒收或降 c_layer（漏的靠人工从台账捞回）。

【description 格式】结构化为"地域锚：X；特征：Y"，禁止写入文章场景/事件性信息。
【attrs】region=所属政区；org=所属机构；role=职务头衔（非人物留空）。

【实体清单】
${list}

只输出JSON：{"results":[{"name":"实体名","verdict":"accept|c_layer|reject","reject_reason":"generic|not_local|non_notable|null","description":"...","role":"...","attrs":{"region":"","org":"","role":""}}]}`;

  const r = await chat(cfg, prompt);
  if (r.error) {
    // 调用失败：宁严勿松，未判定的全部降 c_layer（不丢、也不污染主库）
    for (const it of pending) {
      results.push({
        name: it.name, verdict: 'c_layer', rejectReason: 'llm_unavailable', description: '', role: '',
        attrs: { region: geoAnchor(it.evidence, body) ?? '', org: '', role: '' }, by: 'llm',
      });
    }
    return { results, usage: r.usage, error: r.error };
  }

  interface AuditLlmItem {
    name: string;
    verdict: string;
    reject_reason?: string | null;
    description?: string;
    role?: string;
    attrs?: { region?: string; org?: string; role?: string };
  }
  let map = new Map<string, AuditLlmItem>();
  try {
    map = new Map((extractJson<{ results?: AuditLlmItem[] }>(r.content).results ?? []).map((x) => [norm(x.name), x]));
  } catch {
    /* 解析失败按缺项处理 */
  }

  for (const it of pending) {
    const v = map.get(norm(it.name));
    if (!v) {
      results.push({
        name: it.name, verdict: 'c_layer', rejectReason: 'llm_missing', description: '', role: '',
        attrs: { region: geoAnchor(it.evidence, body) ?? '', org: '', role: '' }, by: 'llm',
      });
      continue;
    }
    results.push({
      name: it.name,
      verdict: (v.verdict === 'accept' || v.verdict === 'c_layer' ? v.verdict : 'reject') as AuditResult['verdict'],
      rejectReason: v.reject_reason ?? null,
      description: v.description ?? '',
      role: it.type === 'person' ? (v.role ?? '') : '',
      attrs: {
        region: v.attrs?.region ?? geoAnchor(it.evidence, body) ?? '',
        org: v.attrs?.org ?? '',
        role: v.attrs?.role ?? '',
      },
      by: 'llm',
    });
  }
  return { results, usage: r.usage };
}

// ---------------------------------------------------------------- 对齐判决（多候选）

export interface JudgeCandidate {
  id: number;
  name: string;
  type: string;
  description?: string | null;
  role?: string | null;
  facts?: string[];
  co?: string[];
}

export async function stageJudge(
  cfg: LlmCfg,
  mention: { name: string; type: string; role?: string; evidence: string; co?: string[] },
  candidates: JudgeCandidate[],
): Promise<{ best: number; confidence: number; reason: string; usage: LlmUsage | null; error?: string }> {
  const cardList = candidates
    .map(
      (c, i) =>
        `[${i + 1}] 名称：${c.name}｜类型：${c.type}\n    描述：${c.description ?? '-'}\n    身份：${c.role ?? '-'}\n    共现：${(c.co ?? []).slice(0, 6).join('、') || '-'}\n    事实：${(c.facts ?? []).slice(0, 3).join('；') || '-'}`,
    )
    .join('\n');

  const prompt = `你在做实体对齐。判断"新提及"与下列哪一个候选指同一事物；都不是则 best=0。

【候选】
${cardList}

【新提及】
名称：${mention.name}｜类型：${mention.type}
身份：${mention.role || '-'}
证据：${mention.evidence}
同篇共现：${(mention.co ?? []).slice(0, 6).join('、') || '-'}

【要点】
- 只有确实指同一事物才选；拿不准选 0
- person 特别注意：职务不同但机构相同/相关，可能是同一人职务变动 → 选 0 让人判断
- 名称不同但确为同义异写可合并（如"温州菜"与"瓯菜"）

只输出JSON：{"best":0到${candidates.length}的整数,"confidence":0到1,"reason":"一句话理由"}`;

  // 单次尝试（不再叠加"解析重试 × 网络重试"，避免「每个提及最多 6 次调用」的成本爆炸）。
  // 解析失败返回 error='parse'，由调用方转人工 —— 绝不能默认成"判非同一 → 新建实体"，否则会造重复实体。
  if (cfg.signal?.aborted) return { best: 0, confidence: 0, reason: '已取消', usage: null, error: '已取消' };
  const r = await chat(cfg, prompt, 2);
  if (r.error) return { best: 0, confidence: 0, reason: `LLM失败: ${r.error}`, usage: r.usage, error: r.error };
  try {
    const v = extractJson<{ best?: number; confidence?: number; reason?: string }>(r.content);
    return { best: Number(v.best ?? 0), confidence: Number(v.confidence ?? 0), reason: v.reason ?? '', usage: r.usage };
  } catch {
    const loose = parseLooseObjects(r.content).find((o) => typeof o.best !== 'undefined' || typeof o.reason === 'string');
    if (loose) {
      return {
        best: Number(loose.best ?? 0),
        confidence: Number(loose.confidence ?? 0),
        reason: String(loose.reason ?? ''),
        usage: r.usage,
      };
    }
    return { best: 0, confidence: 0, reason: '解析失败', usage: r.usage, error: 'parse' };
  }
}

// ---------------------------------------------------------------- Stage 2 事实抽取

export interface FactCandidate {
  dimension: string;
  statement: string;
  quote: string;
  confidence: number;
  risk?: string | null;
}

export interface EventCandidate {
  description: string;
  timeText: string;
  quote: string;
  confidence?: number;
}

export async function stageFacts(
  cfg: LlmCfg,
  entity: { name: string; aliases: string[]; type: string },
  dimensions: { code: string; name: string }[],
  body: string,
): Promise<{ facts: FactCandidate[]; events: EventCandidate[]; usage: LlmUsage | null; error?: string }> {
  // 正文前置为「稳定前缀」：同篇文章逐实体调用时，开头 ${body} 完全一致，
  // 触发 GLM 隐式前缀缓存（缓存命中 0.23/百万 token，约输入价 3 折），且不改变抽取内容。
  const prompt = `【正文】
${body}

你是事实与事件抽取器。针对实体「${entity.name}」（别名：${entity.aliases.join('、') || '无'}），从上面正文中抽取它直接相关的事实与事件。

【维度口径（predicate 优先从这里选，输出其中文名）】
${dimensions.map((d) => d.name || d.code).join('、')}

【facts 要求】
1. 每条输出 { dimension, statement, quote, confidence, risk }
2. dimension 优先用上面口径里的词；确实都不贴切时可自拟简短谓词（2~6字）
3. statement 是完整陈述句；quote 必须是正文逐字片段（10~60字），禁止改写
4. 事实必须能从 quote 直接读出，禁止脑补

【events 要求（真实事件才收，状态描述不算）】
1. 事件 = 时间 + 地点/主体 + 动作的语义组装（如"2019年6月 温州举办长桌宴"）
2. description 是含时间与动作的完整陈述；timeText 用原文时间表述（如"今年6月"）
3. quote 必须是正文逐字片段（10~60字），禁止改写
4. 没有就输出空数组

只输出JSON对象：{"facts":[{"dimension":"...","statement":"...","quote":"...","confidence":0.9,"risk":null}],"events":[{"description":"...","timeText":"...","quote":"...","confidence":0.8}]}`;

  /** 严格解析（原逻辑）：整段 {"facts":[...],"events":[...]} 或纯数组；失败返回 null */
  const strictParse = (text: string): { facts: FactCandidate[]; events: EventCandidate[] } | null => {
    try {
      const t = text.trim();
      const objStart = t.indexOf('{');
      const arrStart = t.indexOf('[');
      if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
        const end = t.lastIndexOf('}');
        const obj = JSON.parse(t.slice(objStart, end + 1)) as { facts?: FactCandidate[]; events?: EventCandidate[] };
        return {
          facts: (obj.facts ?? []).filter((f) => f.dimension && f.statement && f.quote),
          events: (obj.events ?? []).filter((e) => e.description && e.quote),
        };
      }
      if (arrStart >= 0) {
        const end = t.lastIndexOf(']');
        const arr = JSON.parse(t.slice(arrStart, end + 1));
        return {
          facts: (Array.isArray(arr) ? arr : []).filter((f: FactCandidate) => f.dimension && f.statement && f.quote),
          events: [],
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  // 解析失败重试一次（附纠错提示）；容错解析保证「坏一条只丢一条」，不再整篇作废
  let usage: LlmUsage | null = null;
  let lastErr = '两次尝试均未得到可用的 JSON';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (cfg.signal?.aborted) return { facts: [], events: [], usage, error: '已取消' };
    const r = await chat(cfg, attempt === 1 ? prompt : prompt + JSON_FIX_HINT);
    usage = r.usage ?? usage;
    if (r.error) return { facts: [], events: [], usage, error: r.error }; // 传输层错误，chat 内部已重试

    const text = (r.content ?? '').trim();
    const strict = strictParse(text);
    if (strict) return { facts: strict.facts, events: strict.events, usage }; // 含合法空结果
    const loose = toFactsEvents(parseLooseObjects(text));
    if (loose.facts.length || loose.events.length) return { facts: loose.facts, events: loose.events, usage }; // 抢救出部分
    lastErr = 'JSON 非法且无法抢救';
  }
  return { facts: [], events: [], usage, error: `解析失败: ${lastErr}` };
}

// ---------------------------------------------------------------- Stage 2b 事实抽取（批量多条实体）

export interface FactsBatchItem {
  id: number;
  name: string;
  aliases: string[];
  dims: { code: string; name: string }[];
}

/**
 * 批量事实抽取：一次调用处理 ≤10 个实体，正文只发一次（省调用次数与输入 token）。
 * 护栏：实体之间用 === 硬隔离；要求按实体分块输出；调用方需逐实体独立校验，
 * 缺失/失败的实体回退到单实体 stageFacts（独立回退，不连累整批）。
 */
export async function stageFactsBatch(
  cfg: LlmCfg,
  entities: FactsBatchItem[],
  body: string,
): Promise<{
  results: { entityName: string; facts: FactCandidate[]; events: EventCandidate[] }[];
  usage: LlmUsage | null;
  error?: string;
}> {
  if (!entities.length) return { results: [], usage: null };

  const blocks = entities
    .map(
      (e, i) =>
        `=== 实体${i + 1}：${e.name}${e.aliases.length ? `（别名：${e.aliases.join('、')}）` : ''} ===\n可用维度：${e.dims
          .map((d) => d.name || d.code)
          .join('、')}`,
    )
    .join('\n\n');

  const prompt = `【正文】
${body}

你是事实与事件抽取器。请为下面每个实体，分别从上面正文中抽取**它自己**直接相关的事实与事件。

${blocks}

【硬性要求】
1. 每个实体单独输出一条结果，用 "entity" 字段写**完全一致**的实体名；不要跨实体混写、不要漏实体
2. 事实结构 { dimension, statement, quote, confidence, risk }；dimension 优先用该实体「可用维度」里的词，都不贴切时可自拟简短谓词（2~6字）
3. statement 是完整陈述句；quote 必须是正文逐字片段（10~60字），禁止改写
4. 事实必须能从 quote 直接读出，禁止脑补
5. 事件结构 { description, timeText, quote, confidence }；事件 = 时间 + 地点/主体 + 动作，状态描述不算；没有就输出空数组
6. 只输出 JSON，不要解释、不要 markdown 代码块

只输出JSON对象：{"results":[{"entity":"实体名","facts":[{"dimension":"...","statement":"...","quote":"...","confidence":0.9,"risk":null}],"events":[{"description":"...","timeText":"...","quote":"...","confidence":0.8}]}]}`;

  let usage: LlmUsage | null = null;
  let lastErr = '两次尝试均未得到可用的 JSON';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (cfg.signal?.aborted) return { results: [], usage, error: '已取消' };
    const r = await chat(cfg, attempt === 1 ? prompt : prompt + JSON_FIX_HINT);
    usage = r.usage ?? usage;
    if (r.error) return { results: [], usage, error: r.error };

    const text = (r.content ?? '').trim();
    const results: { entityName: string; facts: FactCandidate[]; events: EventCandidate[] }[] = [];
    try {
      const objs = parseLooseObjects(text);
      for (const o of objs) {
        const wrapped = Array.isArray(o.results) ? (o.results as unknown[]).filter(isObj) : [o];
        for (const w of wrapped) {
          const entityName = String((w as Record<string, unknown>).entity ?? (w as Record<string, unknown>).entityName ?? '').trim();
          if (!entityName) continue;
          const { facts, events } = toFactsEvents([w as Record<string, unknown>]);
          if (facts.length || events.length) results.push({ entityName, facts, events });
        }
      }
    } catch {
      /* 落到重试 */
    }
    if (results.length) return { results, usage };
    lastErr = 'JSON 非法或未解析出任何实体结果';
  }
  return { results: [], usage, error: `解析失败: ${lastErr}` };
}

// ---------------------------------------------------------------- 谓词/维度归一（LLM 兜底）

/** 确定性规则：常见同义/变体 → 现有口径。命中即零成本。 */
export const PREDICATE_SYNONYMS: Record<string, string> = {
  举办于: '举行', 举行于: '举行', 召开于: '举行', 发生于: '举行',
  '出现于': '登上',
  属于: '隶属于', 归属: '隶属于', 下属: '隶属于', 隶属于: '隶属于',
  坐落于: '位于', 地处: '位于', 处于: '位于', 总部位于: '位于',
  更名: '改名', 更名为: '改名', 改名为: '改名',
  被誉为: '被称为', 称为: '被称为',
  制造: '生产',
};

/**
 * 谓词/维度归一：把「模型自拟的新词」批量判决到**已有口径**或判定为新口径。
 * 调用方应先用映射表与 PREDICATE_SYNONYMS 规则过滤，只把剩下的新词传进来（通常很少）。
 * 返回 mapping：raw → 已有口径（或 null 表示确为新词）。
 */
export async function stageNormalizePredicates(
  cfg: LlmCfg,
  raws: string[],
  known: string[],
  kind: 'fact' | 'relation',
): Promise<{ mapping: Record<string, string | null>; usage: LlmUsage | null; error?: string }> {
  if (!raws.length || !known.length) return { mapping: {}, usage: null };

  const list = raws.slice(0, 30);
  const kindText = kind === 'fact' ? '事实维度' : '关系谓词';
  const prompt = `你在做${kindText}归一。把下面「新词」各自映射到【已有口径】里最贴切的一个；确实都不是同一含义的，映射为 null（表示它是新口径）。

【已有口径】
${known.join('、')}

【新词】
${list.map((r, i) => `${i + 1}. ${r}`).join('\n')}

【要求】
1. 只做同义/近义归一，不要强行归类（拿不准就 null）
2. 输出严格 JSON：{"mapping":{"新词":"已有口径或null"}}
3. 只输出 JSON，不要解释`;

  const r = await chat(cfg, prompt);
  if (r.error) return { mapping: {}, usage: r.usage, error: r.error };
  try {
    const objs = parseLooseObjects(r.content);
    const raw = (objs[0]?.mapping ?? {}) as Record<string, unknown>;
    const mapping: Record<string, string | null> = {};
    for (const w of list) {
      const v = raw[w];
      if (v === null || v === undefined) mapping[w] = null;
      else {
        const s = String(v).trim();
        mapping[w] = known.includes(s) ? s : null; // 只接受已有口径，避免模型自造
      }
    }
    return { mapping, usage: r.usage };
  } catch (err) {
    return { mapping: {}, usage: r.usage, error: `解析失败: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------- Stage 3 关系抽取（知识图谱）

export interface RelationCandidate {
  /** 头实体（必须是实体清单里的名称或正文中完整出现的实体名） */
  head: string;
  /** 自由生成的谓词（2~6 字动词短语），入库前经 predicate_map 归一 */
  predicate: string;
  tail: string;
  tail_type?: string | null;
  statement: string;
  quote: string;
  /** 方向自报（封闭 3 值）：把「谁大谁小」从隐含推断变成可校验的显式声明 */
  orientation?: RelationOrientation;
  confidence?: number;
}

/** 方向自报的三值封闭集（不是谓词词表，模型只需判「head 是大是小」） */
export type RelationOrientation = 'small_is_head' | 'big_is_head' | 'symmetric';

/** 推荐关系类型（自由生成优先，贴切时用这些，便于归一沉淀）。已剔除泛化词，避免引导模型产出无信息谓词 */
export const RELATION_HINTS = [
  '隶属于',
  '任职于',
  '创办',
  '举办',
  '位于',
  '参与',
  '合作',
  '下属',
  '上级',
  '发生于',
];

/**
 * 泛化（低信息量）关系谓词：既不进入推荐词表，入库时也降级处理——
 * 不作为「可信规则」（origin 记 llm 而非 rule），避免图谱里沉淀大量同义泛化边。
 * 若 predicate_map 中已有更具体的历史归一，normalizeRelationPredicate 会复用（即改写）。
 */
export const GENERIC_RELATION_PREDICATES = new Set([
  '关联',
  '相关',
  '相关于',
  '涉及',
  '有关',
  '联系',
  '关系',
  '包含',
  '包括',
  '含有',
]);

/** 供提示词/归一使用的推荐关系词（已剔除泛化词） */
export const usableRelationHints = (): string[] =>
  RELATION_HINTS.filter((p) => !GENERIC_RELATION_PREDICATES.has(p));

/** 关系证据硬校验的驳回记录（用于报告，保证不是「静默丢弃」） */
export interface RelationReject {
  head: string;
  tail: string;
  predicate: string;
  quote: string;
  confidence: number;
  reason: string;
}

/** 去空白（含全角空格/换行），用于「名称是否逐字出现在引句里」的判据比较 */
const compactText = (s: unknown) => String(s ?? '').replace(/[\s\u3000]+/g, '');

/**
 * 证据硬校验（①号判据型规则：完备、零成本、不枚举任何词表）：
 * head 与 tail 必须**逐字出现在引句里**——引句是关系唯一的证据，若连两端实体名都没出现，
 * 这条关系必然是从别处脑补的。
 * 实测拦下的典型脏数据：引句「马站镇渔寮社区举行中心大楼落成仪式」被抽成
 * 「苍南 -属于行政区-> 马站镇」（引句里根本没有「苍南」）。
 * 刻意**不做**行政区/组织后缀剥离：「渔寮」不视为「渔寮社区」的命中——否则会放过
 * 「渔寮景区位于渔寮社区」这类只有共现、引句里缺一端的假关系（那种只能靠模型自证/复核）。
 */
export function relationEvidenceIssues(head: string, tail: string, quote: string): string[] {
  const q = compactText(quote);
  const h = compactText(head);
  const t = compactText(tail);
  const issues: string[] = [];
  if (h.length < 2) issues.push(`head 非法：「${head}」`);
  else if (!q.includes(h)) issues.push(`引句未出现 head「${head}」`);
  if (t.length < 2) issues.push(`tail 非法：「${tail}」`);
  else if (!q.includes(t)) issues.push(`引句未出现 tail「${tail}」`);
  return issues;
}

/** 方向被自动纠正的记录（用于报告，保证可追溯） */
export interface RelationDirectionFix {
  head: string;
  tail: string;
  predicate: string;
  quote: string;
  confidence: number;
  reason: string;
}

/**
 * 引句「连写语序」判据（①层的判据型规则，零词表）：
 * 中文行政/地理/机构名称**紧邻连写**时，语序恒定「大→小」——「永嘉县岩头镇下日川村」
 * 「茶山街道梅园社区」「马站镇渔寮社区」。故紧邻时：
 * - tail 紧接 head（大在前）→ head 在语序上是「小」
 * - head 紧接 tail（大在后）→ head 在语序上是「大」
 * 两端不紧邻（中间有谓词）时返回 null——这种情况方向由谓词语序天然决定，判据不适用，
 * 应尊重模型输出（实测有明确谓词连接时几乎不会错向）。
 * 已在本项目 320 条关系草稿上验证：紧邻「大→小」的 24 条方向全部正确。
 */
export function headQuoteOrder(head: string, tail: string, quote: string): 'big' | 'small' | null {
  const q = compactText(quote);
  const h = compactText(head);
  const t = compactText(tail);
  if (!h || !t || h === t) return null;
  const hi = q.indexOf(h);
  const ti = q.indexOf(t);
  if (hi < 0 || ti < 0) return null;
  if (ti + t.length === hi) return 'small'; // tail 紧接 head：大在前 → head 是小的
  if (hi + h.length === ti) return 'big'; // head 紧接 tail：小在前 → head 是大的
  return null;
}

/**
 * 方向纠偏（第 1 层）：模型自报的 orientation 与引句连写语序矛盾时，交换 head/tail。
 * 例：引句「洞头区东屏街道东岙村」抽成「洞头区 位于 东屏街道」——orientation=small_is_head
 * 但语序显示 head 是「大」→ 矛盾 → 交换为「东屏街道 位于 洞头区」。
 */
export function orientByQuote(
  head: string,
  tail: string,
  quote: string,
  orientation?: RelationOrientation,
): { head: string; tail: string; flipped: boolean; reason?: string } {
  if (!orientation || orientation === 'symmetric') return { head, tail, flipped: false };
  const order = headQuoteOrder(head, tail, quote);
  if (!order) return { head, tail, flipped: false }; // 判据不适用（两端不紧邻），尊重模型
  const declared = orientation === 'small_is_head' ? 'small' : 'big';
  if (declared === order) return { head, tail, flipped: false };
  return {
    head: tail,
    tail: head,
    flipped: true,
    reason: `引句连写语序显示 head 是「${order === 'big' ? '大' : '小'}」，但模型自报 ${orientation} → 已交换`,
  };
}

/**
 * 互逆谓词对归一（第 2 层，封闭集）：把「大→小」的谓词统一到「小→大」的规范谓词，需交换 head/tail。
 * 「A 下辖 B」≡「B 隶属于 A」，两者并存会在图谱里出现同一事实的两条反向边。
 * 只收**方向语义无歧义**的管辖类谓词；「上级/下属」因语义可正可反（A 的上级是 B / A 是 B 的上级）故意不收。
 */
export const INVERSE_PREDICATE_PAIRS: Record<string, string> = {
  下辖: '隶属于',
  辖有: '隶属于',
  rel_下辖: '隶属于',
  rel_辖有: '隶属于',
};

/** 命中互逆对则返回交换并归一后的关系，否则返回 null（原样保留） */
export function normalizeInversePair(
  rel: RelationCandidate,
): { rel: RelationCandidate; from: string } | null {
  const from = String(rel.predicate ?? '').trim();
  const canonical = INVERSE_PREDICATE_PAIRS[from];
  if (!canonical) return null;
  return {
    from,
    rel: {
      ...rel,
      head: rel.tail,
      tail: rel.head,
      predicate: canonical,
      statement: `${rel.tail} ${canonical} ${rel.head}`,
    },
  };
}

/** 关系 schema 行：某 head 分类 × tail 类型 → 建议关系词（后台可维护，注入提示词） */
export interface RelationSchemaLine {
  categoryId: number;
  catCode: string;
  catName: string;
  tailType: string;
  relations: string[];
}

/** 把关系 schema 渲染成提示词行（按本批实体的 head 类型过滤：精确 code 或顶层前缀） */
function relationSchemaLines(schemas: RelationSchemaLine[], entities: { name: string; type: string }[]): string {
  if (!schemas.length) return '';
  const headCodes = new Set<string>();
  for (const e of entities) {
    headCodes.add(e.type);
    headCodes.add(e.type.split('.')[0]);
  }
  const lines = schemas
    .filter((s) => headCodes.has(s.catCode) || headCodes.has(s.catCode.split('.')[0]))
    .map((s) => `- ${s.catName}（${s.catCode}）— ${s.tailType}：${s.relations.join('、')}`);
  return lines.length ? `\n【关系词表（按 head 实体分类 × tail 类型配置，优先从中选用；表外可自拟更贴切的）】\n${lines.join('\n')}\n` : '';
}

/**
 * 关系把关（确定性兜底）：只针对"空间/归属/is-a"几类有限的泛词做硬校验，其余开放谓词放行。
 * 关键判据：泛词谓词必须**逐字出现在引句里**——"林斤澜 位于 温州"的引句没有"位于"二字，就是脑补，硬拦。
 * 合法的"藤桥镇位于鹿城区"（正文逐字有"位于"）照常放行。语义质量交判别式验证器。
 */
const SPATIAL_WORDS = ['位于', '地处', '坐落', '坐落于', '毗邻', '交界', '接壤', '相连', '相邻', '靠近'];
const ADMIN_WORDS = ['隶属', '隶属于', '下辖', '辖有', '直属', '归口'];
const ISA_WORDS = ['属于', '是', '属于是'];

export function checkRelationSchemaGate(
  _schemas: RelationSchemaLine[],
  headCode: string,
  tailCode: string | null | undefined,
  predicate: string,
  quote?: string,
): { ok: boolean; reason?: string; hard?: boolean } {
  const p = String(predicate ?? '').trim();
  const q = String(quote ?? '');
  if (!p) return { ok: true };
  const headTop = headCode.split('.')[0];
  const tailTop = tailCode ? tailCode.split('.')[0] : null;

  // 空间/归属泛词：引句里没有这个词 = 模型脑补 → 硬拦（不进草稿）；逐字出现才看类型约束
  if (SPATIAL_WORDS.includes(p) || ADMIN_WORDS.includes(p)) {
    if (!q.includes(p)) {
      return { ok: false, hard: true, reason: `泛谓词「${p}」未逐字出现在引句里，属脑补关系，已拦（引句：${q.slice(0, 30)}…）` };
    }
    if (SPATIAL_WORDS.includes(p) && tailTop !== 'geo') {
      return { ok: false, reason: `空间谓词「${p}」要求 tail 为地理类实体（当前 ${headCode}→${tailCode ?? '未知'}）` };
    }
    if (ADMIN_WORDS.includes(p)) {
      const orgGeo = (t?: string | null) => t === 'org' || t === 'geo';
      if (!orgGeo(headTop) || !orgGeo(tailTop)) {
        return { ok: false, reason: `归属谓词「${p}」只允许机构/地理之间（当前 ${headCode}→${tailCode ?? '未知'}）` };
      }
    }
    return { ok: true };
  }
  // is-a：仅用于 美食/物产/文化 之间的分类语义（"三丝敲鱼 属于 瓯菜"合法；"吴洁 属于 市餐协"拦）
  if (ISA_WORDS.includes(p)) {
    const foodLike = (t?: string | null) => !!t && (t === 'culture' || t === 'product' || t.startsWith('culture.'));
    if (!foodLike(headTop) || !foodLike(tailTop)) {
      return { ok: false, reason: `is-a 谓词「${p}」仅用于 美食/物产/概念 的分类关系（当前 ${headCode}→${tailCode ?? '未知'}）` };
    }
  }
  return { ok: true };
}

/**
 * 关系抽取：按实体分批调用（每批 ≤6 个实体），避免实体过多时输出过长导致 JSON 截断。
 * 实测教训：14 个实体一次调用 → 143 秒 / 17k token 后 JSON 括号不配平，全军覆没。
 * 要求 head/tail 必须是本批实体清单中的名称或正文里完整出现的实体名；quote 逐字。
 * 出口再经 relationEvidenceIssues 硬校验，不合格的丢弃并记入 rejected（进任务报告）。
 */
export async function stageRelations(
  cfg: LlmCfg,
  entities: { name: string; type: string }[],
  body: string,
  typeList: CategoryHint[] = [],
  relationSchema: RelationSchemaLine[] = [],
): Promise<{ relations: RelationCandidate[]; rejected: RelationReject[]; directionFixes: RelationDirectionFix[]; usage: LlmUsage | null; error?: string }> {
  if (!entities.length) return { relations: [], rejected: [], directionFixes: [], usage: null };

  const CHUNK = 6;
  const chunks: { name: string; type: string }[][] = [];
  for (let i = 0; i < entities.length; i += CHUNK) chunks.push(entities.slice(i, i + CHUNK));

  const relations: RelationCandidate[] = [];
  const rejected: RelationReject[] = [];
  const directionFixes: RelationDirectionFix[] = [];
  let usage: LlmUsage | null = null;
  let firstError: string | undefined;

  for (const chunk of chunks) {
    if (cfg.signal?.aborted) break; // 已取消：不再发起后续批次
    const list = chunk.map((e) => `- ${e.name}（${e.type}）`).join('\n');
    const prompt = `你是知识图谱的关系抽取器。请从下面的新闻正文中，抽取实体之间的关系（三元组：head - predicate - tail）。

【已知实体清单】
${list}

【类型清单（tail_type 从下列取值）】
${categoryHintLines(typeList)}
${relationSchemaLines(relationSchema, chunk)}
【关系要求（只抽真正的人事/业务/物产关系，禁止空间与归属泛词）】
1. 只抽取正文里真正述及、或能直接从正文读出的实体间关系；并列列举、单纯共现、只提到地名都不算关系。
2. predicate 用简洁、有业务语义的关系动词，如：任职于、担任、当选、创办、加入、任教、师承、师徒、合作、主办、承办、入选、列入、属于、联合组织、派遣、捐赠、获得、发布、认证、发源于、盛产、传承、创制。**人物→机构：正文给出具体职务/头衔时，直接用该职务词作谓词**（如「瓯菜博物馆首任馆长胡进盛」→ 胡进盛-[首任馆长]->瓯菜博物馆；「市餐协秘书长吴洁」→ 吴洁-[秘书长]->市餐协），只有正文没给具体职务时才用「任职于/创办」。

3. 谓词必须是能体现**动作/关系**的动词短语；**不要把名词性的属性/工艺/技法词当作谓词**（如「制作工艺」「做法」「烹饪技法」「配方」——这些只是事物的属性描述，不是关系）。正文写的是"制作/做某菜"，谓词就用「制作」；写的是"开设某工艺课/传授技艺"，谓词就用「开设/传授/传承」。
4. **禁止使用「位于/地处/坐落/隶属/隶属于/下辖/辖有/毗邻/相连/交界/包含」这类空间或归属泛词**。只有当正文**逐字**出现这些词（如"位于鹿城区"）时才可用；仅因实体出现在某地语境、或某人属于某单位，就套「位于/隶属」是严重幻觉，绝不允许。
5. 结合 head 与 tail 的实体类型选择贴切谓词，优先从上方【关系词表】中选用。
6. **同一事实方向只取一、同义谓词避免两变体**：同一对实体之间若正文表达的是同一条关系，只能输出一个方向、一种谓词。不要把同一事实拆成两个同义谓词变体（如 举办/主办/承办/举行 是同一个动作，只选一个；「传承人」这类身份词不作谓词，用「传承」），也不要同时输出「A—举办→B」和「B—举行→A」两条反向边。作为容器/活动的一方（机构/人选作主办方=head，活动/名单=tail）。

【示范（同类报道的正确抽法）】
- 正文「市餐协秘书长吴洁介绍」→ {"head":"吴洁","predicate":"任职于","tail":"市餐协","quote":"市餐协秘书长吴洁介绍"}
- 正文「温州技师学院党委副书记、校长刘杰先生」→ {"head":"刘杰","predicate":"任职于","tail":"温州技师学院","quote":"温州技师学院党委副书记、校长刘杰先生"}
- 正文「藤桥食品与温州时尚智造设计中心联名推出"古港古戏"」→ {"head":"藤桥食品","predicate":"合作","tail":"温州时尚智造设计中心","quote":"藤桥食品与温州时尚智造设计中心联名"}
- 正文「1956年徐岩池带瓯菜赴杭州展销会成名」→ {"head":"徐岩池","predicate":"传承","tail":"温州菜","quote":"1956年徐岩池带瓯菜赴杭州展销会成名"}
- 正文「虾虮于2011年列入温州市非遗名录」→ {"head":"虾虮","predicate":"列入","tail":"温州市非遗名录","quote":"虾虮于2011年列入温州市非遗名录"}
- 反例（不要学）：正文「包含永嘉、泰顺、平阳」抽成「平阳 位于 永嘉」是错的；正文「市委副书记、市长张文杰表示」抽成「张文杰 位于 温州」是错的；正文「市餐协秘书长吴洁介绍」抽成「吴洁 隶属于 温州」是错的。

【硬性要求】
1. head 与 tail 必须是上面「已知实体清单」里的名称，或是正文中完整出现的实体名；禁止使用代词（该公司、其、他、该集团）
2. **head 与 tail 都必须逐字出现在 quote 里**（改名、简称、省略后缀都不算）；不满足就整条不要输出
3. quote 必须是正文逐字复制的连续片段（10~60字），能读出该关系，禁止改写、禁止省略号拼接
4. statement 是完整陈述句，如「A 任职于 B」，且方向必须与 quote 一致（A→B 不能写成 B→A）
5. 关系必须能从 quote 直接读出，禁止脑补；若两者只是并列出现、quote 读不出谓词，不要输出
6. 同一关系只输出一次；没有把握不要输出
7. 只输出 JSON

【方向自报（orientation，必填）】
head 与 tail 谁"大"必须如实标注，用于校验方向：
- small_is_head：head 是下级/局部（任职于、入选、举办、发生于…）
- big_is_head：head 是上级/整体（统辖、统管…）
- symmetric：对等/无大小（合作、参与…）
注意：中文连写是"大→小"（如「茶山街道梅园社区」中茶山街道大、梅园社区小），不要写反。

【正文】
${body}

{"relations":[{"head":"实体A","predicate":"任职于","tail":"实体B","tail_type":"org.company或null","statement":"A 任职于 B","quote":"原文逐字片段","orientation":"small_is_head","confidence":0.9}]}`;

    // 本批：解析失败重试一次（附纠错提示）；失败只影响本批，不连累其他批次
    let parsed: RelationCandidate[] | null = null;
    for (let attempt = 1; attempt <= 2 && parsed === null; attempt += 1) {
      if (cfg.signal?.aborted) break;
      const r = await chat(cfg, attempt === 1 ? prompt : prompt + JSON_FIX_HINT);
      if (r.usage) {
        usage = usage
          ? {
              promptTokens: usage.promptTokens + r.usage.promptTokens,
              completionTokens: usage.completionTokens + r.usage.completionTokens,
            }
          : r.usage;
      }
      if (r.error) {
        firstError ??= r.error;
        break; // 传输层错误，chat 内部已重试
      }
      const text = (r.content ?? '').trim();
      try {
        parsed = extractJson<{ relations?: RelationCandidate[] }>(text).relations ?? []; // 含合法空结果
      } catch {
        const loose = parseLooseObjects(text).filter(isRelationLike) as unknown as RelationCandidate[];
        if (loose.length) parsed = loose; // 抢救出部分
        else firstError ??= '解析失败: JSON 非法且无法抢救';
      }
    }

    for (const x of parsed ?? []) {
      const head = String(x?.head ?? '').trim();
      const tail = String(x?.tail ?? '').trim();
      const predicate = String(x?.predicate ?? '').trim();
      const quote = typeof x?.quote === 'string' ? x.quote : '';
      const push = (reason: string) =>
        rejected.push({ head, tail, predicate, quote, confidence: Number(x?.confidence ?? 0), reason });

      if (!head || !tail || !predicate) {
        push('字段缺失（head/tail/predicate）');
        continue;
      }
      if (head === tail) {
        push('自环（head 与 tail 相同）');
        continue;
      }
      if (quote.length < 4 || !body.includes(quote)) {
        push('引句非正文逐字片段');
        continue;
      }
      // ① 判据型硬校验：head/tail 必须逐字出现在引句里，不合格的直接不进草稿
      const issues = relationEvidenceIssues(head, tail, quote);
      if (issues.length) {
        push(issues.join('；'));
        continue;
      }
      // 直接信任模型的 SPO 方向，不做启发式翻转。
      // 之前按「引句连写语序：谁先出现=大」判方向，会把正确的 实体→名单 误翻成 名单→实体
      // （如「温州酒家 列入 名单」→「名单 列入 温州酒家」）。方向以模型为准，交由判别式验证器把关；
      // 真正的双向重复由 discovery.service 的「同谓词反向去重」处理。
      const oriented = { head, tail, flipped: false } as const;
      const finalStatement =
        x.statement ?? `${oriented.head} ${predicate} ${oriented.tail}`;
      relations.push({ ...x, head: oriented.head, tail: oriented.tail, predicate, quote, statement: finalStatement });
    }
  }

  // 有产出就不算失败；全空且至少一批报错才标记 error
  return { relations, rejected, directionFixes, usage, error: relations.length ? undefined : firstError };
}

// ---------------------------------------------------------------- Stage 4 事实→图谱（从已入档事实派生关系边）

/** 事实派生的关系候选：head 由输入实体固定（entity 字段），模型只产出 predicate/tail */
export interface FactRelationCandidate {
  /** 主体实体名（必须是输入清单里的名称） */
  entity: string;
  /** 自由谓词（1~3 字动词短语），入库前经 predicate_map 归一 */
  predicate: string;
  tail: string;
  tail_type?: string | null;
  confidence?: number;
}

/** 事实派生关系的驳回记录（报告留档，不静默丢弃） */
export interface FactRelationReject {
  entity: string;
  tail: string;
  predicate: string;
  reason: string;
}

/**
 * 事实→图谱：把「实体已核实入档的事实清单」作为输入，抽取「主体 → 事实陈述中出现的
 * 其它实体/概念」的关系边。借鉴 ai-knowledge-graph 的两个思路：
 * - hub 推断 prompt：把**已有边（含反向）注入提示词**，明令「不要复述或反向复述已有关系」；
 * - 无序对键防重（_pair_key）：A→B 与 B→A 视为同一连接（本阶段先在提示词层抑制，
 *   无序对硬去重在 discovery.service 的派生入库层完成）。
 * 与 Stage 3（从新闻正文抽关系）的差异：输入是结构化事实而非正文，head 固定为事实主体，
 * tail 必须逐字出现在该主体的事实陈述里（陈述即证据，不再要求正文引句）。
 */
export async function stageFactRelations(
  cfg: LlmCfg,
  entityFacts: { name: string; type: string; facts: { dimension: string; statement: string }[] }[],
  typeList: CategoryHint[] = [],
  existingEdges: string[] = [],
): Promise<{ relations: FactRelationCandidate[]; rejected: FactRelationReject[]; usage: LlmUsage | null; error?: string }> {
  if (!entityFacts.length) return { relations: [], rejected: [], usage: null };

  const CHUNK = 4;
  const chunks: typeof entityFacts[] = [];
  for (let i = 0; i < entityFacts.length; i += CHUNK) chunks.push(entityFacts.slice(i, i + CHUNK));

  const relations: FactRelationCandidate[] = [];
  const rejected: FactRelationReject[] = [];
  let usage: LlmUsage | null = null;
  let firstError: string | undefined;

  for (const chunk of chunks) {
    if (cfg.signal?.aborted) break;
    const entityLines = chunk
      .map((e) => `### ${e.name}（${e.type}）\n${e.facts.map((f) => `- [${f.dimension}] ${f.statement}`).join('\n')}`)
      .join('\n\n');
    const existing = existingEdges.length ? existingEdges.join('\n') : '（暂无）';

    const prompt = `你是知识图谱构建器。下面是若干主体实体**已核实入档的事实清单**。请从这些事实陈述中，抽取「主体实体 → 陈述中出现的其它实体/概念」的关系边。

【主体实体与已核实事实】
${entityLines}

【类型清单（tail_type 从下列取值，取不到就 null）】
${categoryHintLines(typeList)}
【该主体已有关系（禁止重复：正向、反向、谓词同义都算重复）】
${existing}

【抽取要求】
1. 只抽「主体实体 → 事实陈述中出现的对象」方向；每条边的 tail 必须逐字出现在该主体某条事实陈述里（改名/省略后缀都不算）。
2. predicate 用简洁的关系动词（1~3 字），体现动作或关系；**名词性的属性词（制作工艺/做法/配方/口感/特点）不作谓词**。
3. 事实里主体的纯属性描述（如「外酥里嫩」「历史悠久」）不产边；只有陈述里出现**另一个实体或概念**（人物/机构/地点/活动/菜品/名单/食材/口味/技法等）时才可能产边。
4. **数值属性不产边**：主体的数量类陈述（面积/人口/营收/增速/百分比/金额/重量/条目数/年份年代/规格数量）是属性不是关系，这些数值、数量短语绝不能作 tail（如「近两百亿元」「17.4%」「108个条目」「175万人」）。
5. **tail 必须是专名或明确概念**：具体的人名/地名/机构名/品牌/菜品/活动/名单/食材/技法才可作 tail；通用泛指词（牛排、火锅、铁板烧、消费者、市民、三层结构、日常宴请 这类任何语境都能出现的词）不当 tail。
6. **主体必须是动作发出者**：若事实里动作的真正主语是别人、主体只是地点或机构背景（如「学院老师任职于瓯菜」「餐厅负责人黄宗燕表示」），不要产出主体在前的边（可跳过不抽）。
7. 同一关系只输出一条；**与【已有关系】重复（含方向相反、谓词同义：举行/举办/主办/承办视为同一谓词）的一律不要输出**。
8. tail 不要用主体自身（不能自环）；不要用代词，用陈述里的原名。
9. 宁缺毋滥：陈述读不出明确关系的不要输出；没有把握不要输出。
10. 只输出 JSON。

【输出格式】
{"relations":[{"entity":"主体实体名","predicate":"出现于","tail":"温州海鲜宴席","tail_type":"culture.dish","confidence":0.85}]}`;

    // 解析失败重试一次（与 stageRelations 同模式），失败只影响本批
    let parsed: FactRelationCandidate[] | null = null;
    for (let attempt = 1; attempt <= 2 && parsed === null; attempt += 1) {
      if (cfg.signal?.aborted) break;
      const r = await chat(cfg, attempt === 1 ? prompt : prompt + JSON_FIX_HINT);
      if (r.usage) {
        usage = usage
          ? { promptTokens: usage.promptTokens + r.usage.promptTokens, completionTokens: usage.completionTokens + r.usage.completionTokens }
          : r.usage;
      }
      if (r.error) {
        firstError ??= r.error;
        break;
      }
      const text = (r.content ?? '').trim();
      try {
        parsed = extractJson<{ relations?: FactRelationCandidate[] }>(text).relations ?? [];
      } catch {
        const loose = parseLooseObjects(text).filter((o) => o.entity && o.predicate && o.tail) as unknown as FactRelationCandidate[];
        if (loose.length) parsed = loose;
        else firstError ??= '解析失败: JSON 非法且无法抢救';
      }
    }

    // 硬校验：entity ∈ 本批、tail 逐字出现在该主体的陈述、非自环
    const byName = new Map(chunk.map((e) => [e.name, e]));
    for (const x of parsed ?? []) {
      const entity = String(x?.entity ?? '').trim();
      const tail = String(x?.tail ?? '').trim();
      const predicate = String(x?.predicate ?? '').trim();
      const push = (reason: string) => rejected.push({ entity, tail, predicate, reason });
      if (!entity || !tail || !predicate) {
        push('字段缺失（entity/tail/predicate）');
        continue;
      }
      const owner = byName.get(entity);
      if (!owner) {
        push('entity 不在本批主体清单');
        continue;
      }
      if (compactText(entity) === compactText(tail)) {
        push('自环（tail 与主体相同）');
        continue;
      }
      const tailHit = owner.facts.some((f) => compactText(f.statement).includes(compactText(tail)));
      if (!tailHit) {
        push('tail 未逐字出现在该主体的事实陈述里');
        continue;
      }
      relations.push({ ...x, entity, tail, predicate });
    }
  }

  return { relations, rejected, usage, error: relations.length ? undefined : firstError };
}

// ---------------------------------------------------------------- 关系判别式验证器

export interface RelationVerifyInput {
  head: string;
  headType?: string | null;
  tail: string;
  tailType?: string | null;
  predicate: string;
  quote: string;
  statement: string;
}

export interface RelationVerdict {
  verdict: 'pass' | 'fail';
  reason: string;
}

export interface RejectSampleLike {
  head: string;
  predicate: string;
  tail: string;
  quote: string | null;
  reason: string | null;
}

/**
 * 关系判别式验证：给定已抽取的三元组 + 引句，独立判定
 * ① 引句是否足以支撑该关系（并列共现/脑补/方向矛盾 → fail）
 * ② head/tail 实体类型与谓词语义是否兼容
 * 生成器自检不可靠（见"位于"幻觉），判别式二分类更稳；动态注入最近驳回反例 few-shot。
 */
export async function stageVerifyRelations(
  cfg: LlmCfg,
  items: RelationVerifyInput[],
  opts: { rejectSamples?: RejectSampleLike[]; typeHints?: CategoryHint[] } = {},
): Promise<{ verdicts: RelationVerdict[]; usage: LlmUsage | null; error?: string }> {
  if (!items.length) return { verdicts: [], usage: null };

  const list = items
    .map(
      (it, idx) =>
        `${idx + 1}. ${it.head}${it.headType ? `（${it.headType}）` : ''} —${it.predicate}→ ${it.tail}${it.tailType ? `（${it.tailType}）` : ''}\n   陈述：${it.statement}\n   引句：“${it.quote}”`,
    )
    .join('\n\n');

  const samples = (opts.rejectSamples ?? []).slice(0, 8)
    .map((s) => `- ${s.head} —${s.predicate}→ ${s.tail}，引句“${s.quote ?? ''}”，驳回原因：${s.reason ?? ''}`)
    .join('\n');

  const typeLines = opts.typeHints?.length ? categoryHintLines(opts.typeHints) : '';

  const prompt = `你是知识图谱关系审核员。下面每一条是一条「已抽取的关系三元组」（head —谓词→ tail），附陈述与原文引句。

${list}

【审核判据】
1. 引句支撑性：引句能否直接读出该关系？head 与 tail 是否都逐字出现在引句中、且引句明确表达谓词语义？凡是「并列列举/单纯共现/脑补/方向与引句矛盾/引句读不出谓词」的，一律 fail。
2. 类型兼容性：head/tail 的实体类型与谓词语义是否匹配？例如「隶属于」要求 tail 是机构/组织类；人/菜品/概念不应作为机构谓词的宾语；空间谓词（位于/坐落）要求地点类 tail。
3. 宁缺毋滥：拿不准就 fail，把决定权留给人工。

${typeLines ? `【类型清单】\n${typeLines}\n` : ''}
${samples ? `【最近驳回的反例（引以为戒，不要放过同类）】\n${samples}\n` : ''}

【要求】
1. 每条必须给出裁决，只输出严格 JSON，不要任何解释文字
2. verdict 取 pass 或 fail；reason 必填（简短中文：pass 写「引句可证」；fail 写具体原因，如「并列列举，引句读不出位于关系」）

{"verdicts":[{"i":1,"verdict":"pass","reason":"引句可证"},{"i":2,"verdict":"fail","reason":"并列列举，引句读不出该关系"}]}`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await chat(cfg, attempt === 1 ? prompt : prompt + '\n\n注意：上次输出不是合法 JSON，请只输出上面要求的 JSON 结构，不要夹带解释。');
    if (r.error) return { verdicts: [], usage: r.usage, error: r.error };
    const raw = (r.content ?? '').trim();
    try {
      const obj = extractJson<{ verdicts?: { i: number; verdict: string; reason?: string }[] }>(raw);
      const verdicts = (obj.verdicts ?? []).map((v) => ({
        index: Math.max(0, Math.min(items.length - 1, Math.round(Number(v.i)) - 1)),
        verdict: String(v.verdict ?? '').trim().toLowerCase() === 'pass' ? ('pass' as const) : ('fail' as const),
        reason: String(v.reason ?? '').trim().slice(0, 300),
      }));
      if (verdicts.length) return { verdicts, usage: r.usage };
    } catch {
      /* 重试一次 */
    }
  }
  return { verdicts: [], usage: null, error: '验证器解析失败' };
}

