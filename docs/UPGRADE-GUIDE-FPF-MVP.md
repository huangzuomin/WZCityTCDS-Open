# WZCityTCDS 架构演进与版本升级合并指南（FPF MVP 全阶段收官版）

> **目标受众**：原分支作者、核心研发人员与部署运维团队  
> **适用版本**：从历史分支（如 `master` / `test/rbac-*`）升级迁移至 FPF 规范化生产基线 `main`（标签：`v0.3.0-fpf`）  
> **仓库地址**：
> - 内部 Gitea 仓库：`http://192.168.214.54:3000/ssadwlll/WZCityTCDS`（分支：`main`）
> - GitHub 镜像仓库：`https://github.com/huangzuomin/WZCityTCDS`（分支：`main`）
> - 开源治理控制器：`https://github.com/huangzuomin/WZCityTCDS-Open`（分支：`main`）

---

## 一、本轮迭代实现了什么？（功能复盘与问题解决）

在本轮迭代中，我们引入了 **FPF（Five Powers Flow，五权分立自动化自治开发范式）**。与传统的单人/单体 Agent 开发不同，FPF 强制拆分了架构审查、代码实现（DEV）、独立容器实机验收（独立 QA Bot）、主权授权（Owner）与地图记账（Scribe）五项权力，彻底杜绝了“自己写代码、自己改测试、自说自话通过”的假阳性风险。

整个迭代严格围绕 **Phase 1（架构契约 S1~S5）**、**Phase 2（核心引擎 C1~C5）**、**Phase 3（服务运行时与端点 R1~R4）** 推进，累计完成 31 个规范化 PR，实现以下核心功能与架构升级：

### 1.1 核心功能与能力落地

1. **确立城市时空可信内容枢纽「Option A」出版内核定位（S1/S2）**：
   - **单根实体原则**：明确本系统**不建立第二套城市实体库**，城市实体唯一主身份（`ent_[a-z0-9_-]{8,64}`）完全继承自枢纽中台主数据；
   - **单向受控投影**：本系统独占事实断言与出版签发入口，发布后单向推入枢纽供检索，枢纽不得反向篡改事实版本。
2. **不可变事实版本链状态机（S3 / C3）**：
   - 彻底废除物理更新（UPDATE）事实数据的模式，采用 **Append-Only 版本链**；
   - 任何事实修正（更正、更名、时间校正、数值调整）均生成具有唯一 UUID 的全新 `FactRevision`，严格维护因果前驱链（`predecessor_id`），历史版本可追溯且物理不可变。
3. **字符级证据片段（EvidenceSpan）溯源与哈希验签（S4 / C4）**：
   - 实行「无证据不发布」硬约束。每条事实断言必须绑定原文正文的起始偏移量、结束偏移量、精确引文字符串及 Unicode NFKC 标准化后的 SHA-256 哈希值；
   - 建立自动化信源撤稿失效管道：当上游新闻撤稿时，自动级联标记证据失效（`STALE_SOURCE_RETRACTED`），阻止无效事实继续流通；
   - 内置冲突仲裁算法：同属性出现数值或表述分歧时，按权威等级（官方发布 > 权威商业门户 > 自媒体）自动化裁决，重大冲突挂起等待人工裁决。
4. **统一发布安全门禁与多渠道分发出口（S5 / C5 / R1）**：
   - **Fail-Closed 安全门禁**：公共出口前置安全检查，未签发草稿、证据失效内容绝对不可见；内嵌正则与 IP 探测，一旦检测到内网私有 IP（`192.168.x.x`、`10.x.x.x`）或敏感 Token 泄露，**立即硬拦截并返回 HTTP 403**；
   - **多端出口统一路由**：对外提供统一高可用出口，包括 REST API（`/outlets/snapshot/:id`）、HTML 静态存档归档页（`/outlets/archive/:id`）、Atom 订阅流（`/outlets/feed.atom`）、站点地图（`/outlets/sitemap.xml`）、变更消费流（`/outlets/changes.ndjson`）以及面向 AI Agent 的 LLM MCP 智能体协议。
5. **采编审校工作台与 NestJS API（R2）**：
   - 建立完整的任务流转状态机（`PENDING_REVIEW` -> `IN_REVIEW` -> `CHANGES_REQUESTED` / `REJECTED` / `PUBLISHED`）；
   - 提供任务认领、放弃、预检证据验签、人工冲突仲裁与终审签发端点，严格受 JWT 与 `@Roles('admin', 'editor', 'reviewer')` 角色权限守卫。
6. **枢纽单向投影同步端与变更流消费端（R3）**：
   - 实现了带 SHA-256 数字签名的投影回执客户端（`HubOneWayProjector`）；
   - 实现了基于单调递增 Sequence Cursor 的上游实体变更消费器（`ChangesStreamConsumer`），支持 NDJSON 流式解析与死信队列容错。
7. **全链路端到端集成流水线与系统健康评估器（R4）**：
   - 封装 `EndToEndIntegrationPipeline` 串联 9 步黄金发布链路；
   - 落地 `SystemHealthEvaluator`，自动化探测审校台、证据引擎、版本链存储、安全网关、公共出口、枢纽投影 6 大核心子系统的健康运行状态与指标。

### 1.2 解决的根本性痛点

- **仓库体积与大文件污染治理**：排除了老历史中近 200MB 的模型权重二进制文件（`model.safetensors`、`pytorch_model.bin`）及 45MB 的无用抓包 Excel，将仓库恢复为极度纯净的工程代码库；
- **敏感信息彻底剥离**：内网生产机 IP、私有数据库连接串与临时调试凭证已从 Git 提交历史中全量剥离脱敏；
- **双语言契约双保险**：完成 TypeScript 核心实现（125/125 单元与集成测试通过）与 Python Pydantic v2 对等镜像模型（120/120 校验测试通过），跨语言调用零摩擦；
- **确立可审计治理账本**：全流程所有操作、PR、Commit SHA 与独立 QA 容器运行回执均在 `.local-coordination/` 下进行哈希存证，完全可复盘追溯。

---

## 二、合并与切换新版本操作指南

### 2.1 为什么不能直接执行 `git merge`？
新基线是以脱敏后的代码作为独立初始提交（`2165d7a`）起步演进的。若原分支作者直接在老分支执行 `git merge open/main`，会遇到：
1. **`fatal: refusing to merge unrelated histories`** 错误；
2. 即使加 `--allow-unrelated-histories` 强行合并，也会将老分支里几百兆的模型大文件、废弃脚本和潜在的敏感信息**重新倒灌回新工程**，导致好不容易建立的安全网关和规范被破坏。

因此，请严格按照以下操作指南完成版本切换：

---

### 2.2 推荐方案：直接切换至 `main` 主干分支（零污染、最稳妥）

新版本代码已经完整推送至内网 Gitea 及 GitHub 私有仓库的 **`main`** 分支，原作者只需将开发工作区切换至 `main` 即可：

#### 第一步：备份个人正在开发的临时分支
```bash
# 确保本地未提交的修改先暂存或提交到个人备份分支
git checkout -b backup/my-in-progress-work
git add .
git commit -m "chore: backup in-progress work before migrating to main"
```

#### 第二步：拉取并切换到最新的 `main`
```bash
# 获取远端最新引用
git fetch origin main

# 切换并跟踪 Gitea 上的 main 分支
git checkout -B main origin/main
```

#### 第三步：本地依赖安装与质量自检
```bash
# 1. 验证 Python 镜像契约（120 项全通即正常）
export PYTHONPATH="$(pwd)"   # Windows PowerShell 下执行: $env:PYTHONPATH=(Get-Location).Path
python packages/shared/python/contracts/verify_contracts.py

# 2. 验证 TypeScript 核心契约与测试（125 项全通即正常）
node packages/shared/dist/e2e/e2e.spec.js
```

#### 第四步：若有老分支尚未提交的代码需要并入
如果原分支作者在老分支上有**确实需要保留的新业务逻辑或页面**，切忌整枝合并，使用 `git cherry-pick` 单独拣选：
```bash
# 切换到 main 后，拉取专属特性分支
git checkout -b feat/integrate-my-feature

# 将老分支特定的提交拣选过来（替换为实际 Commit SHA）
git cherry-pick <COMMIT_HASH>

# 解决少量冲突后，运行自动化测试确保全部通过
python packages/shared/python/contracts/verify_contracts.py
```

---

### 2.3 备选方案：若现有部署脚本强制依赖 `master` 名称

如果原作者或服务器的自动化流水线写死了只认 `master`，请在本地执行指针覆盖对齐：

```bash
# 1. 将老 master 重命名归档备查
git branch -m master master-legacy-archive

# 2. 从最新的 main 重新拉出本地 master 分支
git checkout -B master origin/main

# 3. 强推覆盖 Gitea 远端 master（需仓库管理员权限）
git push origin master --force
```

---

## 三、下一阶段开发路线图（迈向生产 MVP）

当前核心逻辑、契约层与状态机均已在模拟环境中 100% 验证通过。距离生产环境完整点亮，下一阶段需要重点攻克以下 5 个工程任务：

```
[阶段 1: 物理存储与基础设施] ──► [阶段 2: 异步任务与队列] ──► [阶段 3: 前后端真实联调] ──► [阶段 4: 容器化交付]
        │                               │                             │
    MySQL 8.0 迁移                  Redis + BullMQ              Vue3 后台页面点亮
    真实表结构与种子数据            异步新闻爬取队列            LLM API Key 真实调用
```

### 1. 物理数据库迁移与连接配置（优先级：P0）
- **任务目标**：将集成测试的内存存储对接到真实的 MySQL 8.0 / InnoDB 实例；
- **具体工作**：
  1. 在根目录配置实际 `.env`（参考 `.env.example` 中的 `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`）；
  2. 执行 `apps/api` 下的 Drizzle 迁移脚本：`pnpm --filter @ssot/api run db:push` 或 `db:migrate`，生成完整的物理表与外键索引；
  3. 运行种子脚本注入初始系统管理员账号与基础字典数据。

### 2. Redis 缓存与 BullMQ 异步调度接入（优先级：P1）
- **任务目标**：打通新闻源异步抓取与大模型批量抽取管线；
- **具体工作**：
  1. 启动 Redis 实例并配置连接参数；
  2. 启用 `apps/api/src/modules/news` 中的定时爬取与去重队列；
  3. 配置高并发限流保护，防止上游新闻源或网络波动造成任务堆积。

### 3. Vue3 审校后台（Admin）前后端联调点亮（优先级：P0）
- **任务目标**：让审校人员可以在浏览器中真实操作审校工作台；
- **具体工作**：
  1. 联调 `apps/admin` 前端与 `apps/api` 后端，打通登录 JWT 验证、Token 刷新与跨域（CORS）；
  2. 将已封装好的前端 API 客户端（`apps/admin/src/api/` 下的 `workbenchApi`, `outletsApi`, `healthApi`, `hubSyncApi`）与现有 UI 视图完成数据绑定；
  3. 现场验证：新闻录入 -> 待审列表显示 -> 人工仲裁分歧 -> 点击批准发布 -> 详情页即时展示最新 Revision。

### 4. 生产大模型抽取流水线密钥与熔断配置（优先级：P1）
- **任务目标**：接入真实 LLM 提供商进行实时事实自动抽取；
- **具体工作**：
  1. 在 `apps/api/src/modules/llm-config` 中配置生产 LLM API Key（通义千问、DeepSeek、Moonshot 等）；
  2. 配置调用超时时间（默认 30s）与失败重试策略；
  3. 启用抽取费用监控与 Token 预算熔断拦截。

### 5. 一键容器化部署交付（Docker Compose）（优先级：P1）
- **任务目标**：实现服务器零配置一键启动；
- **具体工作**：
  1. 编写包含 MySQL 8.0、Redis 7、API 后端容器、Admin 前端 Nginx 容器的 `docker-compose.yml`；
  2. 提供生产环境 `deploy.sh` 脚本，支持健康探针检查（`GET /api/health`）与热重载。

---

> **结语**：本次升级奠定了系统长期演进的坚实基石，杜绝了技术债务与架构歧义。欢迎原作者按照本指南平滑切入 `main` 分支，共同开启下一阶段生产联调！
