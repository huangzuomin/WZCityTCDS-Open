/**
 * URN 规范：  urn:wz:{dataset}:{category}:{name}
 * 兼容既有：  oucai:dish:三丝敲鱼
 */

export interface ParsedUrn {
  dataset: string;
  category: string;
  name: string;
}

export function buildUrn(dataset: string, category: string, name: string): string {
  return `${dataset}:${category}:${name}`;
}

export function parseUrn(urn: string): ParsedUrn | null {
  const parts = urn.split(':');
  if (parts.length !== 3) return null;
  const [dataset, category, name] = parts;
  if (!dataset || !category || !name) return null;
  return { dataset, category, name };
}

/** 证据资产 URN：urn:wz:asset:66wz:news:20001229:46758 */
export function buildAssetUrn(source: string, channel: string, date: string, id: number | string): string {
  return `urn:wz:asset:${source}:${channel}:${date}:${id}`;
}

/** 事实 URN：urn:wz:fact:三丝敲鱼 */
export function buildFactUrn(entityName: string): string {
  return `urn:wz:fact:${entityName}`;
}

/**
 * 事实编号（全网唯一）：{dataset}-F-{entityId 6位}-{域内序号 2位}
 * 如 wenzhou-city-trust-F-000512-01。实体 id 全局唯一 + 序号实体内唯一 ⇒ 全网不撞号。
 */
export function buildFactCode(dataset: string, entityId: number, seq: number): string {
  return `${dataset}-F-${String(entityId).padStart(6, '0')}-${String(seq).padStart(2, '0')}`;
}

/** 证据编号（全网唯一）：{dataset}-E-{entityId 6位}-{域内序号 2位}，如 wenzhou-city-trust-E-000512-01 */
export function buildEvidenceCode(dataset: string, entityId: number, seq: number): string {
  return `${dataset}-E-${String(entityId).padStart(6, '0')}-${String(seq).padStart(2, '0')}`;
}

/** 取编号末段序号，兼容新老格式：wenzhou-city-trust-F-000512-01 / F-01 / E12 → 1 / 1 / 12 */
export function codeSeq(code: string | null | undefined): number {
  const m = String(code ?? '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}
