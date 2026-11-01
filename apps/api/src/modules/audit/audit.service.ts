import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { auditLog, users } from '../../db/schema';

export interface AuditRecord {
  userId?: number | null;
  action: string;
  targetType: string;
  targetId?: number | null;
  before?: unknown;
  after?: unknown;
  remark?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async record(rec: AuditRecord): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        userId: rec.userId ?? null,
        action: rec.action,
        targetType: rec.targetType,
        targetId: rec.targetId ?? null,
        beforeJson: (rec.before ?? null) as Record<string, unknown> | null,
        afterJson: (rec.after ?? null) as Record<string, unknown> | null,
        remark: rec.remark ?? null,
      });
    } catch {
      // 审计失败不能阻断业务写操作
    }
  }

  async list(query: {
    targetType?: string;
    targetId?: number;
    userId?: number;
    action?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  }) {
    const where = and(
      query.targetType ? eq(auditLog.targetType, query.targetType) : undefined,
      query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
      query.userId ? eq(auditLog.userId, query.userId) : undefined,
      query.action ? eq(auditLog.action, query.action) : undefined,
      query.dateFrom ? gte(auditLog.createdAt, new Date(query.dateFrom)) : undefined,
      query.dateTo ? lte(auditLog.createdAt, new Date(`${query.dateTo} 23:59:59`)) : undefined,
    );
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [{ value: total }] = await this.db.select({ value: count() }).from(auditLog).where(where);
    const items = await this.db
      .select({
        id: auditLog.id,
        userId: auditLog.userId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        remark: auditLog.remark,
        createdAt: auditLog.createdAt,
        userName: users.displayName,
        username: users.username,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, total, page, pageSize };
  }
}
