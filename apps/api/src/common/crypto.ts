import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** URL / 正文 / span 去重哈希：统一 SHA-256 十六进制 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** span_hash = sha256(quote + '|' + bodyVersion)，唯一约束 (article_id, span_hash) 防重复抽取 */
export function spanHash(quote: string, bodyVersion: number | string): string {
  return sha256(`${quote}|${bodyVersion}`);
}

/** 短哈希：页面展示用（原型里的 c8ad0c32 这种） */
export function shortHash(input: string, len = 8): string {
  return sha256(input).slice(0, len);
}

const SCRYPT_KEYLEN = 64;

/** 口令哈希：scrypt$<salt>$<hash>，无需额外依赖 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
