/**
 * 公开前台地址（后台与前台已分离：前台在 apps/web，后台在 apps/admin）。
 *
 * - 单域按路径分流部署（nginx：`/` → 前台、`/admin/` → 后台）时默认同源，返回原路径即可；
 * - 若前台换成独立端口/子域（如 `http://host:8080` 或 `https://www.example.com`），
 *   构建后台时设置 `VITE_PUBLIC_BASE` 即可，无需改代码。
 */
const BASE = (import.meta.env.VITE_PUBLIC_BASE || '').replace(/\/+$/, '');
// dev 下后台（5174）与公开前台（5173）分属不同端口；未显式配置 VITE_PUBLIC_BASE 时，
// 默认指向前台 dev server，否则相对路径会落到后台端口而打不开档案页。
const DEV_BASE =
  import.meta.env.DEV && !BASE ? `${location.protocol}//${location.hostname}:5173` : '';

export function publicUrl(path: string): string {
  const prefix = BASE || DEV_BASE;
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`;
}
