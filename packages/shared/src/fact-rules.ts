/**
 * 事实质量规则（PRD R02 / R03）—— 唯一实现，API 运行时与运维脚本共用。
 *
 * 设计原则：
 * 1. 只做确定性判定，不在这里调用模型；
 * 2. reject 级问题必须能在入库前拦住，warning 级只标记（statement_kind / alerts）；
 * 3. 所有入口（agent MCP / CLI 管线 / 后台）必须走同一份规则，禁止各写一套。
 */

/** 合法 period_key：YYYY / YYYY-MM / YYYY-Qn */
export const PERIOD_KEY_RE = /^(\d{4}|\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4])$/;

/** 计量单位词表（按"长度优先"匹配，避免"万元"被"元"抢先） */
export const UNIT_WORDS = [
  '万平方米',
  '平方公里',
  '万吨',
  '万亩',
  '万人次',
  '亿元',
  '万元',
  '平方米',
  '公里',
  '吨',
  '亩',
  '元',
  '人',
  '家',
  '所',
  '项',
  '场',
  '次',
  '个',
  '条',
  '艘',
  '辆',
  '台',
  '件',
  '张',
  '%',
  '％',
];

/** 评价/修辞词：命中且无数字、无机构动作时，判为 rhetoric（不自动签发） */
export const RHETORIC_WORDS = [
  '被誉为',
  '堪称',
  '象征',
  '缩影',
  '根基',
  '馈赠',
  '名片',
  '引擎',
  '金字招牌',
  '底气',
  '标杆',
  '典范',
  '引领',
  '赋能',
  '焕新',
  '不可或缺',
  '独一无二',
];

/** 规划/目标词：与已发生事实区分 */
export const PLAN_WORDS = [
  '计划',
  '拟',
  '将打造',
  '力争',
  '预计',
  '目标',
  '规划',
  '有望',
  '打算',
  '筹建',
  '拟建',
  '将建',
  '将要',
];

export function validPeriodKey(key: string | null | undefined): boolean {
  if (key === null || key === undefined || key === '') return true;
  return PERIOD_KEY_RE.test(String(key));
}

export function hasNumber(text: string): boolean {
  return /\d/.test(text);
}

export function hasUnit(text: string): boolean {
  return UNIT_WORDS.some((u) => text.includes(u));
}

export type StatementKind = 'claim' | 'attributed' | 'opinion' | 'rhetoric' | 'plan';

/**
 * 断言形态判定（启发式，仅用于"是否允许自动签发"与页面标注）：
 * - plan：含规划/目标词
 * - rhetoric：含修辞词且无数字
 * - opinion：含"认为/表示/觉得/期待"等主观词
 * - attributed：含"据介绍/据称/记者获悉"等转述标记
 * - claim：其余
 */
export function classifyStatementKind(statement: string): StatementKind {
  const s = String(statement ?? '');
  if (PLAN_WORDS.some((w) => s.includes(w))) return 'plan';
  if (RHETORIC_WORDS.some((w) => s.includes(w)) && !hasNumber(s)) return 'rhetoric';
  if (/(认为|表示|觉得|期待|希望|看好|感叹)/.test(s)) return 'opinion';
  if (/(据介绍|据称|据报道|记者获悉|消息称|官方表示)/.test(s)) return 'attributed';
  return 'claim';
}

/** 认定/沿革类标记：与数字同属"可核验"信号 */
export const VERIFIABLE_MARKERS = [
  '非遗',
  '名录',
  '评为',
  '入选',
  '获得',
  '获评',
  '认定',
  '起源于',
  '始于',
  '建于',
  '创始于',
  '首创',
  '首次',
];

/** 是否属于可核验断言（含数字，或含认定/沿革标记） */
export function isVerifiableClaim(statement: string): boolean {
  const s = String(statement ?? '');
  return hasNumber(s) || VERIFIABLE_MARKERS.some((w) => s.includes(w));
}

export interface FactQualityInput {
  statement: string;
  factType?: string | null;
  semanticRole?: string | null;
  periodKey?: string | null;
  subjectScope?: string | null;
  temporalKind?: string | null;
  asOf?: string | null;
  eventStart?: string | null;
}

export interface QualityIssue {
  code: string;
  field: string;
  hint: string;
  severity: 'reject' | 'warn';
}

export interface QualityResult {
  ok: boolean;
  statementKind: StatementKind;
  issues: QualityIssue[];
}

/**
 * 事实入库前的字段级校验。
 * reject 级 → 调用方必须拒绝写入；warn 级 → 写 alerts / 阻止自动签发。
 */
export function validateFactQuality(input: FactQualityInput): QualityResult {
  const issues: QualityIssue[] = [];
  const statement = String(input.statement ?? '').trim();
  const role = (input.semanticRole ?? null) as string | null;
  const periodKey = input.periodKey ?? null;
  const subjectScope = (input.subjectScope ?? '').trim();
  const temporalKind = String(input.temporalKind ?? 'unknown');

  if (!validPeriodKey(periodKey)) {
    issues.push({
      code: 'INVALID_PERIOD_KEY',
      field: 'period_key',
      hint: 'period_key 只允许 YYYY / YYYY-MM / YYYY-Qn，无时间口径请传 null',
      severity: 'reject',
    });
  }
  if (periodKey && String(periodKey).length > 10) {
    issues.push({ code: 'PERIOD_KEY_TOO_LONG', field: 'period_key', hint: 'period_key 超过 10 字符', severity: 'reject' });
  }
  if (statement.length > 200) {
    issues.push({ code: 'STATEMENT_TOO_LONG', field: 'statement', hint: '单条断言不得超过 200 字', severity: 'reject' });
  }
  if (role === 'metric') {
    if (!hasNumber(statement)) {
      issues.push({ code: 'METRIC_NO_NUMBER', field: 'statement', hint: '指标类事实必须含具体数值', severity: 'reject' });
    }
    if (!hasUnit(statement)) {
      issues.push({
        code: 'METRIC_NO_UNIT',
        field: 'statement',
        hint: '指标类事实必须含计量单位（吨/万元/亩/% 等）',
        severity: 'reject',
      });
    }
    if (!subjectScope && !periodKey) {
      issues.push({
        code: 'METRIC_NO_SCOPE',
        field: 'subject_scope',
        hint: '指标类事实必须给出统计口径（subject_scope）或时间期（period_key）',
        severity: 'reject',
      });
    }
  }
  if (temporalKind === 'event' && !input.eventStart) {
    issues.push({ code: 'EVENT_NO_TIME', field: 'event_start', hint: '事件类事实必须给 event_start', severity: 'reject' });
  }
  if ((temporalKind === 'as_of' || temporalKind === 'period') && !input.asOf && !periodKey) {
    issues.push({
      code: 'ASOF_NO_TIME',
      field: 'as_of',
      hint: '截至/期间类事实必须给 as_of 或 period_key',
      severity: 'reject',
    });
  }

  const statementKind = classifyStatementKind(statement);
  if (statementKind === 'rhetoric' || statementKind === 'opinion') {
    issues.push({
      code: 'STATEMENT_NOT_CLAIM',
      field: 'statement',
      hint: `断言形态判定为 ${statementKind}，不得自动签发；如需保留请人工改为归属式表述`,
      severity: 'warn',
    });
  }

  return { ok: !issues.some((i) => i.severity === 'reject'), statementKind, issues };
}

/**
 * 规则 6 自动签发门槛（PRD 存量处置）：五项全部满足才允许 sign_mode='auto'。
 * independentEvidenceCount 需由调用方按来源家族计算，未判定时传 0。
 */
export interface AutoApproveInput extends FactQualityInput {
  confidence: number;
  independentEvidenceCount: number;
  evidenceCount: number;
}

export function canAutoApprove(input: AutoApproveInput): { ok: boolean; reason: string } {
  const q = validateFactQuality(input);
  if (!q.ok) return { ok: false, reason: q.issues.find((i) => i.severity === 'reject')!.code };
  if (q.statementKind !== 'claim') return { ok: false, reason: `kind_${q.statementKind}` };
  // 可核验性：必须带数字或明确的认定/沿革标记，否则视为经验描述，不自动签发
  if (!isVerifiableClaim(input.statement)) return { ok: false, reason: 'unverifiable' };
  if (Number(input.confidence) < 0.85) return { ok: false, reason: 'low_confidence' };
  if (Number(input.evidenceCount) < 2) return { ok: false, reason: 'single_evidence' };
  if (Number(input.independentEvidenceCount) < 2) return { ok: false, reason: 'not_independent' };
  if (input.semanticRole === 'metric' && !input.periodKey) return { ok: false, reason: 'metric_no_period' };
  if (input.temporalKind === 'event' && !input.eventStart) return { ok: false, reason: 'event_no_time' };
  return { ok: true, reason: 'passed' };
}

/**
 * 自动放行分档（PRD 第 13 条："单源并不天然不可发布，多篇也不天然构成独立核验"）。
 *
 * - A 档（交叉来源）：字段合格 + claim + 可核验 + 置信≥0.85 + 证据≥2 且来自≥2 篇文章
 * - B 档（单源已核）：字段合格 + claim + 可核验 + 置信≥0.80 + 至少 1 条证据
 *   B 档必须落 alerts=['single_source']，页面明确标注"单条报道"，不得与 A 档同权展示。
 *
 * 两档都不允许 rhetoric / opinion / plan，也不放宽 period_key、单位、事件时间等硬校验。
 */
export type AutoApproveTier = 'A' | 'B';

export interface AutoApproveDecision {
  tier: AutoApproveTier | null;
  reason: string;
}

export function autoApproveTier(input: AutoApproveInput): AutoApproveDecision {
  const a = canAutoApprove(input);
  if (a.ok) return { tier: 'A', reason: 'passed_A' };

  const q = validateFactQuality(input);
  if (!q.ok) return { tier: null, reason: a.reason };
  if (q.statementKind !== 'claim') return { tier: null, reason: a.reason };
  if (!isVerifiableClaim(input.statement)) return { tier: null, reason: 'unverifiable' };
  if (Number(input.confidence) < 0.8) return { tier: null, reason: 'low_confidence' };
  if (Number(input.evidenceCount) < 1) return { tier: null, reason: 'no_evidence' };
  if (input.semanticRole === 'metric' && !input.periodKey) return { tier: null, reason: 'metric_no_period' };
  if (input.temporalKind === 'event' && !input.eventStart) return { tier: null, reason: 'event_no_time' };
  return { tier: 'B', reason: 'passed_B' };
}
