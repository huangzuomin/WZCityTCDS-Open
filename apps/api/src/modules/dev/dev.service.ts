import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { count, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { extractTasks, systemSettings } from '../../db/schema';

/**
 * 开发调试：清空抽取管线产出数据 + 已入库的新闻语料（不碰配置）。
 * 保留：entity / entity_alias（实体主数据与别名，人工维护成本高，不随管线清空）、
 *       category / fact_dimension / category_dimension（分类与维度配置）、
 *       llm_setting（大模型设置）、user（账号）。
 */
const PIPELINE_TABLES = [
  'extract_task', // 抽取任务队列
  'extraction_draft', // 事实/事件/关系草稿
  'align_task', // 待人工裁决
  'extraction_run', // 抽取批次
  'entity_relation', // 关系边（知识图谱，实体保留、关系重建）
  'entity_attr_index', // 实体属性索引（派生数据，保留实体本身）
  'entity_article', // 实体-文章关联（随语料清空）
  'fact_evidence', // 事实-证据关联（关键：必须与 fact/evidence 同清，否则旧关联借 id 复生错挂）
  'event_evidence', // 事件-证据关联
  'evidence_entity', // 证据-实体多归属关联（多实体归属改造新增表）
  'graph_node', // 实体/概念镜像节点（派生数据：实体保留时一并重建图谱节点）
  'entity_embedding', // 实体向量（派生数据，保留实体但清向量，避免与新语料不一致）
  'article_hit', // 实体-文章倒排命中
  'relation_reject_sample', // 关系驳回样本
  'validation_result', // 校验结果
  'page_build', // 展示层构建记录
  'ac_scan_job', // AC 扫描任务
  'ac_entity_hit', // AC 命中明细
  'ac_extraction_context', // AC 抽取上下文
  'fact_change', // 事实变更记录
  'fact', // 事实
  'event', // 事件
  'evidence', // 证据
  'llm_call_log', // LLM 调用日志
  'source_article_body', // 已入库新闻正文（先删子表）
  'source_article', // 已入库新闻语料
] as const;

/** 各表中文名，便于前端直接展示 */
const TABLE_LABELS: Record<string, string> = {
  extract_task: '抽取任务',
  extraction_draft: '抽取草稿',
  align_task: '待裁决任务',
  extraction_run: '抽取批次',
  entity_relation: '关系边',
  entity_attr_index: '实体属性',
  entity_article: '实体-文章关联',
  fact_change: '事实变更',
  fact: '事实',
  event: '事件',
  evidence: '证据',
  llm_call_log: 'LLM 调用日志',
  source_article_body: '已入库新闻正文',
  source_article: '已入库新闻语料',
};

@Injectable()
export class DevService {
  private readonly logger = new Logger(DevService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** 各管线表当前行数（清空前预览，让操作者知道会删掉什么） */
  async pipelineStats() {
    const items: { table: string; label: string; rows: number }[] = [];
    let total = 0;
    for (const table of PIPELINE_TABLES) {
      const rows = await this.countOf(table);
      items.push({ table, label: TABLE_LABELS[table] ?? table, rows });
      total += rows;
    }
    const [{ value: running }] = await this.db
      .select({ value: count() })
      .from(extractTasks)
      .where(eq(extractTasks.status, 'running'));
    return { items, total, running: Number(running) };
  }

  /** 一键清空管线产出数据 */
  async clearPipeline() {
    // 安全闸：有任务正在执行时不清理，避免写入被截断的表
    const [{ value: running }] = await this.db
      .select({ value: count() })
      .from(extractTasks)
      .where(eq(extractTasks.status, 'running'));
    if (Number(running) > 0) {
      throw new BadRequestException(
        `有 ${running} 条任务正在执行，请先到「生产线」或「实时新闻」取消排队，等其结束后再清空`,
      );
    }

    const cleared: { table: string; label: string; rows: number }[] = [];
    const failures: { table: string; message: string }[] = [];
    for (const table of PIPELINE_TABLES) {
      const before = await this.countOf(table);
      try {
        await this.db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
        cleared.push({ table, label: TABLE_LABELS[table] ?? table, rows: before });
      } catch (e) {
        failures.push({ table, message: (e as Error).message });
      }
    }

    // 顺带复位新闻调度状态：数据都清空了，上一次的「执行中」不应再挂着
    await this.resetNewsSchedule();

    // 语料都清空了，增量游标一并重置：下次入库回到「取最新 N 条」重新开始
    await this.db.delete(systemSettings).where(eq(systemSettings.skey, 'NEWS_ES_CURSOR'));

    const total = cleared.reduce((s, c) => s + c.rows, 0);
    this.logger.warn(`[dev] 清空管线数据：${cleared.length} 张表 / 共 ${total} 行，失败 ${failures.length} 张`);
    return { cleared, failures, total };
  }

  // ---------------------------------------------------------------- 内部

  private async countOf(table: string): Promise<number> {
    const res = (await this.db.execute(sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``))) as unknown;
    const rows = Array.isArray(res) ? ((res[0] ?? []) as { n?: number | string }[]) : [];
    return Number(rows[0]?.n ?? 0);
  }

  private async resetNewsSchedule(): Promise<void> {
    try {
      const [row] = await this.db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.skey, 'NEWS_SCHEDULE_STATE'))
        .limit(1);
      if (!row) return;
      const st = JSON.parse(row.svalue) as Record<string, unknown>;
      if (!st.running) return;
      st.running = false;
      st.lastStatus = 'error';
      st.lastError = '清空管线数据';
      await this.db
        .update(systemSettings)
        .set({ svalue: JSON.stringify(st) })
        .where(eq(systemSettings.skey, 'NEWS_SCHEDULE_STATE'));
    } catch (e) {
      this.logger.warn(`[dev] 复位新闻调度状态失败：${(e as Error).message}`);
    }
  }
}
