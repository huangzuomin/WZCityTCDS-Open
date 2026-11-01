import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  decimal,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

/**
 * 说明：
 * 1. 大表（source_article / fact / evidence）不建外键约束，靠索引 + 应用层保证完整性，
 *    避免 400 万行级 DML 的锁与额外开销；小配置表保留外键。
 * 2. 所有时间戳用 timestamp；纯业务日期（发布日、首次入档、最后核验）用 date，便于按日比较。
 * 3. 软删除统一 deleted_at。
 */

const pk = () => bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey();
// MySQL 5.7 不支持 DEFAULT (now())，统一用 CURRENT_TIMESTAMP
const createdAt = () => timestamp('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull();
const updatedAt = () =>
  timestamp('updated_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).onUpdateNow().notNull();
// 可空时间一律用 datetime：MySQL 5.7 strict 模式下 timestamp NULL DEFAULT NULL 会报 ER_INVALID_DEFAULT
const deletedAt = () => datetime('deleted_at', { mode: 'date' });
const nullableAt = (name: string) => datetime(name, { mode: 'date' });

// ---------------------------------------------------------------- 系统 / 权限

export const users = mysqlTable(
  'user',
  {
    id: pk(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 64 }),
    role: mysqlEnum('role', ['admin', 'editor', 'reviewer', 'viewer']).default('viewer').notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    lastLoginAt: nullableAt('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    uqUsername: uniqueIndex('uq_user_username').on(t.username),
  }),
);

export const auditLog = mysqlTable(
  'audit_log',
  {
    id: pk(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: bigint('target_id', { mode: 'number', unsigned: true }),
    beforeJson: json('before_json').$type<Record<string, unknown>>(),
    afterJson: json('after_json').$type<Record<string, unknown>>(),
    remark: varchar('remark', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => ({
    idxTarget: index('idx_audit_target').on(t.targetType, t.targetId),
    idxCreated: index('idx_audit_created').on(t.createdAt),
  }),
);

// ---------------------------------------------------------------- 语料域 / 类别 / 字段

export const datasets = mysqlTable(
  'dataset',
  {
    id: pk(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', ['active', 'archived']).default('active').notNull(),
    sort: int('sort').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCode: uniqueIndex('uq_dataset_code').on(t.code),
  }),
);

/**
 * 分类（v2 全局一棵树）：code 全树唯一、自由命名，不再挂在某个语料域下。
 * 语料域通过 dataset_category 关联可用分类并挑选启用维度子集。
 */
export const categories = mysqlTable(
  'category',
  {
    id: pk(),
    parentId: bigint('parent_id', { mode: 'number', unsigned: true }),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCode: uniqueIndex('uq_category_code').on(t.code),
    idxParent: index('idx_category_parent').on(t.parentId),
  }),
);

/** 语料域 × 分类 关联（v2）：某库关联哪些全局分类 + 该分类下启用哪些维度子集 */
export const datasetCategories = mysqlTable(
  'dataset_category',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => datasets.id),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => categories.id),
    /** 该库对该分类启用的维度子集（fact_dimension.id 数组，空 = 不抽该分类的事实维度） */
    dimIds: json('dim_ids').$type<number[]>(),
    /** 语料域首页：该分类在首页展示的实体数量（0 = 不在首页展示该分类目录；>0 = 首页该目录展示的实体数） */
    homeShow: int('home_show').default(0).notNull(),
    sort: int('sort').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqDatasetCategory: uniqueIndex('uq_dataset_category').on(t.datasetId, t.categoryId),
  }),
);

export const fieldDefs = mysqlTable(
  'field_def',
  {
    id: pk(),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => categories.id),
    key: varchar('key', { length: 64 }).notNull(),
    label: varchar('label', { length: 64 }).notNull(),
    type: mysqlEnum('type', [
      'text',
      'textarea',
      'number',
      'date',
      'select',
      'multiselect',
      'boolean',
      'url',
      'json',
      'entity_ref',
    ]).notNull(),
    required: boolean('required').default(false).notNull(),
    inheritable: boolean('inheritable').default(true).notNull(),
    optionsJson: json('options_json').$type<{ value: string; label: string }[]>(),
    defaultValue: text('default_value'),
    placeholder: varchar('placeholder', { length: 128 }),
    helpText: varchar('help_text', { length: 255 }),
    groupName: varchar('group_name', { length: 64 }),
    sort: int('sort').default(0).notNull(),
    searchable: boolean('searchable').default(false).notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCategoryKey: uniqueIndex('uq_field_category_key').on(t.categoryId, t.key),
    idxCategory: index('idx_field_category').on(t.categoryId),
  }),
);

/** 事实口径分类（v2 全局定义，语料域经 dataset_category 挑选启用子集） */
export const factDimensions = mysqlTable(
  'fact_dimension',
  {
    id: pk(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    /**
     * v1.1 更新策略兜底列：LLM 裁决器缺省时的维度级默认
     * - replace    同槽位新陈述取代旧陈述（原行为，如年产值、产量规模）
     * - accumulate 累积型，同槽位历史记录并存（如获奖记录、荣誉认证）
     * - merge      可归并型，语义等价时累积证据、否则并存
     */
    updatePolicy: mysqlEnum('update_policy', ['replace', 'accumulate', 'merge']).default('replace').notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCode: uniqueIndex('uq_dim_code').on(t.code),
  }),
);

/**
 * 分类 × 维度 多对多映射（v2 全局）：决定某分类可用哪些维度（提示词裁剪 + 新谓词建议）。
 * 语料域在 dataset_category.dim_ids 里再挑选实际启用的子集。
 */
export const categoryDimensions = mysqlTable(
  'category_dimension',
  {
    id: pk(),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true }).notNull(),
    dimensionId: bigint('dimension_id', { mode: 'number', unsigned: true }).notNull(),
    sort: int('sort').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqCatDim: uniqueIndex('uq_cat_dim').on(t.categoryId, t.dimensionId),
  }),
);

/** 事件类型（每语料域可配） */
export const eventTypes = mysqlTable(
  'event_type',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqDatasetCode: uniqueIndex('uq_evtype_dataset_code').on(t.datasetId, t.code),
  }),
);

/** LLM 抽取提示词模板（绑定语料域/类别） */
export const promptTemplates = mysqlTable(
  'prompt_template',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true }),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    version: int('version').default(1).notNull(),
    content: mediumtext('content').notNull(),
    status: mysqlEnum('status', ['draft', 'active', 'archived']).default('draft').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCodeVersion: uniqueIndex('uq_prompt_code_version').on(t.datasetId, t.code, t.version),
  }),
);

// ---------------------------------------------------------------- 实体

export const entities = mysqlTable(
  'entity',
  {
    id: pk(),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true }).notNull(),
    /** v2 溯源用：实体首次来自哪个语料域（实体本身全局唯一，查重池全局） */
    originDatasetId: bigint('origin_dataset_id', { mode: 'number', unsigned: true }),
    urn: varchar('urn', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    lede: text('lede'),
    seedSource: varchar('seed_source', { length: 255 }),
    /** 实体来源：seed=预置种子, llm=模型发现, manual=人工新建, imported=外部导入 */
    source: mysqlEnum('source', ['seed', 'llm', 'manual', 'imported']).default('manual').notNull(),
    attrsJson: json('attrs_json').$type<Record<string, unknown>>(),
    status: mysqlEnum('status', ['draft', 'published', 'archived']).default('draft').notNull(),
    revision: int('revision').default(1).notNull(),
    publishedAt: nullableAt('published_at'),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    uqUrn: uniqueIndex('uq_entity_urn').on(t.urn),
    idxCategory: index('idx_entity_category').on(t.categoryId),
    idxStatus: index('idx_entity_status').on(t.status),
    idxName: index('idx_entity_name').on(t.name),
    idxUpdated: index('idx_entity_updated').on(t.updatedAt),
  }),
);

export const entityAliases = mysqlTable(
  'entity_alias',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    alias: varchar('alias', { length: 255 }).notNull(),
    source: varchar('source', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEntityAlias: uniqueIndex('uq_alias_entity').on(t.entityId, t.alias),
    idxAlias: index('idx_alias_name').on(t.alias),
  }),
);

/** 需要筛选/排序的自定义字段冗余到这里，避免全表扫 JSON */
export const entityAttrIndex = mysqlTable(
  'entity_attr_index',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    fieldKey: varchar('field_key', { length: 64 }).notNull(),
    valueVarchar: varchar('value_varchar', { length: 255 }),
    valueNumber: decimal('value_number', { precision: 20, scale: 6 }),
    valueDate: date('value_date', { mode: 'string' }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEntityKey: uniqueIndex('uq_attr_entity_key').on(t.entityId, t.fieldKey),
    idxKeyValue: index('idx_attr_key_value').on(t.fieldKey, t.valueVarchar),
  }),
);

// ---------------------------------------------------------------- 语料

export const sourceArticles = mysqlTable(
  'source_article',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    sourceSite: varchar('source_site', { length: 64 }),
    sourceOrg: varchar('source_org', { length: 128 }),
    title: varchar('title', { length: 512 }).notNull(),
    url: varchar('url', { length: 1024 }).notNull(),
    urlHash: char('url_hash', { length: 64 }).notNull(),
    externalId: varchar('external_id', { length: 64 }),
    publishedAt: date('published_at', { mode: 'string' }),
    batch: mysqlEnum('batch', ['baseline', 'incremental']).default('baseline').notNull(),
    contentHash: char('content_hash', { length: 64 }),
    bodyVersion: int('body_version').default(1).notNull(),
    quality: mysqlEnum('quality', ['A', 'B', 'C', 'D']).default('B').notNull(),
    status: mysqlEnum('status', ['raw', 'cleaned', 'archived']).default('raw').notNull(),
    /** 文章主题（LLM 抽取，一句话，不含标点结尾）；事实稿页面的标题位 */
    theme: varchar('theme', { length: 512 }),
    /** 文章所属主题（每篇文章一个主题，跨文章按 canonical_key 归并）；/facts/{topicId} 聚合口径 */
    topicId: bigint('topic_id', { mode: 'number', unsigned: true }),
    /** 文章摘要（LLM 抽取，客观转述，含关键时间/数字/主体）；事实稿页面的导语位 */
    summary: text('summary'),
    /** 核心数据（LLM 抽取）：[{ value: '12', label: '场平行论坛' }]，事实稿页面的事实概览指标卡 */
    keyStats: json('key_stats'),
    /**
     * 结构化核心数据（PRD R03）：[{ metricKey, valueText, unit, period, region, scope, approx, legacy }]
     * 旧 key_stats 保留用于降级读取；只有 v2 中字段齐全的指标才允许上首屏。
     */
    keyStatsV2: json('key_stats_v2'),
    /** 文章主题/摘要的 LLM 产出时间与提示词版本，便于回溯重跑 */
    briefAt: nullableAt('brief_at'),
    briefPromptVersion: varchar('brief_prompt_version', { length: 32 }),
    fetchedAt: nullableAt('fetched_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqUrlHash: uniqueIndex('uq_article_url_hash').on(t.urlHash),
    idxDatasetPub: index('idx_article_dataset_pub').on(t.datasetId, t.publishedAt),
    idxContentHash: index('idx_article_content_hash').on(t.contentHash),
    idxBatch: index('idx_article_batch').on(t.datasetId, t.batch),
    idxTopic: index('idx_article_topic').on(t.topicId),
  }),
);

// ---------------------------------------------------------------- 主题（事实聚合口径）

/**
 * 主题：一篇文章一个主题，多篇报道可归并到同一主题（如「2026世界青年科学家峰会」）。
 * - canonicalKey 是归并主键（去修饰词/标点/全半角后的小写键），唯一索引兜底并发重复建档
 * - aliases 冗余存别名（同时落 topic_alias 供精确命中）
 * - 合并只置 status='merged' + mergedIntoId，不改写历史 fact_topic，读取时沿链归并
 */
export const topics = mysqlTable(
  'topic',
  {
    id: pk(),
    code: varchar('code', { length: 64 }),
    name: varchar('name', { length: 255 }).notNull(),
    canonicalKey: varchar('canonical_key', { length: 191 }).notNull(),
    aliases: json('aliases'),
    definition: text('definition'),
    status: mysqlEnum('status', ['active', 'merged', 'archived']).default('active').notNull(),
    mergedIntoId: bigint('merged_into_id', { mode: 'number', unsigned: true }),
    /** 主题签发状态（双重门禁之一）：只有 published 的主题才对外公开 */
    publicationStatus: mysqlEnum('publication_status', ['private', 'preview', 'published', 'withdrawn'])
      .default('private')
      .notNull(),
    /** 当前公开的签发版本（topic_revision.id） */
    publishedRevisionId: bigint('published_revision_id', { mode: 'number', unsigned: true }),
    publishedAt: datetime('published_at', { mode: 'date' }),
    /** 主题下最早/最新报道日（回填与增量维护，便于排序与展示） */
    firstArticleAt: date('first_article_at', { mode: 'string' }),
    lastArticleAt: date('last_article_at', { mode: 'string' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCanonical: uniqueIndex('uq_topic_canonical').on(t.canonicalKey),
    uqCode: uniqueIndex('uq_topic_code').on(t.code),
    idxStatus: index('idx_topic_status').on(t.status, t.lastArticleAt),
  }),
);

/** 主题别名（主题名 / 简称 / 英文名等），alias_key 唯一即「别名全局唯一指向一个主题」 */
export const topicAliases = mysqlTable(
  'topic_alias',
  {
    id: pk(),
    topicId: bigint('topic_id', { mode: 'number', unsigned: true }).notNull(),
    alias: varchar('alias', { length: 255 }).notNull(),
    aliasKey: varchar('alias_key', { length: 191 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqAliasKey: uniqueIndex('uq_topic_alias_key').on(t.aliasKey),
    idxTopic: index('idx_topic_alias_topic').on(t.topicId),
  }),
);

/**
 * 主题签发快照（PRD R05）：发布/回滚原子化，HTML/JSON/JSON-LD/sitemap 同版本渲染。
 * payload 记录签发时的事实 ID+版本清单、栏目、指标卡与排序，页面不再实时拼装。
 */
export const topicRevisions = mysqlTable(
  'topic_revision',
  {
    id: pk(),
    topicId: bigint('topic_id', { mode: 'number', unsigned: true }).notNull(),
    rev: int('rev').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    definition: text('definition'),
    aliases: json('aliases'),
    payload: json('payload').notNull(),
    factCount: int('fact_count').default(0).notNull(),
    signedBy: bigint('signed_by', { mode: 'number', unsigned: true }),
    signedAt: timestamp('signed_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    uqTopicRev: uniqueIndex('uq_topic_rev').on(t.topicId, t.rev),
    idxSigned: index('idx_topic_revision_signed').on(t.topicId, t.signedAt),
  }),
);

/**
 * 事实 × 主题：一条事实可挂「主主题 + 附带主题」。
 * - primary：事实归属于该主题页（同一事实只应有一条 primary，读取时按 confidence/created 取一条兜底）
 * - secondary：事实在文章主题下顺带出现，用于溯源与文章页标注，不进主题页聚合
 */
export const factTopics = mysqlTable(
  'fact_topic',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }).notNull(),
    topicId: bigint('topic_id', { mode: 'number', unsigned: true }).notNull(),
    role: mysqlEnum('role', ['primary', 'secondary']).default('primary').notNull(),
    confidence: decimal('confidence', { precision: 4, scale: 3 }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqFactTopic: uniqueIndex('uq_fact_topic').on(t.factId, t.topicId),
    idxTopicRole: index('idx_fact_topic_topic_role').on(t.topicId, t.role),
    idxFact: index('idx_fact_topic_fact').on(t.factId),
  }),
);

/** 正文垂直拆分：列表查询永不触碰大字段 */
export const sourceArticleBodies = mysqlTable('source_article_body', {
  articleId: bigint('article_id', { mode: 'number', unsigned: true }).primaryKey(),
  bodySlice: mediumtext('body_slice'),
  bodyRaw: mediumtext('body_raw'),
  sliceRule: varchar('slice_rule', { length: 64 }),
  updatedAt: updatedAt(),
});

/** 实体 → 文章 倒排表（AC 自动机批量构建，供管线召回，不依赖搜索引擎） */
export const articleHits = mysqlTable(
  'article_hit',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }).notNull(),
    hitCount: int('hit_count').default(0).notNull(),
    firstOffset: int('first_offset').default(0).notNull(),
    matchedAlias: varchar('matched_alias', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEntityArticle: uniqueIndex('uq_hit_entity_article').on(t.entityId, t.articleId),
    idxArticle: index('idx_hit_article').on(t.articleId),
  }),
);

/** 实体与相关新闻的显式关联（含未产生证据的报道） */
export const entityArticles = mysqlTable(
  'entity_article',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }).notNull(),
    role: mysqlEnum('role', ['baseline', 'incremental', 'reference']).default('reference').notNull(),
    isRelevant: boolean('is_relevant').default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEntityArticle: uniqueIndex('uq_entity_article').on(t.entityId, t.articleId),
    idxArticle: index('idx_ea_article').on(t.articleId),
  }),
);

// ---------------------------------------------------------------- 证据 / 事实 / 事件

/** 来源发布主体（PRD R01）：替代 evidence.source_org 自由文本，用于独立性判定 */
export const sources = mysqlTable(
  'source',
  {
    id: pk(),
    // MySQL 5.7 + utf8mb4：联合唯一键总长度需 < 1000 字节（(96+128)*4=896）
    publisher: varchar('publisher', { length: 96 }).notNull(),
    domain: varchar('domain', { length: 128 }),
    sourceType: mysqlEnum('source_type', ['media', 'official', 'primary', 'unknown']).default('unknown').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqPublisher: uniqueIndex('uq_source_publisher').on(t.publisher, t.domain),
  }),
);

/**
 * 来源家族（PRD R01）：同文转载 / 同稿多站 / 同一原文的多个 URL 归为一族。
 * 独立性判定只按"家族"计，不按文章条数计。
 */
export const sourceFamilies = mysqlTable(
  'source_family',
  {
    id: pk(),
    clusterKey: varchar('cluster_key', { length: 191 }).notNull(),
    originalSourceId: bigint('original_source_id', { mode: 'number', unsigned: true }),
    originType: mysqlEnum('origin_type', ['original', 'reprint', 'official', 'statement', 'unknown'])
      .default('unknown')
      .notNull(),
    memberCount: int('member_count').default(0).notNull(),
    decidedBy: mysqlEnum('decided_by', ['rule', 'human', 'llm_suggest']).default('rule').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqClusterKey: uniqueIndex('uq_source_family_key').on(t.clusterKey),
  }),
);

export const evidences = mysqlTable(
  'evidence',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }).notNull(),
    code: varchar('code', { length: 64 }),
    sourceOrg: varchar('source_org', { length: 128 }),
    /** 来源主体与来源家族（PRD R01）：独立性判定按家族计，不按文章条数计 */
    sourceId: bigint('source_id', { mode: 'number', unsigned: true }),
    sourceFamilyId: bigint('source_family_id', { mode: 'number', unsigned: true }),
    originType: mysqlEnum('origin_type', ['original', 'reprint', 'official', 'statement', 'unknown'])
      .default('unknown')
      .notNull(),
    supportRelation: mysqlEnum('support_relation', ['direct', 'qualified', 'mention', 'conflict'])
      .default('direct')
      .notNull(),
    independence: mysqlEnum('independence', ['independent', 'same_family', 'unknown']).default('unknown').notNull(),
    materialTitle: varchar('material_title', { length: 512 }),
    sourceUrl: varchar('source_url', { length: 1024 }),
    publishedAt: date('published_at', { mode: 'string' }),
    quote: text('quote'),
    spanStart: int('span_start').notNull(),
    spanEnd: int('span_end').notNull(),
    spanHash: char('span_hash', { length: 64 }).notNull(),
    assetUrn: varchar('asset_urn', { length: 255 }),
    bodyVersion: int('body_version').default(1).notNull(),
    qualityGrade: mysqlEnum('quality_grade', ['A', 'B', 'C', 'D']).default('B').notNull(),
    verifyStatus: mysqlEnum('verify_status', ['pending', 'passed', 'failed']).default('pending').notNull(),
    verifyDetail: text('verify_detail'),
    batch: mysqlEnum('batch', ['baseline', 'incremental']).default('baseline').notNull(),
    origin: mysqlEnum('origin', ['llm', 'human', 'import']).default('llm').notNull(),
    status: mysqlEnum('status', ['draft', 'active', 'rejected']).default('draft').notNull(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCode: uniqueIndex('uq_evidence_code').on(t.code),
    uqSpan: uniqueIndex('uq_evidence_span').on(t.articleId, t.spanHash),
    idxEntityStatus: index('idx_evidence_entity').on(t.entityId, t.status),
    idxArticle: index('idx_evidence_article').on(t.articleId),
    idxVerify: index('idx_evidence_verify').on(t.verifyStatus),
  }),
);

/** 证据归属实体（多对多）：一条证据可支撑多个实体的事实。
 *  evidence.entity_id 保留为首归冗余（编号/assetUrn 仍用它）；真实多归属在此登记。 */
export const evidenceEntities = mysqlTable(
  'evidence_entity',
  {
    id: pk(),
    evidenceId: bigint('evidence_id', { mode: 'number', unsigned: true }).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    role: mysqlEnum('role', ['primary', 'share']).default('share').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEvidenceEntity: uniqueIndex('uq_evidence_entity').on(t.evidenceId, t.entityId),
  }),
);

/** 事实：append-only，内容变更产生新版本行，旧行转 superseded */
export const facts = mysqlTable(
  'fact',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    code: varchar('code', { length: 64 }),
    dimensionId: bigint('dimension_id', { mode: 'number', unsigned: true }),
    dimension: varchar('dimension', { length: 64 }),
    statement: text('statement').notNull(),
    factType: mysqlEnum('fact_type', ['current_state', 'source_claim', 'occurred']).default('source_claim').notNull(),
    status: mysqlEnum('status', [
      'draft',
      'pending_review',
      'active',
      'superseded',
      'pending_arbitration',
      'rejected',
      'archived',
    ])
      .default('draft')
      .notNull(),
    /**
     * 双重门禁（PRD R05）：审核状态与发布状态分离。
     * 公开可见 = status='active' AND review_status='approved' AND publication_status='published'
     */
    reviewStatus: mysqlEnum('review_status', ['candidate', 'approved', 'rejected']).default('candidate').notNull(),
    publicationStatus: mysqlEnum('publication_status', ['private', 'published', 'withdrawn']).default('private').notNull(),
    signedAt: datetime('signed_at', { mode: 'date' }),
    signedBy: bigint('signed_by', { mode: 'number', unsigned: true }),
    /** 断言形态（PRD R02）：修辞/观点不得自动成为可公开的客观断言 */
    statementKind: mysqlEnum('statement_kind', ['claim', 'attributed', 'opinion', 'rhetoric', 'plan'])
      .default('claim')
      .notNull(),
    confidence: decimal('confidence', { precision: 4, scale: 3 }).default('0.500').notNull(),
    corroborateCount: int('corroborate_count').default(1).notNull(),
    firstSeenAt: date('first_seen_at', { mode: 'string' }),
    lastVerifiedAt: date('last_verified_at', { mode: 'string' }),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    supersededById: bigint('superseded_by_id', { mode: 'number', unsigned: true }),
    version: int('version').default(1).notNull(),
    arbitrationNote: text('arbitration_note'),
    /**
     * v1.1 归并裁决三轴（由逐条 LLM 裁决器输出，冗余存储以承载槽位语义）：
     * - semanticRole 事实语义角色；record（获奖/记录类）受硬规则保护，永不被 supersede
     * - periodKey    时间槽位键（如 2025 / 2025-Q1 / 2026-03），区分跨期指标
     * - subjectScope 主体范围（如同一维度的不同口径/子对象）
     * 三者与 entity_id + dimension 共同构成「槽位」，见 idx_fact_slot
     */
    semanticRole: mysqlEnum('semantic_role', [
      'metric',
      'trend',
      'ratio',
      'comparison',
      'record',
      'definition',
    ]),
    periodKey: varchar('period_key', { length: 32 }),
    subjectScope: varchar('subject_scope', { length: 128 }),
    /** 时间精度：年份精度不得被精确化为 01-01（PRD R03） */
    timePrecision: mysqlEnum('time_precision', ['unknown', 'year', 'quarter', 'month', 'day'])
      .default('unknown')
      .notNull(),
    /** 时间确定性：exact 原文明确 / inferred 由规则推断 / declared 来源自述 */
    timeCertainty: mysqlEnum('time_certainty', ['unknown', 'exact', 'inferred', 'declared'])
      .default('unknown')
      .notNull(),
    origin: mysqlEnum('origin', ['llm', 'human', 'import']).default('llm').notNull(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    updatedBy: bigint('updated_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // ---- v2 事实详情页增强（对齐产品原型：时间语义 / 签发责任 / 告警 / 修订链入口） ----
    /** 时间语义类型：决定「适用性」标签（当前/待生效/历史/计划/截至）。缺省 unknown 走旧口径兜底 */
    temporalKind: mysqlEnum('temporal_kind', [
      'unknown',
      'effective',
      'event',
      'historical',
      'period',
      'plan',
      'as_of',
    ])
      .default('unknown')
      .notNull(),
    /** 截至时间（区别于 validFrom/validTo：用于「截至报道日」类事实） */
    asOf: date('as_of', { mode: 'string' }),
    /** 事件发生起始（event 类事实） */
    eventStart: date('event_start', { mode: 'string' }),
    /** 事件发生结束（event 类事实） */
    eventEnd: date('event_end', { mode: 'string' }),
    /** 核对方式（如「报道依据核对」「机构通知核对」） */
    method: varchar('method', { length: 128 }),
    /** 签发方式：存量导入 / 自动规则签发 / 人工签发 */
    signMode: mysqlEnum('sign_mode', ['import', 'auto', 'human']).default('human').notNull(),
    /** 来源权威类型（新闻报道转述 / 机构通知 / 采访记录 / 模拟） */
    sourceAuthority: varchar('source_authority', { length: 128 }),
    /** 是否经过独立真实性现场核验（不随签发自动产生） */
    independentlyVerified: boolean('independently_verified').default(false).notNull(),
    /** 本修订签发时刻（区别于 created_at/updated_at/核验日） */
    issuedAt: datetime('issued_at'),
    /** 事实级告警（如「存量提取错误，待人工更正」） */
    alerts: json('alerts').$type<string[]>().default([]),
    /**
     * 规范事实（PRD R02）：同一事件/同一引句因挂不同实体被重复建档时，非代表条指向代表条。
     * 公开页面只展示 canonical_fact_id IS NULL 的那条，其余实体在 fact_entity 里以 participant 保留。
     */
    canonicalFactId: bigint('canonical_fact_id', { mode: 'number', unsigned: true }),
  },
  (t) => ({
    uqCode: uniqueIndex('uq_fact_code').on(t.code),
    idxEntityStatus: index('idx_fact_entity_status').on(t.entityId, t.status),
    idxEntityCode: index('idx_fact_entity_code').on(t.entityId, t.code),
    idxVerified: index('idx_fact_verified').on(t.lastVerifiedAt),
    idxSuperseded: index('idx_fact_superseded').on(t.supersededById),
    /** v1.1 槽位复合索引：entity + dimension + 裁决三轴，用于定位同槽位现行事实 */
    idxSlot: index('idx_fact_slot').on(t.entityId, t.dimension, t.semanticRole, t.periodKey, t.subjectScope),
    /** 公开发布门禁：所有公开出口按这三列过滤 */
    idxPublic: index('idx_fact_public').on(t.publicationStatus, t.reviewStatus, t.status),
    idxKind: index('idx_fact_kind').on(t.statementKind),
    idxCanonical: index('idx_fact_canonical').on(t.canonicalFactId),
  }),
);

/**
 * 事实 × 实体（PRD R02）：一条事实可挂多个主体，区分 primary / participant / mentioned。
 * fact.entity_id 保留为主实体冗余列，多主体关系在此登记。
 */
export const factEntities = mysqlTable(
  'fact_entity',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    role: mysqlEnum('role', ['primary', 'participant', 'mentioned']).default('participant').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqFactEntity: uniqueIndex('uq_fact_entity').on(t.factId, t.entityId),
    idxEntity: index('idx_fact_entity_entity').on(t.entityId),
  }),
);

export const factEvidences = mysqlTable(
  'fact_evidence',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }).notNull(),
    evidenceId: bigint('evidence_id', { mode: 'number', unsigned: true }).notNull(),
    role: mysqlEnum('role', ['support', 'refute']).default('support').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqFactEvidence: uniqueIndex('uq_fact_evidence').on(t.factId, t.evidenceId),
    idxEvidence: index('idx_fe_evidence').on(t.evidenceId),
  }),
);

/** 事实变化：不是日志，是页面上独立展示的因果链 */
export const factChanges = mysqlTable(
  'fact_change',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    changeType: mysqlEnum('change_type', ['new', 'update', 'corroborate', 'retire']).notNull(),
    occurredAt: date('occurred_at', { mode: 'string' }),
    fromFactId: bigint('from_fact_id', { mode: 'number', unsigned: true }),
    toFactId: bigint('to_fact_id', { mode: 'number', unsigned: true }),
    summary: varchar('summary', { length: 512 }),
    rationale: text('rationale'),
    mechanismJson: json('mechanism_json').$type<Record<string, unknown>>(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    idxEntity: index('idx_change_entity').on(t.entityId, t.occurredAt),
    idxFrom: index('idx_change_from').on(t.fromFactId),
    idxTo: index('idx_change_to').on(t.toFactId),
  }),
);

/**
 * 事实逐版不可变修订快照（append-only）。
 * 原系统的 fact 表只存「当前版本」的 statement/validFrom…，旧版值不在库；
 * 本表在每次产生新事实行时落一份完整快照，支撑详情页「修订轨迹 / 查看旧版」。
 */
export const factRevisions = mysqlTable(
  'fact_revision',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }).notNull(),
    rev: int('rev').notNull(),
    statement: text('statement').notNull(),
    dimension: varchar('dimension', { length: 64 }),
    factType: mysqlEnum('fact_type', ['current_state', 'source_claim', 'occurred']),
    confidence: decimal('confidence', { precision: 4, scale: 3 }),
    temporalKind: varchar('temporal_kind', { length: 16 }),
    asOf: date('as_of', { mode: 'string' }),
    eventStart: date('event_start', { mode: 'string' }),
    eventEnd: date('event_end', { mode: 'string' }),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    /** subjectScope 快照（限定条件/口径） */
    qualifier: varchar('qualifier', { length: 128 }),
    /** 本版挂载的证据 id 列表（快照，避免旧版证据随当前关联变动而失真） */
    evidenceIds: json('evidence_ids').$type<number[]>().default([]),
    method: varchar('method', { length: 128 }),
    signMode: varchar('sign_mode', { length: 16 }),
    sourceAuthority: varchar('source_authority', { length: 128 }),
    independentlyVerified: boolean('independently_verified').default(false).notNull(),
    /** 签发/编辑责任（创建者 id 快照） */
    actor: bigint('actor', { mode: 'number', unsigned: true }),
    /** 该版发布状态快照（released/withdrawn/…） */
    release: varchar('release', { length: 16 }),
    /** 版本变更类型：initial/update/correction/state_change/interval_closed/retire */
    changeType: varchar('change_type', { length: 24 }).notNull().default('initial'),
    reason: text('reason'),
    issuedAt: datetime('issued_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    uqFactRev: uniqueIndex('uq_fact_revision').on(t.factId, t.rev),
    idxFact: index('idx_fact_revision_fact').on(t.factId, t.rev),
  }),
);

/**
 * 事实间关系（版本继承 / 更正链）：succeeds（新事实取代旧）、corrected_by（被某版更正）、same_period（同口径跨期）。
 * 与图谱 relation 表用途不同，这里表达的是「事实版本演进」语义。
 */
export const factRelations = mysqlTable(
  'fact_relation',
  {
    id: pk(),
    fromFactId: bigint('from_fact_id', { mode: 'number', unsigned: true }).notNull(),
    toFactId: bigint('to_fact_id', { mode: 'number', unsigned: true }).notNull(),
    type: mysqlEnum('type', ['succeeds', 'succeeded_by', 'corrected_by', 'same_period', 'corroborates'])
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqFromTo: uniqueIndex('uq_fact_relation').on(t.fromFactId, t.toFactId, t.type),
    idxTo: index('idx_fact_relation_to').on(t.toFactId),
  }),
);

export const events = mysqlTable(
  'event',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    typeId: bigint('type_id', { mode: 'number', unsigned: true }),
    eventType: varchar('event_type', { length: 64 }),
    timeText: varchar('time_text', { length: 64 }),
    timePrecision: mysqlEnum('time_precision', ['dynasty', 'decade', 'year', 'month', 'day']),
    timeStart: date('time_start', { mode: 'string' }),
    timeEnd: date('time_end', { mode: 'string' }),
    isInferred: boolean('is_inferred').default(false).notNull(),
    location: varchar('location', { length: 255 }),
    subject: varchar('subject', { length: 255 }),
    description: text('description'),
    quote: text('quote'),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    status: mysqlEnum('status', ['draft', 'active', 'rejected']).default('draft').notNull(),
    origin: mysqlEnum('origin', ['llm', 'human', 'import']).default('llm').notNull(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idxEntityTime: index('idx_event_entity_time').on(t.entityId, t.timeStart),
    idxEntityStatus: index('idx_event_entity_status').on(t.entityId, t.status),
  }),
);

export const eventEvidences = mysqlTable(
  'event_evidence',
  {
    id: pk(),
    eventId: bigint('event_id', { mode: 'number', unsigned: true }).notNull(),
    evidenceId: bigint('evidence_id', { mode: 'number', unsigned: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqEventEvidence: uniqueIndex('uq_event_evidence').on(t.eventId, t.evidenceId),
    idxEvidence: index('idx_ee_evidence').on(t.evidenceId),
  }),
);

// ---------------------------------------------------------------- 知识图谱（实体-实体关系）

/**
 * 实体关系（图谱的边）：head → predicate → tail。
 * - predicate：归一后的标准关系码（自由谓词经 predicate_map 归一沉淀）
 * - 尾实体允许是新候选：tailEntityId 为空时只存 tailText/tailType，审核通过时才建实体并回填
 */
export const entityRelations = mysqlTable(
  'entity_relation',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    headEntityId: bigint('head_entity_id', { mode: 'number', unsigned: true }).notNull(),
    /** 归一后的标准关系码，如 rel_隶属 */
    predicate: varchar('predicate', { length: 64 }).notNull(),
    /** 模型自由生成的原始谓词（保留以便追溯与再归一） */
    predicateRaw: varchar('predicate_raw', { length: 64 }),
    tailEntityId: bigint('tail_entity_id', { mode: 'number', unsigned: true }),
    tailText: varchar('tail_text', { length: 255 }).notNull(),
    /** 尾实体类型（新候选建实体时用，如 org.company） */
    tailType: varchar('tail_type', { length: 64 }),
    /** 节点层引用：实体端 = 该实体镜像的 graph_node.id；概念端 = 概念节点 id（可空，旧数据兼容） */
    headNodeId: bigint('head_node_id', { mode: 'number', unsigned: true }),
    /** 节点层引用：尾端非实体（概念/食材等）时指向 graph_node.id，tailEntityId 留空 */
    tailNodeId: bigint('tail_node_id', { mode: 'number', unsigned: true }),
    /** 展示用的一句话陈述：A 关系 B */
    statement: varchar('statement', { length: 512 }),
    confidence: decimal('confidence', { precision: 4, scale: 3 }).default('0.800').notNull(),
    status: mysqlEnum('status', ['active', 'superseded', 'rejected']).default('active').notNull(),
    version: int('version').default(1).notNull(),
    supersededById: bigint('superseded_by_id', { mode: 'number', unsigned: true }),
    /** 多篇文章/多次审核命中同一条边的次数（同事实的 corroborate 语义） */
    corroborateCount: int('corroborate_count').default(1).notNull(),
    origin: mysqlEnum('origin', ['llm', 'manual', 'import', 'fact']).default('llm').notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    evidenceId: bigint('evidence_id', { mode: 'number', unsigned: true }),
    dedupeKey: char('dedupe_key', { length: 64 }),
    firstSeenAt: nullableAt('first_seen_at'),
    lastVerifiedAt: nullableAt('last_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idxHead: index('idx_rel_head').on(t.headEntityId, t.status),
    idxTail: index('idx_rel_tail').on(t.tailEntityId, t.status),
    idxDatasetPred: index('idx_rel_dataset_pred').on(t.datasetId, t.predicate),
    idxDedupe: index('idx_rel_dedupe').on(t.dedupeKey),
  }),
);

// ---------------------------------------------------------------- 图谱节点层（实体 ∪ 概念）

/**
 * 图谱节点：节点 = 实体 ∪ 概念。
 * - node_type=entity：镜像实体（entityId 指向 entity.id），供图谱统一节点空间
 * - node_type=concept：非实体节点（食材/口味/工艺等，如「面粉」「保留食物原味」），
 *   由关系草稿批准时按 tailType 自动创建，不再为此新造草稿实体
 * 关系事实层仍是 entity_relation（置信度/印证/证据/版本/反转都在它上面）。
 */
export const graphNodes = mysqlTable(
  'graph_node',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    nodeType: mysqlEnum('node_type', ['entity', 'concept']).default('concept').notNull(),
    /** node_type=entity 时指向 entity.id */
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    /** 概念类型（分类 code，如 culture.food / concept） */
    categoryCode: varchar('category_code', { length: 64 }),
    /** 概念首次出现的文章 */
    sourceArticleId: bigint('source_article_id', { mode: 'number', unsigned: true }),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqDatasetName: uniqueIndex('uq_node_dataset_name').on(t.datasetId, t.name),
    idxNodeType: index('idx_node_type').on(t.nodeType),
    idxNodeEntity: index('idx_node_entity').on(t.entityId),
  }),
);

// ---------------------------------------------------------------- 管线 / 审核

/** 关系驳回样本（人工/大模型审批驳回的边）：供关系判别式验证器动态注入 few-shot 反例 */
export const relationRejectSamples = mysqlTable(
  'relation_reject_sample',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    head: varchar('head', { length: 255 }).notNull(),
    predicate: varchar('predicate', { length: 128 }).notNull(),
    tail: varchar('tail', { length: 255 }).notNull(),
    quote: text('quote'),
    reason: varchar('reason', { length: 512 }),
    claimHash: char('claim_hash', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uqClaimHash: uniqueIndex('uq_reject_claim_hash').on(t.claimHash),
    idxDatasetCreated: index('idx_reject_dataset_created').on(t.datasetId, t.id),
  }),
);

/** 关系抽取 schema（按 head 实体分类 × tail 类型给关系词）：提示词动态注入，后台可维护 */
export const relationSchemas = mysqlTable(
  'relation_schema',
  {
    id: pk(),
    categoryId: bigint('category_id', { mode: 'number', unsigned: true }).notNull(),
    /** 尾实体类型（分类 code，如 org/person/geo/culture.food） */
    tailType: varchar('tail_type', { length: 64 }).notNull(),
    /** 该类型组合的建议关系词（LLM 从中选，schema 外可自拟） */
    relations: json('relations').$type<string[]>().notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqCatTail: uniqueIndex('uq_schema_cat_tail').on(t.categoryId, t.tailType),
  }),
);

export const extractionRuns = mysqlTable(
  'extraction_run',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    promptTemplateId: bigint('prompt_template_id', { mode: 'number', unsigned: true }),
    batchType: mysqlEnum('batch_type', ['baseline', 'incremental']).notNull(),
    model: varchar('model', { length: 64 }),
    promptVersion: varchar('prompt_version', { length: 32 }),
    articleCount: int('article_count').default(0).notNull(),
    status: mysqlEnum('status', ['pending', 'running', 'succeeded', 'failed']).default('pending').notNull(),
    statsJson: json('stats_json').$type<Record<string, unknown>>(),
    errorMsg: text('error_msg'),
    startedAt: nullableAt('started_at'),
    finishedAt: nullableAt('finished_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxDatasetStatus: index('idx_run_dataset').on(t.datasetId, t.status),
  }),
);

export const extractionDrafts = mysqlTable(
  'extraction_draft',
  {
    id: pk(),
    runId: bigint('run_id', { mode: 'number', unsigned: true }).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    /** entity=新发现的候选实体（此时 entityId 为空，审核通过后才建实体）；relation=知识图谱的实体关系 */
    targetType: mysqlEnum('target_type', ['fact', 'evidence', 'event', 'change', 'entity', 'relation']).notNull(),
    payloadJson: json('payload_json').$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum('status', ['pending', 'approved', 'rejected']).default('pending').notNull(),
    reviewedBy: bigint('reviewed_by', { mode: 'number', unsigned: true }),
    reviewedAt: nullableAt('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxRunStatus: index('idx_draft_run_status').on(t.runId, t.status),
    idxEntity: index('idx_draft_entity').on(t.entityId),
  }),
);

export const validationResults = mysqlTable(
  'validation_result',
  {
    id: pk(),
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    ruleCode: varchar('rule_code', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: bigint('target_id', { mode: 'number', unsigned: true }),
    passed: boolean('passed').notNull(),
    message: text('message'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxRun: index('idx_validation_run').on(t.runId, t.passed),
    idxTarget: index('idx_validation_target').on(t.targetType, t.targetId),
  }),
);

/** 展示层构建/发布记录（动态路由下用于缓存失效与回滚追溯） */
export const pageBuilds = mysqlTable(
  'page_build',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    revision: int('revision').notNull(),
    route: varchar('route', { length: 255 }).notNull(),
    contentHash: char('content_hash', { length: 64 }),
    builtAt: timestamp('built_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    idxEntityRevision: index('idx_build_entity').on(t.entityId, t.revision),
  }),
);

// ---------------------------------------------------------------- AC 扫描（提取流水线前置段）

/**
 * AC 扫描产物：文章归一化 → AC 匹配 → 最长匹配过滤 → 句子窗口合并。
 * 上下文窗口是后续 LLM 事实抽取的调用单元（按实体分类聚合，重叠窗口合并）。
 */

/** 一次全量扫描任务：建树 → 扫描 → 过滤 → 上下文窗口 */
export const acScanJobs = mysqlTable(
  'ac_scan_job',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    triggerType: mysqlEnum('trigger_type', ['manual', 'schedule']).default('manual').notNull(),
    status: mysqlEnum('status', ['running', 'succeeded', 'failed']).default('running').notNull(),
    /** 建树词条数（实体名 + 别名，去重后） */
    patternCount: int('pattern_count').default(0).notNull(),
    articleTotal: int('article_total').default(0).notNull(),
    articleScanned: int('article_scanned').default(0).notNull(),
    /** 有保留命中的文章数 */
    hitArticleCount: int('hit_article_count').default(0).notNull(),
    /** AC 原始命中（含嵌套重叠） */
    rawHitCount: int('raw_hit_count').default(0).notNull(),
    /** 最长匹配保留的命中 */
    keptHitCount: int('kept_hit_count').default(0).notNull(),
    /** 嵌套短词被过滤数（如 大黄鱼 ⊂ 鹿西大黄鱼） */
    overlapFiltered: int('overlap_filtered').default(0).notNull(),
    suspectHitCount: int('suspect_hit_count').default(0).notNull(),
    /** 合并后的上下文窗口数 = 待 LLM 调用数 */
    contextCount: int('context_count').default(0).notNull(),
    buildMs: int('build_ms').default(0).notNull(),
    scanMs: int('scan_ms').default(0).notNull(),
    errorMsg: text('error_msg'),
    startedAt: nullableAt('started_at'),
    finishedAt: nullableAt('finished_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxDataset: index('idx_acscan_job_dataset').on(t.datasetId, t.id),
  }),
);

/** AC 命中明细：每个 (文章, 实体, 位置) 一行；被过滤的命中也保留，供审计与可视化 */
export const acEntityHits = mysqlTable(
  'ac_entity_hit',
  {
    id: pk(),
    jobId: bigint('job_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    entityName: varchar('entity_name', { length: 255 }).notNull(),
    categoryCode: varchar('category_code', { length: 64 }).notNull(),
    mention: varchar('mention', { length: 255 }).notNull(),
    startPos: int('start_pos').notNull(),
    endPos: int('end_pos').notNull(),
    isKept: boolean('is_kept').default(true).notNull(),
    /** overlap_short：与更长实体重叠被过滤 */
    rejectReason: varchar('reject_reason', { length: 64 }),
    contextId: bigint('context_id', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    idxJobKept: index('idx_ac_hit_job_kept').on(t.jobId, t.isKept),
    idxJobArticle: index('idx_ac_hit_job_article').on(t.jobId, t.articleId),
    idxJobEntity: index('idx_ac_hit_job_entity').on(t.jobId, t.entityId),
    idxContext: index('idx_ac_hit_context').on(t.contextId),
  }),
);

/** 抽取上下文：同类别实体的句子窗口按重叠合并，LLM 聚合调用的最小单元 */
export const acExtractionContexts = mysqlTable(
  'ac_extraction_context',
  {
    id: pk(),
    jobId: bigint('job_id', { mode: 'number', unsigned: true }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }).notNull(),
    categoryCode: varchar('category_code', { length: 64 }).notNull(),
    entityIds: json('entity_ids').$type<number[]>().notNull(),
    entityNames: json('entity_names').$type<string[]>().notNull(),
    /** 窗口内保留命中数 */
    hitCount: int('hit_count').default(0).notNull(),
    windowText: text('window_text').notNull(),
    startPos: int('start_pos').notNull(),
    endPos: int('end_pos').notNull(),
    windowChars: int('window_chars').notNull(),
    /** 被合并掉的句子窗口数（杠杆2：聚合调用的压缩比） */
    mergeCount: int('merge_count').default(1).notNull(),
    /** pending_llm：待抽取；saturated_skip：实体字段饱和跳过（杠杆1）；llm_done：已抽取 */
    status: mysqlEnum('status', ['pending_llm', 'saturated_skip', 'llm_done']).default('pending_llm').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    idxJobCategory: index('idx_ac_ctx_job_category').on(t.jobId, t.categoryCode),
    idxJobArticle: index('idx_ac_ctx_job_article').on(t.jobId, t.articleId),
    idxStatus: index('idx_ac_ctx_status').on(t.jobId, t.status),
  }),
);

/** 系统级键值配置（websearch token 等，运行时可改不重启） */
export const systemSettings = mysqlTable('system_setting', {
  id: pk(),
  skey: varchar('skey', { length: 128 }).notNull().unique(),
  svalue: text('svalue').notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- 实体发现 / 审核 / 对齐（新模式）

/**
 * 实体语义向量（本地 bge-small-zh，512 维）。
 * 召回策略是「先分块 blocking（同类别 + 同地域锚），块内再算余弦」，
 * 因此不需要外部向量库：块内通常只有几十~几百条，暴力计算足够快。
 */
export const entityEmbeddings = mysqlTable(
  'entity_embedding',
  {
    id: pk(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    dim: int('dim').notNull(),
    /** 归一化后的向量，JSON 数组（float 截断 4 位） */
    vec: json('vec').$type<number[]>().notNull(),
    /** 生成向量的文本（实体名 + 结构化描述），便于复查与重建 */
    sourceText: varchar('source_text', { length: 512 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqEntity: uniqueIndex('uq_embed_entity').on(t.entityId),
  }),
);

/**
 * 事实语义向量（与 entity_embedding 同 provider/维度，切换 provider 后必须全量重嵌）。
 * 用于 agent 通道的 candidate_facts 语义召回与跨文章事实去重；字面相似度是降级兜底。
 */
export const factEmbeddings = mysqlTable(
  'fact_embedding',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    dim: int('dim').notNull(),
    /** 归一化后的向量，JSON 数组（float 截断 4 位） */
    vec: json('vec').$type<number[]>().notNull(),
    /** 生成向量的文本（陈述句，供复查与重建） */
    sourceText: varchar('source_text', { length: 512 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqFact: uniqueIndex('uq_fact_embed').on(t.factId),
  }),
);

/**
 * 对齐任务队列：新提及与库中实体判定时，凡不能自动定论的都落这里等人工裁决。
 * 人工的每次裁决都会沉淀（别名/谓词映射/规则），让同类问题下次自动命中。
 */
export const alignTasks = mysqlTable(
  'align_task',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    /** merge_suggest=疑似同一待确认合并; new_entity=判定新实体待确认收录;
     *  conflict=属性冲突需裁决; predicate_new=新谓词待注册 */
    kind: mysqlEnum('kind', ['merge_suggest', 'new_entity', 'conflict', 'predicate_new']).notNull(),
    /** 新提及（尚未入库的叫法） */
    mentionName: varchar('mention_name', { length: 255 }).notNull(),
    mentionType: varchar('mention_type', { length: 64 }),
    /** 命中的库中实体（merge_suggest / conflict 时有值） */
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    /** 候选、打分、理由等明细，供人工判断 */
    payloadJson: json('payload_json').$type<Record<string, unknown>>(),
    status: mysqlEnum('status', ['pending', 'approved', 'rejected']).default('pending').notNull(),
    resolution: varchar('resolution', { length: 64 }),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    reviewedBy: bigint('reviewed_by', { mode: 'number', unsigned: true }),
    reviewedAt: nullableAt('reviewed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idxStatus: index('idx_align_status').on(t.datasetId, t.status),
    idxKind: index('idx_align_kind').on(t.kind, t.status),
    idxEntity: index('idx_align_entity').on(t.entityId),
  }),
);

/**
 * 谓词归一化映射：把模型自由输出的谓词收敛到 fact_dimension 的标准维度。
 * 维度不归一 → 事实版本更新 / 变化检测 / 多源确认全部失效，故这是事实层的地基。
 */
export const predicateMaps = mysqlTable(
  'predicate_map',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    /** 模型原始谓词 */
    raw: varchar('raw', { length: 64 }).notNull(),
    /** 归一化后的标准维度（fact_dimension.code） */
    canonical: varchar('canonical', { length: 64 }).notNull(),
    /** rule=规则/词典命中, llm=模型判定, manual=人工指定 */
    origin: mysqlEnum('origin', ['rule', 'llm', 'manual']).default('rule').notNull(),
    hitCount: int('hit_count').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqRaw: uniqueIndex('uq_predicate_raw').on(t.datasetId, t.raw),
    idxCanonical: index('idx_predicate_canonical').on(t.datasetId, t.canonical),
  }),
);

/**
 * 文章级抽取队列（断点续跑）。语料来源 oucai.news，externalKey 存其 asset_id；
 * 正文落 source_article 后回填 articleId。stage 记录最后完成的阶段，
 * 重跑时从断点继续，已完成的文章不重复调用 LLM。
 */
export const extractTasks = mysqlTable(
  'extract_task',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    /** 外部语料主键（oucai.news.asset_id） */
    externalKey: varchar('external_key', { length: 128 }).notNull(),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    title: varchar('title', { length: 512 }),
    sourceOrg: varchar('source_org', { length: 128 }),
    pubDate: date('pub_date', { mode: 'string' }),
    bodyChars: int('body_chars').default(0).notNull(),
    /**
     * 该任务是否抽取关系图谱（由任务计划在建队列时写入）。
     * false 时 processTask 跳过 Stage 3 LLM 关系抽取、关系草稿验证、Stage 4 事实→图谱派生。
     * 落库到行而非按次传参：跑批失败/取消后重跑（含改用手动跑批）仍沿用原设定。
     */
    extractRelations: boolean('extract_relations').default(true).notNull(),
    /** pending=未开始; discover/audit/align/fact=各阶段; done=全部完成 */
    stage: mysqlEnum('stage', ['pending', 'discover', 'audit', 'align', 'fact', 'done']).default('pending').notNull(),
    status: mysqlEnum('status', ['pending', 'running', 'done', 'failed', 'skipped']).default('pending').notNull(),
    attempts: int('attempts').default(0).notNull(),
    errorMsg: text('error_msg'),
    statsJson: json('stats_json').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqExternal: uniqueIndex('uq_task_external').on(t.datasetId, t.externalKey),
    idxStatus: index('idx_task_status').on(t.datasetId, t.status),
    idxRun: index('idx_task_run').on(t.runId, t.status),
  }),
);

/** 任务计划：定时读发布实体 → websearch → 采集 → 语料入库 → 抽取草稿 */
export const harvestTasks = mysqlTable(
  'harvest_task',
  {
    id: pk(),
    datasetId: bigint('dataset_id', { mode: 'number', unsigned: true }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    /** site: 限定域，逗号分隔，如 66wz.com */
    siteDomains: varchar('site_domains', { length: 255 }).notNull().default('66wz.com'),
    /** 每实体查询变体数（主名/别名…，风控考虑每变体间隔 2s） */
    queriesPerEntity: int('queries_per_entity').default(3).notNull(),
    /** draft=草稿待人工审核（P6 工作台）；auto=校验全过自动应用 */
    applyMode: mysqlEnum('apply_mode', ['draft', 'auto']).default('draft').notNull(),
    intervalMinutes: int('interval_minutes').default(1440).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    lastRunAt: nullableAt('last_run_at'),
    nextRunAt: nullableAt('next_run_at'),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    idxDue: index('idx_task_due').on(t.enabled, t.nextRunAt),
  }),
);

/** 任务运行记录：一次完整执行链的过程数据与逐环节日志 */
export const harvestRuns = mysqlTable(
  'harvest_run',
  {
    id: pk(),
    taskId: bigint('task_id', { mode: 'number', unsigned: true }).notNull(),
    triggerType: mysqlEnum('trigger_type', ['schedule', 'manual']).notNull(),
    status: mysqlEnum('status', ['running', 'succeeded', 'failed']).default('running').notNull(),
    statsJson: json('stats_json').$type<Record<string, unknown>>(),
    logJson: json('log_json').$type<string[]>(),
    errorMsg: text('error_msg'),
    startedAt: nullableAt('started_at'),
    finishedAt: nullableAt('finished_at'),
  },
  (t) => ({
    idxTask: index('idx_harvest_run_task').on(t.taskId, t.id),
  }),
);

// ---------------------------------------------------------------- 大模型设置 / 调用日志

/** 大模型接入配置：后台可配，OpenAI 兼容 /chat/completions；可设为生产线(is_default) */
export const llmSettings = mysqlTable(
  'llm_setting',
  {
    id: pk(),
    name: varchar('name', { length: 128 }).notNull(),
    baseUrl: varchar('base_url', { length: 512 }).notNull(),
    apiKey: text('api_key').notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    /** text=文本模型（生产线抽取用，可多条同时设为生产线） | vector=向量模型 */
    kind: varchar('kind', { length: 10 }).default('text').notNull(),
    dimensions: int('dimensions'), // 向量模型维度（use_default_dim=false 时生效）
    useDefaultDim: boolean('use_default_dim').default(true).notNull(), // 向量模型：使用默认维度
    isDefault: boolean('is_default').default(false).notNull(),
    temperature: decimal('temperature', { precision: 4, scale: 2 }).default('0.10').notNull(),
    maxTokens: int('max_tokens').default(2048).notNull(),
    /** 生产线并发数：该渠道跑批时展开的 worker 数（默认 10） */
    concurrency: int('concurrency').default(10).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idxDefault: index('idx_llm_setting_default').on(t.isDefault),
  }),
);

/** 大模型调用日志：统计调用次数与 token 消耗 */
export const llmCallLogs = mysqlTable(
  'llm_call_log',
  {
    id: pk(),
    settingId: bigint('setting_id', { mode: 'number', unsigned: true }),
    model: varchar('model', { length: 128 }).notNull(),
    endpoint: varchar('endpoint', { length: 512 }).notNull(),
    purpose: varchar('purpose', { length: 64 }).default('extract').notNull(),
    promptTokens: int('prompt_tokens').default(0).notNull(),
    completionTokens: int('completion_tokens').default(0).notNull(),
    totalTokens: int('total_tokens').default(0).notNull(),
    latencyMs: int('latency_ms').default(0).notNull(),
    status: mysqlEnum('status', ['success', 'error']).default('success').notNull(),
    errorMessage: text('error_message'),
    /** 归属的抽取批次（extraction_run.id）：多模型并发时按 run 汇总 */
    runId: bigint('run_id', { mode: 'number', unsigned: true }),
    /** 归属的发现任务（extract_task.id）：新生产线的处理记录单元 */
    taskId: bigint('task_id', { mode: 'number', unsigned: true }),
    /** 调用上下文：实体 + 文章，便于明细页定位 */
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    articleId: bigint('article_id', { mode: 'number', unsigned: true }),
    /** 明细：请求要点（模型/温度/prompt 片段）+ 响应原文片段 + 候选数等 */
    detailJson: json('detail_json').$type<Record<string, unknown>>(),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    idxCreated: index('idx_llm_log_created').on(t.createdAt),
    idxSetting: index('idx_llm_log_setting').on(t.settingId),
    idxPurpose: index('idx_llm_log_purpose').on(t.purpose),
    idxRun: index('idx_llm_log_run').on(t.runId),
    idxTask: index('idx_llm_log_task').on(t.taskId),
  }),
);

// ---------------------------------------------------------------- 观测台 / AI 引用探测

/** 固定问题集：从 facts 派生或人工维护，供探针回归测试 */
export const probeQuestions = mysqlTable(
  'probe_question',
  {
    id: pk(),
    factId: bigint('fact_id', { mode: 'number', unsigned: true }),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    question: varchar('question', { length: 512 }).notNull(),
    expectedAnswer: text('expected_answer').notNull(),
    category: mysqlEnum('category', ['fact', 'time', 'status', 'place', 'public_service', 'history'])
      .notNull()
      .default('fact'),
    status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uqQuestion: uniqueIndex('uq_probe_question').on(t.question),
    idxEntity: index('idx_probe_q_entity').on(t.entityId),
    idxStatus: index('idx_probe_q_status').on(t.status),
  }),
);

/** 一次探针回归：对全部 active 问题逐模型跑一轮 */
export const probeRuns = mysqlTable(
  'probe_run',
  {
    id: pk(),
    modelId: varchar('model_id', { length: 64 }).notNull(),
    questionCount: int('question_count').default(0).notNull(),
    status: mysqlEnum('status', ['running', 'done', 'failed']).default('running').notNull(),
    startedAt: nullableAt('started_at'),
    finishedAt: nullableAt('finished_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxModel: index('idx_probe_run_model').on(t.modelId, t.id),
  }),
);

/** 单题单模型探测结果：引用判定 + 来源 URL + 摘录 */
export const probeResults = mysqlTable(
  'probe_result',
  {
    id: pk(),
    runId: bigint('run_id', { mode: 'number', unsigned: true }).notNull(),
    questionId: bigint('question_id', { mode: 'number', unsigned: true }).notNull(),
    modelId: varchar('model_id', { length: 64 }).notNull(),
    cited: mysqlEnum('cited', ['fact_page', 'same_domain', 'other', 'none']).notNull(),
    matchMethod: mysqlEnum('match_method', ['url_struct', 'url_text', 'none']).notNull(),
    sourceUrls: json('source_urls').$type<string[]>(),
    matchedUrl: varchar('matched_url', { length: 1024 }),
    excerpt: text('excerpt'),
    rawAnswer: mediumtext('raw_answer'),
    probedAt: nullableAt('probed_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    idxRun: index('idx_probe_res_run').on(t.runId),
    idxQuestionModel: index('idx_probe_res_qm').on(t.questionId, t.modelId),
    idxCited: index('idx_probe_res_cited').on(t.cited),
  }),
);
