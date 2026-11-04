# WZCityTCDS 实体主数据单根对齐与信源接入契约规约（S2 阶段）

> **状态：`APPROVED / EFFECTIVE`**  
> **关联任务：`WZCITYTCDS-S2-ENTITY-ADAPTER-CONTRACT`**  
> **基准架构决策：`ARCH-DECISION-01 (OPTION_A)`**  
> **基线 Commit：`94adb788050737241c54507d7f91c492cc5b8430`**  
> **绑定模式文件：`docs/contracts/schemas/entity-lookup.schema.json`, `docs/contracts/schemas/unresolved-entity-proposal.schema.json`, `docs/contracts/schemas/source-news-event.schema.json`**

---

## 一、契约目标与背景

根据 S1 阶段正式确立的 Option A 架构边界（`docs/architecture/SYSTEM-BOUNDARY-OPTION-A.md`），`WZCityTCDS` 是**城市时空可信内容枢纽的正式事实出版内核**。

本契约作为 S2 研发切片的标准交付物，旨在解决事实抽取与签发流程的两大核心接入边界：
1. **实体主数据单根对齐**：如何与枢纽的 `EntityResolver` 进行确定性身份对齐，以及发现新实体时的治理流转规约，杜绝在本地建立平行实体主数据表；
2. **上游 CMS 语料接入与撤回**：如何以标准事件（Event）模型接收主流媒体新闻报道原料，并对上游撤稿、修改事件进行事实层面的安全响应。

---

## 二、契约 1：枢纽实体解析协议（Entity Lookup and Resolution）

### 2.1 交互时序与契约定义
- **交互角色**：WZCityTCDS 抽取管道 / 审核工作台（Client）与 城市时空可信内容枢纽 EntityResolver（Server）
- **数据规范**：`docs/contracts/schemas/entity-lookup.schema.json`

```
  WZCityTCDS (事实抽取管道)                    枢纽 EntityResolver
            |                                           |
            |--- 1. LOOKUP_REQUEST (mention, context) ->|
            |                                           | (时空拓扑 / 别名索引 / 歧义消解)
            |<-- 2. LOOKUP_RESPONSE (entity_id, status)-|
            |                                           |
```

### 2.2 响应状态处理准则
1. **`EXACT_MATCH`（精确匹配）**：
   - 枢纽唯一确定实体身份（置信度 >= 0.85）；
   - 系统将该断言与标准 `entity_id`（格式：`ent_[a-z0-9_-]{8,64}`）直接绑定；
2. **`MULTIPLE_MATCHES`（存在歧义）**：
   - 枢纽返回候选实体列表（包含别名与时空坐标）；
   - 系统将事实断言标记为 `AMBIGUOUS_ENTITY`，自动进入人工审核工作台（ReviewTask），由事实审核员结合新闻上下文进行人工裁决确认；
3. **`UNRESOLVED_NOT_FOUND`（未收录实体）**：
   - 枢纽主数据中未检索到对应实体；
   - **红线规约**：系统严禁在本地数据库直接生成正式实体 ID！触发契约 2（未收录实体治理提案）。

---

## 三、契约 2：未收录实体治理提案协议（Unresolved Entity Proposal）

当新闻语料中提取出客观真实但枢纽尚未收录的实体（如新竣工地标、新成立企事业单位、突发事件主体）时，必须严格执行异步治理流转：

- **数据规范**：`docs/contracts/schemas/unresolved-entity-proposal.schema.json`

```
  WZCityTCDS 抽取/审核工作台                     枢纽主数据治理团队
            |                                           |
            |--- 1. 提交治理提案 (UnresolvedProposal) ->|
            |       (包含原文证据、上下文片段、推荐类别)  |
            |                                           | (专家审核 / 时空建档 / 分配主ID)
            |<-- 2. 提案裁决回执 (HubAdjudication) -----|
            |       (allocated_entity_id, status)       |
            |                                           |
```

### 3.1 状态流转契约
- **`SUBMITTED`**：提案已提交至枢纽待办队列，WZCityTCDS 内部事实暂存为挂起态（`PENDING_ENTITY_RESOLUTION`），禁止对外签发；
- **`ACCEPTED_ALLOCATED`**：枢纽采纳提案，正式分配唯一主 ID（`allocated_entity_id`），本系统自动唤醒挂起事实并完成关联；
- **`MERGED_AS_ALIAS`**：枢纽判定该候选名实为已有实体的非正规别名，返回既有 `entity_id` 并将其记入别名库；
- **`REJECTED`**：枢纽判定该提及不构成独立城市实体，事实驳回或转为普通非结构化描述。

---

## 四、契约 3：上游 CMS 语料接入与撤回事件模型（Source News Event）

主流媒体采编系统（CMS）是权威新闻语料的唯一来源。语料通过确定性事件协议单向推入或拉取。

- **数据规范**：`docs/contracts/schemas/source-news-event.schema.json`

### 4.1 摄入事件（`NEWS_PUBLISHED` / `NEWS_UPDATED`）
- 必须包含信源文档唯一标识（`source_doc_id`）与全文 SHA-256（`content_sha256`）；
- 必须对全文进行分段切片（`paragraphs`），每个段落包含明确的段落序号（`paragraph_index`）、起止字符（`char_start`, `char_end`）与段落哈希（`paragraph_sha256`）；
- 此结构直接为后续 S4 阶段的 `EvidenceSpan` 字符级哈希验签提供不可变的证据原料。

### 4.2 撤稿事件响应规约（`NEWS_RETRACTED`）
当上游 CMS 发出新闻撤稿事件时，系统必须按照以下状态机执行事实保护：
1. **影响面排查**：依据 `source_doc_id` 自动定位所有依赖该源的事实断言（`FactAssertion`）；
2. **多源独立性评估**：
   - 若该事实拥有两个或以上独立信源支撑（且其他信源未撤稿），系统仅将该事实证据集中的对应源标记为 `SOURCE_RETRACTED`，事实保持 `PUBLISHED` 但更新版本说明；
   - 若该事实仅依赖此单一信源，系统立即将事实置为 `SUSPENDED_DUE_TO_SOURCE_RETRACTION`（挂起审校态），触发新版本修订（`FactRevision`），并同步更新对外出口状态。

---

## 五、安全与治理红线（Strict Invariants）

1. **零本地实体主表**：系统数据模型中只允许出现 `hub_entity_id` 引用字段，严禁在 `apps/api/` 或数据库迁移脚本中创建 `t_entity`、`t_entity_alias` 等独立主表；
2. **证据强哈希**：所有提案与事实断言必须附带 `evidence_span_hash`，确保证据与原始语料严格一致；
3. **白名单准入**：本切片仅包含 JSON Schema 与 Markdown 契约，零触碰底层业务源码，符合 FPF S2 阶段准入标准。
