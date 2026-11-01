import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { type InferModel } from 'drizzle-orm';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { llmSettings } from '../../db/schema';

type LlmSettingRow = InferModel<typeof llmSettings, 'select'>;
export type LlmSettingPublic = Omit<LlmSettingRow, 'apiKey'> & { apiKeyMasked: string };
/** text=文本模型（生产线抽取用，可多条 ） / vector=向量模型 */
export type LlmKind = 'text' | 'vector';

function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 4) return '****';
  return '****' + k.slice(-4);
}

/** 生产线并发数：1~50，默认 10 */
function clampConcurrency(v?: number): number {
  const n = Math.round(Number(v ?? 10));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 10;
}

@Injectable()
export class LlmConfigService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private toPublic(row: LlmSettingRow): LlmSettingPublic {
    const { apiKey, ...rest } = row;
    return { ...rest, apiKeyMasked: maskKey(apiKey) };
  }

  async list(kind?: LlmKind): Promise<LlmSettingPublic[]> {
    const rows = await this.db
      .select()
      .from(llmSettings)
      .where(kind ? eq(llmSettings.kind, kind) : undefined)
      .orderBy(desc(llmSettings.isDefault), desc(llmSettings.id));
    return rows.map((r) => this.toPublic(r));
  }

  /** 生产线文本/向量配置：is_default 且启用；无则返回 null（调用方回落环境变量/规则） */
  async getActiveByKind(kind: LlmKind): Promise<LlmSettingRow | null> {
    const [row] = await this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.kind, kind), eq(llmSettings.isDefault, true), eq(llmSettings.enabled, true)))
      .limit(1);
    return row ?? null;
  }

  async getActiveConfig(): Promise<LlmSettingRow | null> {
    return this.getActiveByKind('text');
  }

  async getActiveVectorConfig(): Promise<LlmSettingRow | null> {
    return this.getActiveByKind('vector');
  }

  /**
   * 生产线模型：「文本模型」里启用 + 设为生产线的全部配置。
   * 允许多条并存 —— 抽取时并发调用，结果合并去重。
   */
  async getProductionSettings(): Promise<LlmSettingRow[]> {
    return this.db
      .select()
      .from(llmSettings)
      .where(and(eq(llmSettings.kind, 'text'), eq(llmSettings.isDefault, true), eq(llmSettings.enabled, true)))
      .orderBy(asc(llmSettings.id));
  }

  async getById(id: number): Promise<LlmSettingRow | null> {
    const [row] = await this.db.select().from(llmSettings).where(eq(llmSettings.id, id)).limit(1);
    return row ?? null;
  }

  async create(data: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    kind?: LlmKind;
    dimensions?: number | null;
    useDefaultDim?: boolean;
    isDefault?: boolean;
    temperature?: number;
    maxTokens?: number;
    /** 生产线并发数（该渠道跑批 worker 数），默认 10 */
    concurrency?: number;
    enabled?: boolean;
    notes?: string | null;
  }) {
    const kind = data.kind ?? 'text';
    // 文本模型允许多条生产线（跑批时按并发数分摊队列），不再互斥
    if (data.isDefault && kind === 'vector') await this.clearDefault(kind);
    const [ins] = await this.db.insert(llmSettings).values({
      name: data.name,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      model: data.model,
      kind,
      dimensions: kind === 'vector' ? (data.dimensions ?? null) : null,
      useDefaultDim: kind === 'vector' ? (data.useDefaultDim ?? true) : true,
      isDefault: data.isDefault ?? false,
      temperature: String(data.temperature ?? 0.1),
      maxTokens: data.maxTokens ?? 2048,
      concurrency: clampConcurrency(data.concurrency),
      enabled: data.enabled ?? true,
      notes: data.notes ?? null,
    });
    return this.toPublic((await this.getById(Number(ins.insertId)))!);
  }

  async update(
    id: number,
    data: Partial<{
      name: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      kind: LlmKind;
      dimensions: number | null;
      useDefaultDim: boolean;
      isDefault: boolean;
      temperature: number;
      maxTokens: number;
      concurrency: number;
      enabled: boolean;
      notes: string | null;
    }>,
  ) {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException('配置不存在');
    const kind = (data.kind ?? existing.kind) as LlmKind;
    if (data.isDefault && kind === 'vector') await this.clearDefault(kind);
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl;
    if (data.apiKey !== undefined && data.apiKey) patch.apiKey = data.apiKey; // 空串表示不修改
    if (data.model !== undefined) patch.model = data.model;
    if (data.kind !== undefined) patch.kind = data.kind;
    if (data.dimensions !== undefined) patch.dimensions = kind === 'vector' ? data.dimensions : null;
    if (data.useDefaultDim !== undefined) patch.useDefaultDim = data.useDefaultDim;
    if (data.isDefault !== undefined) patch.isDefault = data.isDefault;
    if (data.temperature !== undefined) patch.temperature = String(data.temperature);
    if (data.maxTokens !== undefined) patch.maxTokens = data.maxTokens;
    if (data.concurrency !== undefined) patch.concurrency = clampConcurrency(data.concurrency);
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.notes !== undefined) patch.notes = data.notes;
    await this.db.update(llmSettings).set(patch).where(eq(llmSettings.id, id));
    return this.toPublic((await this.getById(id))!);
  }

  async remove(id: number) {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException('配置不存在');
    await this.db.delete(llmSettings).where(eq(llmSettings.id, id));
    return { deleted: true, id };
  }

  async setDefault(id: number) {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException('配置不存在');
    const kind = existing.kind as LlmKind;
    // 文本模型可多条同时为生产线（抽取时并发调用）；向量模型保持唯一
    if (kind === 'vector') await this.clearDefault(kind);
    await this.db.update(llmSettings).set({ isDefault: true }).where(eq(llmSettings.id, id));
    return this.toPublic((await this.getById(id))!);
  }

  /** 取消生产线（多条并存时撤掉其中一条） */
  async unsetDefault(id: number) {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException('配置不存在');
    await this.db.update(llmSettings).set({ isDefault: false }).where(eq(llmSettings.id, id));
    return this.toPublic((await this.getById(id))!);
  }

  private async clearDefault(kind: LlmKind = 'text') {
    await this.db.update(llmSettings).set({ isDefault: false }).where(and(eq(llmSettings.isDefault, true), eq(llmSettings.kind, kind)));
  }
}
