import { chat, type LlmCfg } from '../discovery/stages';
import { extractJson } from '../discovery/lexicon';

/**
 * 事实归并裁决器（三元口径）：
 * 同一「实体 + 维度」下已有现行事实时，交由大模型判断新陈述与之的关系，结论三种：
 * - corroborate：与某条现行事实讲的是同一件事、且**信息内容等价**（仅措辞/冗余/格式差异）→ 多源确认（计数+1，不建版本）
 * - duplicate  ：与某条现行事实讲的是同一件事，但**信息有增删/订正**（补人名、改数字、更精确完整）→ 取代该条（旧版转 superseded）
 * - append     ：**讲的是另一件事**（不同事件/时间/对象，或同一对象的另一侧面）→ 作为独立事实新增
 * 同时给出新事实的槽位坐标（semantic_role / period_key / subject_scope）。
 * 模型不可用时由调用方退回字面判同兜底，绝不擅自取代既有事实。
 */

export type SemanticRole = 'metric' | 'trend' | 'ratio' | 'comparison' | 'record' | 'definition';
export type UpdatePolicy = 'replace' | 'accumulate' | 'merge';
export type Verdict = 'corroborate' | 'duplicate' | 'append';

const ROLES: SemanticRole[] = ['metric', 'trend', 'ratio', 'comparison', 'record', 'definition'];
const VERDICTS: Verdict[] = ['corroborate', 'duplicate', 'append'];

export interface AdjudicationCandidate {
  factId: number;
  code: string | null;
  statement: string;
  semanticRole: SemanticRole | null;
  periodKey: string | null;
  subjectScope: string | null;
}

export interface AdjudicationInput {
  entityName: string;
  dimension: string;
  newStatement: string;
  updatePolicy: UpdatePolicy;
  candidates: AdjudicationCandidate[];
}

export interface AdjudicationResult {
  verdict: Verdict;
  semanticRole: SemanticRole | null;
  periodKey: string | null;
  subjectScope: string | null;
  targetFactId: number | null;
  reason: string;
}

const ROLE_DESC = `- metric     可量化的指标数值（如年产值、产量、面积、数量）
- trend      趋势/走势判断（随时间变化的趋向，非单点数值）
- ratio      比例/占比
- comparison 比较/排名（A 优于/高于 B 之类）
- record     记录类（获奖、入选名录、认证、首创、第一等一次性事件性荣誉）
- definition 定义/定性描述（是什么、属于什么、由什么构成、有什么特征）`;

// 2026-10-18 P2-B 改动说明：新增「同一来源句/同一段落里的互补信息点 → 判 append、严禁判 duplicate」
// 的约束与正/反例（反例即白象香糕：同句「始于清朝末」+「由某某商号所创」曾被误判 duplicate→supersede，
// 导致「始于清朝末」信息丢失）。原因：抽取器把同一句话切成两条重叠区间的事实，互补信息不构成取代关系。
const VERDICT_DESC = `- corroborate 新陈述与某条现行事实**讲的是同一件事，且信息内容等价**——仅措辞/冗余/格式不同，
             **没有任何人名、数字、时间、地点、结论的新增或改动**。
             → 多源确认：只把该条计数+1、刷新核验时间，**不新建版本、不取代**。
             例：「在“泥竞速赛”中，队员们需要一脚跪在“泥艋”船内」vs「在泥竞速赛中，队员需要一脚跪在泥艋内」→ corroborate
                 「温州市商务局是龙舟宴活动的主办单位」vs「…的主办方」→ corroborate
                 「中国瓯菜研究会会长是周雄」vs「温州中国瓯菜研究会会长是周雄」→ corroborate
- duplicate  新陈述与某条现行事实**讲的是同一件事，但信息有增删或订正**（补了人名/数字/条件，
             或更精确、更完整的版本）→ 取代：旧版转 superseded，新陈述落为新版本。
             例：「洞头餐饮协会…设有秘书长一职」vs「…其秘书长为刘强」→ duplicate（补了人名）
                 「大黄鱼年产2.3万吨」vs「…年产2.4万吨」→ duplicate（改了数字）
                 「…参加全省挑战赛的宴席」vs「…并名列前三的宴席」→ duplicate（补了名次）
- append     新陈述讲的是**另一件事**：不同事件、不同时间、不同对象、不同侧面，
             各自独立成立、互不覆盖，应作为独立事实新增。
             **同一来源句/同一段落里的互补信息点**（一句话里含两个并列信息，如「始于清朝末」
             与「由某某商号所创」；两条陈述**互相不可推出**，且**不是对同一条信息的订正/补值**）
             同样属于 append：两条各自独立保留，**不得判 duplicate**（不得让旧条转 superseded）。
             例：「举办龙舟宴」vs「承办特色100碗评选」→ append
                 「明代为贡品」（历史）vs「年产量2.3万吨」（现状）→ append
                 「拥有国家地理标志」（荣誉）vs「落户深远海养殖带」（产地）→ append
                 【同源互补·反例】「白象香糕俗称板糕，有悠久历史，始于清朝末。」vs
                 「白象香糕是由浙江乐清县白象镇公久南北货商号所创。」→ append
                 （同一句话切成两条：一句讲起始年代、一句讲创始商号，互相推不出，绝非取代）

【判别要点】
- **corroborate 与 duplicate 的分界**：把两条陈述逐项对齐——只要新陈述读得出旧陈述**没有**的信息
  （人名、数字、时间、地点、条件、名次、结论…）→ duplicate；信息完全等价、只是换了个说法 → corroborate。
- **同一来源句/同一段落的互补信息 → 必须判 append（严禁 duplicate）**：一句话里含两个并列信息点，
  两条陈述**互相不可推出**、也不是对同一条信息的订正/补值 → 各自独立保留，判 append。
  反例（白象香糕，务必照此判 append）：「有悠久历史，始于清朝末。」vs「是由浙江乐清县白象镇公久
  南北货商号所创。」——同一句的两个互补信息点，曾误判 duplicate/supersede 把「始于清朝末」错误下架。
  正例（判 duplicate）：「白象香糕始于清朝末。」vs「白象香糕始于清光绪年间。」——对同一条「起始年代」
  信息的更精确订正 → duplicate。
- **同一个维度 ≠ 同一件事**：同一维度（如"荣誉认证""历史沿革"）下可以有许多互不相干的独立事实。
- 只要两条陈述不能互相改写（读一条就能推出另一条）→ 就是 append。
- 拿不准 corroborate 还是 duplicate → 选 duplicate（宁可留版本变化，也不要把变化藏起来）；
  但**同源同句的互补信息不属于「拿不准 corroborate/duplicate」的情形**——按上一条直接判 append；
  拿不准 duplicate 还是 append → 选 append。`;

export function buildAdjudicationPrompt(input: AdjudicationInput): string {
  const cand = input.candidates
    .map((c, i) => {
      const slot = [c.semanticRole ?? '未标注', c.periodKey ?? '-', c.subjectScope ?? '-'].join(' / ');
      return `${i + 1}. [事实ID ${c.factId}]（槽位：${slot}）${c.statement}`;
    })
    .join('\n');

  return `你是知识库事实的「归并裁决器」。给定实体「${input.entityName}」在维度「${input.dimension}」下已存在的现行事实，以及一条新的候选事实，请判断新事实是否与其中某条**讲的是同一件事**，并为新事实标注槽位坐标。

【该维度的默认更新策略】${input.updatePolicy}（replace=同槽位应覆盖；accumulate=应历史累积并存；merge=语义等价则合并、否则并存）。策略仅作参考，以你的语义判断为准。

【已存在的现行事实】
${cand || '(无)'}

【新的候选事实】
${input.newStatement}

【语义角色 semantic_role（择一）】
${ROLE_DESC}

【裁决 verdict（择一，三种）】
${VERDICT_DESC}

【槽位坐标说明】
- period_key：**时间槽位键**，用于区分同一槽位在不同时间区间的取值。判断顺序：(1) 陈述中出现明确的年份/季度/月份（如“2025年”“2024”“2026-09”）→ 必须填入，**且只能填下列规范格式**：年份「2025」、年月「2025-07」、季度「2025-Q1」；(2) 无任何时间线索 → 填 null。
  **严禁编造或挪用**（编造比留空更差，会污染槽位；实测存量里已出现“20年”“999”“2026年浙江高考和高中选考”这类脏值）：
  · 不得把数量/金额/面积/规模当时间（如“2000亩”“2600万元”“43家”“20年来”）；
  · 不得把事件名、活动名、机构名当时间（如“2026年浙江高考和高中选考”）；
  · 不得用朝代、公元前、模糊时段（如“北宋”“公元前192年”“上世纪六七十年代”“解放初期”“清末民初”）→ 一律 null；
  · 不得用相对时间（如“去年”“今年”“20年来”）→ 一律 null；
  · 不得填日精度（“2025-07-15”截到月写“2025-07”）；年份区间取起点（“2026-2027”写“2026”）。
  即：**无法确定就填 null**，留空永远优于编造。
- subject_scope：当同一维度下存在多个不同主体/口径而需区分时填写（如"海水养殖"与"深远海养殖"），无需区分时用 null；不要编造，判不准就 null。

只输出一个 JSON 对象，不要输出任何解释性文字或代码块围栏，格式：
{"semantic_role":"<角色>","period_key":<字符串或null>,"subject_scope":<字符串或null>,"verdict":"<裁决>","target_fact_id":<整数或null>,"reason":"<一句中文理由>"}
其中 target_fact_id：verdict=corroborate / duplicate 时必填，指向与之讲同一件事的那条现行事实 ID；verdict=append 时填 null。`;
}

export function parseAdjudication(raw: string, candidates: AdjudicationCandidate[]): AdjudicationResult | null {
  let obj: unknown;
  try {
    obj = extractJson<Record<string, unknown>>(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const verdict = String(o.verdict ?? '').trim() as Verdict;
  if (!VERDICTS.includes(verdict)) return null;

  const roleRaw = o.semantic_role == null ? null : String(o.semantic_role).trim();
  const semanticRole = roleRaw && ROLES.includes(roleRaw as SemanticRole) ? (roleRaw as SemanticRole) : null;

  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s && s !== 'null' ? s : null;
  };

  const idRaw = o.target_fact_id;
  let targetFactId: number | null = null;
  if (idRaw != null) {
    const n = Number(idRaw);
    if (Number.isFinite(n) && candidates.some((c) => c.factId === n)) targetFactId = n;
  }

  return {
    verdict,
    semanticRole,
    periodKey: str(o.period_key),
    subjectScope: str(o.subject_scope),
    targetFactId,
    reason: String(o.reason ?? '').trim(),
  };
}

/** 调用生产线模型做一次归并裁决；出错/空响应返回 null，由调用方走兜底策略。 */
export async function adjudicateFact(cfg: LlmCfg, input: AdjudicationInput): Promise<AdjudicationResult | null> {
  const res = await chat(cfg, buildAdjudicationPrompt(input), 2);
  if (res.error || !res.content) return null;
  return parseAdjudication(res.content, input.candidates);
}
