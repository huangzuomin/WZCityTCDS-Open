import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  datasets,
  entities,
  evidenceEntities,
  evidences as evidence,
  factEvidences,
  facts,
  sourceArticleBodies,
  sourceArticles,
} from '../../db/schema';
import { buildEvidenceCode, codeSeq } from '@ssot/shared';
import { shortHash, spanHash } from '../../common/crypto';
import { locateQuote } from '../../common/text';
import type {
  CreateEvidenceDto,
  ListEvidenceQuery,
  UpdateEvidenceDto,
} from './evidence.dto';

/** 事务里可复用的执行器（this.db 或交易 tx 都可满足这些操作） */
type TxDb = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

@Injectable()
export class EvidenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(query: ListEvidenceQuery) {
    const where = and(
      query.entityId ? eq(evidence.entityId, query.entityId) : undefined,
      query.articleId ? eq(evidence.articleId, query.articleId) : undefined,
      query.status ? eq(evidence.status, query.status) : undefined,
      query.verifyStatus ? eq(evidence.verifyStatus, query.verifyStatus) : undefined,
      query.batch ? eq(evidence.batch, query.batch) : undefined,
      query.keyword ? like(evidence.quote, `%${query.keyword}%`) : undefined,
    );

    const [{ value: total }] = await this.db.select({ value: count() }).from(evidence).where(where);
    const items = await this.db
      .select()
      .from(evidence)
      .where(where)
      .orderBy(desc(evidence.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: items.map((e) => ({ ...e, spanShort: shortHash(e.spanHash) })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(id: number) {
    const [row] = await this.db.select().from(evidence).where(eq(evidence.id, id)).limit(1);
    if (!row) throw new NotFoundException('证据不存在');
    return { ...row, spanShort: shortHash(row.spanHash) };
  }

  /** 证据链：本实体「现行(active)/待仲裁/被替代(superseded)」事实通过 fact_evidence 引用的证据（去重）。
   *  一条证据可被多实体复用，故不再按 evidence.entity_id 过滤；每条附带归属实体(evidence_entity→entity)。
   *  返回字段在原有基础上新增 `entities: [{id,name,slug}]`。 */
  async chain(entityId: number) {
    const rows = await this.db
      .selectDistinct({
        id: evidence.id,
        code: evidence.code,
        quote: evidence.quote,
        spanStart: evidence.spanStart,
        spanEnd: evidence.spanEnd,
        spanHash: evidence.spanHash,
        assetUrn: evidence.assetUrn,
        sourceOrg: evidence.sourceOrg,
        materialTitle: evidence.materialTitle,
        sourceUrl: evidence.sourceUrl,
        publishedAt: evidence.publishedAt,
        qualityGrade: evidence.qualityGrade,
        verifyStatus: evidence.verifyStatus,
        verifyDetail: evidence.verifyDetail,
        batch: evidence.batch,
        bodyVersion: evidence.bodyVersion,
        articleId: evidence.articleId,
        articleUrl: sourceArticles.url,
        articleTitle: sourceArticles.title,
      })
      .from(evidence)
      .innerJoin(factEvidences, eq(factEvidences.evidenceId, evidence.id))
      .innerJoin(
        facts,
        and(
          eq(facts.id, factEvidences.factId),
          eq(facts.entityId, entityId),
          inArray(facts.status, ['active', 'pending_arbitration', 'superseded']),
        ),
      )
      .leftJoin(sourceArticles, eq(evidence.articleId, sourceArticles.id))
      .where(eq(evidence.status, 'active'))
      .orderBy(evidence.id);

    // 归属实体（evidence_entity → entity），按证据 id 聚合
    const evIds = rows.map((r) => r.id);
    const entRows = evIds.length
      ? await this.db
          .select({
            evidenceId: evidenceEntities.evidenceId,
            id: entities.id,
            name: entities.name,
            slug: entities.slug,
            role: evidenceEntities.role,
          })
          .from(evidenceEntities)
          .innerJoin(entities, eq(entities.id, evidenceEntities.entityId))
          .where(inArray(evidenceEntities.evidenceId, evIds))
      : [];
    const entByEv = new Map<number, { id: number; name: string; slug: string | null; role: string }[]>();
    for (const r of entRows) {
      const list = entByEv.get(Number(r.evidenceId)) ?? [];
      list.push({ id: Number(r.id), name: r.name, slug: r.slug, role: r.role });
      entByEv.set(Number(r.evidenceId), list);
    }

    return rows.map((r) => ({
      ...r,
      spanShort: shortHash(r.spanHash ?? ''),
      entities: entByEv.get(Number(r.id)) ?? [],
    }));
  }

  async create(dto: CreateEvidenceDto, userId?: number) {
    const [article] = await this.db
      .select()
      .from(sourceArticles)
      .where(eq(sourceArticles.id, dto.articleId))
      .limit(1);
    if (!article) throw new NotFoundException('文章不存在');

    const [body] = await this.db
      .select()
      .from(sourceArticleBodies)
      .where(eq(sourceArticleBodies.articleId, dto.articleId))
      .limit(1);
    const slice = body?.bodySlice ?? '';

    const span = this.resolveSpan(slice, dto);
    if (!span) {
      throw new BadRequestException({
        code: 'QUOTE_NOT_FOUND',
        message: '引句在正文切片中未命中，无法建立物理锚点',
      });
    }

    const hash = spanHash(dto.quote, article.bodyVersion ?? 1);

    // 编号命名空间：实体首次来源的语料域 code（如 wenzhou-city-trust），无则 global
    const [ent] = await this.db
      .select({ originDatasetId: entities.originDatasetId })
      .from(entities)
      .where(eq(entities.id, dto.entityId))
      .limit(1);
    const [ds] = ent?.originDatasetId
      ? await this.db
          .select({ code: datasets.code })
          .from(datasets)
          .where(eq(datasets.id, ent.originDatasetId))
          .limit(1)
      : [];
    const datasetCode = ds?.code ?? 'global';

    // 证据（按 (article_id, span_hash) 去重）+ 多实体归属 在同一事务内落库：
    // 首建归 primary；复用已有证据时归 share（证据可支撑多个实体的事实）。
    const evidenceId = await this.db.transaction(async (tx) => {
      // 编号域内自增：实体行锁串行化同一实体的并发写入，避免两路算出同一序号撞号
      await tx.execute(sql`SELECT id FROM ${entities} WHERE id = ${dto.entityId} FOR UPDATE`);
      const code = dto.code ?? (await this.nextCode(dto.entityId, datasetCode, tx));

      const [ins] = await tx
        .insert(evidence)
        .values({
          entityId: dto.entityId,
          articleId: dto.articleId,
          code,
          sourceOrg: dto.sourceOrg ?? article.sourceOrg,
          materialTitle: dto.materialTitle ?? article.title,
          sourceUrl: dto.sourceUrl ?? article.url,
          publishedAt: dto.publishedAt ?? article.publishedAt,
          quote: dto.quote,
          spanStart: span.start,
          spanEnd: span.end,
          spanHash: hash,
          assetUrn: dto.assetUrn ?? this.buildAssetUrn(article, dto.entityId),
          bodyVersion: article.bodyVersion ?? 1,
          qualityGrade: dto.qualityGrade,
          // 引句已逐字命中正文切片（resolveSpan 失败会直接抛错），即通过回查
          verifyStatus: 'passed',
          verifyDetail: '自动锚定：引句逐字命中正文切片',
          // 批次以文章真实批次为准（档案页基线/增量统计的数据源）
          batch: article.batch,
          origin: dto.origin,
          status: dto.status,
          createdBy: userId ?? null,
        })
        .onDuplicateKeyUpdate({
          set: {
            spanStart: span.start,
            spanEnd: span.end,
            quote: dto.quote,
            materialTitle: dto.materialTitle ?? article.title,
          },
        });

      let id = Number(ins.insertId);
      if (!id) {
        // 命中已有证据（同一 (article_id, span_hash)）：复用该证据，登记为 share 归属
        const [dup] = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.articleId, dto.articleId), eq(evidence.spanHash, hash)))
          .limit(1);
        id = Number(dup?.id ?? 0);
        if (id) {
          await tx
            .insert(evidenceEntities)
            .values({ evidenceId: id, entityId: dto.entityId, role: 'share' })
            .onDuplicateKeyUpdate({ set: { role: 'share' } });
        }
      } else {
        await tx
          .insert(evidenceEntities)
          .values({ evidenceId: id, entityId: dto.entityId, role: 'primary' })
          .onDuplicateKeyUpdate({ set: { role: 'primary' } });
      }
      return id;
    });

    return this.detail(evidenceId);
  }

  async update(id: number, dto: UpdateEvidenceDto) {
    const current = await this.detail(id);
    if (dto.quote && dto.quote !== current.quote) {
      const [body] = await this.db
        .select()
        .from(sourceArticleBodies)
        .where(eq(sourceArticleBodies.articleId, current.articleId))
        .limit(1);
      const span = this.resolveSpan(body?.bodySlice ?? '', { ...dto, quote: dto.quote });
      if (!span) throw new BadRequestException('引句在正文切片中未命中');
      (dto as { spanStart?: number; spanEnd?: number }).spanStart = span.start;
      (dto as { spanStart?: number; spanEnd?: number }).spanEnd = span.end;
    }
    await this.db.update(evidence).set(dto as never).where(eq(evidence.id, id));
    return this.detail(id);
  }

  /** 锚点复核台核心：把引句在正文切片里高亮出来，人工一键通过/失败 */
  async anchorPreview(input: {
    articleId: number;
    quote?: string;
    spanStart?: number;
    spanEnd?: number;
    context?: number;
  }) {
    const [article] = await this.db
      .select()
      .from(sourceArticles)
      .where(eq(sourceArticles.id, input.articleId))
      .limit(1);
    if (!article) throw new NotFoundException('文章不存在');

    const [body] = await this.db
      .select()
      .from(sourceArticleBodies)
      .where(eq(sourceArticleBodies.articleId, input.articleId))
      .limit(1);
    const slice = body?.bodySlice ?? '';
    const ctx = input.context ?? 120;

    let start = input.spanStart;
    let end = input.spanEnd;
    if (start === undefined || end === undefined) {
      if (!input.quote) throw new BadRequestException('需要提供引句或 span');
      const found = locateQuote(slice, input.quote);
      start = found?.start;
      end = found?.end;
    }

    const matched = start !== undefined && end !== undefined && start >= 0 && end <= slice.length;

    if (!matched || start === undefined || end === undefined) {
      return {
        articleId: input.articleId,
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        bodyVersion: article.bodyVersion,
        sliceRule: body?.sliceRule ?? null,
        sliceLength: slice.length,
        quote: input.quote ?? '',
        spanStart: null,
        spanEnd: null,
        matched: false,
        before: slice.slice(0, Math.min(slice.length, ctx * 4)),
        hit: '',
        after: '',
        spanHashPreview: null,
      };
    }

    return {
      articleId: input.articleId,
      title: article.title,
      url: article.url,
      publishedAt: article.publishedAt,
      bodyVersion: article.bodyVersion,
      sliceRule: body?.sliceRule ?? null,
      sliceLength: slice.length,
      quote: input.quote ?? slice.slice(start, end),
      spanStart: start,
      spanEnd: end,
      matched: true,
      /** 前端三段式渲染：before / hit / after */
      before: slice.slice(Math.max(0, start - ctx), start),
      hit: slice.slice(start, end),
      after: slice.slice(end, Math.min(slice.length, end + ctx)),
      spanHashPreview: shortHash(spanHash(slice.slice(start, end), article.bodyVersion ?? 1)),
    };
  }

  async verify(id: number, verifyStatus: 'pending' | 'passed' | 'failed', detail?: string | null, userId?: number) {
    await this.detail(id);
    await this.db
      .update(evidence)
      .set({ verifyStatus, verifyDetail: detail ?? null, updatedAt: new Date() })
      .where(eq(evidence.id, id));
    return this.detail(id);
  }

  /** 逐字回查：evidence.bodyVersion 与 article.bodyVersion 不一致 → 标为待复核 */
  async detectStale(entityId?: number) {
    const rows = await this.db
      .select({
        id: evidence.id,
        bodyVersion: evidence.bodyVersion,
        articleBodyVersion: sourceArticles.bodyVersion,
      })
      .from(evidence)
      .innerJoin(sourceArticles, eq(evidence.articleId, sourceArticles.id))
      .where(
        and(
          entityId ? eq(evidence.entityId, entityId) : undefined,
          sql`${evidence.bodyVersion} <> ${sourceArticles.bodyVersion}`,
        ),
      );

    if (rows.length) {
      for (let i = 0; i < rows.length; i += 500) {
        const ids = rows.slice(i, i + 500).map((r) => r.id);
        await this.db
          .update(evidence)
          .set({ verifyStatus: 'pending', verifyDetail: '正文切片版本变更，锚点需重算' })
          .where(inArray(evidence.id, ids));
      }
    }
    return { stale: rows.length };
  }

  /** R1 引句逐字回查：返回每条证据的命中情况（对应原型「校验：引句逐字回查 29/29 PASS」） */
  async recheck(entityId: number) {
    const rows = await this.db
      .select({
        id: evidence.id,
        code: evidence.code,
        quote: evidence.quote,
        bodySlice: sourceArticleBodies.bodySlice,
      })
      .from(evidence)
      .leftJoin(sourceArticleBodies, eq(evidence.articleId, sourceArticleBodies.articleId))
      .where(eq(evidence.entityId, entityId));

    let pass = 0;
    const failures: { id: number; code: string | null; quote: string }[] = [];
    for (const r of rows) {
      const hit = locateQuote(r.bodySlice, r.quote);
      if (hit) {
        pass += 1;
        await this.db
          .update(evidence)
          .set({ verifyStatus: 'passed', verifyDetail: '引句逐字回查通过' })
          .where(eq(evidence.id, r.id));
      } else {
        failures.push({ id: r.id, code: r.code, quote: r.quote ?? '' });
        await this.db
          .update(evidence)
          .set({ verifyStatus: 'failed', verifyDetail: '引句在正文切片中未命中' })
          .where(eq(evidence.id, r.id));
      }
    }
    return { total: rows.length, pass, fail: failures.length, failures };
  }

  async stats(entityId: number) {
    const [row] = await this.db
      .select({
        total: count(),
        passed: sql<number>`SUM(CASE WHEN ${evidence.verifyStatus} = 'passed' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN ${evidence.verifyStatus} = 'pending' THEN 1 ELSE 0 END)`,
        failed: sql<number>`SUM(CASE WHEN ${evidence.verifyStatus} = 'failed' THEN 1 ELSE 0 END)`,
      })
      .from(evidence)
      .where(eq(evidence.entityId, entityId));
    return {
      entityId,
      total: Number(row?.total ?? 0),
      passed: Number(row?.passed ?? 0),
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  // ---------------------------------------------------------------- 内部

  private resolveSpan(slice: string, dto: { quote: string; spanStart?: number; spanEnd?: number }) {
    if (dto.spanStart !== undefined && dto.spanEnd !== undefined) {
      const actual = slice.slice(dto.spanStart, dto.spanEnd);
      const ok = actual === dto.quote || actual.trim() === dto.quote.trim();
      if (ok) return { start: dto.spanStart, end: dto.spanEnd };
    }
    return locateQuote(slice, dto.quote);
  }

  /**
   * 生成全网唯一证据编号：{dataset}-E-{entityId 6位}-{域内序号 2位}。
   * 旧格式 E1 实体内唯一、全网重号；实体 id 全局唯一 ⇒ 新编号全网不撞号。
   */
  private async nextCode(entityId: number, datasetCode: string, db: TxDb = this.db) {
    const rows = await db
      .select({ code: evidence.code })
      .from(evidence)
      .where(eq(evidence.entityId, entityId));
    let max = 0;
    for (const r of rows) max = Math.max(max, codeSeq(r.code));
    return buildEvidenceCode(datasetCode, entityId, max + 1);
  }

  private buildAssetUrn(
    article: { url: string; publishedAt: string | null; id: number },
    entityId: number,
  ) {
    const date = (article.publishedAt ?? '').replace(/-/g, '');
    const host = (() => {
      try {
        return new URL(article.url).hostname.replace(/^www\./, '');
      } catch {
        return 'unknown';
      }
    })();
    return `urn:wz:asset:${host}:news:${date || 'nodate'}:${article.id}:${entityId}`;
  }

  /** 供事实/事件挂载后回填「证据 → 支撑对象」展示 */
  async linkedTargets(evidenceId: number) {
    const row = await this.detail(evidenceId);
    const [entity] = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(and(eq(entities.id, row.entityId), isNull(entities.deletedAt)))
      .limit(1);
    return { entity: entity ?? null };
  }
}
