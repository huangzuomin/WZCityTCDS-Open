# WZCityTCDS 项目唯一事实地图（Bootstrap Draft）

> **状态：`BOOTSTRAP_DRAFT_HUMAN_REVIEW_REQUIRED`**
>
> 本文件是供仓库所有者确认的初始项目地图草案，不是已生效的正式地图，
> 不得据此创建候选代码分支、Worktree、BOOTSTRAP_PR 或宣称项目已经就绪。

## 一、当前里程碑总览

| 切片编号 | 模块 / 目标 | 负责人 | DEV 状态 | 独立 QA 裁决 | 主干合并状态 | 部署状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| BOOT-00 | 仓库、公开候选与治理基线盘点 | Coordinator | EVIDENCE_READY_NOT_AUTHORIZED | NOT_RUN | N/A | N/A |
| BOOT-01 | 产品架构定位裁决 | Human Owner + Architecture Review | WAITING_HUMAN_DECISION | NOT_RUN | N/A | N/A |
| BOOT-02 | 初始项目地图确认 | Human Owner | DRAFT_READY_FOR_REVIEW | NOT_RUN | N/A | N/A |
| BOOT-03 | 新仓库与 FPF 本地 Bootstrap | Coordinator | BLOCKED | NOT_RUN | NOT_STARTED | NOT_STARTED |
| BOOT-04 | 治理文件与 BOOTSTRAP_PR | Coordinator + DEV + QA | BLOCKED | NOT_RUN | NOT_CREATED | N/A |
| BOOT-05 | 准入与开发工位启用 | Human Owner + QA | BLOCKED | NOT_RUN | NOT_STARTED | NOT_STARTED |

当前没有任何业务切片获准开发。第一张正式工作令应先完成架构定位审查，
而不是编写业务代码。

## 二、基线事实

- **原私有控制器仓库**：`huangzuomin/WZCityTCDS`
- **Controller ref**：`github/master`
- **Controller SHA**：`1891a4205529946f585e7651b9769eaa317517ad`
- **GitHub 分支保护**：未启用
- **原仓库可见性**：私有
- **本地干净公开候选**：
  `F:\SSOT\Work\事实发布系统\_publication\WZCityTCDS-public-candidate`
- **候选分支**：`main`
- **候选根提交**：`2165d7a7a7d0691f0bf2a1bdb9472f160d4127c5`
- **候选 Git 远端**：无
- **候选文件**：263
- **候选大小**：5,301,289 bytes
- **候选安全扫描**：Gitleaks 0 命中；非 `package.json` 私网 IPv4 0 命中
- **锁定源码保持**：262 个非 `.gitignore` 源文件与 Controller blob 完全一致
- **候选状态**：`LOCAL_AUDIT_CANDIDATE_NOT_PUBLICATION_READY`

候选不是可运行版本。为保证首批公开内容不包含已发现的内网地址和本地运行文件，
111 个含私网 IPv4 的源码文件与 9 个被 `.gitignore` 命中的本地运行文件暂未进入候选。

## 三、产品使命（事实层描述）

锁定基线的 `readme.md`、`docs/CAPABILITIES.md` 和关联设计文档将当前系统描述为：

- 面向 GEO 的事实生产与发布系统；
- 把新闻语料经过采集、抽取、人工审核、冲突裁决和签发，形成可引用的结构化事实；
- 使用 append-only 事实版本链、证据 span、事实变化记录和审计日志；
- 仅公开已发布实体；
- 同时向页面和机器出口提供事实，包括 feed、catalog、sitemap 和 changes；
- 目标事实语义强调权威、无歧义、可引用和可追溯。

这些是当前文档和代码结构的描述，不等于相关能力已经通过独立 QA 验收。

## 四、待裁决的系统定位

- **决策编号**：`ARCH-DECISION-01`
- **决策状态**：`NEEDS_HUMAN_DECISION`
- **待回答的问题**：

  `WZCityTCDS` 是城市时空可信内容枢纽的正式事实出版内核，
  还是建立在枢纽之上的独立公共事实服务？

- **DEV 条件性建议**：Option A，正式事实出版内核；该建议尚未成为正式决定。
- **裁决人**：仓库所有者 `huangzuomin`
- **详细比较**：
  `.local-coordination/FPF-BOOTSTRAP-WZCITYTCDS-20261101/phase3/project-map/ARCH-DECISION-01.draft.md`

在裁决前，项目不得自行固化以下任一方向：

- 不建立第二套城市实体主数据；
- 不假定枢纽已经提供可用的实体解析接口；
- 不把独立仓库或独立域名解释为独立事实权威；
- 不把 `facts.66wz.com` 的公开页面观察解释为内部系统已经完成集成。

## 五、当前边界与责任归属

| 领域对象 / 能力 | 当前设计口径 | 验证状态 |
| :--- | :--- | :--- |
| 城市实体、别名、实体重定向 | 由城市时空可信内容枢纽统一治理 | 接口和现网能力 NOT_VERIFIED |
| 新闻原文、文章修订、采编责任 | 由 CMS 作为上游权威 | CMS 事件能力 NOT_VERIFIED |
| 候选抽取、审核任务 | WZCityTCDS 内部对象，不对公网暴露 | 代码与文档存在，独立 QA NOT_RUN |
| FactAssertion / FactRevision | 由 WZCityTCDS 事实注册与签发流程维护 | 目标契约与现实现 NOT_FULLY_ALIGNED |
| Publication / PublicationRevision | 由 WZCityTCDS 负责签发和版本化 | 目标契约与现实现 NOT_FULLY_ALIGNED |
| 来源快照与 EvidenceSpan | 建议由统一来源/证据服务归口，兼容现有 span hash | 物理服务归属 NOT_VERIFIED |
| 公共页面、JSON、Feed、API、MCP | 只能消费已签发版本 | 当前实现与发布门禁 NOT_INDEPENDENTLY_VERIFIED |
| 事实发布、更正、撤回责任 | 取决于 ARCH-DECISION-01 | NEEDS_HUMAN_DECISION |

现有设计文档建议采用“逻辑主记录 + 单向受控投影”：
枢纽拥有实体身份与来源证据治理，WZCityTCDS 拥有候选、事实签发与出版版本。
该建议仍需业务负责人确认，不能被当作已完成的系统集成事实。

## 六、现有能力清单（未独立验收）

锁定基线的代码与文档中可发现以下能力：

- 语料域、类别树和动态字段定义；
- 实体、事实、证据、事件和关系数据模型；
- Pipeline / Discovery 抽取与候选审核；
- 事实状态机、冲突检测和人工仲裁；
- EvidenceSpan、来源片段和质量状态；
- 已发布实体档案页；
- feed、catalog、sitemap、changes 机器出口；
- JWT 角色、审计日志、LLM 配置与调用日志；
- 采集调度、新闻和文章管理。

上述能力的存在性来自锁定基线文件和代码模块，不代表测试覆盖率、数据正确性、
权利合规、现网可用性或生产安全性已经通过验收。

## 七、关键质量与发布约束

- 事实内容变化必须形成新版本，不得静默覆盖历史版本；
- 未签发候选不得通过页面、API、JSON、静态文件、缓存或 sitemap 公开；
- 公开 HTML、JSON、JSON-LD 和机器出口必须来自同一签发版本；
- 实体内涵必须使用经过治理的稳定身份，不得由模型自由创建正式实体；
- 统计数字必须携带单位、地域、范围和统计期间；
- 事件时间必须区分发生时间、发布时间、有效区间、精度和推断标记；
- 来源转载不等于独立证据；
- 来源撤稿、事实更正和事实撤回必须区分并保留审计链。

## 八、外部依赖与未验证事项

- 城市时空可信内容枢纽的实体解析、别名、来源和证据接口未验证；
- CMS 是否支持发布、更正、撤稿事件未验证；
- `facts.66wz.com` 只完成了公开页面级观察，未验证内部数据库、API/MCP、
  身份规则、span hash、读写一致性和生产权限；
- MySQL、Redis、Docker、WSL、独立 QA Runner 和真实 CI 隔离环境尚未完成本任务验收；
- 原始来源授权、公开引句政策、个人信息、媒体和数据再分发权利未完成核验；
- 代码许可证尚不存在；
- 原仓库历史中命中的凭据是否已全部失效或轮换尚未取得负责人确认。

## 九、当前治理事实

- WORK_ORDER v1 已失效；
- WORK_ORDER v2 仅为未签发草案；
- `SCOPE_GRANT`：`NOT_ISSUED`；
- 独立 QA `ADMISSION_VERDICT`：`NOT_RUN`；
- FPF `init --apply`：`NOT_RUN`；
- FPF 候选分支：`NOT_CREATED`；
- FPF 候选 Worktree：`NOT_CREATED`；
- 业务源码修改：`FORBIDDEN`；
- 新 GitHub 仓库：`NOT_CREATED`；
- 新仓库远端：`NOT_CONFIGURED`。

## 十、建议的人工确认项

1. 确认 `ARCH-DECISION-01` 选择 Option A 还是 Option B。
2. 确认本草案是否可作为初始项目地图事实基线。
3. 确认新公开仓库名称。建议暂用 `huangzuomin/WZCityTCDS-Open`，
   保留原私有仓库名称和完整历史不动。
4. 确认代码许可证、文档许可证和数据/内容再分发边界。
5. 确认原仓库发现的凭据已经轮换或失效。

只有上述事项明确后，才能重新签发 WORK_ORDER v2、创建新控制器仓库、
执行 FPF Bootstrap 规划并推进独立 QA 准入。
