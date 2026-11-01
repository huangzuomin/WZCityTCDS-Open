import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { linkedCategoryIds } from '../../common/dataset-categories';
import { categories, datasets, entities, entityRelations, evidences, graphNodes } from '../../db/schema';
import { sha256 } from '../../common/crypto';

/**
 * 图谱节点 id 编码（实体 ∪ 概念 统一节点空间）：
 * - 实体节点 → 正整数 = entity.id
 * - 概念节点 → 负整数 = -graph_node.id
 * 两张表各自自增，id 必然撞号，故用符号区分，避免把「面粉」渲染成「张三」。
 */
export const conceptNodeId = (graphNodeId: number) => -Math.abs(graphNodeId);
export const isConceptNodeId = (id: number) => id < 0;
/** 概念节点 id → graph_node.id */
const conceptGraphNodeId = (id: number) => Math.abs(id);

export interface GraphNode {
  /** 实体为正 entity.id；概念为负 -graph_node.id */
  id: number;
  /** 实体 | 概念 */
  nodeType: 'entity' | 'concept';
  name: string;
  categoryCode: string | null;
  categoryName: string | null;
  status: string;
  lede: string | null;
  /** v2：实体溯源语料域（可空 = 纯全局实体）；概念节点为概念所属语料域 */
  datasetId: number | null;
  /** 供前端跳转档案页（概念节点为空） */
  slug: string | null;
  datasetCode: string | null;
}

export interface GraphEdge {
  id: number;
  /** 头节点 id（恒为实体，正数） */
  head: number;
  /** 尾节点 id：实体为正 entity.id；概念为负 -graph_node.id */
  tail: number;
  predicate: string;
  label: string;
  predicateRaw: string | null;
  statement: string | null;
  confidence: number;
  corroborateCount: number;
  articleId: number | null;
  /** 支撑引句：随证据挂载，供前端边 tooltip / 关联面板溯源展示 */
  evidenceId?: number | null;
  quote?: string | null;
  evidenceCode?: string | null;
  verifyStatus?: 'pending' | 'passed' | 'failed' | null;
}

export interface EntityGraph {
  center: number;
  depth: number;
  direction: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 谓词码（rel_隶属）→ 展示标签（隶属） */
const labelOf = (predicate: string) => predicate.replace(/^rel_/, '');

/**
 * 知识图谱查询（只读浏览）：
 * - entityGraph：以某节点为中心的多跳子图（BFS，深度 ≤3，带谓词/置信度/方向过滤）
 * - overview：按度数取 top N 节点的概览子图
 * - relations：关系明细列表（表格浏览）
 * - predicates：谓词分布（过滤面板）
 * - searchNodes：节点搜索（实体 ∪ 概念，选中心点用）
 */
@Injectable()
export class GraphService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * 边的两端节点 id：头恒为实体；尾优先实体，其次概念（tailNodeId）。
   * 旧数据（无 node_id）照常走 entity id，无需迁移。
   */
  private edgeEnds(e: typeof entityRelations.$inferSelect): { head: number; tail: number | null } {
    const head = e.headEntityId;
    if (e.tailEntityId != null) return { head, tail: e.tailEntityId };
    if (e.tailNodeId != null) return { head, tail: conceptNodeId(e.tailNodeId) };
    return { head, tail: null };
  }

  /** 以节点为中心的多跳子图 */
  async entityGraph(
    nodeId: number,
    opts: { depth?: number; direction?: 'both' | 'out' | 'in'; minConfidence?: number; predicate?: string } = {},
  ) {
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
    const direction = opts.direction ?? 'both';
    const visited = new Set<number>([nodeId]);
    const edgeMap = new Map<number, typeof entityRelations.$inferSelect>();
    let frontier = [nodeId];

    for (let hop = 0; hop < depth && frontier.length; hop += 1) {
      // 前端节点 id 拆分：实体（正）查 head/tailEntityId，概念（负）查 tailNodeId
      const frontierEntities = frontier.filter((id) => !isConceptNodeId(id));
      const frontierConcepts = frontier.filter(isConceptNodeId).map(conceptGraphNodeId);
      const touched = [
        frontierEntities.length ? inArray(entityRelations.headEntityId, frontierEntities) : undefined,
        frontierEntities.length ? inArray(entityRelations.tailEntityId, frontierEntities) : undefined,
        frontierConcepts.length ? inArray(entityRelations.tailNodeId, frontierConcepts) : undefined,
      ].filter((v) => v !== undefined);
      if (!touched.length) break;

      const frontierSet = new Set(frontier);
      const rows = await this.db
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.status, 'active'),
            opts.minConfidence ? gte(entityRelations.confidence, String(opts.minConfidence)) : undefined,
            opts.predicate ? eq(entityRelations.predicate, opts.predicate) : undefined,
            or(...touched),
          ),
        )
        .limit(800);

      const next: number[] = [];
      for (const r of rows) {
        const ends = this.edgeEnds(r);
        const isOut = frontierSet.has(ends.head);
        const isIn = ends.tail != null && frontierSet.has(ends.tail);
        if (direction === 'out' && !isOut) continue;
        if (direction === 'in' && !isIn) continue;
        edgeMap.set(r.id, r);
        for (const nid of [ends.head, ends.tail]) {
          if (nid != null && !visited.has(nid)) {
            visited.add(nid);
            next.push(nid);
          }
        }
      }
      frontier = next;
    }

    const nodeIds = [...visited];
    const nodes = await this.loadNodes(nodeIds);
    const known = new Set(nodes.map((n) => n.id));
    const edges = await this.attachEvidence(
      [...edgeMap.values()]
        .map((e) => ({ e, ends: this.edgeEnds(e) }))
        .filter(({ ends }) => ends.tail != null && known.has(ends.head) && known.has(ends.tail as number))
        .map(({ e }) => this.toEdge(e)),
    );

    return { center: nodeId, depth, direction, nodes, edges };
  }

  /** 概览子图：按度数取 top N 节点 + 它们之间的边 */
  async overview(datasetId?: number, limit = 50) {
    const size = Math.max(limit, 5);
    const activeWhere = and(
      datasetId ? eq(entityRelations.datasetId, datasetId) : undefined,
      eq(entityRelations.status, 'active'),
    );

    // 度数 = 头端 + 尾端（实体/概念分别统计后合并到统一节点 id 空间）
    const [headRows, tailEntityRows, tailNodeRows] = await Promise.all([
      this.db
        .select({ id: entityRelations.headEntityId, n: count() })
        .from(entityRelations)
        .where(activeWhere)
        .groupBy(entityRelations.headEntityId),
      this.db
        .select({ id: entityRelations.tailEntityId, n: count() })
        .from(entityRelations)
        .where(and(activeWhere, isNotNull(entityRelations.tailEntityId)))
        .groupBy(entityRelations.tailEntityId),
      this.db
        .select({ id: entityRelations.tailNodeId, n: count() })
        .from(entityRelations)
        .where(and(activeWhere, isNotNull(entityRelations.tailNodeId)))
        .groupBy(entityRelations.tailNodeId),
    ]);

    const degree = new Map<number, number>();
    const bump = (id: number, n: number) => degree.set(id, (degree.get(id) ?? 0) + n);
    for (const r of headRows) if (r.id != null) bump(Number(r.id), Number(r.n));
    for (const r of tailEntityRows) if (r.id != null) bump(Number(r.id), Number(r.n));
    for (const r of tailNodeRows) if (r.id != null) bump(conceptNodeId(Number(r.id)), Number(r.n));

    const topIds = [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, size)
      .map(([id]) => id);
    if (!topIds.length) return { nodes: [], edges: [], degrees: {} as Record<number, number> };

    const topEntities = topIds.filter((id) => !isConceptNodeId(id));
    const topConcepts = topIds.filter(isConceptNodeId).map(conceptGraphNodeId);
    // 两端都在 top 集合内的边（尾端命中实体或概念任一即可）
    const tailHit = [
      topEntities.length ? inArray(entityRelations.tailEntityId, topEntities) : undefined,
      topConcepts.length ? inArray(entityRelations.tailNodeId, topConcepts) : undefined,
    ].filter((v) => v !== undefined);

    const rows = topEntities.length
      ? await this.db
          .select()
          .from(entityRelations)
          .where(and(activeWhere, inArray(entityRelations.headEntityId, topEntities), tailHit.length ? or(...tailHit) : undefined))
      : [];
    const topSet = new Set(topIds);
    const edges = await this.attachEvidence(
      rows
        .filter((r) => {
          const ends = this.edgeEnds(r);
          return ends.tail != null && topSet.has(ends.head) && topSet.has(ends.tail);
        })
        .map((r) => this.toEdge(r)),
    );

    const nodes = await this.loadNodes(topIds);
    const degrees: Record<number, number> = {};
    for (const id of topIds) degrees[id] = degree.get(id) ?? 0;
    return { nodes, edges, degrees };
  }

  /** 关系明细列表（表格浏览，可按头实体/谓词/关键词筛选） */
  async relations(query: {
    datasetId?: number;
    headEntityId?: number;
    predicate?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = query.page ?? 1;
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 200);
    const headAlias = entities;
    const where = and(
      query.datasetId ? eq(entityRelations.datasetId, query.datasetId) : undefined,
      eq(entityRelations.status, 'active'),
      query.headEntityId ? eq(entityRelations.headEntityId, query.headEntityId) : undefined,
      query.predicate ? eq(entityRelations.predicate, query.predicate) : undefined,
      query.keyword
        ? or(
            like(entityRelations.tailText, `%${query.keyword}%`),
            like(entityRelations.statement, `%${query.keyword}%`),
          )
        : undefined,
    );

    const [{ value: total }] = await this.db.select({ value: count() }).from(entityRelations).where(where);
    const rows = await this.db
      .select({ rel: entityRelations, headName: headAlias.name })
      .from(entityRelations)
      .leftJoin(headAlias, eq(headAlias.id, entityRelations.headEntityId))
      .where(where)
      .orderBy(asc(entityRelations.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const tailIds = [...new Set(rows.map((r) => r.rel.tailEntityId).filter((v): v is number => v != null))];
    const tailRows = tailIds.length
      ? await this.db.select({ id: entities.id, name: entities.name }).from(entities).where(inArray(entities.id, tailIds))
      : [];
    const tailName = new Map(tailRows.map((t) => [t.id, t.name]));

    // 概念尾端（新候选不再建草稿实体，改为概念节点）取 graph_node 名称
    const nodeIds = [...new Set(rows.map((r) => r.rel.tailNodeId).filter((v): v is number => v != null))];
    const nodeRows = nodeIds.length
      ? await this.db.select({ id: graphNodes.id, name: graphNodes.name }).from(graphNodes).where(inArray(graphNodes.id, nodeIds))
      : [];
    const nodeName = new Map(nodeRows.map((n) => [n.id, n.name]));

    return {
      items: rows.map(({ rel, headName }) => {
        const tailLabel =
          (rel.tailEntityId ? tailName.get(rel.tailEntityId) : null) ??
          (rel.tailNodeId ? nodeName.get(rel.tailNodeId) : null) ??
          null;
        return {
          ...this.toEdge(rel),
          headName: headName ?? null,
          tailName: tailLabel,
          tailText: rel.tailText,
          tailType: rel.tailType,
          firstSeenAt: rel.firstSeenAt,
          lastVerifiedAt: rel.lastVerifiedAt,
        };
      }),
      total: Number(total),
      page,
      pageSize,
    };
  }

  /** 谓词分布（归一后的关系类型 + 计数） */
  async predicates(datasetId?: number) {
    const rows = await this.db
      .select({
        predicate: entityRelations.predicate,
        n: count(),
        avgConfidence: sql<number>`COALESCE(ROUND(AVG(${entityRelations.confidence}), 2), 0)`,
      })
      .from(entityRelations)
      .where(
        and(
          datasetId ? eq(entityRelations.datasetId, datasetId) : undefined,
          eq(entityRelations.status, 'active'),
        ),
      )
      .groupBy(entityRelations.predicate)
      .orderBy(desc(count()));
    return rows.map((r) => ({
      predicate: r.predicate,
      label: labelOf(r.predicate),
      count: Number(r.n),
      avgConfidence: Number(r.avgConfidence),
    }));
  }

  /** 实体搜索（兼容旧接口：仅实体） */
  async searchEntities(keyword: string, datasetId?: number, limit = 20) {
    const kw = (keyword ?? '').trim();
    if (!kw) return [];
    const rows = await this.db
      .select({
        id: entities.id,
        name: entities.name,
        categoryCode: categories.code,
        categoryName: categories.name,
        status: entities.status,
      })
      .from(entities)
      .leftJoin(categories, eq(categories.id, entities.categoryId))
      .where(
        and(
          datasetId ? inArray(entities.categoryId, await linkedCategoryIds(this.db, datasetId)) : undefined,
          isNull(entities.deletedAt),
          like(entities.name, `%${kw}%`),
        ),
      )
      .limit(limit);
    return rows;
  }

  /** 节点搜索（实体 ∪ 概念，供图谱中心点选择） */
  async searchNodes(keyword: string, datasetId?: number, limit = 20) {
    const kw = (keyword ?? '').trim();
    if (!kw) return [];
    const entityHits = await this.searchEntities(kw, datasetId, limit);
    const conceptRows = await this.db
      .select({
        id: graphNodes.id,
        name: graphNodes.name,
        categoryCode: graphNodes.categoryCode,
        categoryName: categories.name,
      })
      .from(graphNodes)
      .leftJoin(categories, eq(categories.code, graphNodes.categoryCode))
      .where(
        and(
          eq(graphNodes.nodeType, 'concept'),
          eq(graphNodes.status, 'active'),
          datasetId ? eq(graphNodes.datasetId, datasetId) : undefined,
          like(graphNodes.name, `%${kw}%`),
        ),
      )
      .limit(limit);
    return [
      ...entityHits.map((e) => ({ ...e, nodeType: 'entity' as const })),
      ...conceptRows.map((c) => ({
        id: conceptNodeId(c.id),
        name: c.name,
        categoryCode: c.categoryCode,
        categoryName: c.categoryName,
        status: 'concept',
        nodeType: 'concept' as const,
      })),
    ].slice(0, limit);
  }

  /**
   * 人工反转关系方向：head ⇄ tail 对调并写库。
   * - origin 记为 manual、version+1，便于与本条被模型重复抽取的情况区分
   * - dedupeKey 按新方向重算：模型若再抽到旧方向会另建一条（可在发现审核里驳回）
   * - 若新方向已存在等价关系，则把本条标记为 superseded 并指向它，避免重复
   * - 概念尾端不可反转：图谱头节点必须是实体（entity_relation.head_entity_id 非空）
   */
  async reverseRelation(id: number) {
    const [rel] = await this.db.select().from(entityRelations).where(eq(entityRelations.id, id)).limit(1);
    if (!rel) throw new NotFoundException('关系不存在');
    if (rel.status !== 'active') throw new BadRequestException('只有生效中的关系可以反转');
    if (rel.tailEntityId == null) {
      throw new BadRequestException(
        rel.tailNodeId != null
          ? '尾端是概念节点，无法反转（图谱头节点必须是实体）'
          : '尾实体尚未对齐（新候选），无法反转；请先在发现审核里把它对齐成实体',
      );
    }

    const [headRow] = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.id, rel.headEntityId))
      .limit(1);
    const [tailRow] = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.id, Number(rel.tailEntityId)))
      .limit(1);
    if (!headRow || !tailRow) throw new NotFoundException('关系两端实体不存在');

    const newHead = tailRow.id;
    const newTail = headRow.id;
    const label = labelOf(rel.predicate);
    const statement = `${tailRow.name} ${label} ${headRow.name}`;

    const [dup] = await this.db
      .select({ id: entityRelations.id })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.datasetId, rel.datasetId),
          eq(entityRelations.headEntityId, newHead),
          eq(entityRelations.predicate, rel.predicate),
          eq(entityRelations.tailEntityId, newTail),
          eq(entityRelations.status, 'active'),
        ),
      )
      .limit(1);
    if (dup) {
      await this.db
        .update(entityRelations)
        .set({
          status: 'superseded',
          supersededById: dup.id,
          origin: 'manual',
          version: rel.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(entityRelations.id, id));
      return { reversed: false, id, mergedInto: dup.id, message: '已存在同向关系，本条已标记为被取代' };
    }

    await this.db
      .update(entityRelations)
      .set({
        headEntityId: newHead,
        tailEntityId: newTail,
        tailText: headRow.name,
        tailType: null,
        statement,
        dedupeKey: sha256(`relation|${newHead}|${rel.predicate}|${headRow.name}|${newTail}`),
        origin: 'manual',
        version: rel.version + 1,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(entityRelations.id, id));

    return {
      reversed: true,
      id,
      head: newHead,
      tail: newTail,
      headName: tailRow.name,
      tailName: headRow.name,
      statement,
    };
  }

  /** 人工修改关系名称（谓词）。origin=manual；同步重建 statement 与 dedupeKey */
  async updateRelation(id: number, patch: { predicate?: string }) {
    const [rel] = await this.db.select().from(entityRelations).where(eq(entityRelations.id, id)).limit(1);
    if (!rel) throw new NotFoundException('关系不存在');
    if (rel.status !== 'active') throw new BadRequestException('只有生效中的关系可修改');
    const predicate = (patch?.predicate ?? '').trim().replace(/^rel_/, '');
    if (!predicate) throw new BadRequestException('关系名称不能为空');

    const [headRow] = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.id, rel.headEntityId))
      .limit(1);
    const [tailRow] =
      rel.tailEntityId != null
        ? await this.db.select({ id: entities.id, name: entities.name }).from(entities).where(eq(entities.id, Number(rel.tailEntityId))).limit(1)
        : [];
    let tailName = rel.tailText;
    if (rel.tailEntityId != null && tailRow) tailName = tailRow.name;
    const statement = `${headRow?.name ?? ''} ${predicate} ${tailName ?? ''}`.trim();

    // 改后若与同批次已有等价边冲突，尽量标记取代，避免重复
    const [dup] = await this.db
      .select({ id: entityRelations.id })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.datasetId, rel.datasetId),
          eq(entityRelations.headEntityId, rel.headEntityId),
          eq(entityRelations.predicate, predicate),
          rel.tailEntityId != null ? eq(entityRelations.tailEntityId, rel.tailEntityId) : isNull(entityRelations.tailEntityId),
          eq(entityRelations.status, 'active'),
          ne(entityRelations.id, id),
        ),
      )
      .limit(1);
    if (dup) {
      await this.db
        .update(entityRelations)
        .set({ status: 'superseded', supersededById: dup.id, origin: 'manual', version: rel.version + 1, updatedAt: new Date() })
        .where(eq(entityRelations.id, id));
      return { updated: false, id, mergedInto: dup.id, message: '已存在同向等价关系，本条已标记为被取代' };
    }

    await this.db
      .update(entityRelations)
      .set({
        predicate,
        statement,
        dedupeKey: sha256(`relation|${rel.headEntityId}|${predicate}|${tailName}|${rel.tailEntityId ?? ''}`),
        origin: 'manual',
        version: rel.version + 1,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(entityRelations.id, id));
    return { updated: true, id, predicate, statement };
  }

  /** 删除关系（软删为 rejected，保留审计与证据，不再出现在活跃子图） */
  async deleteRelation(id: number) {
    const [rel] = await this.db.select().from(entityRelations).where(eq(entityRelations.id, id)).limit(1);
    if (!rel) throw new NotFoundException('关系不存在');
    await this.db
      .update(entityRelations)
      .set({ status: 'rejected', origin: 'manual', version: rel.version + 1, updatedAt: new Date() })
      .where(eq(entityRelations.id, id));
    return { deleted: true, id };
  }

  /** 修改概念节点名称（非实体节点，node_type=concept）。同语料域内名称唯一。 */
  async updateConceptNode(id: number, patch: { name?: string }) {
    const name = (patch?.name ?? '').trim();
    if (!name) throw new BadRequestException('节点名称不能为空');
    const [node] = await this.db.select().from(graphNodes).where(eq(graphNodes.id, id)).limit(1);
    if (!node) throw new NotFoundException('节点不存在');
    if (node.nodeType !== 'concept') {
      throw new BadRequestException('只有概念节点（非实体）可以直接改名；实体请到实体档案页修改');
    }
    // 名称为负 id 空间的 graph_node，改名后若撞同语料域同名另一节点则报错
    const [dup] = await this.db
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(and(eq(graphNodes.datasetId, node.datasetId), eq(graphNodes.name, name), ne(graphNodes.id, id)))
      .limit(1);
    if (dup) throw new BadRequestException(`同语料域已存在同名节点「${name}」`);
    await this.db.update(graphNodes).set({ name, updatedAt: new Date() }).where(eq(graphNodes.id, id));
    return { updated: true, id, name };
  }

  /**
   * 以多个实体为中心的多跳合并子图（语料首页「城市事实目录」所列实体 ∪ 邻居）。
   * 多个种子做同一轮 BFS，返回去重后的节点与边；与 entityGraph 同机制（复用 edgeEnds / loadNodes / attachEvidence）。
   */
  async forEntities(
    entityIds: number[],
    opts: { depth?: number; minConfidence?: number } = {},
  ): Promise<{ seeds: number[]; depth: number; nodes: GraphNode[]; edges: GraphEdge[] }> {
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
    const seeds = [...new Set(entityIds.filter((id) => Number.isInteger(id) && !isConceptNodeId(id)))];
    if (!seeds.length) return { seeds, depth, nodes: [], edges: [] };
    const visited = new Set<number>(seeds);
    const edgeMap = new Map<number, typeof entityRelations.$inferSelect>();
    let frontier = [...seeds];

    for (let hop = 0; hop < depth && frontier.length; hop += 1) {
      const frontierEntities = frontier.filter((id) => !isConceptNodeId(id));
      const frontierConcepts = frontier.filter(isConceptNodeId).map(conceptGraphNodeId);
      const touched = [
        frontierEntities.length ? inArray(entityRelations.headEntityId, frontierEntities) : undefined,
        frontierEntities.length ? inArray(entityRelations.tailEntityId, frontierEntities) : undefined,
        frontierConcepts.length ? inArray(entityRelations.tailNodeId, frontierConcepts) : undefined,
      ].filter((v) => v !== undefined);
      if (!touched.length) break;
      const frontierSet = new Set(frontier);
      const rows = await this.db
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.status, 'active'),
            opts.minConfidence ? gte(entityRelations.confidence, String(opts.minConfidence)) : undefined,
            or(...touched),
          ),
        )
        .limit(2000);
      const next: number[] = [];
      for (const r of rows) {
        const ends = this.edgeEnds(r);
        edgeMap.set(r.id, r);
        for (const nid of [ends.head, ends.tail]) {
          if (nid != null && !visited.has(nid)) {
            visited.add(nid);
            next.push(nid);
          }
        }
      }
      frontier = next;
    }

    const nodeIds = [...visited];
    const nodes = await this.loadNodes(nodeIds);
    const known = new Set(nodes.map((n) => n.id));
    const edges = await this.attachEvidence(
      [...edgeMap.values()]
        .map((e) => ({ e, ends: this.edgeEnds(e) }))
        .filter(({ ends }) => ends.tail != null && known.has(ends.head) && known.has(ends.tail as number))
        .map(({ e }) => this.toEdge(e)),
    );
    return { seeds, depth, nodes, edges };
  }

  // ---------------------------------------------------------------- 内部

  /** 节点层加载：实体（正 id）走 entity 表，概念（负 id）走 graph_node */
  private async loadNodes(ids: number[]): Promise<GraphNode[]> {
    if (!ids.length) return [];
    const entityIds = ids.filter((id) => !isConceptNodeId(id));
    const nodeIds = ids.filter(isConceptNodeId).map(conceptGraphNodeId);
    const [entityNodes, conceptNodes] = await Promise.all([
      this.loadEntityNodes(entityIds),
      this.loadConceptNodes(nodeIds),
    ]);
    const byId = new Map([...entityNodes, ...conceptNodes].map((n) => [n.id, n]));
    // 保持入参顺序，未命中的节点（已删除/禁用）跳过
    return ids.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n);
  }

  private async loadEntityNodes(ids: number[]): Promise<GraphNode[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: entities.id,
        name: entities.name,
        status: entities.status,
        lede: entities.lede,
        datasetId: entities.originDatasetId,
        slug: entities.slug,
        datasetCode: datasets.code,
        categoryCode: categories.code,
        categoryName: categories.name,
      })
      .from(entities)
      .leftJoin(categories, eq(categories.id, entities.categoryId))
      .leftJoin(datasets, eq(datasets.id, entities.originDatasetId))
      .where(inArray(entities.id, ids));
    return rows.map((r) => ({
      id: r.id,
      nodeType: 'entity' as const,
      name: r.name,
      status: r.status,
      lede: r.lede,
      datasetId: r.datasetId,
      slug: r.slug,
      datasetCode: r.datasetCode,
      categoryCode: r.categoryCode,
      categoryName: r.categoryName,
    }));
  }

  private async loadConceptNodes(ids: number[]): Promise<GraphNode[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: graphNodes.id,
        name: graphNodes.name,
        status: graphNodes.status,
        datasetId: graphNodes.datasetId,
        categoryCode: graphNodes.categoryCode,
        datasetCode: datasets.code,
        categoryName: categories.name,
      })
      .from(graphNodes)
      .leftJoin(categories, eq(categories.code, graphNodes.categoryCode))
      .leftJoin(datasets, eq(datasets.id, graphNodes.datasetId))
      .where(and(inArray(graphNodes.id, ids), eq(graphNodes.nodeType, 'concept')));
    return rows.map((r) => ({
      id: conceptNodeId(r.id),
      nodeType: 'concept' as const,
      name: r.name,
      status: r.status,
      lede: null,
      datasetId: r.datasetId,
      slug: null,
      datasetCode: r.datasetCode,
      categoryCode: r.categoryCode,
      categoryName: r.categoryName,
    }));
  }

  private toEdge(e: typeof entityRelations.$inferSelect): GraphEdge {
    const ends = this.edgeEnds(e);
    return {
      id: e.id,
      head: ends.head,
      tail: ends.tail ?? 0,
      predicate: e.predicate,
      label: labelOf(e.predicate),
      predicateRaw: e.predicateRaw,
      statement: e.statement,
      confidence: Number(e.confidence),
      corroborateCount: e.corroborateCount,
      articleId: e.articleId,
      evidenceId: e.evidenceId ?? null,
    };
  }

  /** 批量把边的证据引句/编码/核验状态挂上去（避免逐边 N+1 查询） */
  private async attachEvidence(edges: GraphEdge[]): Promise<GraphEdge[]> {
    const ids = [...new Set(edges.map((e) => e.evidenceId).filter((v): v is number => v != null))];
    if (!ids.length) return edges;
    const rows = await this.db
      .select({ id: evidences.id, quote: evidences.quote, code: evidences.code, verifyStatus: evidences.verifyStatus })
      .from(evidences)
      .where(inArray(evidences.id, ids));
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return edges.map((e) =>
      e.evidenceId != null && byId.has(e.evidenceId)
        ? {
            ...e,
            quote: byId.get(e.evidenceId)?.quote ?? null,
            evidenceCode: byId.get(e.evidenceId)?.code ?? null,
            verifyStatus: byId.get(e.evidenceId)?.verifyStatus ?? null,
          }
        : e,
    );
  }
}