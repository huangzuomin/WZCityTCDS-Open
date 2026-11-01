import { Injectable, Inject } from '@nestjs/common';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { llmCallLogs, llmSettings } from '../../db/schema';

export interface LlmLogInput {
  settingId: number | null;
  model: string;
  endpoint: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorMessage?: string | null;
  /** 归属批次（extraction_run.id），用于生产线明细页按批次聚合 */
  runId?: number | null;
  /** 归属发现任务（extract_task.id），新生产线的处理记录单元 */
  taskId?: number | null;
  entityId?: number | null;
  articleId?: number | null;
  detailJson?: Record<string, unknown> | null;
  createdBy?: number | null;
}

export interface LlmLogFilter {
  settingId?: number;
  purpose?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class LlmLogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async logCall(entry: LlmLogInput) {
    await this.db.insert(llmCallLogs).values({
      settingId: entry.settingId ?? null,
      model: entry.model,
      endpoint: entry.endpoint,
      purpose: entry.purpose,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      latencyMs: entry.latencyMs,
      status: entry.status,
      errorMessage: entry.errorMessage ?? null,
      runId: entry.runId ?? null,
      taskId: entry.taskId ?? null,
      entityId: entry.entityId ?? null,
      articleId: entry.articleId ?? null,
      detailJson: entry.detailJson ?? null,
      createdBy: entry.createdBy ?? null,
    });
  }

  async list(query: LlmLogFilter) {
    const where = and(
      query.settingId ? eq(llmCallLogs.settingId, query.settingId) : undefined,
      query.purpose ? eq(llmCallLogs.purpose, query.purpose) : undefined,
      query.status ? eq(llmCallLogs.status, query.status as 'success' | 'error') : undefined,
      query.from ? gte(llmCallLogs.createdAt, new Date(`${query.from} 00:00:00`)) : undefined,
      query.to ? lte(llmCallLogs.createdAt, new Date(`${query.to} 23:59:59`)) : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(llmCallLogs).where(where);
    const rows = await this.db
      .select()
      .from(llmCallLogs)
      .where(where)
      .orderBy(desc(llmCallLogs.id))
      .limit(query.pageSize ?? 20)
      .offset(((query.page ?? 1) - 1) * (query.pageSize ?? 20));
    return { items: rows, total: Number(total), page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
  }

  async stats(query: Omit<LlmLogFilter, 'page' | 'pageSize'>) {
    const where = and(
      query.settingId ? eq(llmCallLogs.settingId, query.settingId) : undefined,
      query.purpose ? eq(llmCallLogs.purpose, query.purpose) : undefined,
      query.status ? eq(llmCallLogs.status, query.status as 'success' | 'error') : undefined,
      query.from ? gte(llmCallLogs.createdAt, new Date(`${query.from} 00:00:00`)) : undefined,
      query.to ? lte(llmCallLogs.createdAt, new Date(`${query.to} 23:59:59`)) : undefined,
    );

    const [totals] = await this.db
      .select({
        calls: count(),
        success: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='success' THEN 1 ELSE 0 END)`,
        errors: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='error' THEN 1 ELSE 0 END)`,
        promptTokens: sql<number>`COALESCE(SUM(${llmCallLogs.promptTokens}),0)`,
        completionTokens: sql<number>`COALESCE(SUM(${llmCallLogs.completionTokens}),0)`,
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
        avgLatency: sql<number>`COALESCE(ROUND(AVG(${llmCallLogs.latencyMs})),0)`,
      })
      .from(llmCallLogs)
      .where(where);

    const bySetting = await this.db
      .select({
        settingId: llmCallLogs.settingId,
        settingName: llmSettings.name,
        model: llmCallLogs.model,
        calls: count(),
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
      })
      .from(llmCallLogs)
      .leftJoin(llmSettings, eq(llmCallLogs.settingId, llmSettings.id))
      .where(where)
      .groupBy(llmCallLogs.settingId, llmSettings.name, llmCallLogs.model);

    const byDay = await this.db
      .select({
        day: sql<string>`DATE(${llmCallLogs.createdAt})`,
        calls: count(),
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
      })
      .from(llmCallLogs)
      .where(where)
      .groupBy(sql`DATE(${llmCallLogs.createdAt})`)
      .orderBy(sql`DATE(${llmCallLogs.createdAt})`);

    return {
      totals: {
        calls: Number(totals?.calls ?? 0),
        success: Number(totals?.success ?? 0),
        errors: Number(totals?.errors ?? 0),
        promptTokens: Number(totals?.promptTokens ?? 0),
        completionTokens: Number(totals?.completionTokens ?? 0),
        totalTokens: Number(totals?.totalTokens ?? 0),
        avgLatencyMs: Number(totals?.avgLatency ?? 0),
      },
      bySetting,
      byDay,
    };
  }
}
