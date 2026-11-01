import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, like, lt, sql } from 'drizzle-orm';
import { buildUrn } from '@ssot/shared';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  auditLog,
  categories,
  datasetCategories,
  datasets,
  entities,
  entityAliases,
  entityAttrIndex,
  evidences,
  extractionDrafts,
  facts,
} from '../../db/schema';
import { toSlug } from '../../common/slug';
import { CategoryService } from '../category/category.service';
import { FieldDefService } from '../field-def/field-def.service';
import {
  CreateEntityDto,
  ListEntityQuery,
  UpdateEntityDto,
} from './entity.dto';

@Injectable()
export class EntityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly categoryService: CategoryService,
    private readonly fieldDefService: FieldDefService,
  ) {}

  /** 语料域通过关联分类过滤实体（v2：实体全局，dataset 视图 = 该库关联分类下的实体） */
  private async linkedCategoryIds(datasetId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: datasetCategories.categoryId })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    return rows.map((r) => Number(r.id));
  }

  async list(query: ListEntityQuery) {
    const linkedIds = query.datasetId ? await this.linkedCategoryIds(query.datasetId) : [];
    const where = and(
      isNull(entities.deletedAt),
      query.datasetId ? inArray(entities.categoryId, linkedIds) : undefined,
      query.categoryId ? eq(entities.categoryId, query.categoryId) : undefined,
      query.status ? eq(entities.status, query.status) : undefined,
      query.keyword ? like(entities.name, `%${query.keyword}%`) : undefined,
    );

    const [{ value: total }] = await this.db.select({ value: count() }).from(entities).where(where);

    // keyset（游标）分页：深分页不退化
    const keyset = query.cursor
      ? query.order === 'desc'
        ? lt(entities.id, query.cursor)
        : gt(entities.id, query.cursor)
      : undefined;

    const factCount = sql<number>`(SELECT COUNT(*) FROM fact WHERE fact.entity_id = ${entities.id} AND fact.status = 'active')`.as('factCount');

    const rows = await this.db
      .select({
        id: entities.id,
        urn: entities.urn,
        name: entities.name,
        slug: entities.slug,
        status: entities.status,
        revision: entities.revision,
        originDatasetId: entities.originDatasetId,
        categoryId: entities.categoryId,
        datasetName: datasets.name,
        datasetCode: datasets.code,
        categoryName: categories.name,
        factCount,
        updatedAt: entities.updatedAt,
      })
      .from(entities)
      .leftJoin(datasets, eq(entities.originDatasetId, datasets.id))
      .leftJoin(categories, eq(entities.categoryId, categories.id))
      .where(and(where, keyset))
      .orderBy(
        query.sort === 'factCount'
          ? query.order === 'desc'
            ? desc(factCount)
            : asc(factCount)
          : query.order === 'desc'
            ? desc(entities.id)
            : asc(entities.id),
      )
      .limit(query.pageSize)
      .offset(query.cursor ? 0 : (query.page - 1) * query.pageSize);

    return {
      items: rows,
      total,
      page: query.page,
      pageSize: query.pageSize,
      nextCursor: rows.length === query.pageSize ? rows[rows.length - 1].id : null,
    };
  }

  async findOne(id: number) {
    const [row] = await this.db.select().from(entities).where(eq(entities.id, id)).limit(1);
    if (!row || row.deletedAt) throw new NotFoundException('实体不存在');
    return row;
  }

  /** 详情 = 实体 + 动态字段定义（后台据此渲染表单） + 别名 */
  async detail(id: number) {
    const entity = await this.findOne(id);
    const [fields, aliases] = await Promise.all([
      this.fieldDefService.resolve(entity.categoryId),
      this.db.select().from(entityAliases).where(eq(entityAliases.entityId, id)),
    ]);
    return { ...entity, fields, aliases };
  }

  async create(dto: CreateEntityDto) {
    const category = await this.categoryService.findOne(dto.categoryId);
    const [ds] = dto.originDatasetId
      ? await this.db
          .select()
          .from(datasets)
          .where(eq(datasets.id, dto.originDatasetId))
          .limit(1)
      : [];

    // P4② 同名先归属：新建前先按名称查「published 且未软删」的既有实体，命中则复用（不再新建），
    // 事实/证据随后挂到它上面。用于修复抽取入库时同名实体被重复新建（米醴琼/老酒汗/锅贴/麦麦酒）。
    const reusedId = await this.findSameNamePublished(dto.name);
    if (reusedId != null) return this.detail(reusedId);

    const attrs = await this.validateAttrs(category.id, dto.attrs ?? {});
    // URN 用叶子类别（wz:geo.region:永嘉），避免同名不同子类撞车（如 虹桥镇 vs 虹桥）；
    // 纯全局实体（无溯源域）用 global 前缀
    const urn = buildUrn(ds?.code ?? 'global', category.code, dto.name);

    const [dup] = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.urn, urn))
      .limit(1);
    if (dup) throw new ConflictException(`URN 已存在：${urn}`);

    const slug = dto.slug
      ? await this.assertSlugAvailable(dto.slug) // 显式 slug 必须全局唯一：URL 路径 /archive/:dataset/:slug 不区分实体类型
      : await this.ensureUniqueSlug(toSlug(dto.name));

    const created = await this.withLockRetry(() =>
      this.db.transaction(async (tx) => {
        const [ins] = await tx.insert(entities).values({
          categoryId: category.id,
          originDatasetId: dto.originDatasetId ?? null,
          urn,
          name: dto.name,
          slug,
          lede: dto.lede ?? null,
          seedSource: dto.seedSource ?? null,
          attrsJson: attrs,
          status: dto.status ?? 'draft',
          publishedAt: dto.status === 'published' ? new Date() : null,
        });
        const entityId = Number(ins.insertId);

        if (dto.aliases?.length) {
          await tx.insert(entityAliases).values(
            dto.aliases.map((alias) => ({ entityId, alias })),
          );
        }
        await this.syncAttrIndex(tx, entityId, category.id, attrs);
        return entityId;
      }),
    );

    return this.detail(created);
  }

  /**
   * P4② 同名先归属：按「完全相同名称 + published + 未软删」查既有实体，命中则返回其 id 供复用。
   * 命中多条时取 active 事实更多者，再取 active 证据更多者（与首页目录去重口径一致）。
   * 只做完全相同名称判定，不做模糊/别名匹配，避免误合并。
   */
  private async findSameNamePublished(name: string): Promise<number | null> {
    const rows = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.name, name), eq(entities.status, 'published'), isNull(entities.deletedAt)));
    if (!rows.length) return null;
    if (rows.length === 1) return Number(rows[0].id);

    const ids = rows.map((r) => Number(r.id));
    const [factRows, evRows] = await Promise.all([
      this.db
        .select({ entityId: facts.entityId, c: count() })
        .from(facts)
        .where(and(inArray(facts.entityId, ids), eq(facts.status, 'active')))
        .groupBy(facts.entityId),
      this.db
        .select({ entityId: evidences.entityId, c: count() })
        .from(evidences)
        .where(and(inArray(evidences.entityId, ids), eq(evidences.status, 'active')))
        .groupBy(evidences.entityId),
    ]);
    const factMap = new Map(factRows.map((r) => [Number(r.entityId), Number(r.c ?? 0)]));
    const evMap = new Map(evRows.map((r) => [Number(r.entityId), Number(r.c ?? 0)]));
    const ranked = ids
      .map((id) => ({ id, factCount: factMap.get(id) ?? 0, evidenceCount: evMap.get(id) ?? 0 }))
      .sort((a, b) => b.factCount - a.factCount || b.evidenceCount - a.evidenceCount);
    return ranked[0].id;
  }

  /**
   * 规则自动审批：draft 实体只要抽取到过 ≥1 条事实草稿（任意状态）即发布。
   * 事实活跃度 = 该实体在语料中真实存在的信号；复用 update() 走完整发布链路（revision/缓存）。
   */
  async autoPublish(datasetId: number | undefined, userId?: number) {
    const factDraftEnts = await this.db
      .selectDistinct({ entityId: extractionDrafts.entityId })
      .from(extractionDrafts)
      .where(eq(extractionDrafts.targetType, 'fact'));
    const ids = factDraftEnts.map((r) => r.entityId).filter((v): v is number => v != null);
    if (!ids.length) return { published: 0, candidates: 0 };

    const candidates = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(
        and(
          eq(entities.status, 'draft'),
          isNull(entities.deletedAt),
          datasetId ? inArray(entities.categoryId, await this.linkedCategoryIds(datasetId)) : undefined,
          inArray(entities.id, ids),
        ),
      );

    let published = 0;
    for (const e of candidates) {
      try {
        await this.update(e.id, { status: 'published' });
        published += 1;
      } catch {
        // 单条失败跳过（如 URN 冲突），不阻断整批
      }
    }

    await this.db.insert(auditLog).values({
      userId: userId ?? null,
      action: 'auto_publish',
      targetType: 'entity',
      targetId: null,
      afterJson: { published, candidates: candidates.length, rule: 'has_fact_draft' },
      remark: `规则自动发布 ${published}/${candidates.length} 个实体（有事实草稿）`,
    });

    return { published, candidates: candidates.length };
  }

  async update(id: number, dto: UpdateEntityDto) {
    const current = await this.findOne(id);

    const patch: Partial<typeof entities.$inferInsert> = {};
    let contentChanged = false;

    if (dto.name !== undefined && dto.name !== current.name) {
      const category = await this.categoryService.findOne(current.categoryId);
      const [dataset] = current.originDatasetId
        ? await this.db
            .select()
            .from(datasets)
            .where(eq(datasets.id, current.originDatasetId))
            .limit(1)
        : [];
      const urn = buildUrn(dataset?.code ?? 'global', category.code, dto.name);
      const [dup] = await this.db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.urn, urn))
        .limit(1);
      if (dup && dup.id !== id) throw new ConflictException(`URN 已存在：${urn}`);
      patch.urn = urn;
      patch.name = dto.name;
      contentChanged = true;
    }

    if (dto.slug !== undefined && dto.slug !== current.slug) {
      patch.slug = await this.ensureUniqueSlug(dto.slug, id);
      contentChanged = true;
    }
    if (dto.lede !== undefined && dto.lede !== current.lede) {
      patch.lede = dto.lede;
      contentChanged = true;
    }
    if (dto.seedSource !== undefined) patch.seedSource = dto.seedSource;

    if (dto.attrs !== undefined) {
      const attrs = await this.validateAttrs(current.categoryId, dto.attrs);
      patch.attrsJson = attrs;
      contentChanged = true;
    }

    if (dto.status !== undefined && dto.status !== current.status) {
      patch.status = dto.status;
      patch.publishedAt = dto.status === 'published' ? new Date() : current.publishedAt;
      contentChanged = true;
    }

    const nextAttrs = (patch.attrsJson ?? current.attrsJson ?? {}) as Record<string, unknown>;

    await this.withLockRetry(() =>
      this.db.transaction(async (tx) => {
        if (Object.keys(patch).length) {
          const nextRevision = contentChanged ? current.revision + 1 : current.revision;
          await tx
            .update(entities)
            .set({ ...patch, revision: nextRevision })
            .where(eq(entities.id, id));
        }
        if (dto.aliases) {
          await tx.delete(entityAliases).where(eq(entityAliases.entityId, id));
          if (dto.aliases.length) {
            await tx
              .insert(entityAliases)
              .values(dto.aliases.map((alias) => ({ entityId: id, alias })));
          }
        }
        if (patch.attrsJson) await this.syncAttrIndex(tx, id, current.categoryId, nextAttrs);
      }),
    );

    return this.detail(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.db.update(entities).set({ deletedAt: new Date() }).where(eq(entities.id, id));
    return { deleted: true };
  }

  // ---------------------------------------------------------------- 别名

  async addAlias(id: number, alias: string, source?: string | null) {
    await this.findOne(id);
    await this.db
      .insert(entityAliases)
      .values({ entityId: id, alias, source: source ?? null })
      .onDuplicateKeyUpdate({ set: { alias } });
    return this.listAliases(id);
  }

  async listAliases(id: number) {
    return this.db.select().from(entityAliases).where(eq(entityAliases.entityId, id));
  }

  async removeAlias(id: number, aliasId: number) {
    await this.db
      .delete(entityAliases)
      .where(and(eq(entityAliases.entityId, id), eq(entityAliases.id, aliasId)));
    return this.listAliases(id);
  }

  // ---------------------------------------------------------------- 内部

  private async validateAttrs(categoryId: number, attrs: Record<string, unknown>) {
    const { schema } = await this.fieldDefService.buildValidator(categoryId);
    const parsed = schema.safeParse(attrs);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ATTRS_INVALID',
        message: '自定义字段校验失败',
        errors: parsed.error.flatten(),
      });
    }
    return parsed.data as Record<string, unknown>;
  }

  /**
   * MySQL 死锁自动重试。
   * 并发建/改实体时，entity_attr_index 唯一索引（uq_attr_entity_key）同页多行插入
   * 容易触发死锁（ER_LOCK_DEADLOCK, errno 1213），被选为牺牲者的事务整体回滚，
   * 这里在事务级重试（退避递增 + 抖动），通常一次重试即可成功。
   */
  private async withLockRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i += 1) {
      try {
        return await fn();
      } catch (e) {
        const err = e as { errno?: number; code?: string; message?: string };
        const isDeadlock =
          err?.errno === 1213 ||
          err?.code === 'ER_LOCK_DEADLOCK' ||
          /deadlock/i.test(err?.message ?? '');
        if (!isDeadlock) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 50 * (i + 1) + Math.random() * 50));
      }
    }
    throw lastErr;
  }

  /** searchable 字段冗余到索引表，避免列表筛选扫 JSON */
  private async syncAttrIndex(
    tx: Pick<Db, 'delete' | 'insert'>,
    entityId: number,
    categoryId: number,
    attrs: Record<string, unknown>,
  ) {
    const fields = await this.fieldDefService.resolve(categoryId);
    const searchable = fields.filter((f) => f.searchable);
    if (!searchable.length) return;

    await tx.delete(entityAttrIndex).where(eq(entityAttrIndex.entityId, entityId));
    const rows = searchable
      .map((f) => {
        const value = attrs[f.key];
        if (value === null || value === undefined) return null;
        const asString = Array.isArray(value) ? value.join(',') : String(value);
        const asNumber = Number(value);
        return {
          entityId,
          fieldKey: f.key,
          valueVarchar: asString.slice(0, 255),
          valueNumber: Number.isFinite(asNumber) ? String(asNumber) : null,
          valueDate: /^\d{4}-\d{2}-\d{2}$/.test(asString) ? asString : null,
        };
      })
      .filter(Boolean) as (typeof entityAttrIndex.$inferInsert)[];

    if (rows.length) await tx.insert(entityAttrIndex).values(rows);
  }

  private async ensureUniqueSlug(base: string, excludeId?: number) {
    let slug = base;
    for (let i = 1; i < 50; i += 1) {
      const [dup] = await this.db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.slug, slug))
        .limit(1);
      if (!dup || (excludeId && dup.id === excludeId)) return slug;
      slug = `${base}-${i}`;
    }
    return `${base}-${Date.now()}`;
  }

  /** 显式指定 slug 时的唯一性校验（未删除的实体中全局唯一，URL 路径语义） */
  private async assertSlugAvailable(slug: string) {
    const [dup] = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(and(eq(entities.slug, slug), isNull(entities.deletedAt)))
      .limit(1);
    if (dup) throw new ConflictException(`slug 已被实体「${dup.name}」(id=${dup.id}) 占用：${slug}`);
    return slug;
  }
}
