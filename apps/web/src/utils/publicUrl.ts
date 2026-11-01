/**
 * 公开前台内部链接工具（档案页/图谱页与 demo 展示页同源）。
 * - 默认同源（返回原路径）；构建时可用 `VITE_PUBLIC_BASE` 覆盖成独立域名前缀。
 * - 与后台版（apps/admin/src/utils/publicUrl.ts）不同：这里不写死 5173 跳转，
 *   因为前台本身就是档案页所在端口。
 */
const BASE = (import.meta.env.VITE_PUBLIC_BASE || '').replace(/\/+$/, '');

export function publicUrl(path: string): string {
  const prefix = BASE;
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`;
}
