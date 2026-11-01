import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/db.module';
import { factTopics, topicAliases, topics } from '../../db/schema';

/**
 * 主题解析器（TS 版，供内部 agent 通道使用，与原 wenzhou-extract/topic-resolver.mjs 同构）。
 * 归并顺序：canonicalKey 精确 → 别名精确 → LLM 归并 → 新建。
 */

const CANDIDATE_LIMIT = 20;
/** LLM 判同一性的最低把握：低于该值宁可新建，也不错误合并 */
const MERGE_MIN_CONFIDENCE = 0.75;
const NAME_MAX = 120;
const DEFINITION_MAX = 400;

/** 进程内 canonicalKey → topicId 缓存 */
const cache = new Map<string, number>();
/** 进程内 aliasKey → topicId 缓存 */
const aliasCache = new Map<string, number>();

export function resetTopicCache() {
  cache.clear();
  aliasCache.clear();
}

/** 主题归一化键：全半角/大小写/空白/标点/书名号/年份/届次统一 */
export function canonicalKey(name: unknown): string {
  let s = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
  s = s.replace(/[（(【[「『].*?[）)】\]」』]/g, '');
  s = s.replace(/[\s\u3000]/g, '');
  s = s.replace(/[，,。.、；;：:！!？?·\-–—_/\\|~`@#$%^&*+=<>{}"'“”‘’《》「」【】]/g, '');
  s = s.replace(/^(?:19|20)\d{2}年?/, '').replace(/^第[一二三四五六七八九十百千零两\d]+届/, '');
  s = s.replace(/^(?:19|20)\d{2}年?/, '');
  s = s.replace(/(?:活动|系列活动|专题报道)$/, '');
  return s.slice(0, 180);
}

/** 展示用名称清洗 */
export function cleanTopicName(name: unknown): string {
  return String(name ?? '')
    .replace(/^[\s“"'《「【]+|[\s”"'》」】]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

function cleanDefinition(def: unknown): string {
  return String(def ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEFINITION_MAX);
}

function cleanAliases(list: unknown, mainName: string): string[] {
  const seen = new Set([canonicalKey(mainName)]);
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const alias = cleanTopicName(raw);
    const key = canonicalKey(alias);
    if (!alias || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= 6) break;
  }
  return out;
}

function topicCode(key: string): string {
  return `TP-${createHash('md5').update(key).digest('hex').slice(0, 10)}`;
}

export interface ResolvedTopic {
  id: number;
  name: string;
  created: boolean;
  matchedBy: 'cache' | 'canonical' | 'alias' | 'llm' | 'new';
  aliases: string[];
}

async function findByCanonical(db: Db, key: string) {
  const [row] = await db.select().from(topics).where(eq(topics.canonicalKey, key)).limit(1);
  return row ?? null;
}

async function findByAlias(db: Db, key: string) {
  const [row] = await db
    .select({ id: topics.id, name: topics.name, definition: topics.definition, status: topics.status })
    .from(topicAliases)
    .innerJoin(topics, eq(topicAliases.topicId, topics.id))
    .where(eq(topicAliases.aliasKey, key))
    .limit(1);
  return row ?? null;
}

async function findById(db: Db, id: number) {
  const [row] = await db.select().from(topics).where(eq(topics.id, id)).limit(1);
  return row ?? null;
}

/** 沿 merged_into_id 找到最终主题 */
export async function resolveFinalTopicId(db: Db, id: number | null | undefined, depth = 0): Promise<number | null> {
  if (!id || depth > 5) return id ?? null;
  const row = await findById(db, id);
  if (!row) return null;
  if (row.status === 'merged' && row.mergedIntoId) {
    return resolveFinalTopicId(db, Number(row.mergedIntoId), depth + 1);
  }
  return Number(row.id);
}

/** 别名落库 + 重建 topics.aliases 冗余数组 */
async function addAliases(db: Db, topicId: number, aliases: string[]): Promise<number> {
  if (!aliases.length) return 0;
  for (const alias of aliases) {
    const key = canonicalKey(alias);
    if (!key) continue;
    // 别名防御（10-28 台账：别名污染）：别名必须是主题的另一种叫法。
    // 拦截：标题式长句（≥12字）、机构/活动/文档类词——这些是文章主题名/实体名被误当别名提交的
    if (alias.length >= 12) continue;
    if (/(研究所|博物馆|联合会|培训学校|学校|公司|集团|大展台|协会|服务中心|嘉年华|大宴|大赛|博览会|名录|推选|生活节|手册|体系|变迁|日历|非遗馆)/.test(alias)) continue;
    await db
      .insert(topicAliases)
      .values({ topicId, alias, aliasKey: key })
      .onDuplicateKeyUpdate({ set: { alias: alias } });
    aliasCache.set(key, topicId);
  }
  const all = await db.select({ alias: topicAliases.alias }).from(topicAliases).where(eq(topicAliases.topicId, topicId));
  await db.update(topics).set({ aliases: all.map((a) => a.alias) }).where(eq(topics.id, topicId));
  return aliases.length;
}

/** 候选主题（最近活跃优先），P 阶段接 LLM 归并时使用 */
async function pickCandidates(db: Db, key: string) {
  const rows = await db
    .select()
    .from(topics)
    .where(eq(topics.status, 'active'))
    .orderBy(desc(topics.lastArticleAt), desc(topics.updatedAt))
    .limit(200);
  const score = (row: (typeof rows)[number]) => {
    const other = String(row.canonicalKey ?? '');
    if (!other) return 0;
    const set = new Set(key);
    let common = 0;
    for (const ch of new Set(other)) if (set.has(ch)) common += 1;
    const overlap = common / Math.max(1, Math.min(set.size, new Set(other).size));
    const contained = other.includes(key) || key.includes(other) ? 0.3 : 0;
    return overlap + contained;
  };
  return rows
    .map((r) => ({ ...r, score: score(r) }))
    .filter((r) => r.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT);
}

interface MergeCandidate {
  id: number;
  name: string;
  definition?: string | null;
}

function buildMergePrompt(input: {
  name: string;
  aliases: string[];
  definition: string;
  candidates: MergeCandidate[];
}): string {
  const cand = input.candidates
    .map((c, i) => `${i + 1}. [id=${c.id}] ${c.name}${c.definition ? ` —— ${String(c.definition).slice(0, 80)}` : ''}`)
    .join('\n');
  return `你是新闻主题归并器。判断「待归档主题」是否与下面某个「已有主题」指同一个主题。

判断标准：核心指称相同即算同一主题——全称/简称、含或不含年份与届次、别称、同一事件的连续报道都算。
仅仅属于同一大类（例如都属于"美食""科技""会议"）不算同一主题；人物与他人、不同届不同城市的事件不算。

【待归档主题】
名称：${input.name}
别名：${input.aliases.length ? input.aliases.join('、') : '无'}
定义：${input.definition || '无'}

【已有主题】
${cand}

只输出一个 JSON 对象，不要解释、不要代码块围栏：
{"match_id": 数字或null, "confidence": 0~1, "reason": "不超过30字"}；没有同一主题时 match_id 输出 null。`;
}

function parseMerge(content: unknown, candidates: MergeCandidate[]): { matchId: number | null; candidate?: MergeCandidate } {
  const text = String(content ?? '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { matchId: null };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { matchId: null };
  }
  const id = obj?.match_id == null || obj.match_id === 'null' ? null : Number(obj.match_id);
  const confidence = Number(obj?.confidence ?? 0);
  const hit = id ? candidates.find((c) => Number(c.id) === id) : null;
  if (!hit || !Number.isFinite(confidence) || confidence < MERGE_MIN_CONFIDENCE) return { matchId: null };
  return { matchId: Number(hit.id), candidate: hit };
}

/**
 * 解析并归并主题。
 */
export async function resolveTopic(
  db: Db,
  payload: { name?: unknown; aliases?: unknown; definition?: unknown },
  opts?: { llm?: (prompt: string) => Promise<{ content: string | null }> },
): Promise<ResolvedTopic | null> {
  const name = cleanTopicName(payload?.name);
  if (!name) return null;
  const key = canonicalKey(name);
  if (!key) return null;
  const definition = cleanDefinition(payload?.definition);
  const inputAliases = cleanAliases(payload?.aliases, name);

  // 1) 缓存 / canonical 精确命中
  const cached = cache.get(key);
  if (cached) {
    const row = await findById(db, cached);
    if (row && row.status !== 'merged') {
      // 缓存命中也要补别名，否则同一主题的后续文章别名会丢
      await addAliases(db, Number(row.id), inputAliases);
      return { id: Number(row.id), name: row.name, created: false, matchedBy: 'cache', aliases: inputAliases };
    }
    cache.delete(key);
  }
  const byKey = await findByCanonical(db, key);
  if (byKey) {
    const finalId = await resolveFinalTopicId(db, Number(byKey.id));
    if (finalId) {
      cache.set(key, finalId);
      await addAliases(db, finalId, inputAliases);
      return { id: finalId, name: byKey.name, created: false, matchedBy: 'canonical', aliases: inputAliases };
    }
  }

  // 2) 别名精确命中
  for (const alias of [name, ...inputAliases]) {
    const akey = canonicalKey(alias);
    if (!akey) continue;
    const aliasHit = aliasCache.has(akey) ? await findById(db, aliasCache.get(akey)!) : await findByAlias(db, akey);
    if (aliasHit) {
      const finalId = await resolveFinalTopicId(db, Number(aliasHit.id));
      if (finalId) {
        cache.set(key, finalId);
        await addAliases(db, finalId, [name, ...inputAliases]);
        return { id: finalId, name: aliasHit.name ?? name, created: false, matchedBy: 'alias', aliases: inputAliases };
      }
    }
  }

  // 3) LLM 归并（仅未命中时，候选 ≤20 条交模型判同一性）
  if (opts?.llm) {
    try {
      const candidates = await pickCandidates(db, key);
      if (candidates.length) {
        const { content } = await opts.llm(buildMergePrompt({ name, aliases: inputAliases, definition, candidates }));
        const { matchId, candidate } = parseMerge(content, candidates);
        if (matchId) {
          cache.set(key, matchId);
          await addAliases(db, matchId, [name, ...inputAliases]);
          if (definition && candidate && !candidate.definition) {
            await db
              .update(topics)
              .set({ definition })
              .where(and(eq(topics.id, matchId), or(isNull(topics.definition), eq(topics.definition, ''))));
          }
          return { id: matchId, name: candidate?.name ?? name, created: false, matchedBy: 'llm', aliases: inputAliases };
        }
      }
    } catch (e) {
      // 归并失败不阻断建档：退化为新建，下次回填仍可再合并
      console.warn(`[topic] LLM 归并失败，按新主题建档：${name}（${String(e).slice(0, 120)}）`);
    }
  }

  // 4) 新建
  const code = topicCode(key);
  try {
    const [res] = await db.insert(topics).values({
      code,
      name,
      canonicalKey: key,
      aliases: inputAliases,
      definition: definition || null,
    });
    const id = Number(res.insertId);
    cache.set(key, id);
    await addAliases(db, id, inputAliases);
    return { id, name, created: true, matchedBy: 'new', aliases: inputAliases };
  } catch (e) {
    if (String((e as Error).message).includes('ER_DUP_ENTRY')) {
      const again = await findByCanonical(db, key);
      if (again) {
        const finalId = await resolveFinalTopicId(db, Number(again.id));
        if (finalId) {
          cache.set(key, finalId);
          await addAliases(db, finalId, inputAliases);
          return { id: finalId, name: again.name, created: false, matchedBy: 'canonical', aliases: inputAliases };
        }
      }
    }
    throw e;
  }
}

/** 事实挂主题：role=primary/secondary，幂等（唯一键 fact_id+topic_id） */
export async function linkFactTopic(
  db: Db,
  input: { factId: number; topicId: number; role?: 'primary' | 'secondary'; confidence?: number | null },
): Promise<boolean> {
  const { factId, topicId, role = 'primary', confidence = null } = input;
  if (!factId || !topicId) return false;
  await db
    .insert(factTopics)
    .values({ factId, topicId, role, confidence: confidence == null ? null : String(confidence) })
    .onDuplicateKeyUpdate({ set: { role } });
  return true;
}

/** 主题报道时间区间维护 */
export async function touchTopicArticleRange(db: Db, topicId: number, publishedAt: string | null) {
  if (!topicId || !publishedAt) return;
  await db.execute(
    sql`UPDATE topic SET first_article_at = LEAST(COALESCE(first_article_at, ${publishedAt}), ${publishedAt}), last_article_at = GREATEST(COALESCE(last_article_at, ${publishedAt}), ${publishedAt}) WHERE id = ${topicId}`,
  );
}
