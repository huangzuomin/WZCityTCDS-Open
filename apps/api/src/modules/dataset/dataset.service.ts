import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { categories, datasetCategories, datasets, entities, factDimensions } from '../../db/schema';
import {
  CreateDatasetDto,
  ListDatasetQuery,
  SyncDatasetCategoriesDto,
  UpdateDatasetDto,
} from './dataset.dto';

@Injectable()
export class DatasetService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** 某语料域关联的全部全局分类 id */
  async linkedCategoryIds(datasetId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: datasetCategories.categoryId })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    return rows.map((r) => Number(r.id));
  }

  async list(query: ListDatasetQuery) {
    const where = and(
      query.status ? eq(datasets.status, query.status) : undefined,
      query.keyword
        ? or(like(datasets.name, `%${query.keyword}%`), like(datasets.code, `%${query.keyword}%`))
        : undefined,
    );

    const [{ value: total }] = await this.db.select({ value: count() }).from(datasets).where(where);

    const items = await this.db
      .select()
      .from(datasets)
      .where(where)
      .orderBy(asc(datasets.sort), desc(datasets.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: number) {
    const [row] = await this.db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
    if (!row) throw new NotFoundException('语料域不存在');
    return row;
  }

  async create(dto: CreateDatasetDto) {
    const [exist] = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(eq(datasets.code, dto.code))
      .limit(1);
    if (exist) throw new ConflictException(`code 已存在：${dto.code}`);

    const [created] = await this.db.insert(datasets).values({
      code: dto.code,
      name: dto.name,
      description: dto.description ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? 'active',
    });
    return this.findOne(Number(created.insertId));
  }

  async update(id: number, dto: UpdateDatasetDto) {
    await this.findOne(id);
    await this.db.update(datasets).set({ ...dto, updatedAt: new Date() }).where(eq(datasets.id, id));
    return this.findOne(id);
  }

  /** 软删除：有关联分类/实体时拒绝物理删除，仅归档 */
  async remove(id: number) {
    await this.findOne(id);
    const catIds = await this.linkedCategoryIds(id);
    const [{ value: entityCount }] = await this.db
      .select({ value: count() })
      .from(entities)
      .where(catIds.length ? inArray(entities.categoryId, catIds) : sql`1 = 0`);
    const [{ value: linkCount }] = await this.db
      .select({ value: count() })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, id));

    if (entityCount > 0 || linkCount > 0) {
      await this.db.update(datasets).set({ status: 'archived' }).where(eq(datasets.id, id));
      return { deleted: false, archived: true, entityCount, linkCount };
    }
    await this.db.delete(datasets).where(eq(datasets.id, id));
    return { deleted: true, archived: false };
  }

  /** 概览：给仪表盘用（数量走预聚合，避免大表 COUNT 全扫） */
  async stats(id: number) {
    const catIds = await this.linkedCategoryIds(id);
    const [{ value: categoryCount }] = await this.db
      .select({ value: count() })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, id));
    const [{ value: entityCount }] = await this.db
      .select({ value: count() })
      .from(entities)
      .where(catIds.length ? inArray(entities.categoryId, catIds) : sql`1 = 0`);
    return { datasetId: id, categoryCount, entityCount };
  }

  async ping() {
    const [row] = await this.db.select({ now: sql<string>`now()` }).from(datasets).limit(1);
    return row ?? null;
  }

  // ---------------------------------------------------------------- 关联分类（dataset_category）

  /** 某语料域关联的分类清单（含启用维度 id + 维度信息，供数据集页「关联分类」面板） */
  async linkedCategories(datasetId: number) {
    const links = await this.db
      .select({
        id: datasetCategories.id,
        datasetId: datasetCategories.datasetId,
        categoryId: datasetCategories.categoryId,
        dimIds: datasetCategories.dimIds,
        homeShow: datasetCategories.homeShow,
        sort: datasetCategories.sort,
        code: categories.code,
        name: categories.name,
        description: categories.description,
        parentId: categories.parentId,
        status: categories.status,
      })
      .from(datasetCategories)
      .innerJoin(categories, eq(datasetCategories.categoryId, categories.id))
      .where(eq(datasetCategories.datasetId, datasetId))
      .orderBy(asc(datasetCategories.sort), asc(datasetCategories.categoryId));

    const dimIds = [...new Set(links.flatMap((l) => l.dimIds ?? []))];
    const dims = dimIds.length
      ? await this.db
          .select({ id: factDimensions.id, code: factDimensions.code, name: factDimensions.name })
          .from(factDimensions)
          .where(inArray(factDimensions.id, dimIds))
      : [];
    const dimById = new Map(dims.map((d) => [Number(d.id), d]));
    return {
      links: links.map((l) => ({
        ...l,
        dims: (l.dimIds ?? [])
          .map((id) => dimById.get(Number(id)))
          .filter((d): d is NonNullable<typeof d> => !!d),
      })),
      allDims: await this.db
        .select({ id: factDimensions.id, code: factDimensions.code, name: factDimensions.name })
        .from(factDimensions)
        .orderBy(asc(factDimensions.sort)),
    };
  }

  /** 关联一个全局分类到语料域（可带启用维度子集） */
  async linkCategory(datasetId: number, categoryId: number, dimIds?: number[] | null) {
    await this.findOne(datasetId);
    const [cat] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!cat) throw new NotFoundException('分类不存在');
    const [max] = await this.db
      .select({ m: sql<number>`COALESCE(MAX(${datasetCategories.sort}), -1)` })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    await this.db
      .insert(datasetCategories)
      .values({
        datasetId,
        categoryId,
        dimIds: dimIds ?? [],
        sort: (max?.m ?? -1) + 1,
      })
      .onDuplicateKeyUpdate({ set: { dimIds: dimIds ?? [] } });
    return this.linkedCategories(datasetId);
  }

  /** 更新某库关联分类的启用维度子集 / 排序 / 首页展示数量 */
  async updateLinkedCategory(datasetId: number, categoryId: number, body: { dimIds?: number[]; sort?: number; homeShow?: number }) {
    await this.findOne(datasetId);
    await this.db
      .update(datasetCategories)
      .set({
        ...(body.dimIds !== undefined ? { dimIds: body.dimIds } : {}),
        ...(body.sort !== undefined ? { sort: body.sort } : {}),
        ...(body.homeShow !== undefined ? { homeShow: Math.max(0, Math.floor(Number(body.homeShow) || 0)) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(datasetCategories.datasetId, datasetId), eq(datasetCategories.categoryId, categoryId)));
    return this.linkedCategories(datasetId);
  }

  /**
   * 批量同步关联分类（「配置首页」/「关联分类」一次保存）：
   * 以请求中的 links 为准做整表 diff —— 新增的插入、缺失的删除、共有的按提供的字段更新。
   * 字段缺省（dimIds / homeShow 未传）时不覆盖已有值，避免两个面板互相清空对方数据。
   */
  async syncCategories(datasetId: number, dto: SyncDatasetCategoriesDto) {
    await this.findOne(datasetId);

    // 校验分类存在
    const ids = [...new Set(dto.links.map((l) => l.categoryId))];
    const cats = ids.length
      ? await this.db.select({ id: categories.id }).from(categories).where(inArray(categories.id, ids))
      : [];
    const known = new Set(cats.map((c) => Number(c.id)));
    const missing = ids.find((id) => !known.has(id));
    if (missing) throw new NotFoundException(`分类不存在：${missing}`);

    const existing = await this.db
      .select({ categoryId: datasetCategories.categoryId, sort: datasetCategories.sort })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    const existingIds = new Set(existing.map((e) => Number(e.categoryId)));
    const wantIds = new Set(dto.links.map((l) => l.categoryId));

    let maxSort = existing.reduce((m, e) => Math.max(m, Number(e.sort)), -1);

    // 1) 新增
    for (const l of dto.links) {
      if (!existingIds.has(l.categoryId)) {
        await this.db.insert(datasetCategories).values({
          datasetId,
          categoryId: l.categoryId,
          dimIds: l.dimIds ?? [],
          homeShow: l.homeShow ?? 0,
          sort: ++maxSort,
        });
      }
    }
    // 2) 更新（仅提供的字段）
    for (const l of dto.links) {
      if (!existingIds.has(l.categoryId)) continue;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (l.dimIds !== undefined) set.dimIds = l.dimIds;
      if (l.homeShow !== undefined) set.homeShow = Math.max(0, Math.floor(Number(l.homeShow) || 0));
      if (Object.keys(set).length > 1) {
        await this.db
          .update(datasetCategories)
          .set(set)
          .where(and(eq(datasetCategories.datasetId, datasetId), eq(datasetCategories.categoryId, l.categoryId)));
      }
    }
    // 3) 删除（请求中不再关联的）
    for (const e of existing) {
      if (!wantIds.has(Number(e.categoryId))) {
        await this.db
          .delete(datasetCategories)
          .where(and(eq(datasetCategories.datasetId, datasetId), eq(datasetCategories.categoryId, e.categoryId)));
      }
    }

    return this.linkedCategories(datasetId);
  }

  /** 取消关联分类 */
  async unlinkCategory(datasetId: number, categoryId: number) {
    await this.findOne(datasetId);
    await this.db
      .delete(datasetCategories)
      .where(and(eq(datasetCategories.datasetId, datasetId), eq(datasetCategories.categoryId, categoryId)));
    return this.linkedCategories(datasetId);
  }
}
