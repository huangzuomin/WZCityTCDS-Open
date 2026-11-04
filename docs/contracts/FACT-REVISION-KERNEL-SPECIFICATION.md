# WZCityTCDS 事实版本链与不可变签发内核状态机规约（S3 阶段）

> **状态：`APPROVED / EFFECTIVE`**  
> **关联任务：`WZCITYTCDS-S3-FACT-REVISION-KERNEL`**  
> **基准架构决策：`ARCH-DECISION-01 (OPTION_A)`**  
> **基线 Commit：`939bdc8c365cfbfa3bf2e8a9389fc41abab907e9`**  
> **绑定模式文件：`docs/contracts/schemas/fact-revision-lifecycle.schema.json`, `docs/contracts/schemas/publication-snapshot.schema.json`, `docs/contracts/schemas/revision-state-transition.schema.json`**

---

## 一、概述与核心使命

根据系统架构定位（Option A），`WZCityTCDS` 独占城市时空可信内容枢纽中事实生产、仲裁与正式出版的写生命周期。

为杜绝传统 CMS 与业务系统中常见的“数据原地覆盖（In-Place Update）”、“事实静默篡改”与“责任追溯断裂”等致命隐患，本规范建立了**不可变 Append-Only 事实版本链（Fact Revision Chain）**与**确定性签发状态机（Publication State Machine）**。

---

## 二、双层数据模型结构（Assertion 与 Revision）

事实模型严格区分**逻辑标识根（Assertion）**与**物理不可变版本（Revision）**：

```
+---------------------------------------------------------------------------------+
| FactAssertion (逻辑根)                                                           |
| assertion_id: "ast_wz_pop_lucheng_2025"                                         |
| entity_id: "ent_wz_lucheng_district"                                            |
| property_path: "demographics.permanent_population.total"                       |
+---------------------------------------------------------------------------------+
          |
          |--- Revision 1: rev_001 (created: 2026-01-10, state: SUPERSEDED)
          |    parent_hash: GENESIS
          |    raw_value: 80.5, unit: "万人", period: "2024"
          |    evidence_hashes: ["sha256:d8a..."]
          |
          |--- Revision 2: rev_002 (created: 2026-06-15, state: PUBLISHED)
          |    parent_hash: "sha256:7f3b..." (Hash of rev_001)
          |    raw_value: 81.2, unit: "万人", period: "2025"
          |    evidence_hashes: ["sha256:e9c...", "sha256:12a..."]
          |
          v
```

### 2.1 哈希链式存证（Hash-Chaining）
- 每一个 `FactRevision` 必须显式记录其前序版本的 SHA-256 哈希（`parent_revision_sha256`）；
- 首个版本（创世版本）的父哈希固定为 `GENESIS`；
- 版本节点之间构成单向哈希链表，任何对历史版本的篡改都会导致后续节点哈希失效，具备防篡改校验能力。

---

## 三、事实修订状态机（Revision State Machine）

### 3.1 状态枚举与语义
1. **`DRAFT`（草稿态）**：抽取算法初筛生成或编辑员录入中的半成品，内部暂存，不对外暴露；
2. **`PENDING_REVIEW`（待审核态）**：事实断言提取完毕并绑定了待验 `EvidenceSpan`，进入审核员与仲裁员复核队列；
3. **`PUBLISHED`（正式签发态）**：通过事实合规、实体单根对齐与证据验签，正式生效并对全域出口可见；
4. **`SUPERSEDED`（已过时态）**：该断言产生了更高序列号的新发布版本，旧版本保留只读历史档案，不再作为当前主推事实；
5. **`REVOKED`（已撤回态）**：因重大事实偏差或法律合规原因被彻底撤销，对外展示撤销墓碑记录（Tombstone），切断外部正常调用。

### 3.2 状态转移矩阵与角色门禁

| 当前状态 (From) | 目标状态 (To) | 触发动作 (Trigger) | 授权角色 | 前置必要条件 |
| :--- | :--- | :--- | :--- | :--- |
| **DRAFT** | PENDING_REVIEW | SUBMIT_FOR_REVIEW | FACT_EXTRACTOR | 绑定至少1项 EvidenceSpan 与合法 Hub entity_id |
| **PENDING_REVIEW**| PUBLISHED | APPROVE_AND_PUBLISH | FACT_REVIEWER / CHIEF_EDITOR | 证据验签通过、实体消歧完成、审核员签名有效 |
| **PENDING_REVIEW**| REJECTED | REJECT_CANDIDATE | FACT_REVIEWER | 填写明确驳回原因并归档未采纳事实 |
| **PUBLISHED** | SUPERSEDED | SUPERSEDE_WITH_NEW_REVISION | SYSTEM_KERNEL (Auto) | 新版本进入 PUBLISHED 态后，自动挂起旧版本 |
| **PUBLISHED** | REVOKED | REVOKE_PUBLISHED_FACT | CHIEF_EDITOR | 填写撤回原因（revocation_reason）与审计记录 |

**绝对安全红线**：禁止对处于 `PUBLISHED`、`SUPERSEDED` 或 `REVOKED` 状态的记录执行 SQL `UPDATE` 或 `DELETE`！任何变更必须以新记录（`INSERT`）产生新版本。

---

## 四、出版快照与单向受控投影（Publication Snapshot）

面向城市时空可信内容枢纽（Hub）与公开出口（Web / API / Feed / MCP）的发布，必须通过**出版快照（Publication Snapshot）**打包分发：

### 4.1 快照生成规则
- 快照汇聚某实体当前所有处于 `PUBLISHED` 状态的最新断言；
- 系统计算所有已包含断言的全局聚合 SHA-256 哈希（`snapshot_digest_sha256`）；
- 赋予不可变发布版本号（`snapshot_revision_id`，格式：`pubrev_[a-zA-Z0-9_-]{12,64}`）。

### 4.2 单向受控投影机制
- **单向推送**：WZCityTCDS 生成不可变快照事件并推送至消息总线或镜像库；
- **枢纽只读消费**：枢纽主数据与图谱检索服务消费快照数据进行时空挂载与全域索引；
- **防脑裂隔离**：枢纽侧绝对无权对快照中的事实内容进行修改或逆向回流写操作。

---

## 五、异常生命周期规程

### 5.1 事实更正（Fact Correction）
- 触发：发布后发现数字、文字或时间存在事实性瑕疵；
- 处理：
  1. 创建新 `FactRevision`，修订原因设为 `ERRATUM_CORRECTION`；
  2. 记录错误说明与更正依据；
  3. 经总编辑审核签发后，旧版本置为 `SUPERSEDED`，新快照对外公布并附带更正告示。

### 5.2 事实撤回（Fact Revocation）
- 触发：证实报道严重失实或涉密违规；
- 处理：
  1. 当前版本直接转入 `REVOKED` 态；
  2. 永久保留该版本的哈希与元数据，但在事实内容层附加上墓碑标记（Tombstone Record）；
  3. 公网对外页面展示撤稿/撤回声明，API 返回 410 Gone 或特定撤回状态码。

### 5.3 上游 CMS 撤稿响应
- 触发：上游媒体发出 `NEWS_RETRACTED` 事件；
- 处理：
  1. 依据 S2 契约中的 `source_doc_id` 自动溯源定位依赖事实；
  2. 自动启动证据重新评估：若失去唯一证据支撑，系统自动将事实降级挂起并通知人工复审团队。
