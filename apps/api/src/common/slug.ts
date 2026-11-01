import { pinyin } from 'pinyin-pro';

/** 生成 URL 友好 slug：三丝敲鱼 → san-si-qiao-yu */
export function toSlug(name: string): string {
  const py = pinyin(name, { toneType: 'none', type: 'array' })
    .join('-')
    .toLowerCase();
  return (
    py
      .replace(/[^a-z0-9\-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 180) || `e${Date.now()}`
  );
}
