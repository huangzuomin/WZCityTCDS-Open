/**
 * websearch.ts —— TRAE 云端 web_search 接口的 Node 移植
 * （端点/头模板来自 Frida 捕获，见仓库根 websearch_调用说明.md）
 *
 * 约束（实测）：
 *  - 每次固定返回 5 条，top_k 被服务端钳制
 *  - 服务端无域名过滤参数，site: 语法写进 user_input
 *  - x-ide-token JWT 约 14 天过期，401 时提示换 token
 *  - 网关有风控，调用方需自行限速（≥2s 间隔）
 */
import { randomUUID } from 'node:crypto';

const ENDPOINT = 'https://trae-api-cn.mchost.guru/api/ide/v1/web_search';

/** 设备/客户端静态头（来自捕获模板；动态头每次调用刷新） */
const STATIC_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-encoding': 'gzip, deflate',
  'app-version': '0.1.58',
  'package-type': 'stable_cn',
  referer: 'https://trae-api-cn.mchost.guru/api/ide/v1/web_search',
  'request-traffic-type': 'prod',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-site': 'none',
  'user-agent': 'TraeClient/TTNet',
  'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  'x-app-version': 'default',
  'x-app-version-code': '20260820',
  'x-bridge-transport': 'aha',
  'x-device-brand': 'OptiPlex 3020',
  'x-device-cpu': 'Intel',
  'x-device-id': '2986699201464398',
  'x-device-type': 'windows',
  'x-ide-version': '0.1.58',
  'x-ide-version-code': '20260820',
  'x-ide-version-type': 'stable',
  'x-lgw-req-sdk-type': '3',
  'x-machine-id': 'aaf44d816d1423272aa6d2cc24ddf80cd599cfdbe04655eac3bc6a6759eb6603',
  'x-net-sdk-domain-dispatch': '1',
  'x-os-version': 'Windows 11 Pro',
  'x-ttnet-bypass-cookie': '0',
  'x-ttnet-bypass-decompression': '1',
  'x-lscbd-aid': '787976',
  'x-lscbd-platform': 'windows',
};

export interface WebsearchReference {
  title: string;
  uri: string;
  snippets: string[];
  icon?: string;
  source?: string;
}

export class WebsearchTokenExpiredError extends Error {
  constructor() {
    super('websearch token 已过期或无效（401）：请在后台「任务计划」更新 x-ide-token');
    this.name = 'WebsearchTokenExpiredError';
  }
}

/** 调一次 web_search，返回 references */
export async function websearch(query: string, token: string, timeoutMs = 30_000): Promise<WebsearchReference[]> {
  const traceId = randomUUID().replace(/-/g, '');
  const headers: Record<string, string> = {
    ...STATIC_HEADERS,
    'x-ide-token': token,
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`,
    'x-request-id': `req_${randomUUID()}`,
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      user_input: query,
      top_k: 5,
      model_name: 'glm-5.3__dev',
      session_id: randomUUID(),
      conversation_id: randomUUID(),
      access_type: 1,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new WebsearchTokenExpiredError();
  if (!res.ok) throw new Error(`websearch HTTP ${res.status}`);
  const data = (await res.json()) as { references?: WebsearchReference[] };
  return data.references ?? [];
}

/** 解析 JWT exp，返回 token 状态（无需验签，只看过期时间） */
export function tokenInfo(token: string): { expired: boolean; exp: number | null; daysLeft: number | null } {
  try {
    const payload = token.split('.')[1];
    if (!payload) return { expired: true, exp: null, daysLeft: null };
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    const exp = decoded.exp ?? null;
    if (!exp) return { expired: false, exp: null, daysLeft: null };
    const daysLeft = (exp - Date.now() / 1000) / 86400;
    return { expired: daysLeft <= 0, exp, daysLeft: Math.round(daysLeft * 10) / 10 };
  } catch {
    return { expired: true, exp: null, daysLeft: null };
  }
}
