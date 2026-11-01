import type { CitedStatus, MatchMethod } from './observatory.types';

export interface DetectCitationInput {
  /** 模型最终回答正文（可能含「参考来源：」内联 URL 块） */
  answerText: string;
  /** 结构化搜索结果里的 url（若厂商返回） */
  structuredUrls?: string[];
  /** 我方事实页域名后缀，如 '66wz.com'（覆盖任意子域） */
  domainSuffix: string;
  /** 事实页路径前缀，用于区分「事实页」与「同域其他页(新闻)」 */
  factPathPrefix?: string;
}

export interface DetectCitationResult {
  cited: CitedStatus;
  sourceUrls: string[];
  matchedUrl: string | null;
  excerpt: string | null;
  matchMethod: MatchMethod;
}

const URL_RE = /https?:\/\/[^\s），。、'""）]+/gi;

function normalize(u: string): string {
  return u.replace(/[）)，。、'"]+$/g, '').trim();
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}

function excerptAround(text: string, url: string): string | null {
  const idx = text.indexOf(url);
  if (idx < 0) return null;
  const start = text.lastIndexOf('\n', idx);
  const end = text.indexOf('\n', idx);
  return text.slice(start < 0 ? 0 : start + 1, end < 0 ? text.length : end).trim() || null;
}

/**
 * 双路抓 URL 并判定引用状态：
 * 1) 结构化 web_search_tool_result[].url
 * 2) 正文正则抽 URL（含「参考来源：」内联块）
 * 命我方域且路径含 factPathPrefix → fact_page；命中我方域其他页 → same_domain；
 * 命中外部域 → other；都无 → none。
 */
export function detectCitation(input: DetectCitationInput): DetectCitationResult {
  const domainSuffix = input.domainSuffix.toLowerCase();
  const factPrefix = input.factPathPrefix ?? '/fact/';

  const all = new Map<string, 'struct' | 'text'>();
  for (const u of input.structuredUrls ?? []) {
    const n = normalize(u);
    if (n) all.set(n, 'struct');
  }
  for (const m of input.answerText.match(URL_RE) ?? []) {
    const n = normalize(m);
    if (n && !all.has(n)) all.set(n, 'text');
  }

  const urls = [...all.keys()];

  // 优先事实页
  for (const u of urls) {
    if (hostOf(u).endsWith(domainSuffix) && pathOf(u).startsWith(factPrefix)) {
      return {
        cited: 'fact_page',
        sourceUrls: urls,
        matchedUrl: u,
        excerpt: excerptAround(input.answerText, u),
        matchMethod: all.get(u) === 'struct' ? 'url_struct' : 'url_text',
      };
    }
  }
  // 同域其他页（新闻等）
  for (const u of urls) {
    if (hostOf(u).endsWith(domainSuffix)) {
      return {
        cited: 'same_domain',
        sourceUrls: urls,
        matchedUrl: u,
        excerpt: excerptAround(input.answerText, u),
        matchMethod: all.get(u) === 'struct' ? 'url_struct' : 'url_text',
      };
    }
  }
  // 外部域
  if (urls.length > 0) {
    const u = urls[0];
    return {
      cited: 'other',
      sourceUrls: urls,
      matchedUrl: u,
      excerpt: excerptAround(input.answerText, u),
      matchMethod: all.get(u) === 'struct' ? 'url_struct' : 'url_text',
    };
  }

  return { cited: 'none', sourceUrls: [], matchedUrl: null, excerpt: null, matchMethod: 'none' };
}
