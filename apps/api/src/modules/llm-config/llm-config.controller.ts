import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Roles } from '../../auth/decorators';
import { LlmConfigService, type LlmKind } from './llm-config.service';
import { testLlmConnection, type LlmConfig } from '../pipeline/llm-client';
import { z } from 'zod';

function normalizeKind(kind?: string): LlmKind | undefined {
  return kind === 'vector' || kind === 'text' ? kind : undefined;
}

const settingSchema = z.object({
  name: z.string().trim().min(1).max(128),
  baseUrl: z.string().trim().min(1).max(512),
  apiKey: z.string().min(1),
  model: z.string().trim().min(1).max(128),
  kind: z.enum(['text', 'vector']).optional(),
  dimensions: z.number().int().min(1).max(4096).nullable().optional(),
  useDefaultDim: z.coerce.boolean().optional(),
  isDefault: z.coerce.boolean().optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  maxTokens: z.coerce.number().int().min(1).max(128000).optional(),
  /** 生产线并发数（该渠道跑批 worker 数），默认 10 */
  concurrency: z.coerce.number().int().min(1).max(50).optional(),
  enabled: z.coerce.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

@Controller('llm-config')
export class LlmConfigController {
  constructor(private readonly service: LlmConfigService) {}

  @Get()
  @Roles('admin', 'editor')
  list(@Query('kind') kind?: string) {
    return this.service.list(normalizeKind(kind));
  }

  @Get('active')
  @Roles('admin', 'editor')
  active(@Query('kind') kind?: string) {
    return kind === 'vector' ? this.service.getActiveVectorConfig() : this.service.getActiveConfig();
  }

  /** 生产线模型（文本模型：启用 + 设为生产线），可能多条 —— 抽取时并发调用 */
  @Get('production')
  @Roles('admin', 'editor')
  production() {
    return this.service.getProductionSettings();
  }

  @Post()
  @Roles('admin')
  create(@Body(new ZodValidationPipe(settingSchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(settingSchema.partial())) dto: unknown) {
    return this.service.update(id, dto as never);
  }

  @Post(':id/set-default')
  @Roles('admin')
  setDefault(@Param('id', ParseIntPipe) id: number) {
    return this.service.setDefault(id);
  }

  /** 取消生产线（文档模型可多条并存，用于撤掉其中一条） */
  @Post(':id/unset-default')
  @Roles('admin')
  unsetDefault(@Param('id', ParseIntPipe) id: number) {
    return this.service.unsetDefault(id);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  /** 连通性测试：文本走 chat completions；向量（kind=vector）走 embeddings */
  @Post('test')
  @Roles('admin', 'editor')
  async test(@Body() body: { id?: number; config?: Record<string, unknown> }) {
    type Ctx = { apiKey: string; model: string; kind: string; dimensions: number | null; useDefaultDim: boolean };
    let ctx: Ctx | null = null;
    if (body.id) {
      const row = await this.service.getById(body.id);
      if (row) {
        ctx = {
          apiKey: row.apiKey,
          model: row.model,
          kind: row.kind,
          dimensions: row.dimensions,
          useDefaultDim: row.useDefaultDim,
        };
      }
    } else if (body.config) {
      const c = body.config as Record<string, unknown>;
      ctx = {
        apiKey: String(c.apiKey ?? ''),
        model: String(c.model ?? ''),
        kind: String(c.kind ?? 'text'),
        dimensions: c.dimensions ? Number(c.dimensions) : null,
        useDefaultDim: Boolean(c.useDefaultDim),
      };
    }
    if (!ctx) return { ok: false, error: '缺少配置' };
    if (ctx.kind === 'vector') return testEmbedding(ctx);
    const cfg: LlmConfig = {
      baseUrl: String((body.config as Record<string, unknown> | undefined)?.baseUrl ?? ''),
      apiKey: ctx.apiKey,
      model: ctx.model,
      temperature: Number((body.config as Record<string, unknown> | undefined)?.temperature ?? 0.1),
      maxTokens: Number((body.config as Record<string, unknown> | undefined)?.maxTokens ?? 2048),
    };
    if (body.id) {
      const row = await this.service.getById(body.id);
      if (!row) return { ok: false, error: '配置不存在' };
      cfg.baseUrl = row.baseUrl;
      cfg.temperature = Number(row.temperature);
      cfg.maxTokens = row.maxTokens;
    }
    if (!cfg.baseUrl) return { ok: false, error: '缺少 baseUrl' };
    return testLlmConnection(cfg);
  }
}

const ZHIPU_EMBED_URL = 'https://open.bigmodel.cn/api/paas/v4/embeddings';
async function testEmbedding(opts: { apiKey: string; model: string; dimensions: number | null; useDefaultDim: boolean }) {
  if (!opts.apiKey) return { ok: false, error: '缺少 API Key' };
  const body: Record<string, unknown> = { model: opts.model, input: '连通性测试文本' };
  if (!opts.useDefaultDim && opts.dimensions) body.dimensions = opts.dimensions;
  try {
    const res = await fetch(ZHIPU_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const emb = json?.data?.[0]?.embedding;
    if (!Array.isArray(emb)) return { ok: false, error: '响应缺少 embedding 数据' };
    return { ok: true, kind: 'vector', model: opts.model, dim: emb.length, latencyMs: 0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
