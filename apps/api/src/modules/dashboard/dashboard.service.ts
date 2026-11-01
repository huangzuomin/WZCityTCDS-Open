import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';

/**
 * 运行态驾驶舱聚合：四指标卡 + 两条流 + 最近一次采集运行。
 * 只读聚合，所有查询走 raw SQL（无用户输入，纯聚合）。
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async scalar(query: string): Promise<number> {
    const res = (await this.db.execute(sql.raw(query))) as unknown as [
      Record<string, unknown>[],
      unknown,
    ];
    const r = res[0]?.[0];
    return r ? Number(Object.values(r)[0]) : 0;
  }

  private async rows<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const res = (await this.db.execute(sql.raw(query))) as unknown as [T[], unknown];
    return res[0] ?? [];
  }

  async ops() {
    const [todayNews, pendingDrafts, pendingArbitration] = await Promise.all([
      this.scalar(`SELECT COUNT(*) c FROM source_article WHERE DATE(created_at) = CURDATE()`),
      this.scalar(`SELECT COUNT(*) c FROM extraction_draft WHERE status = 'pending'`),
      this.scalar(`SELECT COUNT(*) c FROM fact WHERE status = 'pending_arbitration'`),
    ]);
    const lastHarvest = await this.rows<{
      runId: number;
      status: string;
      finishedAt: string | null;
      stats: Record<string, unknown> | null;
      taskName: string | null;
    }>(
      `SELECT hr.id runId, hr.status, hr.finished_at finishedAt, hr.stats_json stats, ht.name taskName
       FROM harvest_run hr
       JOIN harvest_task ht ON ht.id = hr.task_id
       ORDER BY hr.id DESC
       LIMIT 1`,
    );

    const recentArticles = await this.rows<{
      id: number;
      title: string;
      url: string;
      publishedAt: string | null;
      createdAt: string;
      hitCount: number;
      hasChange: number;
    }>(
      `SELECT sa.id, sa.title, sa.url, sa.published_at publishedAt, sa.created_at createdAt,
              COALESCE(MAX(ah.hit_count), 0) hitCount,
              CASE WHEN EXISTS(SELECT 1 FROM fact_change fc WHERE fc.article_id = sa.id) THEN 1 ELSE 0 END hasChange
       FROM source_article sa
       LEFT JOIN article_hit ah ON ah.article_id = sa.id
       GROUP BY sa.id, sa.title, sa.url, sa.published_at, sa.created_at
       ORDER BY sa.created_at DESC, sa.id DESC
       LIMIT 10`,
    );

    // 最近一次 AI 引用（口径与观测台一致：cited ∈ fact_page/same_domain 中 probed_at 最近一条）
    const lc = await this.rows<{
      probedAt: string;
      modelId: string;
      question: string;
      cited: string;
      matchedUrl: string | null;
      factCode: string | null;
      datasetCode: string | null;
      slug: string | null;
    }>(
      `SELECT pr.probed_at probedAt, pr.model_id modelId,
              pq.question, pr.cited, pr.matched_url matchedUrl,
              f.code factCode,
              ds.code datasetCode, en.slug slug
       FROM probe_result pr
       JOIN probe_question pq ON pq.id = pr.question_id
       LEFT JOIN fact f ON f.id = pq.fact_id
       LEFT JOIN entity en ON en.id = f.entity_id
       LEFT JOIN dataset ds ON ds.id = en.origin_dataset_id
       WHERE pr.cited IN ('fact_page','same_domain') AND pr.probed_at IS NOT NULL
       ORDER BY pr.probed_at DESC
       LIMIT 1`,
    );
    const lastCitation = lc[0]
      ? {
          at: lc[0].probedAt,
          model: this.modelLabelOf(lc[0].modelId),
          question: lc[0].question,
          cited: lc[0].cited as 'fact_page' | 'same_domain',
          url: lc[0].matchedUrl ?? '',
          factUrl: lc[0].datasetCode && lc[0].slug
            ? `/archive/${lc[0].datasetCode}/${lc[0].slug}`
            : null,
        }
      : null;

    return {
      todayNews,
      pendingDrafts,
      pendingArbitration,
      lastHarvest: lastHarvest[0] ?? null,
      recentArticles,
      lastCitation,
    };
  }

  /** 探针模型显示名：子通道（websearch-unified:doubao → 豆包）映射中文，其余原样 */
  private modelLabelOf(id: string): string {
    const CH_LABELS: Record<string, string> = { doubao: '豆包', yuanbao: '元宝', trae: '字节TRAE', codebuddy: '腾讯CodeBuddy', unified: '统一联网搜索' };
    const idx = id.indexOf(':');
    if (idx > 0) return CH_LABELS[id.slice(idx + 1)] ?? id.slice(idx + 1);
    return id;
  }

  /**
   * 事实质量评估（只读聚合）。
   * 覆盖六个维度：忠实性(R1) / 归属正确性(R2) / 字段符合性(X3) / 信息量(字段分布)
   *             / 支持度(N=corroborate_count) / 自评校准(confidence)。
   */
  async quality() {
    const [draftTotal, factTotal, factActive, factReview] = await Promise.all([
      this.scalar(`SELECT COUNT(*) c FROM extraction_draft`),
      this.scalar(`SELECT COUNT(*) c FROM fact`),
      this.scalar(`SELECT COUNT(*) c FROM fact WHERE status='active'`),
      this.scalar(`SELECT COUNT(*) c FROM fact WHERE status='pending_review'`),
    ]);

    // 逐规则通过率
    const rules = await this.rows<{ ruleCode: string; total: number; failed: number }>(
      `SELECT rule_code ruleCode, COUNT(*) total, SUM(CASE WHEN passed=0 THEN 1 ELSE 0 END) failed
       FROM validation_result GROUP BY rule_code ORDER BY rule_code`,
    );

    // 全通过（任一规则失败的草稿即被拦）
    const passedDrafts = await this.scalar(
      `SELECT COUNT(*) c FROM extraction_draft d
       WHERE NOT EXISTS (SELECT 1 FROM validation_result v WHERE v.target_type='extraction_draft' AND v.target_id=d.id AND v.passed=0)`,
    );

    // 字段分布
    const byDimension = await this.rows<{
      dimension: string; count: number; active: number; review: number; avgN: number;
    }>(
      `SELECT dimension, COUNT(*) count,
              SUM(status='active') active, SUM(status='pending_review') review,
              AVG(corroborate_count) avgN
       FROM fact GROUP BY dimension ORDER BY count DESC`,
    );

    // 置信度分档
    const confBuckets = await this.rows<{ bucket: string; count: number }>(
      `SELECT CASE WHEN confidence IS NULL THEN '未知'
                   WHEN confidence >= 0.9 THEN '0.9~1.0'
                   WHEN confidence >= 0.8 THEN '0.8~0.9'
                   WHEN confidence >= 0.7 THEN '0.7~0.8'
                   WHEN confidence >= 0.6 THEN '0.6~0.7'
                   ELSE '<0.6' END bucket, COUNT(*) count
       FROM fact GROUP BY bucket ORDER BY bucket`,
    );

    // 支持度 N 分档
    const nBuckets = await this.rows<{ bucket: string; count: number }>(
      `SELECT CASE WHEN corroborate_count >= 10 THEN 'N>=10'
                   WHEN corroborate_count >= 5 THEN 'N 5~9'
                   WHEN corroborate_count >= 2 THEN 'N 2~4'
                   ELSE 'N=1' END bucket, COUNT(*) count
       FROM fact GROUP BY bucket ORDER BY bucket`,
    );

    // 事实最多的实体
    const topEntities = await this.rows<{ name: string; factCount: number; maxN: number }>(
      `SELECT e.name, COUNT(f.id) factCount, MAX(f.corroborate_count) maxN
       FROM fact f JOIN entity e ON e.id = f.entity_id
       GROUP BY e.id, e.name ORDER BY factCount DESC, maxN DESC LIMIT 15`,
    );

    // 最近一次抽取运行
    const lastRun = await this.rows<{
      runId: number; model: string; promptVersion: string;
      articleCount: number; status: string; finishedAt: string | null;
    }>(
      `SELECT id runId, model, prompt_version promptVersion, article_count articleCount,
              status, finished_at finishedAt
       FROM extraction_run ORDER BY id DESC LIMIT 1`,
    );

    // 最近一次 AC 扫描
    const lastScan = await this.rows<{
      jobId: number; patternCount: number; articleScanned: number;
      hitArticleCount: number; keptHitCount: number; buildMs: number; scanMs: number;
    }>(
      `SELECT id jobId, pattern_count patternCount, article_scanned articleScanned,
              hit_article_count hitArticleCount, kept_hit_count keptHitCount,
              build_ms buildMs, scan_ms scanMs
       FROM ac_scan_job ORDER BY id DESC LIMIT 1`,
    );

    const ruleMap = Object.fromEntries(rules.map((r) => [r.ruleCode, r]));
    const rate = (code: string) => {
      const r = ruleMap[code];
      return r ? Number((((r.total - r.failed) / r.total) * 100).toFixed(1)) : null;
    };

    return {
      summary: {
        draftTotal,
        passedDrafts,
        rejectedDrafts: draftTotal - passedDrafts,
        passRate: draftTotal ? Number(((passedDrafts / draftTotal) * 100).toFixed(1)) : 0,
        factTotal,
        factActive,
        factReview,
      },
      // 六个质量维度
      metrics: {
        faithfulness: rate('R1_QUOTE_VERBATIM'),      // 忠实性：引句逐字回查
        attribution: rate('R2_SUBJECT_ANCHOR'),        // 归属正确性：主体锚点/作用域
        fieldRouting: rate('X3_FIELD_ROUTING'),        // 字段符合性
        spanBounds: rate('R3_SPAN_BOUNDS'),
        quoteLength: rate('R5_QUOTE_LENGTH'),
        confidenceRange: rate('R4_CONFIDENCE_RANGE'),
        confidenceMin: rate('R7_CONFIDENCE_MIN'),
        nameSplit: rate('X1_NAME_SPLIT'),
        valueLength: rate('X2_VALUE_LENGTH'),
        cooccurrence: rate('X4_COOCCURRENCE'),
        qualityAnchor: rate('X5_QUALITY_ANCHOR'),
        entityType: rate('X6_ENTITY_TYPE'),
      },
      rules,
      byDimension,
      confBuckets,
      nBuckets,
      topEntities,
      lastRun: lastRun[0] ?? null,
      lastScan: lastScan[0] ?? null,
    };
  }

  /**
   * 知识资产聚合（全景 Dashboard 图表数据源）。
   * 四个数据集一次返回：实体按分类、事实按维度、变化按日趋势、关系谓词 Top。
   * 全部只读聚合，走 raw SQL。
   */
  async viz() {
    const [entityByCategory, factByDimension, changeTrend, relationByPredicate, verdicts, counts] =
      await Promise.all([
        this.rows<{ category: string; name: string; count: number }>(
          `SELECT c.code category, MAX(c.name) name, COUNT(*) count
           FROM entity e JOIN category c ON c.id = e.category_id
           WHERE e.status = 'published' AND e.deleted_at IS NULL
           GROUP BY c.code ORDER BY count DESC LIMIT 12`,
        ),
        this.rows<{ dimension: string; count: number }>(
          `SELECT COALESCE(NULLIF(dimension, ''), '未知') dimension, COUNT(*) count
           FROM fact WHERE status = 'active' GROUP BY dimension ORDER BY count DESC LIMIT 15`,
        ),
        this.rows<{ date: string; cntNew: number; cntUpdate: number; cntCorroborate: number; cntRetire: number }>(
          `SELECT DATE(occurred_at) date,
                  SUM(change_type='new') cntNew,
                  SUM(change_type='update') cntUpdate,
                  SUM(change_type='corroborate') cntCorroborate,
                  SUM(change_type='retire') cntRetire
           FROM fact_change
           WHERE occurred_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
           GROUP BY DATE(occurred_at) ORDER BY date`,
        ),
        this.rows<{ predicate: string; count: number }>(
          `SELECT predicate, COUNT(*) count
           FROM entity_relation WHERE status = 'active'
           GROUP BY predicate ORDER BY count DESC LIMIT 12`,
        ),
        this.rows<{ status: string; count: number }>(
          `SELECT status, COUNT(*) count FROM fact GROUP BY status ORDER BY count DESC`,
        ),
        this.rows<{ cnt: number }>(
          `SELECT COUNT(*) cnt FROM entity WHERE status = 'published' AND deleted_at IS NULL
           UNION ALL SELECT COUNT(*) FROM fact WHERE status = 'active'
           UNION ALL SELECT COUNT(*) FROM event WHERE status = 'active'
           UNION ALL SELECT COUNT(*) FROM entity_relation WHERE status = 'active'`,
        ),
      ]);

    const [entityCount, factCount, eventCount, relationCount] = counts.map((r) => Number(r.cnt));

    return {
      entityByCategory,
      factByDimension,
      changeTrend,
      relationByPredicate,
      verdicts,
      counts: { entity: entityCount, fact: factCount, event: eventCount, relation: relationCount },
      generatedAt: new Date().toISOString(),
    };
  }
}
