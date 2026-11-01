/**
 * LLM 连通性测试（OpenAI 兼容 /chat/completions）。
 *
 * 说明：旧的「实体驱动抽取管线」已下线，抽取统一由 discovery 生产线的 stages.ts 负责；
 * 这里只保留「大模型设置」里测试连接所需的最小能力。
 */

/** 一次调用的显式配置（来自后台 llm_setting） */
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 归一化聊天补全地址：允许「接口地址」填根域名或填完整 /chat/completions 地址。
 * - 已以 /chat/completions 结尾 → 原样使用（兼容智谱等 /api/paas/v4/chat/completions）
 * - 否则 → 视为 base，追加 OpenAI 兼容的 /v1/chat/completions
 */
export function normalizeChatUrl(baseUrl: string): string {
  const u = (baseUrl ?? '').trim();
  if (/chat\/completions\/?$/i.test(u)) return u;
  return u.replace(/\/+$/, '') + '/v1/chat/completions';
}

function extractUsage(json: {
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}): LlmUsage | null {
  const u = json.usage;
  if (!u) return null;
  return {
    promptTokens: Number(u.prompt_tokens ?? 0),
    completionTokens: Number(u.completion_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? 0),
  };
}

/** 连通性测试：发一条最小请求，返回是否成功 + 用量 + 耗时 */
export async function testLlmConnection(config: LlmConfig): Promise<{
  ok: boolean;
  model: string;
  latencyMs: number;
  usage?: LlmUsage | null;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(normalizeChatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        // 推理类模型会把推理过程写入 reasoning_content，content 留到最后；token 太小会被推理占满导致 content 为空
        max_tokens: 384,
        messages: [{ role: 'user', content: '回复两个字：OK' }],
      }),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, model: config.model, latencyMs, error: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return { ok: Boolean(text), model: config.model, latencyMs, usage: extractUsage(json), error: text ? undefined : 'empty' };
  } catch (err) {
    return { ok: false, model: config.model, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}
