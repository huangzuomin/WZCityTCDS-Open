/**
 * 证据独立性判定（PRD R01 / S02）。
 *
 * 只用「来源家族」计数，不按文章条数计数：
 * - 同一篇文章内多段引文 → 1 个家族
 * - 同文转载（content_hash 相同）→ 1 个家族
 * - 不同媒体、不同原文 → 多个家族；其中同一发布主体仍标"同源媒体"，不宣称独立
 */

export interface IndependenceEvidence {
  evidenceId: number;
  familyId?: number | null;
  sourceId?: number | null;
  sourceOrg?: string | null;
}

export interface IndependenceSummary {
  evidenceCount: number;
  familyCount: number;
  publisherCount: number;
  /** 展示用中性文案，禁止出现"交叉核对=真实性确认"式表述 */
  label: string;
  level: 'none' | 'single' | 'same_family' | 'same_publisher' | 'multi_family';
}

export function evidenceIndependence(list: IndependenceEvidence[]): IndependenceSummary {
  const evidenceCount = list.length;
  const families = new Set<string>();
  const publishers = new Set<string>();
  for (const e of list) {
    families.add(e.familyId ? `f:${e.familyId}` : `e:${e.evidenceId}`);
    publishers.add(e.sourceId ? `s:${e.sourceId}` : String(e.sourceOrg ?? `e:${e.evidenceId}`));
  }
  const familyCount = families.size;
  const publisherCount = publishers.size;

  let label = '无引文';
  let level: IndependenceSummary['level'] = 'none';
  if (evidenceCount === 1) {
    label = '单条报道';
    level = 'single';
  } else if (evidenceCount >= 2 && familyCount === 1) {
    label = `同源多引文 ${evidenceCount} 条`;
    level = 'same_family';
  } else if (familyCount >= 2 && publisherCount === 1) {
    label = `多篇报道 · 同源媒体 ${familyCount} 篇`;
    level = 'same_publisher';
  } else if (familyCount >= 2) {
    label = `独立来源 ${familyCount} 组`;
    level = 'multi_family';
  }

  return { evidenceCount, familyCount, publisherCount, label, level };
}
