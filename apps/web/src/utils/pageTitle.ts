/**
 * 页面标题口径（预渲染页 vs 运行时）。
 *
 * 背景：档案页/事实页/变更页与辅助页都是 SSG/SSR 直出的静态 HTML，服务端的 <title>
 * 是给搜索引擎/AI 爬虫看的那一份。SPA 启动后会把 #app 换成交互版——这一步不该顺手
 * 把标题改成通用标题，否则「渲染 JS 的爬虫」拿到的标题会与预渲染的专属标题不一致。
 *
 * 判定「本次首屏来自预渲染」不需要额外标记：预渲染页把完整静态内容放在 #app 内，
 * SPA 空壳的 #app 是空的。
 *
 * 规则：首屏地址未变时，运行时不得覆盖标题；一旦发生客户端路由切换（地址变了），
 * 预渲染标题不再适用，改由本模块接管。
 */
const BRAND_NAME = '温州有据';

const bootFullPath = window.location.pathname + window.location.search;
const prerendered = (() => {
  const el = document.getElementById('app');
  return !!el && el.childElementCount > 0;
})();
let adopted = prerendered;

/** 客户端路由切换后释放预渲染标题（地址未变的首屏导航不算切换） */
export function releasePrerenderedTitle(fullPath: string) {
  if (fullPath !== bootFullPath) adopted = false;
}

/** 预渲染页首屏仍生效时返回 true；调用方可据此整段跳过 head 覆盖 */
export function isPrerenderedBoot(): boolean {
  return adopted;
}

/** 统一标题口径 `{标题} · 温州有据`（已含品牌则不重复追加） */
export const withBrand = (title: string): string =>
  title.includes(BRAND_NAME) ? title : `${title} · ${BRAND_NAME}`;

/** 写标题；预渲染标题仍生效时不做任何事 */
export function setPageTitle(title?: string | null): void {
  if (adopted) return;
  document.title = title ? withBrand(title) : `${BRAND_NAME} 事实档案`;
}
