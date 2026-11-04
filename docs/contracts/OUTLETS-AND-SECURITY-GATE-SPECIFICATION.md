# WZCityTCDS 机器出口与统一发布安全门禁规约（S5 阶段）

> **状态：`APPROVED / EFFECTIVE`**  
> **关联任务：`WZCITYTCDS-S5-OUTLETS-AND-SECURITY-GATE`**  
> **基准架构决策：`ARCH-DECISION-01 (OPTION_A)`**  
> **基线 Commit：`6c14119e4e96d98746886ba18edb1d5c6786e2e3`**  
> **绑定模式文件：`docs/contracts/schemas/public-outlet-contract.schema.json`, `docs/contracts/schemas/security-gate-policy.schema.json`, `docs/contracts/schemas/changes-stream-event.schema.json`**

---

## 一、概述与出口架构使命

作为城市时空可信内容枢纽的正式事实出版内核，`WZCityTCDS` 必须向两类主体提供事实消费出口：
1. **公众与人类读者**：通过权威静态 Web 档案页、JSON-LD 事实卡片进行引用与核验；
2. **机器与智能体代理**：通过开放 REST API、Atom Feed、XML Sitemap、Changes 变更流以及大模型 MCP（Model Context Protocol）工具端点进行自动化消费。

为杜绝“不同出口数据口径不一致”、“未审草稿意外泄漏”、“内网拓扑与凭据暴露”以及“撤回事实仍被机器爬取引用”等系统性安全风险，本规约制定了**多端出口单根一致性契约**与**Fail-Closed（故障闭锁）统一发布安全门禁**。

---

## 二、多端出口单根一致性（Single Root Consistency）

系统确立“单快照多端投影”原则：所有对外通道只能消费处于 `PUBLISHED` 状态的不可变快照（`PublicationSnapshot`）：

```
+---------------------------------------------------------------------------------+
|               不可变出版快照 (PublicationSnapshot: pubrev_20261104_001)           |
|               - entity_id: ent_wz_lucheng_01                                    |
|               - snapshot_digest_sha256: "e4d2...64位哈希..."                    |
+---------------------------------------------------------------------------------+
          |
          +---> [Public HTML Archive] : 静态档案页渲染（展示证据与版本时间线）
          +---> [REST API / JSON]     : 开放接口响应（严格对应快照 JSON）
          +---> [JSON-LD]             : 搜索引擎结构化数据（Schema.org 事实标引）
          +---> [Atom Feed / Sitemap] : 订阅源与爬虫索引清单
          +---> [Changes Stream]      : 事实变更事件流（增量同步）
          +---> [LLM MCP Endpoint]    : 大模型知识工具调用出口
```

### 2.1 强制一致性准则
- 无论通过浏览器、REST 接口还是大模型 MCP 查询某一实体，返回的属性事实、证据哈希、版本号与时间戳必须完全相同；
- 严禁各出口独立连接未经签发的底层抽取表或审核工作台中间态。

---

## 三、统一发布安全门禁（Publication Security Gate）

在快照推向任何公网出口前，必须通过自动化安全门禁的 5 项严苛检查：

- **数据规范**：`docs/contracts/schemas/security-gate-policy.schema.json`

### 3.1 五大门禁校验规则
1. **状态完整性校验（`rule_only_published_state`）**：
   - 扫描快照中包含的所有事实断言；
   - 判定准则：必须 100% 处于 `PUBLISHED` 状态。若混入任一 `DRAFT`、`PENDING_REVIEW` 或 `REJECTED` 数据，直接熔断阻断；
2. **证据验签校验（`rule_evidence_receipt_pass`）**：
   - 检查每个断言是否具备综合结论为 `PASS` 的有效验签回执（`EvidenceVerificationReceipt`）；
   - 判定准则：未验签或验签失败的事实绝对禁止流入出口；
3. **私网 IP 与拓扑阻断（`rule_no_private_ip_leaks`）**：
   - 全文正则扫描私网 IPv4（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`）及内部主机名（`.internal`, `.local`）；
   - 判定准则：命中数必须为 0，防止内网拓扑泄密；
4. **凭据与敏感字段扫描（`rule_no_credential_patterns`）**：
   - 扫描密码、JWT 私钥、API Key（如 `sk-`、`AKID`、PEM 证书切片）；
   - 判定准则：命中数必须为 0；
5. **信源存续状态复查（`rule_source_validity_confirmed`）**：
   - 核查支撑证据关联的信源文档是否收到 `NEWS_RETRACTED` 撤稿事件；
   - 判定准则：已撤稿且无其他多源证据的事实必须被剔除。

### 3.2 Fail-Closed（故障闭锁）原则
若安全门禁自身发生执行异常、超时或无法确认某项规则时，门禁判定一律强制降级为 `FAIL_CLOSED_BLOCKED`，宁可推迟发布，绝不带险放行。

---

## 四、事实撤回与墓碑协议（Tombstone Protocol）

当某项已发布事实被正式撤回（`REVOKED`）时：
1. **HTTP 状态码与标头**：
   - 独立事实档案页或特定 API 资源返回 `HTTP 410 Gone`；
   - 标头携带 `X-Fact-Revocation-Notice` 与撤回时间戳；
2. **墓碑数据包（Tombstone Record）**：
   - 不再向普通查询出口提供原事实内容；
   - 响应中仅包含事实撤回告示、撤回原因（`revocation_reason`）及历史审计编号，保障知识引用体系中“撤回动作本身公开透明”。

---

## 五、变更事件流（Changes Stream）

为支持城市枢纽与外部搜索引擎的毫秒级同步，系统提供规范的追加式事件流：
- **数据规范**：`docs/contracts/schemas/changes-stream-event.schema.json`
- 采用 NDJSON（Newline Delimited JSON）流式输出；
- 携带单调递增的 `change_sequence_num`，确保下游消费者能够断点续传并不漏事件。

---

## 六、S1 至 S5 治理与架构体系全景总结

至此，WZCityTCDS 已完成 MVP 阶段全套架构定位与数据契约的闭环建设：
- **S1（定位审查）**：固化 Option A，确立城市时空可信内容枢纽的正式事实出版内核地位；
- **S2（实体/信源契约）**：落实实体单根归口与上游 CMS 新闻语料接入/撤稿协议；
- **S3（版本链状态机）**：建立不可变 Append-Only 事实版本链与单向受控投影快照；
- **S4（证据验签引擎）**：落地 EvidenceSpan 字符级定位、SHA-256 哈希验签门禁与多源仲裁协议；
- **S5（机器出口与安全门禁）**：确立多端出口单根一致性与 Fail-Closed 发布安全防御边界。
