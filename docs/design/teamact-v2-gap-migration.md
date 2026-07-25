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
| DeliveryCursorStore 的 CAS 基础设施 | CAS 原语先例 | 复用 | 新 cursor 用独立 key prefix（F254 先例） |
| 毛线球 task 系统 | WorkUnit 的最近似物 | **待决**（OQ-1） | 有 title/why/owner/status，无 claim/attempt/outcome 语义 |

**淘汰项**（讨论确认的错误默认）：thread-wide 广播式义务（被 per-recipient obligation 替代）；"无 @ = 给所有人"的隐式广播语义（被显式路由策略替代——注意淘汰的是义务广播，不是 readability）。

## 2. 差距矩阵：范式条款 ↔ 现状 ↔ 缺口

| # | 范式条款（[spec](./teamact-v2-paradigm.md) 锚点） | 现状 | 缺口 | 级别 |
|---|---|---|---|---|
| G1 | WorkUnit 实体（§3） | 工作分散在 thread / feat doc / 毛线球 task，无统一可认领单元 | 核心实体缺失，是其余全部条款的载体 | **P0** |
| G2 | Offer / Claim 结构化事件 + CAS（§3, §6-1） | 言语行为 + F233 事后观测推断 | 无 claim CAS、无 lease、无 generation；"两只猫都以为对方在做"无结构防护 | **P0** |
| G3 | per-recipient obligation（§5） | F254 thread 级 unseen | incident 1b 实测痛点：他人对话算进自己义务 | **P0** |
| G4 | hydration per-invocation-scope（§5） | thread-wide 上下文注入 | incident 1a 实测痛点：他人消息注入 invocation | **P0** |
| G5 | coordination ledger（§7） | F233 有球权域 event log（模式已验证），协调域账本不存在 | G1-G4 的存储基座 | **P0** |
| G6 | Attempt 链 + lineage（§8） | F224 续接协调器已接线，无 WorkUnit/Claim/Attempt 关联 | session 断片仍产生球权歧义 | P1 |
| G7 | HumanGate + offer/claim 双层 SLA（§3） | 无。F233 诊断："operator 是唯一没有掉球保护的 agent" | 人的待办无认领态、无 SLA、无探测 | P1 |
| G8 | FenceToken / fenced effects（§6-2, C2） | 无任何 fencing | 易主/取消竞态零防护（跨猫接管已有真实场景，如额度中断后的任务转移） | P1 |
| G9 | TransferOffer 授权链（C3） | 接管靠会话约定（cross-cat-handoff skill） | 无结构化授权与原子接棒 | P1 |
| G10 | 静默掉球探测（attempt.started + heartbeat，C1） | F233 probe 计划中（Phase B 后续）；无 attempt 心跳 | incident 5 实测痛点：API 中断静默死亡靠人发现 | P1 |
| G11 | Outcome 不可变坐标 + verify 绑定（C4） | review 实践有 hash 惯例（本次五轮 review 即例），无结构化 | TOCTOU 靠 reviewer 自律 | P2 |
| G12 | join / fan-in（C5） | F086 状态机无正式 barrier | fan-out review 结果聚合靠人工 | P2 |
| G13 | 投影分层（§7：审计序 / 因果树 / 执行泳道） | 单一壁钟时间线 UI | incident 2 实测痛点 | P2 |
| G14 | verify 否定约束形式化（§6-4） | 家规文本 + 流程自律（平台层还受共享 GitHub 账号限制） | 无结构化校验 | P2 |

## 3. 改造路径：shadow 先行，逐段转正

**总原则（决议 D7）**：不从局部 data model 补丁开始；先建影子本体 + day-1 真实消费者；S0–S3 **不改变任何现有行为契约**，转正逐项与 maintainer 对齐。

### Phase S0 — Shadow CoordinationLedger（G5, G1, G2 影子化）

- **新建独立 aggregate**：新 key namespace + 闭合事件 union + 纯函数投影，复刻 F233 已验证的 event-sourcing 模式（append-only、rebuild = replay、副作用不进 projector）。**不复用 F233 event log**（KD-1/KD-4 边界）。
- **影子事件产生**：在现有系统动作旁路点 fire-and-forget 产生 workunit / offer / claim / attempt 影子事件（@ 路由 → offer.made；接球响应 → claim.acquired 推断；invocation 终态 → attempt.*；照 F233 B2 ingest 先例，失败仅 log 不阻塞主流程）。
- **Day-1 消费者**（影子系统没有读者就不会被现实修正）：①F233 值班简报经适配器读协调事件做聚合对照；②freshness v2 原型（S2 的读模型预演）。
- **验收**：影子账本重放出的球权轨迹与 F233 观测一致（对照测试）；主链路零行为变化、零性能回归。

### Phase S1 — Delivery / Hydration 隔离（G3, G4）

- per-recipient delivery cursor（复用 DeliveryCursorStore CAS，独立 key prefix，F254 先例）；invocation 上下文水合按 recipient + invocation scope 过滤。
- **验收**：重放 incident 1a/1b 场景（无 @ 消息 → last-replier 路由 → 第三方猫被显式 @ 唤醒），第三方猫不再被注入他人消息、不再被 freshness 拦截。

### Phase S2 — Freshness v2（G3 转正）

- 义务判定改读 per-recipient delivery / claim 状态（消费 S0 账本），替换 thread 级 unseen。
- **验收**：F254 现有测试迁移通过；freshness 误触发率指标（S0 影子期先建 baseline）。

### Phase S3 — 投影分层（G13）

- 三视图：arrival-order 审计 / conversation 因果树（`replyTo` 已有，只做渲染）/ WorkUnit-Attempt 执行泳道（读 shadow ledger）。
- **验收**：UI 三视图可切换；co-creator 实测 incident 2 场景消除。

### Phase S4+ — 逐项转正（视 shadow 验证结果，每项单独对齐）

claim 从影子推断转显式 API → lease/heartbeat → FenceToken + effect 准入（G8）→ HumanGate + SLA（G7）→ TransferOffer（G9）→ Outcome/verify 绑定（G11）→ join barrier（G12）。每项转正前提：S0 影子数据证明该语义在真实负载下成立。

## 4. Maintainer 沟通要点（启动前必须对齐）

1. **方向**：责任协调层（coordination ledger + WorkUnit 本体）是否进主线 roadmap；shadow-first 节奏是否可接受。
2. **边界**：F233 KD-1/KD-4 维持不动（我们承诺 CoordinationLedger 是独立新 aggregate）；新 aggregate 的 ownership 归属与命名。
3. **PR 粒度**：S0 建议拆 3 个 PR（aggregate 骨架+事件 union / 旁路 ingest / 双消费者）；S1-S3 各 1-2 个。
4. **API 表面**：S0–S3 纯内部，不新增用户可见 API，不改现有行为契约。

**开放问题（OQ）**：

- **OQ-1** WorkUnit 与毛线球 task 的关系：统一（task 升级为 WorkUnit）还是并存映射（task 是 WorkUnit 的 UI 投影）？倾向后者起步。
- **OQ-2** 协调事件保留策略：append-only 无限增长 vs 分段归档 + 快照重放。
- **OQ-3** multi-operator 是否纳入本轮：建议不纳入（范式 §9 声明的验证边界外）。

## 5. 变更日志

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-07-25 | 初版：现状映射 18 项、差距矩阵 14 项、S0-S4 路径、沟通要点 | 宪宪/claude-fable-5 |
