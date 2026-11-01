/**
 * 陈述句「近义判同」工具（事实去重硬规则用）。
 *
 * 背景：抽取管线会把同一件事的不同措辞（「秘书长是吴洁」/「是吴洁担任秘书长的组织」、
 * 「瓯菜又称温州菜」/「温州菜又称瓯菜」…）当成「新表述」各自建版，导致同一维度下
 * 出现多条语义重复的事实。这里给出确定性的文本判同，供写入前置硬规则使用——
 * 命中即按「多源确认」合并，不新建版本、不交大模型。
 *
 * 说明：判同只做字面归一 + 字符二元组 Jaccard，不做语义理解；阈值 0.65 的实测依据：
 * 本库「秘书长是吴洁 / 是吴洁担任秘书长的组织」≈0.667，同句 1.0，而不同活动/菜名之间 <0.6。
 * 前端展示层「近义重合」标记使用同一口径与阈值（见 apps/web/src/views/ArchiveView.vue）。
 */

/** 近义判同阈值：归一化后字符二元组 Jaccard 相似度 ≥ 该值即视为同一件事的不同措辞。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.65;

/** 空白与标点（归一化时剔除）。 */
const PUNCT_RE = /[\s，。、；：？！·“”‘’"'（）()〈〉《》【】\[\]—…\-~～,.;:!?/\\]/g;

/** 归一化：去掉空白、标点与高频虚词，只留实义字。 */
export function normalizeStatement(input: unknown): string {
  return String(input ?? '')
    .replace(PUNCT_RE, '')
    .replace(/[的了之]/g, '');
}

/**
 * 「同一口径」判同：在 normalizeStatement 基础上，再忽略不改变语义的副词/语气词（已 / 也 / 均 / 仍 / 尚）。
 * 刻意不含「将 / 会 / 能 / 可 / 不 / 未 / 无」——那些会改变时态、情态或否定，若一并剔除会把
 * 「将投产」与「投产」、「未入选」与「入选」误判成同一口径。
 * 用于裁决 duplicate 时的「就地多源确认」判定：命中即计数+1、不新建版本。
 */
export function isRestatement(a: unknown, b: unknown): boolean {
  const clean = (x: unknown) => String(x ?? '').replace(PUNCT_RE, '').replace(/[的了之已也均仍尚]/g, '');
  const ca = clean(a);
  return ca.length > 0 && ca === clean(b);
}

/**
 * 「同义复述」相似度高阈值：>= 该值且数字集合未变，视为「同一信息、仅措辞/冗余差异」的等价复述。
 * 实测：纯改写（加「该/是/了」、词序调整、同义替换）≈0.85~0.97；
 * 而「设有秘书长一职」→「其秘书长为刘强」（补人名）≈0.62，不会被误并。
 */
export const RESTATEMENT_SIMILARITY_THRESHOLD = 0.85;

/** 数字签名：语句中出现的数字集合，用于挡住「2.3万吨→2.4万吨」这类数值订正被误判为复述。 */
const digitSignature = (s: unknown) => (String(s ?? '').match(/[0-9]/g) || []).sort().join('');

/**
 * 「多源确认」判同（裁决 duplicate 时使用）：
 *   · 归一化后仅差虚词（isRestatement），或
 *   · 数字集合不变且相似度 >= RESTATEMENT_SIMILARITY_THRESHOLD（允许「该/是/了」、词序、同义词等改写）。
 * 数字集合发生变化 → 一律不并入（属数值订正，应作版本更新）。
 */
export function isCorroborating(a: unknown, b: unknown): boolean {
  if (isRestatement(a, b)) return true;
  if (digitSignature(a) !== digitSignature(b)) return false;
  return statementSimilarity(a, b) >= RESTATEMENT_SIMILARITY_THRESHOLD;
}

/** 字符二元组集合（长度 < 2 时为空集）。 */
function bigrams(normalized: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) set.add(normalized.slice(i, i + 2));
  return set;
}

/**
 * 两条陈述的相似度（0~1）。入参可为原始陈述句，内部自行归一化，
 * 因此归一化后完全相同 → 1，完全不同 → 0。
 */
export function statementSimilarity(a: unknown, b: unknown): number {
  const ga = bigrams(normalizeStatement(a));
  const gb = bigrams(normalizeStatement(b));
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}
