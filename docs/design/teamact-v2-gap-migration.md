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

三轮讨论的核心结论：**现有机制大多不是要推倒的补丁，而是范式中正确概念的早期实现**。定向 @ 移交是 Offer 的会话级表达、“我来做”等责任声明是 Claim 的推断式实现、F233 事件溯源是 ledger 的模式先例、F224 续接协调器是 Attempt 链的先行者。改造是**把推断升级为结构、把 thread 粒度收窄为 per-recipient、把散落机制接到统一账本**——不是 big bang 重写。

## 0.5 实测失效记录（范式 §1.2 五类失效的具体数据）

> [范式文档](./teamact-v2-paradigm.md)只保留抽象失效模式（F1–F5）；具体实测数据按文档分工放在本文（2026-07 消息可见性实测 + 既往诊断）：

| # | 失效类 | 实测记录 | 结构根因 |
|---|--------|---------|---------|
| I1a | F1 | 无 @ 消息"1+1=?"按 F078 last-replier 规则**正确**路由给 terra；opus 随后被显式 @ 唤醒，初始上下文水合却把 terra 名下的这条消息（#1372）注入了 opus 的 invocation | 上下文注入不区分 recipient 与 invocation scope |
| I1b | F1 | opus 行动前被 thread 级 freshness 门禁拦下——"未读"判定引用的是 terra 对话中的回复（#1377"2"） | freshness unseen 按 thread 粒度计算 |
| I2 | F2 | UI 消息序混乱、并行回复按壁钟交错渲染、上下文断裂 | 缺投影分层（`replyTo` 已有但只表达消息父子） |
| I3 | F3 | Session 断片、重影、冗余触发（F224 诊断） | 续接协调器已接线，但无 WorkUnit/Claim/Attempt lineage |
| I4 | F4 | 升级给 operator 的事项无限期搁置；F233 诊断确认人工环节是唯一缺少职责超时保护的执行者 | 人不在协调模型内 |
| I5 | F5 | 范式讨论期间 opus 因供应商 API 中断两次静默失联，靠 co-creator 手动"继续"恢复 | 失败的唤醒无 attempt 记录与心跳 |

## 1. 现状映射：现有机制 → 范式概念

| 现有机制 | 对应范式概念 | 判定 | 说明 |
|---|---|---|---|
| @ mention 路由（六层管线） | Offer 的定向投递 | **保留 + 背后结构化** | 会话表达不变；旁路产生结构化 offer 事件 |
| F078 无 @ 消息 last-replier 路由 | 无目标 offer 的默认路由策略 | 保留 | 实测证明路由本身正确（I1a（§0.5） 的根因不在它） |
| 职责认领 = 言语行为（"我来做"）+ F233 观测推断 | Claim | **升级** | 推断 → 结构化 CAS 事件；补 lease / generation |
| `hold_ball`（wakeAfterMs / waitSourceRef / wakeWhen） | park + 结构化等待声明 | 保留 | 已是结构化的先行实现 |
| F117 消息级 delivery 状态机（queued→delivered→canceled） | transport 生命周期的早期实现 | **升级** | 当前状态属于整条消息，不是 per-recipient ACK；补 delivered / seen / processed 的逐接收者确认；"未投递"≠"不可读"（D4） |
| F254 freshness gate（thread 级 unseen + per-cat seenCursor） | attention 进度 + obligation 判定的早期实现 | **升级（粒度）** | 连续 cursor 不能表达稀疏 membership，也不能证明单条消息 processed；判定源改读协调状态 |
| F224 SessionContinuationCoordinator（prepare/commit 已接线） | Attempt 链 | **升级（补 lineage）** | 缺"续的是哪个工作、谁的 claim、第几次尝试" |
| F233 `ball-custody` event log（职责归属观测）+ 纯函数投影 + 7 态状态机 | coordination ledger 的模式先例 | **保持边界，成为消费者** | KD-1/KD-4 不动：观测优先、不做 workflow engine |
| F167 往返熔断 / streak / 无有效接收者的移交检测 | bounded termination 的部分实现 | 保留 | 接入 WorkUnit 终止控制后统一 |
| F064 exit check（该传没传） | Transition 完整性的 harness 兜底 | 保留 | 结构化 Transition 落地后降级为二线防护 |
| F086 multi-mention 编排（pending→running→partial→done） | fan-out 的早期形态 | **升级** | 缺正式 join/fan-in barrier（all/quorum/first-success） |
| F208 能力画像（六维档案） | actor profile 的 capability 维度 | 保留 | authority / family 维度待补 |
| 跨家族 review 铁律（家规文本） | verify 否定约束 | **形式化** | 从约定变为 claim policy 校验（author ≠ verifier） |
| 决策漏斗 / 自决边界（家规文本） | authority policy | 形式化（低优先级） | 文本形态目前够用 |
| whisper / visibility filter | readability ACL | 保留 | D4 的"投递状态不决定阅读权限"与现状一致 |
| DeliveryCursorStore 的 CAS 基础设施 | CAS 原语先例 | 复用 | **不新增同构 cursor**（S1）：`seenCursor` 继续表达连续阅读边界，membership projection 表达稀疏义务集合——语义分工，不静默改写前者 |
| 现有 task 跟踪系统 | WorkUnit 的最近似物 | **待决**（OQ-1） | 有 title/why/owner/status，无 claim/attempt/outcome 语义 |

### 1.1 当前 push 链路的精确语义

当前 A2A 是**主动 push 实现**，不只是“发一个 wake”：

```
post_message / line-start @
  → enqueueA2ATargets（定向路由）
  → InvocationQueue / QueueProcessor（排队并主动启动目标 invocation）
  → router.routeExecution（触发消息内容作为本次执行输入）
  → assembleIncrementalContext（再从 thread cursor 后水合历史）
```

这条链已经能定向触发目标、去重/合并部分重复 dispatch；`QueueProcessor` 在 entry 进入 processing、调用 `routeExecution` 之前就把消息从 queued 推进到 delivered。这个 delivered 是调度/展示生命周期，不是目标 runtime 回传的 ACK。确认和上下文边界尚未闭合：

- `StoredMessage.deliveryStatus` 是**整条消息**的 queued / delivered / canceled，不回答每个 recipient 是否真正收妥、看见、处理；
- `DeliveryCursorStore` 的 delivery / seen cursor 虽然按 cat 分区，却是 thread 上的**连续进度**，不能表达“消息 A 属于我、夹在中间的消息 B 不属于我”的稀疏 ACK；
- `assembleIncrementalContext` 按 thread cursor 取 delivered 消息并做可见性/自身消息过滤，尚不按 routing membership 过滤，所以第三方执行者后来被别的事件唤醒时，仍可能水合并误读不属于自己的消息（I1a）；
- 当前没有 authoritative 的 per-message × per-recipient `enqueued → delivered → seen → processed`，更没有把消息 processed 与 WorkUnit claimed / fulfilled 分开。

因此规范中的“push 不独占可靠性”只能表示**可靠性边界**：主动触发和 envelope 注入可以继续存在，但不能被当作 ACK 或责任真相源。对应的 pull 也不只是“下次 invocation 顺手扫未读消息”，而是执行者从共享的 membership / WorkUnit pool 发现尚未处理的消息与尚未认领的工作；目前这条统一 discovery loop 尚未实现。

**历史错误默认（防回归项，非现状）**：①"无 @ = 给所有人"的隐式广播——**已被 F078 last-replier 定向路由修正**，列此仅防回归；②thread-wide 广播式**义务**——当前仍存在（G3/G4），由 per-recipient membership 替代；注意被淘汰的是义务广播，不是 readability（D4）。

## 2. 差距矩阵：范式条款 ↔ 现状 ↔ 缺口

> 分级图例（依赖层级，不是事故严重级）：**Foundation** = 基座与实测痛点，S0–S2 直接覆盖；**Next** = 依赖基座的第二梯队（S4+ 前段）；**Later** = 完善项（S4+ 后段）。

| # | 范式条款（[spec](./teamact-v2-paradigm.md) 锚点） | 现状 | 缺口 | 层级 |
|---|---|---|---|---|
| G1 | WorkUnit 实体（§2.1） | 工作分散在 thread / feat doc / task 跟踪系统，无统一可认领单元 | 核心实体缺失，是其余全部条款的载体 | **Foundation** |
| G2 | Offer / Claim 结构化事件 + CAS（§2.1, §7 不变量 1） | 言语行为 + F233 事后观测推断 | 无 claim CAS、无 lease、无 generation；"两只猫都以为对方在做"无结构防护 | **Foundation** |
| G3 | per-recipient obligation（§4.1） | seenCursor **已 per-cat**（`userId+catId+threadId` 分区），但义务判定从 raw thread cursor 向后扫描 | 缺 per-message obligation membership：单调 cursor 无法表达稀疏义务集合（I1b（§0.5）） | **Foundation** |
| G4 | hydration per-invocation-scope（§4.1） | 上下文注入按 thread 取材，不查义务归属 | 缺同一 membership projection 的消费侧（I1a（§0.5）） | **Foundation** |
| G5 | coordination ledger（§8） | F233 有职责归属观测 event log（模式已验证），协调域账本不存在 | G1-G4 的存储基座 | **Foundation** |
| G6 | Attempt 链 + lineage（§2.1, §5.3, B7） | F224 续接协调器已接线，无 WorkUnit/Claim/Attempt 关联 | session 断片仍产生职责归属歧义 | Next |
| G7 | HumanGate + offer/claim 双层 SLA（§2.3） | 无；F233 诊断确认 operator 是唯一缺少职责超时保护的执行者 | 人的待办无认领态、无 SLA、无探测 | Next |
| G8 | FenceToken / fenced effects（§7 N2, B2） | 无任何 fencing | 职责转移/取消竞态零防护（跨执行者职责转移已有真实场景，如额度中断后的职责转移） | Next |
| G9 | TransferOffer 授权链（B3） | 职责转移靠会话约定（cross-cat-handoff skill） | 无结构化授权与原子接受转移 | Next |
| G10 | 静默执行失联探测（attempt started + 心跳，B1） | F233 **已有 task 级 probe + wake（Phase B 已落地）** | 缺 Attempt heartbeat/lease 与 provider silent-death 检测（I5：探测粒度在责任项，不在实际执行） | Next |
| G11 | Outcome 不可变坐标 + verify 绑定（B4） | review 实践有 hash 惯例（本范式历轮 review 即例），无结构化 | TOCTOU 靠 reviewer 自律 | Later |
| G12 | join / fan-in（B5） | F086 状态机无正式 barrier | fan-out review 结果聚合靠人工 | Later |
| G13 | 投影分层（§8：审计序 / 因果树 / 执行泳道） | 单一壁钟时间线 UI | I2 实测痛点（§0.5） | Later |
| G14 | verify 否定约束形式化（§7 不变量 4, §9.2） | 家规文本 + 流程自律（平台层还受共享 GitHub 账号限制） | 无结构化校验 | Later |
| G15 | 消息投递协议（§4.4：per-recipient ACK + push trigger + shared-state pull discovery） | 主动 push 已会排队/启动目标 invocation 并把 envelope 送入执行；有 `clientMessageId` 幂等先例、消息级 queued/delivered/canceled、per-cat 连续 cursor | 缺 per-message × per-recipient membership 与 enqueued/delivered/seen/processed ACK；hydration 仍按 thread 扫描；缺从 shared membership / work pool 发现未处理消息与未认领工作的统一 pull loop（与 G3/G4 同根，**并入 S1/S2**） | **Foundation** |
| G16 | 交接契约结构化（§4.2 四要素） | 五元组 handoff 约定（家规文本 + A2A 消息实践，质量靠自律） | 无结构化 schema、无 gate 校验（缺要素的交接照样发出）；验收：handoff/escalate 消息按契约四要素结构化率 | Next |
| G17 | Attempt 检查点 / continuation capsule（§5.3, B7） | 会话续接协调器（prepare/commit）+ 主动交接留言实践（五件套） | 仅覆盖可控中断；缺执行中 durable 检查点（进度 + 未观测副作用清单 + 恢复点），执行静默失联后无从续起（与 G6/G10 关联）；验收见 S4+ 第 3 项（隔离环境故障注入） | Next |
| G18 | 知识生命周期治理（§5.4：晋升/provenance/演替/遗忘） | 记忆系统有分层检索与部分晋升机制 | 缺 Outcome→知识的统一 provenance（未经验证的候选与结论无区分标记）与主动退役流程 | Later |

## 3. 改造路径：shadow 观测 → authority 晋升 → 受控行为切换

**总原则（实施决议 M1，即原范式附录 D7——normative 化后其归属地移至本文；含 review r1 修正）**：不从局部 data model 补丁开始；先建影子本体 + day-1 **dry-run** 消费者。**S0 严格零行为变化；S1–S3 是受控的行为切换**——每次切换必须先通过 Authority Promotion Gate（下），带 feature flag 与单开关 rollback。**允许丢事件的 shadow 数据永远不直接驱动阻断 / 注入 / 展示决策**。

### Phase S0 — Shadow CoordinationLedger（G5, G1, G2 影子化；observe-only）

- **新建独立 aggregate**：新 key namespace + 闭合事件 union + 纯函数投影，复刻 F233 已验证的 event-sourcing 模式（append-only、rebuild = replay、副作用不进 projector）。**不复用 F233 event log**（KD-1/KD-4 边界）。
- **影子事件产生**：现有系统动作旁路点 fire-and-forget 产生 workunit / offer / claim / attempt 影子事件（@ 路由 → offer.made；接收者声明承担职责 → claim.acquired 推断；invocation 终态 → attempt.*；照 F233 B2 ingest 先例，失败仅 log 不阻塞主流程）。
- **消费者一律 dry-run**（影子系统没有读者就不会被现实修正，但读者只观测不决策）：①F233 值班简报适配器——只产出协调事件 vs 现有职责归属观测的**对照报告**，不改简报行为；②freshness v2 原型——**只记录"新语义会怎么判"，不参与实际拦截**。
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
  → 读取进度 = 既有 seenCursor 连续阅读边界 ∩ inbox membership
    （不产生新 cursor，也不改变旧 cursor 语义）
```

- **hydration 与 freshness 都查询这个 projection**——不新增与现有 cursor 同构的第二套 cursor。
- **membership 自带确认状态机（G15）**：projection 建立时即产出 per-recipient 确认事件与状态推进（`created → enqueued → delivered → seen → processed`），S1 期 observe-only（dual-read 对照现有已读/未读行为）。发送侧 dispatcher / 中央队列接受只到 enqueued；目标 inbox / runtime 接受 envelope 才 delivered；目标 prompt 确实包含或主动回读才 seen；目标显式分类/回应才 processed。
- 行为切换（过 Promotion Gate 后）：invocation 上下文水合按 recipient inbox 过滤。
- **验收**：重放 I1a/I1b（§0.5），目标 invocation 收到定向 envelope，第三方猫不再被注入；主动触发只推进到有证据的 ACK 层级；dual-read mismatch = 0 达标窗。

### Phase S2 — Freshness v2 + 投递确认状态机 authority 切换（G3, G15 转正）

- 义务判定从 raw thread 扫描切换到 S1 projection（dry-run 判定对照已在 S0/S1 期积累，过 Promotion Gate 后切换）。
- **确认状态机权威化（G15）**：S1 期 observe-only 的 `created → enqueued → delivered → seen → processed` 迁移转正为投递确认的权威源。保留当前 push-triggered invocation 作为低延迟路径，同时启用两类 shared-state pull discovery：进入回合时查询 recipient inbox；空闲/定时扫描 WorkUnit / Offer pool。push ACK 超时走幂等重投、提醒或升级，不凭 invocation 启停猜测确认。
- **验收**：①现有 freshness 测试迁移通过，误触发率相对 baseline 下降；②**ACK 分层**：中央排队成功只到 enqueued，目标 runtime 未接受前不得 delivered，目标 prompt 未包含前不得 seen，未显式分类/回应前不得 processed；③**丢 trigger 注入**：抑制主动触发后，接收者经 turn-start 或 idle discovery 找回义务，零丢失；④**重复投递注入**：同一 message × recipient 重投不重复推进确认状态、不产生重复义务；⑤**两层分离测试**：信息类消息 processed 不产生 WorkUnit 责任，obligation 类消息 processed ≠ claimed / fulfilled（履行走责任层回合）；⑥**积压治理**：长期无人认领的 pool item 触发 SLA 提醒/升级。

### Phase S3 — 投影分层（G13）

- 三视图：arrival-order 审计 / conversation 因果树（`replyTo` 已有，只做渲染）/ WorkUnit-Attempt 执行泳道。
- **执行泳道的数据源约束**（与总原则一致）：晋升前只做**内部 dry-run 对照视图**（不进正式 UI）；正式 UI 只读取**通过 S3 Promotion Gate 后的 authoritative projection**（该路径 producer 已转 durable、dual-read 达标）——lossy shadow 数据不进正式展示。
- **验收**：UI 三视图可切换；co-creator 实测 I2 场景消除；**泳道投影覆盖率**——所有符合泳道投影条件的 authoritative ledger event 均有对应节点或明确 exclusion reason（不与语义不同的审计视图做逐项比对）。

### Phase S4+ — 逐项转正（每项独立过 Promotion Gate + maintainer 对齐）

依赖序列与各项验收（G15 不在此列——membership 义务源并入 S1，确认状态机并入 S2）：

1. **claim 显式化**（G2）：从影子推断转显式 API；验收：dual-read 推断 vs 显式一致率达标；
2. **lease / heartbeat**（G10 前置）：attempt 心跳与租约续约；验收：心跳断供在 SLA 窗口内被探测；
3. **Attempt lineage + 三分量 fencing + fenced 检查点 —— 单一晋升单元**（G6, G17, G8 的 token 部分）：attempt 激活旋转尝试代数 + 完整 FenceToken{纪元/认领代数/尝试代数} + 携 token 的 durable 检查点（进度 + 未观测副作用清单 + 恢复点）**必须作为同一个晋升单元一起权威化**——checkpoint 先于 fencing 转正会产生"权威恢复源可被旧 attempt 迟到覆盖"的窗口（规范 B7 冲突）。checkpoint 在本单元晋升前只允许 observe-only。验收：**隔离测试环境中故障注入**——①进程强杀后新 attempt 从最后检查点完整重建、无义务丢失；②分区复活的旧 attempt 写检查点/申请副作用被 fence；
4. **effect 准入线性化**（G8 其余部分）：intent 准入与认领/尝试迁移同一串行化域；验收：admission-execute 竞态注入测试；
5. **HumanGate + 双层 SLA**（G7）；验收：operator 待办超时触发提醒/升级链；
6. **TransferOffer 授权链**（G9）；验收：自签 offer 被拒的负面测试；
7. **交接契约结构化 + gate**（G16）：schema 校验缺要素交接。**阈值分两段**：迁移期结构化 coverage ≥95%（旧交接逐步收编）；gate 权威化后合法交接结构化率 = **100%**（gate 拒收缺要素交接，≥95% 只是迁移期指标不是 gate 正确率）；
8. **Outcome / verify 绑定**（G11）→ **join barrier**（G12）；验收：①verify verdict 绑定坐标、产出新版本后旧 verdict 在投影中标 stale（TOCTOU 注入测试）；②join(all/quorum/first-success) 三策略在 fan-out review 场景各通过一例；
9. **知识生命周期治理**（G18）：晋升/provenance/演替/退役流程；验收：知识条目 100% 带 provenance，候选与结论可区分检索。

每项转正前提：S0 影子数据证明该语义在真实负载下成立；顺序可因 maintainer 对齐调整，依赖关系（1→2→3→4）不可倒置，第 3 项内部不可拆分晋升。

## 4. Maintainer 沟通要点（启动前必须对齐）

1. **方向**：责任协调层（coordination ledger + WorkUnit 本体）是否进主线 roadmap；shadow-first 节奏是否可接受。
2. **边界**：F233 KD-1/KD-4 维持不动（我们承诺 CoordinationLedger 是独立新 aggregate）；新 aggregate 的 ownership 归属与命名。
3. **PR 粒度**：S0 建议拆 4 个 PR（aggregate 骨架+事件 union / 旁路 ingest / dry-run 双消费者 / Promotion Gate 基建：dual-read 对比与指标）；S1-S3 各 1-2 个，**行为切换 PR 必须自带 feature flag + rollback**。
4. **API 表面**：S0–S3 不新增用户可见 API。行为语义上：S0 严格零变化；S1–S3 是受控行为切换，全部走 Authority Promotion Gate + feature flag + rollback（§3）。

**开放问题（OQ）**：

- **OQ-1** WorkUnit 与现有 task 跟踪系统的关系：统一（task 升级为 WorkUnit）还是并存映射（task 是 WorkUnit 的 UI 投影）？倾向后者起步。
- **OQ-2** 协调事件保留策略：append-only 无限增长 vs 分段归档 + 快照重放。
- **OQ-3** multi-operator 是否纳入本轮：建议不纳入（范式 §9 声明的验证边界外）。

## 5. 变更日志

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-07-25 | 初版：现状映射 18 项、差距矩阵 14 项、S0-S4 路径、沟通要点 | 宪宪/claude-fable-5 |
| 2026-07-25 | review r1（sol）修订：Authority Promotion Gate 五步门；S1 改 per-message Delivery/Obligation membership projection（cursor 已 per-cat 的坐标系修正）；G3/G4/G10 现状精确化；分级改 Foundation/Next/Later；"无@=广播"标为已修正的历史默认 | 宪宪/claude-fable-5 |
| 2026-07-28 | 配合 paradigm v2 重构（normative 化）：新增 §0.5 实测失效记录（具体数据从 paradigm 移入，I 编号 ↔ F1-F5 映射）；差距矩阵锚点对齐 paradigm v2 章节 | 宪宪/claude-fable-5 |
| 2026-07-28 | review（sol，整体审）修订：新增 G15 投递协议 / G16 交接契约 / G17 Attempt 检查点 / G18 知识生命周期——覆盖 paradigm v2 新增主题的差距行；锚点修正（§7 不变量 N 格式、G6 补 §5.3/B7） | 宪宪/claude-fable-5 |
| 2026-07-28 | review（sol，窄二审）修订：S4+ 重写为九项依赖序列（G6/G15-G18 全部入迁移路径，各带验收；G15 并入 S1/S2）；总原则改实施决议 M1（原 D7 归属地）；G17 验收改隔离环境故障注入 | 宪宪/claude-fable-5 |
| 2026-07-28 | review（sol，窄三审）修订：S4+ 第 3 项改单一晋升单元（lineage + 三分量 fencing + fenced checkpoint 不可拆分，checkpoint 晋升前 observe-only——消除依赖倒置）；S1 补 membership 确认状态机（observe-only）、S2 补其权威化与四项注入验收；G16 阈值分段（迁移 coverage ≥95% / gate 后 100%）；第 8 项补验收 | 宪宪/claude-fable-5 |
| 2026-07-28 | co-creator 校准 push/pull：明确当前为“定向 envelope + 主动触发 invocation”的 push 实现，而非纯 wake；拆分工作调度、上下文取得、消息 ACK 三个平面；pull 定义为 shared-state discovery；G15/S1/S2 同步 per-recipient ACK、误读边界与 hybrid 验收 | 砚砚/gpt-5.6-sol |
| 2026-07-29 | co-creator 校准公开术语：移除内部球类隐喻；区分职责悬置、执行失联、职责失去有效承接三类失效状态，与职责转移、顺序移交两类合法迁移；同步 paradigm、article、gap 与图示/动图 | 砚砚/gpt-5.6-sol |
