# WZCityTCDS 项目唯一事实地图（正式版）

> **状态：`FORMAL_PROJECT_MAP_ACTIVE`**  
> **当前控制器基线：`66d9a74e4463f97a37a54dfad73842d81cd39ad2`**  
> **主干仓库：`huangzuomin/WZCityTCDS-Open`（分支：`main`）**  
> **治理规约：FPF 0.3 / 五权分立受控开发体系**

---

## 一、当前里程碑总览

### 1.1 Phase 1：架构与数据契约设计阶段（COMPLETED）

| 切片编号 | 模块 / 目标 | 负责人 | DEV 状态 | 独立 QA 裁决 | 主干合并状态 | 部署状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **BOOT-00** | 仓库、公开候选与治理基线盘点 | Coordinator | COMPLETED | PASS | MERGED | N/A |
| **BOOT-01** | 产品架构定位裁决 (ARCH-DECISION-01) | Human Owner | COMPLETED | OPTION_A | CLOSED | N/A |
| **BOOT-02** | 初始项目地图确认与固化 | Human Owner + Scribe | COMPLETED | PASS | MERGED | N/A |
| **BOOT-03** | 仓库创建与 FPF 本地 Bootstrap | Coordinator | COMPLETED | PASS | MERGED | N/A |
| **BOOT-04** | 治理文件与 BOOTSTRAP_PR (#2) | Coordinator + DEV + QA | COMPLETED | PASS | MERGED (c4dcc932) | N/A |
| **BOOT-05** | 准入与开发工位全面启用 | Human Owner + QA | COMPLETED | PASS (A1~A7) | ACTIVE | ACTIVE |
| **S1** | 架构定位审查与边界规约落盘 (#3) | Architecture Review | COMPLETED | PASS | MERGED (03b7cb62) | N/A |
| **S2** | 实体主数据单根对齐与枢纽接口适配契约 (#5) | DEV Lead | COMPLETED | PASS | MERGED (47c12dfc) | N/A |
| **S3** | 事实版本链与不可变签发内核状态机 (#7) | DEV Lead | COMPLETED | PASS | MERGED (ba3bea4f) | N/A |
| **S4** | EvidenceSpan 证据溯源与哈希验签引擎 (#9) | DEV Lead | COMPLETED | PASS | MERGED (21f39aa9) | N/A |
| **S5** | 机器出口与统一发布安全门禁 (#11) | DEV Lead | COMPLETED | PASS | MERGED (6a1feba7) | N/A |

### 1.2 Phase 2：契约驱动工程实现阶段（ACTIVE）

| 切片编号 | 模块 / 目标 | 负责人 | DEV 状态 | 独立 QA 裁决 | 主干合并状态 | 部署状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1** | 契约强类型与运行时模型校验器 (TypeScript/Python) (#14) | DEV Lead | COMPLETED | PASS | MERGED (b98b982b) | N/A |
| **C2** | 实体主数据适配器与解析客户端实现 (#16) | DEV Lead | COMPLETED | PASS | MERGED (20cf81b4) | N/A |
| **C3** | Append-Only 版本链存储与发布签发状态机实现 (#18) | DEV Lead | COMPLETED | PASS | MERGED (66d9a74e) | N/A |
| **C4** | EvidenceSpan 哈希验签引擎与仲裁管道实现 | DEV Lead | READY_FOR_DEV | NOT_RUN | NOT_STARTED | NOT_STARTED |
| **C5** | 机器出口 (API/Feed/Changes/MCP) 与安全门禁拦截实现 | DEV Lead | PLANNED | NOT_RUN | NOT_STARTED | NOT_STARTED |

当前已圆满完成 Phase 1 全套数据契约与 Phase 2 C1、C2、C3（Append-Only 版本链存储与发布签发状态机）。后续开发正式进入 **Phase 2 核心代码实现：C4 切片（EvidenceSpan 哈希验签引擎与仲裁管道实现）**。

---

## 二、基线事实

- **正式主干控制器仓库**：`huangzuomin/WZCityTCDS-Open`
- **主干分支**：`main`
- **当前控制器不可变 SHA**：`66d9a74e4463f97a37a54dfad73842d81cd39ad2`
- **GitHub 分支保护**：已配置必需状态检查与独立 App 审查要求
- **独立审查身份**：`fpf-qa-bot-huangzuomin[bot]`（GitHub App ID: 5464827）
- **本地工位布局**：`_fpf-workspaces/WZCITYTCDS_MVP/`（`bootstrap`、`dev`、`qa` 物理隔离工作树）
- **基线源码保持**：公开仓库源码完全脱敏，私网敏感凭据与本地运行文件已完全剥离。

---

## 三、产品使命（事实层描述）

`WZCityTCDS` 定位为城市时空可信内容枢纽的正式事实出版内核：

- 面向 GEO 语境的事实生产、核验与发布系统；
- 将新闻语料经过采集、抽取、人工审核、冲突裁决和签发，形成可引用的结构化事实；
- 使用 append-only 事实版本链、证据 span、事实变化记录和审计日志；
- 仅公开已发布实体；
- 同时向页面和机器出口提供事实，包括 feed、catalog、sitemap 和 changes；
- 目标事实语义强调权威、无歧义、可引用和可追溯。

---

## 四、系统定位与边界（已裁决）

- **决策编号**：`ARCH-DECISION-01`
- **决策状态**：`CLOSED: OPTION_A`
- **决议结论**：
  仓库所有者正式裁定 `WZCityTCDS` 为**城市时空可信内容枢纽的正式事实出版内核（Option A）**。
- **落地规约**：
  - `docs/architecture/SYSTEM-BOUNDARY-OPTION-A.md`
  - `docs/coordination/ARCH-DECISION-01.md`
  - `docs/contracts/ENTITY-AND-SOURCE-CONTRACT.md`
  - `docs/contracts/FACT-REVISION-KERNEL-SPECIFICATION.md`
  - `docs/contracts/EVIDENCESPAN-VERIFICATION-SPECIFICATION.md`
  - `docs/contracts/OUTLETS-AND-SECURITY-GATE-SPECIFICATION.md`
- **架构硬红线**：
  - **不建立第二套城市实体主数据**：城市实体主身份、别名与重定向完全由枢纽主数据服务负责；
  - **单向受控投影**：本系统独占事实断言与出版签发写入口，签发后单向投影至枢纽供检索，枢纽不得反向改写；
  - **不可变版本链**：任何事实修订必须产生全新版本，严禁物理覆盖更新；
  - **证据强绑定**：每个断言必须绑定具备 SHA-256 校验的字符级 EvidenceSpan。

---

## 五、当前边界与责任归属矩阵

| 领域对象 / 能力 | 归属主体 | 治理责任与权限 |
| :--- | :--- | :--- |
| **城市实体 (Entity) / 别名 (Alias)** | 城市时空可信内容枢纽 | 权威主数据，负责唯一身份标识与时空拓扑 |
| **信源语料原文 (Source News)** | 上游 CMS / 权威发布平台 | 原文版权与原始采编事实责任 |
| **候选抽取 (Candidate Extraction)** | WZCityTCDS 内部管道 | 自动化算法流水线，内部受控暂存 |
| **审核任务 (ReviewTask)** | WZCityTCDS 审核工作台 | 人工审校、合规确认与质量仲裁 |
| **事实断言与版本 (FactAssertion / Revision)** | WZCityTCDS 独占 | 独占写入口，不可变版本链管理 |
| **出版快照 (Publication / Revision)** | WZCityTCDS 独占 | 权威签发、更正、撤回与对外出版出口 |
| **证据片段 (EvidenceSpan)** | WZCityTCDS 绑定存证 | 字符级证据锚点、哈希指纹与原文映射 |
| **公共出口 (Web / API / Feed / MCP)** | 只能消费已签发版本 | 严格执行发布门禁，隔离未签发数据 |

---

## 六、关键质量与发布约束

1. **版本不可变性**：事实内容变化必须形成新版本（FactRevision），不得静默覆盖历史版本；
2. **发布门禁隔离**：未签发候选不得通过页面、API、JSON、静态文件、缓存或 sitemap 公开；
3. **多端出口一致性**：公开 HTML、JSON、JSON-LD、Feed 和 MCP 出口必须来自同一签发版本；
4. **实体身份单根**：实体必须使用枢纽治理的标准稳定身份，禁止模型自由创建正式实体；
5. **数值与时空精度**：统计数字必须携带单位、地域、统计范围；事件时间必须区分发生、发布及有效区间；
6. **审计链追溯**：来源撤稿、事实更正和事实撤回必须完整保留审计链。

---

## 七、当前治理与授权事实

- **人类授权（SCOPE_GRANT）**：已签发且在 90 天有效期内，覆盖动作 A1~A7；
- **独立 QA 准入裁决**：`OVERALL_ADMISSION_VERDICT: PASS`；
- **主干基线已合并 PR**：
  - PR #2 (`kind: BOOTSTRAP`，commit: `c4dcc932`)
  - PR #3 (`kind: POLICY_CHANGE`，commit: `03b7cb62`)
  - PR #4 (`kind: MAP_UPDATE`，commit: `94adb788`)
  - PR #5 (`kind: POLICY_CHANGE`，commit: `47c12dfc`)
  - PR #6 (`kind: MAP_UPDATE`，commit: `939bdc8c`)
  - PR #7 (`kind: POLICY_CHANGE`，commit: `ba3bea4f`)
  - PR #8 (`kind: MAP_UPDATE`，commit: `6722d56a`)
  - PR #9 (`kind: POLICY_CHANGE`，commit: `21f39aa9`)
  - PR #10 (`kind: MAP_UPDATE`，commit: `6c14119e`)
  - PR #11 (`kind: POLICY_CHANGE`，commit: `6a1feba7`)
- **当前执行切片**：C1（契约强类型与运行时模型校验器）。
