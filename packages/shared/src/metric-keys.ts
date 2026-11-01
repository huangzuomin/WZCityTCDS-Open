/**
 * 核心指标受控词典（PRD R03 / S03 / S04）。
 *
 * 设计约定：
 * 1. 词典由产品维护，工程只读；新增指标走 PR，不在代码里散落 if-else。
 * 2. metricKey 是**指标卡去重的唯一键**——同 key 不同 label（"现场签约总金额"/"签约项目总金额"）视为同一指标。
 * 3. 卡片要进首屏，必须同时具备 valueText + unit + period（或 region/scope）；缺项只进二级列表。
 */

export interface MetricKeyDef {
  /** 稳定键，入库后不可改 */
  key: string;
  /** 展示名 */
  name: string;
  /** label 命中任意一个即归属（长度优先匹配，先匹配更具体的） */
  patterns: string[];
  /** 常见单位，用于从数值文本里补不到单位时兜底 */
  defaultUnit?: string;
  /**
   * 指标性质（决定首屏准入口径）：
   * - flow：时间序列型（产量/产值/金额/人次），必须有统计期，无期不上首屏
   * - stock：存量/结构型（面积、门店数、价格区间、席位），允许无统计期，
   *          但必须有地域或范围，并标注"时点未标注"
   */
  kind: 'flow' | 'stock';
}

/** 词典顺序即匹配优先级：越具体越靠前 */
export const METRIC_KEYS: MetricKeyDef[] = [
  { key: 'signing_amount', name: '签约金额', patterns: ['签约金额', '签约项目', '签约', '合同金额'], defaultUnit: '万元', kind: 'flow' },
  { key: 'investment_amount', name: '投资金额', patterns: ['总投资', '投资额', '投资金额', '投资'], defaultUnit: '亿元', kind: 'flow' },
  { key: 'annual_output', name: '年产量', patterns: ['年产量', '产量', '年产'], defaultUnit: '吨', kind: 'flow' },
  { key: 'output_value', name: '产值', patterns: ['一产产值', '总产值', '产值'], defaultUnit: '亿元', kind: 'flow' },
  { key: 'breeding_area', name: '养殖面积', patterns: ['养殖面积', '养殖海域', '海域面积', '面积'], defaultUnit: '亩', kind: 'stock' },
  { key: 'enterprise_count', name: '企业数量', patterns: ['企业数量', '家企业', '企业'], defaultUnit: '家', kind: 'stock' },
  { key: 'employee_count', name: '从业人员', patterns: ['从业人员', '就业人数', '带动就业', '营销团队'], defaultUnit: '人', kind: 'stock' },
  { key: 'visitor_count', name: '接待人次', patterns: ['接待游客', '接待人次', '游客量', '客流量'], defaultUnit: '万人次', kind: 'flow' },
  { key: 'brand_count', name: '品牌数量', patterns: ['品牌数量', '个品牌', '品牌'], defaultUnit: '个', kind: 'stock' },
  { key: 'dish_count', name: '菜品数量', patterns: ['道菜', '菜品数量', '道菜品'], defaultUnit: '道', kind: 'stock' },
  { key: 'event_count', name: '活动场次', patterns: ['场次', '场活动', '平行论坛'], defaultUnit: '场', kind: 'stock' },
  { key: 'project_count', name: '项目数量', patterns: ['重点项目', '个项目', '项目数', '签约项目数'], defaultUnit: '个', kind: 'stock' },
  { key: 'exhibitor_count', name: '参展商数量', patterns: ['参展商', '展商'], defaultUnit: '家', kind: 'stock' },
  { key: 'exhibition_area', name: '展区面积', patterns: ['展区面积', '展览面积', '展陈面积'], defaultUnit: '平方米', kind: 'stock' },
  { key: 'price', name: '价格', patterns: ['价格', '售价', '单价', '每斤'], defaultUnit: '元', kind: 'stock' },
  { key: 'species_count', name: '物种数量', patterns: ['物种数', '种鸟类', '物种'], defaultUnit: '种', kind: 'stock' },
];

/** 地名简称 → 规范地域（原文常写"温州""苍南"，不带行政区后缀） */
export const REGION_ALIASES: { alias: string; region: string }[] = [
  { alias: '南麂', region: '平阳县' },
  { alias: '北麂', region: '瑞安市' },
  { alias: '温州', region: '温州市' },
  { alias: '鹿城', region: '鹿城区' },
  { alias: '龙湾', region: '龙湾区' },
  { alias: '瓯海', region: '瓯海区' },
  { alias: '洞头', region: '洞头区' },
  { alias: '永嘉', region: '永嘉县' },
  { alias: '平阳', region: '平阳县' },
  { alias: '苍南', region: '苍南县' },
  { alias: '文成', region: '文成县' },
  { alias: '泰顺', region: '泰顺县' },
  { alias: '瑞安', region: '瑞安市' },
  { alias: '乐清', region: '乐清市' },
  { alias: '龙港', region: '龙港市' },
];

/** 单位词，按长度倒序，保证"万元"不被"元"截断 */
export const METRIC_UNITS = [
  '万平方米',
  '平方公里',
  '万人次',
  '平方米',
  '万吨',
  '万亩',
  '亿元',
  '万元',
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
  '道',
  '种',
  '%',
  '％',
];

export const WENZHOU_REGIONS = [
  '温州市',
  '鹿城区',
  '龙湾区',
  '瓯海区',
  '洞头区',
  '永嘉县',
  '平阳县',
  '苍南县',
  '文成县',
  '泰顺县',
  '瑞安市',
  '乐清市',
  '龙港市',
];

export interface NormalizedKeyStat {
  metricKey: string;
  metricName: string;
  valueText: string;
  unit: string | null;
  period: string | null;
  region: string | null;
  scope: string;
  approx: boolean;
  legacy: boolean;
}

/** label → 指标定义（长度优先，避免"项目"吃掉"签约项目"） */
export function matchMetricKey(label: string): MetricKeyDef | null {
  const s = String(label ?? '').trim();
  if (!s) return null;
  const hits: { def: MetricKeyDef; p: string }[] = [];
  for (const def of METRIC_KEYS) {
    for (const p of def.patterns) {
      if (s.includes(p)) hits.push({ def, p });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.p.length - a.p.length);
  return hits[0].def;
}

export function extractUnit(text: string): string | null {
  const s = String(text ?? '');
  const sorted = [...METRIC_UNITS].sort((a, b) => b.length - a.length);
  for (const u of sorted) {
    if (s.includes(u)) return u;
  }
  return null;
}

/** 从文本里抽时间口径：2024年 / 2024年9月 / 2024-09 / 2024Q1 */
export function extractPeriod(text: string): string | null {
  const s = String(text ?? '');
  let m = s.match(/(\d{4})年(\d{1,2})月/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/(\d{4})-(\d{1,2})(?!\d)/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/(\d{4})年?(?:第)?([1-4一二三四])季度|(\d{4})Q([1-4])/);
  if (m) {
    const y = m[1] ?? m[3];
    const q = m[4] ?? { 一: '1', 二: '2', 三: '3', 四: '4' }[m[2] as '一' | '二' | '三' | '四'];
    if (y && q) return `${y}-Q${q}`;
  }
  m = s.match(/(\d{4})年/);
  if (m) return m[1];
  return null;
}

export function extractRegion(text: string): string | null {
  const s = String(text ?? '');
  for (const r of WENZHOU_REGIONS) {
    if (s.includes(r)) return r;
  }
  // 简称归一（"苍南""温州"）
  for (const a of REGION_ALIASES) {
    if (s.includes(a.alias)) return a.region;
  }
  return null;
}

/** 指标性质：时间序列型必须带统计期，存量型可只带地域/范围 */
export function metricKindOf(metricKey: string): 'flow' | 'stock' {
  return METRIC_KEYS.find((k) => k.key === metricKey)?.kind ?? 'flow';
}

export function isApprox(valueText: string): boolean {
  return /(近|约|超过|逾|接近|余|多|左右)/.test(String(valueText ?? ''));
}

/** 把一条原始 {value,label} 归一为结构化指标 */
export function normalizeKeyStat(raw: { value?: unknown; label?: unknown }): NormalizedKeyStat {
  const valueText = String(raw?.value ?? '').trim();
  const label = String(raw?.label ?? '').trim();
  const def = matchMetricKey(label);
  const unit = extractUnit(valueText) ?? def?.defaultUnit ?? null;
  return {
    metricKey: def?.key ?? 'unmapped',
    metricName: def?.name ?? (label || '未分类指标'),
    valueText,
    unit,
    period: extractPeriod(label) ?? extractPeriod(valueText),
    region: extractRegion(label),
    scope: label,
    approx: isApprox(valueText),
    legacy: !def,
  };
}

/**
 * 指标卡首屏准入（PRD R03）：
 * - flow（产量/产值/金额/人次）：必须有统计期，无期不上首屏
 * - stock（面积/门店数/价格区间/席位）：允许无统计期，但要有地域或范围，并标注"时点未标注"
 */
export function isPublishableKeyStat(s: NormalizedKeyStat): boolean {
  if (s.legacy || s.metricKey === 'unmapped') return false;
  if (!s.valueText || !s.unit) return false;
  // 有统计期最好；没有统计期时，只要有明确地域也可上首屏，但卡片会标"时点未标注"
  return Boolean(s.period || s.region);
}

/** 卡片副标题：口径行 */
export function keyStatCaption(s: NormalizedKeyStat): string {
  const parts = [s.period, s.region, s.scope].filter(Boolean) as string[];
  return parts.join(' · ');
}
