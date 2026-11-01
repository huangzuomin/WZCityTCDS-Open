import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  entities,
  eventEvidences,
  eventTypes,
  events,
  evidences as evidence,
  sourceArticles,
} from '../../db/schema';
import { inferTimePrecision, normalizeText } from '../../common/text';
import type { CreateEventDto, ListEventQuery, UpdateEventDto } from './event.dto';

@Injectable()
export class EventService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(query: ListEventQuery) {
    const where = and(
      query.entityId ? eq(events.entityId, query.entityId) : undefined,
      query.eventType ? eq(events.eventType, query.eventType) : undefined,
      query.status ? eq(events.status, query.status) : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(events).where(where);
    const rows = await this.db
      .select({
        id: events.id,
        entityId: events.entityId,
        entityName: entities.name,
        typeId: events.typeId,
        eventType: events.eventType,
        timeText: events.timeText,
        timePrecision: events.timePrecision,
        timeStart: events.timeStart,
        timeEnd: events.timeEnd,
        isInferred: events.isInferred,
        location: events.location,
        subject: events.subject,
        description: events.description,
        quote: events.quote,
        articleId: events.articleId,
        status: events.status,
        origin: events.origin,
        createdBy: events.createdBy,
        createdAt: events.createdAt,
        updatedAt: events.updatedAt,
      })
      .from(events)
      .leftJoin(entities, eq(events.entityId, entities.id))
      .where(where)
      .orderBy(asc(events.timeStart), asc(events.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return { items: await this.withEvidence(rows as never[]), total, page: query.page, pageSize: query.pageSize };
  }

  /** 时间线：只收录真实事件（时间 + 地点 + 主体 + 动作），按可排序区间升序 */
  async timeline(entityId: number) {
    const rows = await this.db
      .select({
        id: events.id,
        eventType: events.eventType,
        timeText: events.timeText,
        timePrecision: events.timePrecision,
        timeStart: events.timeStart,
        timeEnd: events.timeEnd,
        isInferred: events.isInferred,
        location: events.location,
        subject: events.subject,
        description: events.description,
        quote: events.quote,
        articleId: events.articleId,
        status: events.status,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
        articlePublishedAt: sourceArticles.publishedAt,
        articleBatch: sourceArticles.batch,
      })
      .from(events)
      .leftJoin(sourceArticles, eq(events.articleId, sourceArticles.id))
      .where(and(eq(events.entityId, entityId), eq(events.status, 'active')))
      .orderBy(sql`CASE WHEN ${events.timeStart} IS NULL THEN 1 ELSE 0 END`, desc(events.timeStart), desc(events.id));

    const ids = rows.map((r) => r.id);
    const evLinks = ids.length
      ? await this.db
          .select({
            eventId: eventEvidences.eventId,
            id: evidence.id,
            code: evidence.code,
            quote: evidence.quote,
            articleId: evidence.articleId,
          })
          .from(eventEvidences)
          .innerJoin(evidence, eq(eventEvidences.evidenceId, evidence.id))
          .where(inArray(eventEvidences.eventId, ids))
      : [];

    const byEvent = new Map<number, unknown[]>();
    for (const l of evLinks) {
      const list = byEvent.get(l.eventId) ?? [];
      list.push(l);
      byEvent.set(l.eventId, list);
    }
    return rows.map((r) => ({ ...r, evidences: byEvent.get(r.id) ?? [] }));
  }

  async detail(id: number) {
    const [row] = await this.db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!row) throw new NotFoundException('事件不存在');
    const [withEv] = await this.withEvidence([row]);
    return withEv;
  }

  /**
   * 事件必须是「时间 + 地点 + 主体 + 动作」四要素齐全的真实事件；
   * 状态描述与主体错配的提及不进时间线（R2 主体锚点校验）。
   */
  async create(dto: CreateEventDto, userId?: number) {
    const [entity] = await this.db
      .select()
      .from(entities)
      .where(and(eq(entities.id, dto.entityId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entity) throw new NotFoundException('实体不存在');

    const inferred = inferTimePrecision(dto.timeText);
    const precision = dto.timePrecision ?? inferred.precision;
    const timeStart = dto.timeStart ?? inferred.start;
    const timeEnd = dto.timeEnd ?? inferred.end;
    const isInferred = dto.isInferred ?? inferred.inferred;

    if (dto.quote && dto.subject && !dto.allowMismatch) {
      const nQuote = normalizeText(dto.quote);
      const core = dto.subject.replace(/（[^）]*）/g, '');
      const candidates = [core, core.slice(0, 4), core.slice(0, 2)];
      const hit = candidates.some((c) => c && c.length >= 2 && nQuote.includes(normalizeText(c)));
      if (!hit) {
        throw new BadRequestException({
          code: 'SUBJECT_NOT_IN_QUOTE',
          message: `主体「${dto.subject}」未出现在引句中，该提及不应进入时间线（mention ≠ event）`,
        });
      }
    }

    const [ins] = await this.db.insert(events).values({
      entityId: dto.entityId,
      eventType: dto.eventType,
      timeText: dto.timeText,
      timePrecision: precision,
      timeStart,
      timeEnd,
      isInferred,
      location: dto.location ?? null,
      subject: dto.subject,
      description: dto.description,
      quote: dto.quote ?? null,
      articleId: dto.articleId ?? null,
      status: dto.status,
      origin: dto.origin,
      createdBy: userId ?? null,
    });
    const eventId = Number(ins.insertId);

    if (dto.evidenceIds.length) await this.attachEvidence(eventId, dto.evidenceIds);
    return this.detail(eventId);
  }

  async update(id: number, dto: UpdateEventDto) {
    await this.detail(id);
    const patch: Partial<typeof events.$inferInsert> = {};
    if (dto.eventType !== undefined) patch.eventType = dto.eventType;
    if (dto.timeText !== undefined) patch.timeText = dto.timeText;
    if (dto.timePrecision !== undefined) patch.timePrecision = dto.timePrecision;
    if (dto.timeStart !== undefined) patch.timeStart = dto.timeStart ?? null;
    if (dto.timeEnd !== undefined) patch.timeEnd = dto.timeEnd ?? null;
    if (dto.isInferred !== undefined) patch.isInferred = dto.isInferred;
    if (dto.location !== undefined) patch.location = dto.location ?? null;
    if (dto.subject !== undefined) patch.subject = dto.subject;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.quote !== undefined) patch.quote = dto.quote ?? null;
    if (dto.articleId !== undefined) patch.articleId = dto.articleId ?? null;
    if (dto.status !== undefined) patch.status = dto.status;
    if (Object.keys(patch).length) {
      await this.db.update(events).set(patch).where(eq(events.id, id));
    }
    return this.detail(id);
  }

  async remove(id: number) {
    await this.detail(id);
    await this.db.delete(events).where(eq(events.id, id));
    return { deleted: true };
  }

  async attachEvidence(eventId: number, evidenceIds: number[]) {
    await this.detail(eventId);
    if (!evidenceIds.length) return { attached: 0 };
    await this.db
      .insert(eventEvidences)
      .values(evidenceIds.map((evidenceId) => ({ eventId, evidenceId })))
      .onDuplicateKeyUpdate({ set: { eventId } });
    return { attached: evidenceIds.length };
  }

  async types(datasetId: number) {
    return this.db
      .select()
      .from(eventTypes)
      .where(eq(eventTypes.datasetId, datasetId))
      .orderBy(asc(eventTypes.sort), asc(eventTypes.id));
  }

  async createType(dto: { datasetId: number; code: string; name: string; sort?: number }) {
    const [ins] = await this.db
      .insert(eventTypes)
      .values({ datasetId: dto.datasetId, code: dto.code, name: dto.name, sort: dto.sort ?? 0 })
      .onDuplicateKeyUpdate({ set: { name: dto.name } });
    return { id: Number(ins.insertId), ...dto };
  }

  private async withEvidence(rows: (typeof events.$inferSelect)[]) {
    if (!rows.length) return [];
    const links = await this.db
      .select({
        eventId: eventEvidences.eventId,
        id: evidence.id,
        code: evidence.code,
        quote: evidence.quote,
        articleId: evidence.articleId,
      })
      .from(eventEvidences)
      .innerJoin(evidence, eq(eventEvidences.evidenceId, evidence.id))
      .where(inArray(eventEvidences.eventId, rows.map((r) => r.id)));
    const byEvent = new Map<number, unknown[]>();
    for (const l of links) {
      const list = byEvent.get(l.eventId) ?? [];
      list.push(l);
      byEvent.set(l.eventId, list);
    }
    return rows.map((r) => ({ ...r, evidences: byEvent.get(r.id) ?? [] }));
  }
}
