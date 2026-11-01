import { bigrams, cosine, jaccard, norm, SEM_THRESHOLD, MARGIN_MIN, TOP1_MIN, SEM_ONLY_MIN } from './lexicon';

/**
 * 实体对齐的确定性部分（不调用 LLM）：
 *   精确 → 别名 → 分块 blocking → 打分 → 属性冲突判异
 * 返回「已定论」或「需要 LLM 判决的候选集」，把 LLM 调用压到最少。
 *
 * 设计要点（试点数据支撑）：
 * - 分块 blocking 是主力：同类别 + 同地域锚，把候选池从全库缩到几十条
 * - 属性冲突直接判异：region/org 冲突不问 LLM（试点里省掉 12 次调用）
 * - 语义只是补充：字面和属性都接不住时才用（如「温州菜」↔「瓯菜」）
 */

export interface AlignAttrs {
  region?: string;
  org?: string;
  role?: string;
}

export interface AlignMention {
  name: string;
  type: string;
  evidence: string;
  attrs?: AlignAttrs;
  vec?: number[] | null;
}

export interface AlignTarget {
  id: number;
  name: string;
  type: string;
  description?: string | null;
  role?: string | null;
  attrs?: AlignAttrs | null;
  geo?: string | null;
  aliases?: string[];
  vec?: number[] | null;
}

export interface Candidate {
  id: number;
  name: string;
  score: number;
  src: '字面' | '语义';
  lit: number;
  sem: number | null;
}

export type PreAlignResult =
  | { action: 'exact_hit'; entityId: number }
  | { action: 'alias_hit'; entityId: number }
  | { action: 'new'; reason: string; conflicts?: string[] }
  | { action: 'review'; reason: string; candidates: Candidate[] }
  | { action: 'need_llm'; candidates: Candidate[]; conflicts: string[] };

/** 属性冲突：region/org 冲突判异（职务冲突不判异，可能是同一人职务变动） */
/** 政区名归一：剥掉行政后缀（温州/温州市/温州地区 → 温州），用于政区包含判定 */
function regionKey(name: string): string {
  return norm(name).replace(/(特别行政区|自治州|地区|县级市|市|县|区|旗|盟)$/, '');
}
export function attrConflict(m: AlignAttrs | undefined, t: AlignAttrs | null | undefined): string | null {
  const a = m ?? {};
  const b = t ?? {};
  if (a.region && b.region && a.region !== b.region) return '地域冲突';
  if (a.org && b.org && a.org !== b.org) return '机构冲突';
  return null;
}

export function roleConflict(m: AlignAttrs | undefined, t: AlignAttrs | null | undefined): string | null {
  const a = m ?? {};
  const b = t ?? {};
  if (a.role && b.role && a.role !== b.role) return '职务不同(可能职务变动)';
  return null;
}

/**
 * 对齐预判定。targets 应为已分块后的候选集（同类别 + 地域锚兼容）。
 */
export function preAlign(mention: AlignMention, targets: AlignTarget[]): PreAlignResult {
  const key = norm(mention.name);

  // 1) 精确命中
  const exact = targets.find((t) => norm(t.name) === key);
  if (exact) return { action: 'exact_hit', entityId: exact.id };

  // 2) 别名命中（历史上合并过的叫法，零成本）
  const alias = targets.find((t) => (t.aliases ?? []).some((al) => norm(al) === key));
  if (alias) return { action: 'alias_hit', entityId: alias.id };

  // 2.5) 政区包含命中：「温州地区」/「温州」/「温州市」归一后同一 → 确定性判同，不问 LLM
  if (mention.type.startsWith('geo.region')) {
    const mk = regionKey(mention.name);
    if (mk.length >= 2) {
      const hit = targets.find((t) => {
        const tk = regionKey(t.name);
        return tk.length >= 2 && (tk === mk || tk.includes(mk) || mk.includes(tk));
      });
      if (hit) return { action: 'alias_hit', entityId: hit.id };
    }
  }

  // 3) 打分：字面 bigram + 语义余弦
  const bg = bigrams(mention.name);
  const scored: Candidate[] = [];
  for (const t of targets) {
    let lit = jaccard(bg, bigrams(t.name));
    if (mention.attrs?.region && t.geo === mention.attrs.region) lit += 0.15;
    let sem: number | null = null;
    if (mention.vec && t.vec) sem = cosine(mention.vec, t.vec);
    const score = Math.max(lit, sem ?? 0);
    if (lit > 0.1 || (sem !== null && sem >= SEM_THRESHOLD)) {
      scored.push({ id: t.id, name: t.name, score, src: sem !== null && sem >= SEM_THRESHOLD ? '语义' : '字面', lit, sem });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // 4) 属性冲突 → 直接剔除（不调 LLM）
  const conflicts: string[] = [];
  const kept: Candidate[] = [];
  for (const c of scored) {
    const t = targets.find((x) => x.id === c.id);
    const cf = attrConflict(mention.attrs, t?.attrs);
    if (cf) {
      conflicts.push(`${c.name}(${cf})`);
      continue;
    }
    kept.push(c);
  }
  const top = kept.slice(0, 3);

  // 5) 没有合格候选 → 新实体
  if (!top.length) {
    return { action: 'new', reason: conflicts.length ? '全部候选属性冲突' : '无候选', conflicts };
  }

  // 5.5) 弱候选兜底：字面分低（机构/政区名 embedding 余弦基线普遍 0.6+，纯语义 0.6x 无区分力）
  //      有字面信号(lit>=0.3)维持 TOP1_MIN，否则要求语义 >= SEM_ONLY_MIN，不够直接判「都不是」。
  //      既省 LLM 调用也省人工（如「大庆建筑安装」vs 温州机构 lit=0.00 sem=0.63 → 新实体）
  const minTop = (top[0].lit ?? 0) >= 0.3 ? TOP1_MIN : SEM_ONLY_MIN;
  if (top[0].score < minTop) {
    return { action: 'new', reason: `候选太弱(top1=${top[0].score.toFixed(2)}<${minTop}，字面${(top[0].lit ?? 0).toFixed(2)})` };
  }

  // 6) 纯同名且双方都无身份 → 不自动合并，转人工
  if (mention.type === 'person' && !mention.attrs?.role && !targets.find((t) => t.id === top[0].id)?.role) {
    return { action: 'review', reason: '纯同名且双方无身份，不自动合并', candidates: top };
  }

  // 7) 分差过小 + top1 足够像 → 模型难以区分，转人工
  //    注意：top1 低于 TOP1_MIN 说明压根没有匹配对象，应判"都不是"而非打扰人工
  if (top.length > 1 && Math.abs(top[0].score - top[1].score) < MARGIN_MIN) {
    if (top[0].score < TOP1_MIN) {
      return { action: 'new', reason: `无相似候选(top1=${top[0].score.toFixed(2)}<${TOP1_MIN})`, conflicts };
    }
    return { action: 'review', reason: `候选接近(top1=${top[0].score.toFixed(2)})，模型难以区分`, candidates: top };
  }

  return { action: 'need_llm', candidates: top, conflicts };
}

/** 分块：同类别 + 地域锚兼容（有一方为空则不过滤地域） */
export function blocking<T extends { type: string; geo?: string | null }>(
  all: T[],
  type: string,
  region?: string | null,
): T[] {
  return all.filter((t) => t.type === type && (!region || !t.geo || t.geo === region));
}
