import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { entities, facts } from '../../db/schema';
import { ArchiveService } from '../archive/archive.service';
import { EntityService } from '../entity/entity.service';
import { FactService } from '../fact/fact.service';
import type { ListEntityQuery } from '../entity/entity.dto';
import type { ListFactQuery } from '../fact/fact.dto';

/** 面向 Agent 的只读工具定义（MCP tools/list 的输出结构） */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON-RPC 错误（带标准 code，便于 Agent 判别） */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_LIMIT = 50;

/** withEvidence() 返回的引句行（服务层未导出该类型，此处按字段结构声明） */
interface EvidenceRow {
  id: number;
  code: string | null;
  quote: string | null;
  role: string;
  articleId: number | null;
  materialTitle: string | null;
  sourceOrg: string | null;
  publishedAt: string | null;
}

/**
 * 机器出口：MCP 只读工具服务。
 * 约束：只读、不写库、不暴露写接口；失效与撤回通过事实状态原样反映。
 */
@Injectable()
export class McpService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entityService: EntityService,
    private readonly factService: FactService,
    private readonly archiveService: ArchiveService,
  ) {}

  readonly protocolVersion = '2024-11-05';
  readonly serverInfo = { name: 'ssot-wenzhou-facts', title: '温州有据 · 城市事实', version: '0.1.0' };

  tools(): McpToolDef[] {
    return [
      {
        name: 'get_fact',
        description: '按事实编号（fact_id）读取单条事实：陈述句、状态、时间口径与来源引句。',
        inputSchema: {
          type: 'object',
          properties: {
            fact_id: { type: 'string', description: '事实编号（全网唯一，如 wenzhou-city-trust-F-000512-01），也接受数字 id' },
          },
          required: ['fact_id'],
        },
      },
      {
        name: 'get_entity',
        description: '读取一个城市实体的档案与其当前生效事实（可按 entity_id / urn / slug 之一定位）。',
        inputSchema: {
          type: 'object',
          properties: {
            entity_id: { type: 'number', description: '实体数字 id' },
            urn: { type: 'string', description: '实体 URN' },
            slug: { type: 'string', description: '实体 slug' },
          },
        },
      },
      {
        name: 'search_facts',
        description: '按关键词检索事实陈述句，可限定实体。返回当前口径与状态，不返回已删除内容。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '检索关键词' },
            entity_id: { type: 'number', description: '限定实体数字 id' },
            limit: { type: 'number', description: `返回条数，1-${MAX_LIMIT}，默认 10` },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'search_entities',
        description: '按名称关键词检索城市实体，返回实体名称、类别与生效事实数。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '实体名称关键词' },
            limit: { type: 'number', description: `返回条数，1-${MAX_LIMIT}，默认 10` },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'list_changes',
        description: '读取最近的事实变更流（新增 / 更新 / 佐证 / 退役），用于判断口径是否发生变动。',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: `返回条数，1-${MAX_LIMIT}，默认 10` },
          },
        },
      },
    ];
  }

  /** GET /mcp：服务说明（便于人查看，非 MCP 协议必需） */
  describe() {
    return {
      server: this.serverInfo,
      protocolVersion: this.protocolVersion,
      transport: 'http-jsonrpc',
      methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
      note: '只读服务：不提供任何写操作，事实失效与撤回会同步反映在查询结果中。',
      tools: this.tools().map((t) => ({ name: t.name, description: t.description })),
    };
  }

  /** JSON-RPC 2.0 分发：POST /mcp */
  async handle(payload: unknown): Promise<Record<string, unknown>> {
    const req = payload as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    const id = req?.id ?? null;
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: '无效请求：缺少 method' } };
    }

    try {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: this.protocolVersion,
              serverInfo: this.serverInfo,
              capabilities: { tools: {} },
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.tools() } };
        case 'tools/call': {
          const name = String((req.params?.name as string) ?? '');
          const args = (req.params?.arguments as Record<string, unknown>) ?? {};
          const data = await this.callTool(name, args);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
              isError: false,
            },
          };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `不支持的方法：${req.method}` },
          };
      }
    } catch (err) {
      if (err instanceof McpRpcError) {
        return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : '内部错误' },
      };
    }
  }

  private limitOf(raw: unknown, fallback: number): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(Math.floor(n), MAX_LIMIT);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_fact':
        return this.toolGetFact(args);
      case 'get_entity':
        return this.toolGetEntity(args);
      case 'search_facts':
        return this.toolSearchFacts(args);
      case 'search_entities':
        return this.toolSearchEntities(args);
      case 'list_changes':
        return this.toolListChanges(args);
      default:
        throw new McpRpcError(-32602, `未知工具：${name}`);
    }
  }

  /** 事实编号既支持 code 字符串，也支持数字 id */
  private async resolveFactRow(factId: unknown) {
    const raw = String(factId ?? '').trim();
    if (!raw) throw new McpRpcError(-32602, '缺少参数 fact_id');
    const [row] = /^\d+$/.test(raw)
      ? await this.db.select().from(facts).where(eq(facts.id, Number(raw))).limit(1)
      : await this.db.select().from(facts).where(eq(facts.code, raw)).limit(1);
    if (!row) throw new McpRpcError(-32004, `未找到事实：${raw}`);
    return row;
  }

  private async toolGetFact(args: Record<string, unknown>) {
    const row = await this.resolveFactRow(args.fact_id);
    const detail = await this.factService.detail(row.id);
    const [entity] = await this.db
      .select({ urn: entities.urn, name: entities.name, slug: entities.slug })
      .from(entities)
      .where(eq(entities.id, row.entityId))
      .limit(1);

    return {
      fact_id: row.code ?? `F-${row.id}`,
      fact_type: row.factType,
      entity: { entity_id: row.entityId, urn: entity?.urn, name: entity?.name, slug: entity?.slug },
      dimension: row.dimension,
      statement: row.statement,
      status: row.status,
      confidence: Number(row.confidence ?? 0),
      corroborate_count: row.corroborateCount,
      version: row.version,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      last_verified_at: row.lastVerifiedAt,
      evidence: ((detail.evidences ?? []) as EvidenceRow[]).map((e) => ({
        evidence_id: e.id,
        code: e.code,
        quote: e.quote,
        role: e.role,
        article_id: e.articleId,
        material_title: e.materialTitle,
        source_org: e.sourceOrg,
        published_at: e.publishedAt,
      })),
    };
  }

  private async resolveEntityRow(args: Record<string, unknown>) {
    const id = Number(args.entity_id);
    if (Number.isFinite(id) && id > 0) return this.entityService.findOne(id);
    const urn = typeof args.urn === 'string' ? args.urn.trim() : '';
    const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
    if (!urn && !slug) throw new McpRpcError(-32602, '需要提供 entity_id / urn / slug 之一');
    const [row] = await this.db
      .select()
      .from(entities)
      .where(urn ? eq(entities.urn, urn) : eq(entities.slug, slug))
      .limit(1);
    if (!row || row.deletedAt) throw new McpRpcError(-32004, `未找到实体：${urn || slug}`);
    return row;
  }

  private async toolGetEntity(args: Record<string, unknown>) {
    const row = await this.resolveEntityRow(args);
    const [detail, current] = await Promise.all([
      this.entityService.detail(row.id),
      this.factService.currentByEntity(row.id),
    ]);
    return {
      entity_id: row.id,
      urn: row.urn,
      name: row.name,
      slug: row.slug,
      status: row.status,
      revision: row.revision,
      lede: detail.lede,
      aliases: detail.aliases.map((a) => a.alias),
      facts: current.map((f) => ({
        fact_id: f.code,
        dimension: f.dimension,
        statement: f.statement,
        status: f.status,
        version: f.version,
        confidence: Number(f.confidence ?? 0),
        last_verified_at: f.lastVerifiedAt,
      })),
    };
  }

  private async toolSearchFacts(args: Record<string, unknown>) {
    const keyword = String(args.keyword ?? '').trim();
    if (!keyword) throw new McpRpcError(-32602, '缺少参数 keyword');
    const entityId = Number(args.entity_id);
    const query: ListFactQuery = {
      page: 1,
      pageSize: this.limitOf(args.limit, 10),
      ttlDays: 365,
      keyword,
      entityId: Number.isFinite(entityId) && entityId > 0 ? entityId : undefined,
    };
    const res = await this.factService.list(query);
    return {
      total: res.total,
      items: res.items.map((f) => ({
        fact_id: f.code,
        entity_id: f.entityId,
        dimension: f.dimension,
        statement: f.statement,
        status: f.status,
        confidence: Number(f.confidence ?? 0),
        last_verified_at: f.lastVerifiedAt,
        evidence_count: (f.evidences ?? []).length,
      })),
    };
  }

  private async toolSearchEntities(args: Record<string, unknown>) {
    const keyword = String(args.keyword ?? '').trim();
    if (!keyword) throw new McpRpcError(-32602, '缺少参数 keyword');
    const query: ListEntityQuery = {
      page: 1,
      pageSize: this.limitOf(args.limit, 10),
      order: 'desc',
      sort: 'factCount',
      keyword,
    };
    const res = await this.entityService.list(query);
    return {
      total: res.total,
      items: res.items.map((e) => ({
        entity_id: e.id,
        urn: e.urn,
        name: e.name,
        slug: e.slug,
        category: e.categoryName,
        dataset_code: e.datasetCode,
        fact_count: Number(e.factCount ?? 0),
      })),
    };
  }

  private async toolListChanges(args: Record<string, unknown>) {
    const res = await this.archiveService.listChangesPage(1, this.limitOf(args.limit, 10));
    return {
      total: res.total,
      items: res.items.map((c) => ({
        change_id: c.id,
        change_type: c.changeType,
        summary: c.summary,
        entity: { entity_id: c.entityId, name: c.entityName, slug: c.entitySlug },
        from_statement: c.fromStatement,
        to_statement: c.toStatement,
        dimension: c.toDimension,
        occurred_at: c.occurredAt,
        evidence_url: c.articleUrl,
      })),
    };
  }
}
