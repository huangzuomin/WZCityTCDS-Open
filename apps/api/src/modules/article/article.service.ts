import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { linkedCategoryIds } from '../../common/dataset-categories';
import {
  articleHits,
  datasets,
  entities,
  entityAliases,
  entityArticles,
  sourceArticleBodies,
  sourceArticles,
} from '../../db/schema';
import { sha256 } from '../../common/crypto';
import { charNGrams, jaccard, SLICE_RULE, sliceBody } from '../../common/text';
import { AhoCorasick } from '../../common/aho-corasick';
import type {
  ImportArticlesDto,
  ListArticleQuery,
  UpdateArticleDto,
} from './article.dto';

const BATCH_SIZE = 1000;

interface PreparedItem {
  title: string;
  url: string;
  urlHash: string;
  contentHash: string;
  sourceOrg: string | null;
  sourceSite: string | null;
  publishedAt: string | null;
  externalId: string | null;
  quality: 'A' | 'B' | 'C' | 'D';
  bodyRaw: string;
  bodySlice: string;
}

@Injectable()
export class ArticleService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ---------------------------------------------------------------- 列表 / 详情

  async list(query: ListArticleQuery) {
    const where = and(
      query.datasetId ? eq(sourceArticles.datasetId, query.datasetId) : undefined,
      query.batch ? eq(sourceArticles.batch, query.batch) : undefined,
      query.status ? eq(sourceArticles.status, query.status) : undefined,
      query.keyword ? like(sourceArticles.title, `%${query.keyword}%`) : undefined,
    );

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(sourceArticles)
      .where(where);

    const rows = await this.db
      .select({
        id: sourceArticles.id,
        datasetId: sourceArticles.datasetId,
        title: sourceArticles.title,
        url: sourceArticles.url,
        sourceOrg: sourceArticles.sourceOrg,
        sourceSite: sourceArticles.sourceSite,
        publishedAt: sourceArticles.publishedAt,
        batch: sourceArticles.batch,
        quality: sourceArticles.quality,
        status: sourceArticles.status,
        bodyVersion: sourceArticles.bodyVersion,
        contentHash: sourceArticles.contentHash,
        createdAt: sourceArticles.createdAt,
      })
      .from(sourceArticles)
      .where(where)
      .orderBy(desc(sourceArticles.publishedAt), desc(sourceArticles.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows, total, page: query.page, pageSize: query.pageSize };
  }

  async listByEntity(entityId: number, query: { page?: number; pageSize?: number } = {}) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const rows = await this.db
      .select({
        id: sourceArticles.id,
        title: sourceArticles.title,
        url: sourceArticles.url,
        sourceOrg: sourceArticles.sourceOrg,
        publishedAt: sourceArticles.publishedAt,
        batch: sourceArticles.batch,
        role: entityArticles.role,
        hitCount: articleHits.hitCount,
      })
      .from(entityArticles)
      .innerJoin(sourceArticles, eq(entityArticles.articleId, sourceArticles.id))
      .leftJoin(
        articleHits,
        and(eq(articleHits.articleId, sourceArticles.id), eq(articleHits.entityId, entityId)),
      )
      .where(eq(entityArticles.entityId, entityId))
      .orderBy(desc(sourceArticles.publishedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows, total: rows.length, page, pageSize };
  }

  async detail(id: number) {
    const [row] = await this.db
      .select()
      .from(sourceArticles)
      .where(eq(sourceArticles.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('文章不存在');

    const [body] = await this.db
      .select()
      .from(sourceArticleBodies)
      .where(eq(sourceArticleBodies.articleId, id))
      .limit(1);

    const hits = await this.db
      .select({
        entityId: articleHits.entityId,
        hitCount: articleHits.hitCount,
        firstOffset: articleHits.firstOffset,
        matchedAlias: articleHits.matchedAlias,
        entityName: entities.name,
      })
      .from(articleHits)
      .leftJoin(entities, eq(articleHits.entityId, entities.id))
      .where(eq(articleHits.articleId, id));

    return { ...row, body: body ?? null, hits };
  }

  async body(id: number) {
    const [row] = await this.db
      .select()
      .from(sourceArticleBodies)
      .where(eq(sourceArticleBodies.articleId, id))
      .limit(1);
    if (!row) throw new NotFoundException('正文不存在');
    return row;
  }

  async update(id: number, dto: UpdateArticleDto) {
    await this.detail(id);
    await this.db.update(sourceArticles).set(dto as never).where(eq(sourceArticles.id, id));
    return this.detail(id);
  }

  async batchTag(dto: { ids: number[]; batch?: 'baseline' | 'incremental'; status?: string }) {
    const patch: Partial<typeof sourceArticles.$inferInsert> = {};
    if (dto.batch) patch.batch = dto.batch;
    if (dto.status) patch.status = dto.status as 'raw' | 'cleaned' | 'archived';
    if (!Object.keys(patch).length) return { updated: 0 };
    const res = (await this.db
      .update(sourceArticles)
      .set(patch)
      .where(inArray(sourceArticles.id, dto.ids))) as unknown as { affectedRows: number };
    return { updated: Number(res.affectedRows ?? 0) };
  }

  async stats(datasetId?: number) {
    const where = datasetId ? eq(sourceArticles.datasetId, datasetId) : undefined;
    const [row] = await this.db
      .select({
        total: count(),
        baseline: sql<number>`SUM(CASE WHEN ${sourceArticles.batch} = 'baseline' THEN 1 ELSE 0 END)`,
        incremental: sql<number>`SUM(CASE WHEN ${sourceArticles.batch} = 'incremental' THEN 1 ELSE 0 END)`,
      })
      .from(sourceArticles)
      .where(where);
    return {
      datasetId: datasetId ?? null,
      total: Number(row?.total ?? 0),
      baseline: Number(row?.baseline ?? 0),
      incremental: Number(row?.incremental ?? 0),
    };
  }

  // ---------------------------------------------------------------- 导入

  /**
   * 语料入库：批量 INSERT（每批 1000 条），URL 哈希去重 + 正文哈希二次去重
   * （同一篇文章可能有多个 URL，只靠 URL 去重会漏），正文垂直拆分到 source_article_body。
   */
  async importArticles(dto: ImportArticlesDto) {
    const [dataset] = await this.db
      .select()
      .from(datasets)
      .where(eq(datasets.id, dto.datasetId))
      .limit(1);
    if (!dataset) throw new BadRequestException('语料域不存在');

    const prepared = this.prepare(dto);
    const existing = await this.findExisting(prepared);

    let fresh = prepared.filter(
      (p) => !existing.urlHashes.has(p.urlHash) && !existing.contentHashes.has(p.contentHash),
    );

    // 近似重复检测（可选）：抓"改几个字/改一段"的转载
    let fuzzyDropped = 0;
    const fuzzyExamples: string[] = [];
    if (dto.fuzzyDedupe?.enabled) {
      const r = await this.applyFuzzyDedupe(dto, fresh, dto.fuzzyDedupe);
      fresh = r.fresh;
      fuzzyDropped = r.dropped;
      fuzzyExamples.push(...r.examples);
    }

    let inserted = 0;
    const idPairs: { id: number; item: PreparedItem }[] = [];

    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      const chunk = fresh.slice(i, i + BATCH_SIZE);
      await this.db.insert(sourceArticles).values(
        chunk.map((p) => ({
          datasetId: dto.datasetId,
          sourceSite: p.sourceSite,
          sourceOrg: p.sourceOrg,
          title: p.title,
          url: p.url,
          urlHash: p.urlHash,
          externalId: p.externalId,
          publishedAt: p.publishedAt,
          batch: dto.batch,
          contentHash: p.contentHash,
          bodyVersion: 1,
          quality: p.quality,
          status: 'cleaned' as const,
          fetchedAt: new Date(),
        })),
      );
      // 回查拿到自增 id（不依赖驱动返回的 insertId，批量插入更稳）
      const rows = await this.db
        .select({ id: sourceArticles.id, urlHash: sourceArticles.urlHash })
        .from(sourceArticles)
        .where(inArray(sourceArticles.urlHash, chunk.map((c) => c.urlHash)));
      const byHash = new Map(chunk.map((c) => [c.urlHash, c]));
      for (const r of rows) {
        const item = byHash.get(r.urlHash);
        if (item) idPairs.push({ id: r.id, item });
      }
      inserted += rows.length;
    }

    // 正文垂直拆分：列表查询永远不触碰大字段
    for (let i = 0; i < idPairs.length; i += BATCH_SIZE) {
      const chunk = idPairs.slice(i, i + BATCH_SIZE);
      await this.db.insert(sourceArticleBodies).values(
        chunk.map(({ id, item }) => ({
          articleId: id,
          bodyRaw: item.bodyRaw,
          bodySlice: item.bodySlice,
          sliceRule: SLICE_RULE,
        })),
      );
    }

    let hitRows = 0;
    if (dto.buildHits && idPairs.length) {
      hitRows = await this.buildHitsFor(dto.datasetId, idPairs);
    }

    return {
      datasetId: dto.datasetId,
      received: dto.items.length,
      dedupedByTitleDay: prepared.titleDayDropped,
      duplicateUrl: existing.urlHashes.size,
      duplicateContent: existing.contentHashes.size,
      dedupedByFuzzy: fuzzyDropped,
      fuzzyExamples,
      inserted,
      insertedIds: idPairs.map((p) => p.id),
      hits: hitRows,
    };
  }

  private prepare(dto: ImportArticlesDto) {
    const seenUrl = new Set<string>();
    const seenContent = new Set<string>();
    const seenTitleDay = new Set<string>();
    const rows: PreparedItem[] = [];
    let titleDayDropped = 0;

    for (const raw of dto.items) {
      const url = raw.url.trim();
      const urlHash = sha256(url);
      if (seenUrl.has(urlHash)) continue;

      const bodyRaw = String(raw.text ?? '');
      const bodySlice = sliceBody(bodyRaw);
      const contentHash = sha256(bodySlice);

      // 正文去重：URL 去重盲区（同文多 URL）必须靠 content_hash 再兜一次
      if (seenContent.has(contentHash)) continue;

      const title = raw.title.trim();
      if (dto.dedupeTitleDay) {
        const key = `${title.replace(/\s+/g, '')}|${(raw.publishedAt ?? '').slice(0, 10)}`;
        if (seenTitleDay.has(key)) {
          titleDayDropped += 1;
          continue;
        }
        seenTitleDay.add(key);
      }

      seenUrl.add(urlHash);
      if (contentHash) seenContent.add(contentHash);

      rows.push({
        title,
        url,
        urlHash,
        contentHash,
        sourceOrg: raw.sourceOrg?.trim() || null,
        sourceSite: raw.sourceSite?.trim() || null,
        publishedAt: this.normalizeDate(raw.publishedAt),
        externalId: raw.externalId?.trim() || null,
        quality: raw.quality ?? 'B',
        bodyRaw,
        bodySlice,
      });
    }

    return Object.assign(rows, { titleDayDropped });
  }

  private async findExisting(rows: PreparedItem[]) {
    const urlHashes = new Set<string>();
    const contentHashes = new Set<string>();
    if (!rows.length) return { urlHashes, contentHashes };

    const chunkIn = async (values: string[], column: typeof sourceArticles.urlHash | typeof sourceArticles.contentHash, sink: Set<string>) => {
      for (let i = 0; i < values.length; i += BATCH_SIZE) {
        const chunk = values.slice(i, i + BATCH_SIZE);
        const found = await this.db
          .select({ v: column })
          .from(sourceArticles)
          .where(inArray(column, chunk));
        for (const r of found) if (r.v) sink.add(r.v);
      }
    };

    await chunkIn(rows.map((r) => r.urlHash), sourceArticles.urlHash, urlHashes);
    await chunkIn(
      rows.map((r) => r.contentHash).filter(Boolean),
      sourceArticles.contentHash,
      contentHashes,
    );
    return { urlHashes, contentHashes };
  }

  /**
   * 近似重复检测：与最近 lookbackDays 天已入库的存量比对。
   * 判定：正文 3-gram Jaccard ≥ bodyThreshold 且 标题 2-gram Jaccard ≥ titleThreshold
   * （标题条件防"模板化正文 + 不同标题"误杀）。零 LLM 成本。
   */
  private async applyFuzzyDedupe(
    dto: ImportArticlesDto,
    fresh: PreparedItem[],
    cfg: NonNullable<ImportArticlesDto['fuzzyDedupe']>,
  ): Promise<{ fresh: PreparedItem[]; dropped: number; examples: string[] }> {
    const bodyThreshold = cfg.bodyThreshold ?? 0.8;
    const titleThreshold = cfg.titleThreshold ?? 0.9;
    if (!fresh.length || !(cfg.lookbackDays ?? 7)) {
      return { fresh, dropped: 0, examples: [] };
    }

    const since = new Date(Date.now() - (cfg.lookbackDays ?? 7) * 86_400_000);
    const libRows = await this.db
      .select({
        id: sourceArticles.id,
        title: sourceArticles.title,
        bodySlice: sourceArticleBodies.bodySlice,
      })
      .from(sourceArticles)
      .innerJoin(sourceArticleBodies, eq(sourceArticleBodies.articleId, sourceArticles.id))
      .where(and(eq(sourceArticles.datasetId, dto.datasetId), sql`${sourceArticles.createdAt} >= ${since}`));

    // 库内 n-gram 倒排：gram -> 行索引（候选召回，不做全量两两比对）
    const libGrams: Set<string>[] = libRows.map((r) => charNGrams(r.bodySlice, 3));
    const inv = new Map<string, number[]>();
    libGrams.forEach((gs, i) => {
      for (const g of gs) {
        const arr = inv.get(g);
        if (arr) arr.push(i);
        else inv.set(g, [i]);
      }
    });

    const kept: PreparedItem[] = [];
    const examples: string[] = [];
    let dropped = 0;

    for (const p of fresh) {
      const bodyGrams = charNGrams(p.bodySlice, 3);
      const candIdx = new Set<number>();
      let gCount = 0;
      for (const g of bodyGrams) {
        const hits = inv.get(g);
        if (hits) for (const i of hits) candIdx.add(i);
        if (++gCount >= 300) break; // 子集召回，防长文退化
      }

      let dupTitle: string | null = null;
      for (const i of candIdx) {
        if (jaccard(bodyGrams, libGrams[i]) < bodyThreshold) continue;
        if (jaccard(charNGrams(p.title, 2), charNGrams(libRows[i].title, 2)) < titleThreshold) continue;
        dupTitle = libRows[i].title;
        break;
      }

      if (dupTitle) {
        dropped += 1;
        if (examples.length < 5) examples.push(`${p.title} ≈ ${dupTitle}`);
      } else {
        kept.push(p);
      }
    }

    return { fresh: kept, dropped, examples };
  }

  // ---------------------------------------------------------------- 召回倒排表

  /** 用实体名 + 别名构建 AC 自动机，扫一遍正文产出 article_hit */
  async buildHitsFor(
    datasetId: number,
    pairs: { id: number; item: { bodySlice: string } }[],
  ): Promise<number> {
    if (!pairs.length) return 0;

    const entityRows = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(
        and(
          inArray(entities.categoryId, await linkedCategoryIds(this.db, datasetId)),
          isNull(entities.deletedAt),
        ),
      );
    if (!entityRows.length) return 0;

    const aliasRows = await this.db
      .select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
      .from(entityAliases)
      .where(inArray(entityAliases.entityId, entityRows.map((e) => e.id)));

    const ac = new AhoCorasick();
    for (const e of entityRows) ac.addPattern(e.name, e.id);
    for (const a of aliasRows) ac.addPattern(a.alias, a.entityId);
    ac.build();

    const hitValues: (typeof articleHits.$inferInsert)[] = [];
    const linkValues: (typeof entityArticles.$inferInsert)[] = [];

    for (const { id, item } of pairs) {
      const agg = ac.summarize(item.bodySlice || '');
      for (const [entityId, info] of agg) {
        hitValues.push({
          entityId,
          articleId: id,
          hitCount: info.hitCount,
          firstOffset: info.firstOffset,
          matchedAlias: info.matchedAlias,
        });
        linkValues.push({ entityId, articleId: id, role: 'reference', isRelevant: true });
      }
    }

    for (let i = 0; i < hitValues.length; i += BATCH_SIZE) {
      const chunk = hitValues.slice(i, i + BATCH_SIZE);
      await this.db
        .insert(articleHits)
        .values(chunk)
        .onDuplicateKeyUpdate({
          set: {
            hitCount: sql`VALUES(${articleHits.hitCount})`,
            firstOffset: sql`VALUES(${articleHits.firstOffset})`,
            matchedAlias: sql`VALUES(${articleHits.matchedAlias})`,
          },
        });
    }
    for (let i = 0; i < linkValues.length; i += BATCH_SIZE) {
      const chunk = linkValues.slice(i, i + BATCH_SIZE);
      await this.db.insert(entityArticles).values(chunk).onDuplicateKeyUpdate({ set: { isRelevant: true } });
    }

    return hitValues.length;
  }

  /** 全量重建某个语料域的倒排表（实体/别名变更后调用） */
  async reindex(datasetId: number) {
    await this.db
      .delete(articleHits)
      .where(
        sql`${articleHits.articleId} IN (SELECT id FROM ${sourceArticles} WHERE dataset_id = ${datasetId})`,
      );

    const articleRows = await this.db
      .select({ id: sourceArticles.id })
      .from(sourceArticles)
      .where(eq(sourceArticles.datasetId, datasetId));

    const bodyRows = await this.db
      .select({ articleId: sourceArticleBodies.articleId, bodySlice: sourceArticleBodies.bodySlice })
      .from(sourceArticleBodies)
      .where(
        inArray(
          sourceArticleBodies.articleId,
          articleRows.map((a) => a.id),
        ),
      );

    const byId = new Map(bodyRows.map((b) => [b.articleId, b.bodySlice ?? '']));
    let total = 0;
    for (let i = 0; i < articleRows.length; i += BATCH_SIZE) {
      const chunk = articleRows.slice(i, i + BATCH_SIZE).map((a) => ({
        id: a.id,
        item: { bodySlice: byId.get(a.id) ?? '' },
      }));
      total += await this.buildHitsFor(datasetId, chunk);
    }
    return { datasetId, articles: articleRows.length, hits: total };
  }

  /** 切片规则变更：bodyVersion+1，所有旧证据标为待复核 */
  async reslice(datasetId: number) {
    const rows = await this.db
      .select({ id: sourceArticles.id, bodyVersion: sourceArticles.bodyVersion })
      .from(sourceArticles)
      .where(eq(sourceArticles.datasetId, datasetId));
    for (const r of rows) {
      await this.db
        .update(sourceArticles)
        .set({ bodyVersion: (r.bodyVersion ?? 1) + 1 })
        .where(eq(sourceArticles.id, r.id));
    }
    return { datasetId, articles: rows.length };
  }

  async coverage(datasetId: number) {
    const [row] = await this.db
      .select({
        articles: count(),
        earliest: sql<string>`MIN(${sourceArticles.publishedAt})`,
        latest: sql<string>`MAX(${sourceArticles.publishedAt})`,
      })
      .from(sourceArticles)
      .where(eq(sourceArticles.datasetId, datasetId));

    const [hit] = await this.db
      .select({ linked: sql<number>`COUNT(DISTINCT ${articleHits.articleId})` })
      .from(articleHits);

    return {
      datasetId,
      articles: Number(row?.articles ?? 0),
      earliest: row?.earliest ?? null,
      latest: row?.latest ?? null,
      linkedArticles: Number(hit?.linked ?? 0),
    };
  }

  private normalizeDate(input?: string | null): string | null {
    if (!input) return null;
    const m = String(input).match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (!m) return null;
    const pad = (v: string) => v.padStart(2, '0');
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  }
}
