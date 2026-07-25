---
title: "TeamAct v2 差距与改造计划 — 现状映射 · 差距矩阵 · Shadow 迁移路径"
doc_kind: plan
version: 1
status: living
feature_ids: [F064, F078, F086, F117, F167, F208, F224, F233, F254]
related_docs:
  - design/teamact-v2-paradigm.md
  - architecture/collaboration-landscape.md
  - architecture/ownership/cells/ball-custody.md
topics: [multi-agent, a2a, teamact, gap-analysis, migration, coordination-ledger]
created: 2026-07-25
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
provenance: >
  三份文档之二（工程）：范式规范 → teamact-v2-paradigm.md（基础）；
  本文 = 当前实现与目标范式的差距 + 改造路径（活文档，随实施推进更新，
  同时是与 maintainer 沟通的底稿）；对外交流稿 → teamact-v2-tech-article.md。
---

# TeamAct v2 差距与改造计划

> **定位**：活文档。回答三个问题——我们现在有什么（§1 现状映射）、离
> [范式规范](./teamact-v2-paradigm.md)差多远（§2 差距矩阵）、怎么走过去（§3 改造路径）。
> **代码改造在与 maintainer 沟通对齐前不启动**（§4 是沟通要点清单）；
> 本文先行维护，作为沟通底稿。

## 0. 总判断

三轮讨论的核心结论：**现有机制大多不是要推倒的补丁，而是范式中正确概念的早期实现**。@ 传球是 Offer 的会话级表达、球权言语行为是 Claim 的推断式实现、F233 事件溯源是 ledger 的模式先例、F224 续接协调器是 Attempt 链的先行者。改造是**把推断升级为结构、把 thread 粒度收窄为 per-recipient、把散落机制接到统一账本**——不是 big bang 重写。

## 1. 现状映射：现有机制 → 范式概念

| 现有机制 | 对应范式概念 | 判定 | 说明 |
|---|---|---|---|
| @ mention 路由（六层管线） | Offer 的定向投递 | **保留 + 背后结构化** | 会话表达不变；旁路产生结构化 offer 事件 |
| F078 无 @ 消息 last-replier 路由 | 无目标 offer 的默认路由策略 | 保留 | 实测证明路由本身正确（incident 1a 的根因不在它） |
| 球权 = 言语行为（"我来做"）+ F233 观测推断 | Claim | **升级** | 推断 → 结构化 CAS 事件；补 lease / generation |
| `hold_ball`（wakeAfterMs / waitSourceRef / wakeWhen） | park + 结构化等待声明 | 保留 | 已是结构化的先行实现 |
| F117 delivery 状态机（queued→delivered→canceled） | delivery 生命周期 | **升级** | per-recipient 化；"未投递"≠"不可读"（D4） |
| F254 freshness gate（thread 级 unseen + seenCursor） | obligation 判定 | **升级（粒度）** | thread 级 → per-recipient；判定源改读协调状态 |
| F224 SessionContinuationCoordinator（prepare/commit 已接线） | Attempt 链 | **升级（补 lineage）** | 缺"续的是哪个工作、谁的 claim、第几次尝试" |
| F233 ball-custody event log + 纯函数投影 + 7 态状态机 | coordination ledger 的模式先例 | **保持边界，成为消费者** | KD-1/KD-4 不动：观测优先、不做 workflow engine |
| F167 乒乓熔断 / streak / 虚空传球检测 | bounded termination 的部分实现 | 保留 | 接入 WorkUnit 终止控制后统一 |
| F064 exit check（该传没传） | Transition 完整性的 harness 兜底 | 保留 | 结构化 Transition 落地后降级为二线防护 |
| F086 multi-mention 编排（pending→running→partial→done） | fan-out 的早期形态 | **升级** | 缺正式 join/fan-in barrier（all/quorum/first-success） |
| F208 能力画像（六维档案） | actor profile 的 capability 维度 | 保留 | authority / family 维度待补 |
| 跨家族 review 铁律（家规文本） | verify 否定约束 | **形式化** | 从约定变为 claim policy 校验（author ≠ verifier） |
| 决策漏斗 / 自决边界（家规文本） | authority policy | 形式化（低优先级） | 文本形态目前够用 |
| whisper / visibility filter | readability ACL | 保留 | D4 的"投递状态不决定阅读权限"与现状一致 |
| DeliveryCursorStore 的 CAS 基础设施 | CAS 原语先例 | 复用 | **不新增同构 cursor**（S1）：`seenCursor` 继续表达连续阅读边界，membership projection 表达稀疏义务集合——语义分工，不静默改写前者 |
| 毛线球 task 系统 | WorkUnit 的最近似物 | **待决**（OQ-1） | 有 title/why/owner/status，无 claim/attempt/outcome 语义 |

**历史错误默认（防回归项，非现状）**：①"无 @ = 给所有人"的隐式广播——**已被 F078 last-replier 定向路由修正**，列此仅防回归；②thread-wide 广播式**义务**——当前仍存在（G3/G4），由 per-recipient membership 替代；注意被淘汰的是义务广播，不是 readability（D4）。

## 2. 差距矩阵：范式条款 ↔ 现状 ↔ 缺口

> 分级图例（依赖层级，不是事故严重级）：**Foundation** = 基座与实测痛点，S0–S2 直接覆盖；**Next** = 依赖基座的第二梯队（S4+ 前段）；**Later** = 完善项（S4+ 后段）。

| # | 范式条款（[spec](./teamact-v2-paradigm.md) 锚点） | 现状 | 缺口 | 层级 |
|---|---|---|---|---|
| G1 | WorkUnit 实体（§3） | 工作分散在 thread / feat doc / 毛线球 task，无统一可认领单元 | 核心实体缺失，是其余全部条款的载体 | **Foundation** |
| G2 | Offer / Claim 结构化事件 + CAS（§3, §6-1） | 言语行为 + F233 事后观测推断 | 无 claim CAS、无 lease、无 generation；"两只猫都以为对方在做"无结构防护 | **Foundation** |
| G3 | per-recipient obligation（§5） | seenCursor **已 per-cat**（`userId+catId+threadId` 分区），但义务判定从 raw thread cursor 向后扫描 | 缺 per-message obligation membership：单调 cursor 无法表达稀疏义务集合（incident 1b） | **Foundation** |
| G4 | hydration per-invocation-scope（§5） | 上下文注入按 thread 取材，不查义务归属 | 缺同一 membership projection 的消费侧（incident 1a） | **Foundation** |
| G5 | coordination ledger（§7） | F233 有球权域 event log（模式已验证），协调域账本不存在 | G1-G4 的存储基座 | **Foundation** |
| G6 | Attempt 链 + lineage（§8） | F224 续接协调器已接线，无 WorkUnit/Claim/Attempt 关联 | session 断片仍产生球权歧义 | Next |
| G7 | HumanGate + offer/claim 双层 SLA（§3） | 无。F233 诊断："operator 是唯一没有掉球保护的 agent" | 人的待办无认领态、无 SLA、无探测 | Next |
| G8 | FenceToken / fenced effects（§6-2, C2） | 无任何 fencing | 易主/取消竞态零防护（跨猫接管已有真实场景，如额度中断后的任务转移） | Next |
| G9 | TransferOffer 授权链（C3） | 接管靠会话约定（cross-cat-handoff skill） | 无结构化授权与原子接棒 | Next |
| G10 | 静默掉球探测（attempt.started + heartbeat，C1） | F233 **已有 task/ball 级 probe + wake（Phase B 已落地）** | 缺 Attempt heartbeat/lease 与 provider silent-death 检测（incident 5：探测粒度在球不在执行） | Next |
| G11 | Outcome 不可变坐标 + verify 绑定（C4） | review 实践有 hash 惯例（本范式历轮 review 即例），无结构化 | TOCTOU 靠 reviewer 自律 | Later |
| G12 | join / fan-in（C5） | F086 状态机无正式 barrier | fan-out review 结果聚合靠人工 | Later |
| G13 | 投影分层（§7：审计序 / 因果树 / 执行泳道） | 单一壁钟时间线 UI | incident 2 实测痛点 | Later |
| G14 | verify 否定约束形式化（§6-4） | 家规文本 + 流程自律（平台层还受共享 GitHub 账号限制） | 无结构化校验 | Later |

## 3. 改造路径：shadow 观测 → authority 晋升 → 受控行为切换

**总原则（决议 D7 + review r1 修正）**：不从局部 data model 补丁开始；先建影子本体 + day-1 **dry-run** 消费者。**S0 严格零行为变化；S1–S3 是受控的行为切换**——每次切换必须先通过 Authority Promotion Gate（下），带 feature flag 与单开关 rollback。**允许丢事件的 shadow 数据永远不直接驱动阻断 / 注入 / 展示决策**。

### Phase S0 — Shadow CoordinationLedger（G5, G1, G2 影子化；observe-only）

- **新建独立 aggregate**：新 key namespace + 闭合事件 union + 纯函数投影，复刻 F233 已验证的 event-sourcing 模式（append-only、rebuild = replay、副作用不进 projector）。**不复用 F233 event log**（KD-1/KD-4 边界）。
- **影子事件产生**：现有系统动作旁路点 fire-and-forget 产生 workunit / offer / claim / attempt 影子事件（@ 路由 → offer.made；接球响应 → claim.acquired 推断；invocation 终态 → attempt.*；照 F233 B2 ingest 先例，失败仅 log 不阻塞主流程）。
- **消费者一律 dry-run**（影子系统没有读者就不会被现实修正，但读者只观测不决策）：①F233 值班简报适配器——只产出协调事件 vs 球权观测的**对照报告**，不改简报行为；②freshness v2 原型——**只记录"新语义会怎么判"，不参与实际拦截**。
- **验收**：影子轨迹与 F233 观测一致性对照；主链路零行为变化；**性能预算可测**——主链 p95/p99 延迟增量、错误率、影子写队列积压各设上限（阈值以 S0 前 baseline 实测定案；先验建议 p99 增量 ≤1% 且无新增错误），超预算 = 验收失败。

### Authority Promotion Gate — 任何行为切换的必经门

1. **Dual-read 对比**：新旧判定并行运行，持续记录 coverage（事件覆盖率）、ordering（序一致性）、lag、mismatch 明细；
2. **Producer 转 durable**：该路径的影子 fire-and-forget 升级为 outbox / durable 写入，补 backfill/replay（历史窗口可重放）；
3. **量化阈值**：达标才可切（阈值以 S0 实测数据定案；先验建议：coverage > 99.9%，决策 mismatch = 0 持续一个完整观察窗）；
4. **切换机制**：feature flag 灰度 + 单开关 rollback；
5. **逐路径晋升**：S1 hydration、S2 freshness、S3 UI 各自独立过本门——一条路径晋升不代表其他路径就绪。

### Phase S1 — Delivery/Obligation Membership 投影（G3, G4）

**坐标系修正（review r1）**：现有 delivery cursor **已经**按 `userId + catId + threadId` 分区、seenCursor 已 per-cat——缺的不是"per-recipient cursor"。**真正缺口是每条消息对每个 recipient 的 delivery/obligation membership**：freshness 从 raw thread cursor 向后扫描，单调 cursor 无法表达"cursor 之后只有部分消息属于我的义务"这种稀疏集合。

```
Message/Event
  → per-recipient Delivery/Obligation projection（每条消息的义务归属判定）
  → recipient inbox（按归属过滤后的有序视图）
  → cursor 语义收窄为"该 inbox 内的进度"
```

- **hydration 与 freshness 都查询这个 projection**——不新增与现有 cursor 同构的第二套 cursor。
- 行为切换（过 Promotion Gate 后）：invocation 上下文水合按 recipient inbox 过滤。
- **验收**：重放 incident 1a/1b，第三方猫不再被注入他人消息；dual-read mismatch = 0 达标窗。

### Phase S2 — Freshness v2 authority 切换（G3 转正）

- 义务判定从 raw thread 扫描切换到 S1 projection（dry-run 判定对照已在 S0/S1 期积累，过 Promotion Gate 后切换）。
- **验收**：现有 freshness 测试迁移通过；误触发率相对 S0 期 baseline 下降。

### Phase S3 — 投影分层（G13）

- 三视图：arrival-order 审计 / conversation 因果树（`replyTo` 已有，只做渲染）/ WorkUnit-Attempt 执行泳道。
- **执行泳道的数据源约束**（与总原则一致）：晋升前只做**内部 dry-run 对照视图**（不进正式 UI）；正式 UI 只读取**通过 S3 Promotion Gate 后的 authoritative projection**（该路径 producer 已转 durable、dual-read 达标）——lossy shadow 数据不进正式展示。
- **验收**：UI 三视图可切换；co-creator 实测 incident 2 场景消除；泳道视图与审计视图无数据缺失差异。

### Phase S4+ — 逐项转正（每项独立过 Promotion Gate + maintainer 对齐）

claim 从影子推断转显式 API → lease/heartbeat → FenceToken + effect 准入（G8）→ HumanGate + SLA（G7）→ TransferOffer（G9）→ Outcome/verify 绑定（G11）→ join barrier（G12）。每项转正前提：S0 影子数据证明该语义在真实负载下成立。

## 4. Maintainer 沟通要点（启动前必须对齐）

1. **方向**：责任协调层（coordination ledger + WorkUnit 本体）是否进主线 roadmap；shadow-first 节奏是否可接受。
2. **边界**：F233 KD-1/KD-4 维持不动（我们承诺 CoordinationLedger 是独立新 aggregate）；新 aggregate 的 ownership 归属与命名。
3. **PR 粒度**：S0 建议拆 4 个 PR（aggregate 骨架+事件 union / 旁路 ingest / dry-run 双消费者 / Promotion Gate 基建：dual-read 对比与指标）；S1-S3 各 1-2 个，**行为切换 PR 必须自带 feature flag + rollback**。
4. **API 表面**：S0–S3 不新增用户可见 API。行为语义上：S0 严格零变化；S1–S3 是受控行为切换，全部走 Authority Promotion Gate + feature flag + rollback（§3）。

**开放问题（OQ）**：

- **OQ-1** WorkUnit 与毛线球 task 的关系：统一（task 升级为 WorkUnit）还是并存映射（task 是 WorkUnit 的 UI 投影）？倾向后者起步。
- **OQ-2** 协调事件保留策略：append-only 无限增长 vs 分段归档 + 快照重放。
- **OQ-3** multi-operator 是否纳入本轮：建议不纳入（范式 §9 声明的验证边界外）。

## 5. 变更日志

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-07-25 | 初版：现状映射 18 项、差距矩阵 14 项、S0-S4 路径、沟通要点 | 宪宪/claude-fable-5 |
| 2026-07-25 | review r1（sol）修订：Authority Promotion Gate 五步门；S1 改 per-message Delivery/Obligation membership projection（cursor 已 per-cat 的坐标系修正）；G3/G4/G10 现状精确化；分级改 Foundation/Next/Later；"无@=广播"标为已修正的历史默认 | 宪宪/claude-fable-5 |
