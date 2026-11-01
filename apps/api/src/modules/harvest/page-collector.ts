/**
 * page-collector.ts —— 采集 websearch 命中的详情页
 * （collect_pages.py 的 Node 移植：标题/发布时间/正文/来源，温州网系 CMS 选择器）
 * 无 DOM 依赖，用分层正则提取：容器截断 → 标签剥离 → 实体解码。
 */

export interface CollectedPage {
  url: string;
  title: string;
  text: string;
  pubDate: string | null;
  sourceName: string | null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 正文容器标记（温州网系 CMS 常见 class，命中即从该处截取，避开导航/页脚噪音） */
const BODY_MARKERS = ['TRS_Editor', 'id="zoom"', 'con_news', 'article-content', 'news_content', 'detail-content', 'article_content'];
/** 容器之后的页尾特征（找到即截断） */
const FOOTER_RE = /<(?:div|section)[^>]+class="[^"]*(?:footer|page_tools|editor_boss|related|share|hot_news|page_num)/i;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&mdash;': '—',
  '&middot;': '·',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** 解析单页 HTML → 标题/日期/正文/来源 */
export function parsePage(html: string, url: string): Omit<CollectedPage, 'url'> {
  // 标题：<h1> 优先，<title> 兜底
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(h1?.[1] ?? titleTag?.[1] ?? '').slice(0, 120);

  // 发布时间：meta 优先，正文日期兜底
  let pubDate: string | null = null;
  const metaDate = html.match(
    /<meta[^>]+(?:name="(?:pubdate|publishdate|date)"|property="article:published_time")[^>]+content="([^"]+)"/i,
  ) ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name="(?:pubdate|publishdate|date)"|property="article:published_time")/i);
  if (metaDate) pubDate = metaDate[1];

  // 正文容器截取
  let bodyHtml = html;
  for (const marker of BODY_MARKERS) {
    const idx = html.indexOf(marker);
    if (idx >= 0) {
      let seg = html.slice(idx);
      const foot = seg.search(FOOTER_RE);
      if (foot > 0) seg = seg.slice(0, foot);
      bodyHtml = seg;
      break;
    }
  }
  let text = stripTags(bodyHtml);
  if (!pubDate) {
    const m = text.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/);
    pubDate = m?.[0] ?? null;
  }

  // 来源/作者（正文前 3000 字内）
  const src = text.slice(0, 3000).match(/(?:来源|作者|责编)\s*[:：]\s*([^\s，。;；]{2,20})/);
  const sourceName = src?.[1] ?? null;

  return { title, text, pubDate, sourceName };
}

/** 抓取单个 URL（20s 超时，utf-8/gbk 自适应） */
export async function fetchPage(url: string, timeoutMs = 20_000): Promise<CollectedPage> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 3000));
  // 声明 gbk/gb2312 或 utf-8 解出乱码（U+FFFD）→ 按 gbk 重解（温州网老页面）
  const gbkDeclared = /charset=["']?(gb2312|gbk)/i.test(head);
  let html = new TextDecoder('utf-8').decode(buf);
  if (gbkDeclared || (html.includes('\uFFFD') && /charset=["']?gb/i.test(head))) {
    html = new TextDecoder('gbk').decode(buf);
  }
  return { url, ...parsePage(html, url) };
}
