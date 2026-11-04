# WZCityTCDS EvidenceSpan 证据溯源与哈希验签引擎规约（S4 阶段）

> **状态：`APPROVED / EFFECTIVE`**  
> **关联任务：`WZCITYTCDS-S4-EVIDENCESPAN-VERIFICATION-ENGINE`**  
> **基准架构决策：`ARCH-DECISION-01 (OPTION_A)`**  
> **基线 Commit：`6722d56ade2d2fcbcf91f84a9304baed9f44e488`**  
> **绑定模式文件：`docs/contracts/schemas/evidence-span.schema.json`, `docs/contracts/schemas/evidence-verification-receipt.schema.json`, `docs/contracts/schemas/evidence-conflict-arbitration.schema.json`**

---

## 一、概述与设计宗旨

在真实事实发布系统中，任何结构化断言（`FactAssertion`）的可信根基在于其具备**不可伪造、可回溯至权威信源原文的精准证据链条**。

大语言模型（LLM）抽取过程中最严重的质量风险是“看似合理的事实幻觉（Hallucination）”与“篡改原文微调数字”。本规约作为 S4 研发切片的核心交付物，制定了**字符级证据定位（EvidenceSpan）**、**确定性 SHA-256 证据验签引擎**以及**多源冲突仲裁协议**。

---

## 二、EvidenceSpan 字符级定位模型

每一个 `EvidenceSpan` 必须在原始报道中具备唯一、不可争议的物理切片位置：

```
+-----------------------------------------------------------------------------------------+
| 上游 CMS 新闻原文 (source_doc_id: "news_20261101_0042")                                   |
| paragraph_index: 3                                                                      |
| text: "……2025年温州市实现地区生产总值（GDP）9426.8亿元，按不变价格计算，比上年增长5.8%……" |
+-----------------------------------------------------------------------------------------+
            ^                                                   ^
            | char_start: 18                                    | char_end: 42
+-----------+---------------------------------------------------+-------------------------+
| EvidenceSpan (span_id: "span_gdp_2025_01")                                              |
| quoted_text: "地区生产总值（GDP）9426.8亿元"                                            |
| span_hash: "3f7c1a8e9b4d...64位十六进制SHA-256..."                                      |
+-----------------------------------------------------------------------------------------+
```

### 2.1 确定性哈希计算算法
1. **输入字符流规范化**：
   - 提取原文从 `char_start` 到 `char_end` 截取的原始子串；
   - 保持原文原生空格与标点，严禁模型自行执行文本清洗或缩写；
   - 统一采用 Unicode NFKC 规整化；
2. **编码与哈希**：
   - 采用标准 UTF-8 字节流编码；
   - 采用安全散列算法 SHA-256，生成 64 位小写十六进制字符串（`span_hash`）；
3. **不可变绑定**：
   - `span_hash` 一经计算入库，即作为该证据切片的不可变数字指纹。任何对引用文本或原稿内容的篡改，均可被瞬间检出。

---

## 三、验签引擎门禁（Verification Engine Gate Invariant）

系统实施强类型的发布门禁守卫（Gate Invariant）：

```
[待审事实断言] ---> [Evidence Verification Engine] ---> [验签回执 Receipt]
                               |                                 |
                               +--- SHA-256 指纹比对              +---> PASS?
                               +--- 原文段落切片重验                    |--- YES: 允许签发 (PUBLISHED)
                               +--- 信源存续状态核实                    +--- NO:  拦截并驳回 (BLOCKED)
```

### 3.1 强制门禁规则
- **无回执不签发**：任何 `FactRevision` 在从 `PENDING_REVIEW` 流转至 `PUBLISHED` 时，必须绑定一份综合结论为 `PASS` 的有效验签回执（`EvidenceVerificationReceipt`）；
- **全要素校验三步法**：
  1. **指纹校验（Hash Match）**：依据当前存储的 `quoted_text` 重新计算 SHA-256，必须与 `span_hash` 完全一致；
  2. **原文重验（Containment Match）**：使用 `source_doc_id` 调取上游源语料段落，验证 `paragraph[paragraph_index][char_start:char_end] == quoted_text`；
  3. **存续校验（Source Validity）**：确认该上游文档未收到 `NEWS_RETRACTED` 撤稿事件；
- 任一环节未通过，回执状态立即判定为 `FAIL_*`，事实发布自动阻断。

---

## 四、多源证据冲突仲裁协议（Conflict Arbitration）

当多个权威来源对同一实体的同一属性断言给出不一致数值或描述时（例如统计局官方快讯与媒体转述不一致、或两家媒体报道口径冲突），触发仲裁流转：

- **数据规范**：`docs/contracts/schemas/evidence-conflict-arbitration.schema.json`

### 4.1 权威层级递减规则（Authority Hierarchy）
仲裁引擎优先采用权威层级规则进行自动消歧判定：
1. **第一层级**：`OFFICIAL_GOVERNMENT_RELEASE`（政府官方公报 / 统计局快报 / 法院裁决文书）；
2. **第二层级**：`STATE_MEDIA_PRIMARY`（主流权威党媒原始首发采编报道）；
3. **第三层级**：`LOCAL_MEDIA_REPORT`（地方媒体深入采写报道）；
4. **第四层级**：`COMMERCIAL_PORTAL`（商业门户转述）。

### 4.2 仲裁裁决模式
- **`ADOPT_HIGHER_AUTHORITY`**：高层级信源直接裁决覆盖低层级信源；
- **`PUBLISH_AS_ESTIMATED_RANGE`**：若为不同统计口径（如常住人口 vs 户籍人口），不视作事实冲突，分别作为不同属性路径发布，或合并为区间发布；
- **`SUSPEND_PENDING_OFFICIAL_CLARIFICATION`**：同层级权威媒体出现重大事实对立，挂起事实签发，提交人工专家仲裁员裁定。

---

## 五、上游撤稿影响面评估与降级

当接收到 S2 契约定义的 `NEWS_RETRACTED` 撤稿事件时，验签引擎执行自动降级扫描：
1. **定位所有挂接该 `source_doc_id` 的 EvidenceSpan**，将其 `quality_state` 置为 `STALE_SOURCE_RETRACTED`；
2. **评估依赖断言**：
   - 若断言具备其他 `VALIDATED` 的多源独立证据，更新断言版本，剔除失效证据，保持发布；
   - 若断言失去唯一支撑证据，自动触发状态机 `SUSPEND` 或 `REVOKE` 流程，更新对外出口，确保不留僵尸失实发布。
