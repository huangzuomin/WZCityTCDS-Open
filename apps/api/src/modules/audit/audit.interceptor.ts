import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';
import { IS_PUBLIC_KEY } from '../../auth/decorators';

/** 路由首段 → 审计目标类型 */
const TARGET_BY_SEGMENT: Record<string, string> = {
  datasets: 'dataset',
  categories: 'category',
  'field-defs': 'field_def',
  entities: 'entity',
  users: 'user',
  articles: 'source_article',
  evidence: 'evidence',
  facts: 'fact',
  events: 'event',
  pipeline: 'extraction_run',
  drafts: 'extraction_draft',
};

const ID_PARAM_KEYS = [
  'id',
  'entityId',
  'articleId',
  'factId',
  'evidenceId',
  'eventId',
  'runId',
  'draftId',
  'categoryId',
  'datasetId',
];

const METHOD_VERB: Record<string, string> = {
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

const SENSITIVE = new Set(['password', 'oldPassword', 'newPassword', 'passwordHash', 'token']);

function sanitize(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k) ? '***' : v;
  }
  return out;
}

/** 全局审计：非 GET 且已登录的写操作自动落 audit_log */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<{
        method: string;
        params?: Record<string, string>;
        body?: unknown;
        user?: { id: number };
        route?: { path?: string };
      }>();

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next.handle();
    }
    if (!req.user?.id) return next.handle();

    const routePath: string = req.route?.path ?? '';
    if (routePath.includes('/auth/')) return next.handle();

    const targetType = this.resolveTargetType(routePath);
    if (!targetType) return next.handle();

    const targetId = this.resolveTargetId(req.params);
    const action = this.resolveAction(req.method, routePath, targetType);

    return next.handle().pipe(
      tap(() => {
        void this.audit
          .record({
            userId: req.user?.id ?? null,
            action,
            targetType,
            targetId,
            after: sanitize(req.body),
          })
          .catch((err: Error) => this.logger.warn(`审计写入失败: ${err.message}`));
      }),
    );
  }

  private resolveTargetType(routePath: string): string | null {
    const segs = routePath.split('/').filter((s) => s && !s.startsWith(':'));
    // 优先取「子资源段」：/pipeline/drafts/:id/approve 的审计目标是草稿(extraction_draft)，
    // 而不是首段 pipeline(extraction_run)；退回首段粗粒度资源（/facts/:id → fact）。
    for (const s of segs.slice(1)) if (TARGET_BY_SEGMENT[s]) return TARGET_BY_SEGMENT[s];
    for (const s of segs) if (TARGET_BY_SEGMENT[s]) return TARGET_BY_SEGMENT[s];
    return null;
  }

  private resolveTargetId(params?: Record<string, string>): number | null {
    if (!params) return null;
    for (const key of ID_PARAM_KEYS) {
      const raw = params[key];
      if (raw && /^\d+$/.test(raw)) return Number(raw);
    }
    return null;
  }

  /** 审核语义动词段：记成 `{目标}.{动作}`（如 extraction_draft.approve），便于按动作检索留痕。 */
  private static readonly ACTION_SEGMENTS = new Set([
    'approve',
    'reject',
    'publish',
    'unpublish',
    'retire',
    'archive',
    'restore',
    'merge',
    'apply',
  ]);

  private resolveAction(method: string, routePath: string, targetType: string): string {
    const segs = routePath.split('/').filter((s) => s && !s.startsWith(':'));
    const last = segs[segs.length - 1];
    if (segs.length > 1 && AuditInterceptor.ACTION_SEGMENTS.has(last)) return `${targetType}.${last}`;
    const verb = METHOD_VERB[method] ?? method.toLowerCase();
    const tail = segs.slice(1);
    const sub = tail.length ? `.${tail.join('_')}` : '';
    return `${targetType}.${verb}${sub}`;
  }
}
