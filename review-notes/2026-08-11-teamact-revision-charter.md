---
title: "TeamAct article 第三轮修订章程（一次结构手术）"
doc_kind: revision-charter
topics: [teamact, revision, structure-surgery]
created: 2026-08-11
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
status: completed
---

# 第三轮修订章程

> **闭环记录（2026-08-11）**：C1–C6 全部落地 + sol 结构 review（REQUEST_CHANGES：P1×3/P2×2/P3）修复 + lang 发布边界收敛（r22）+ 视觉迁移全套（8 项，双向跨个体图审含各一轮退回修复）。**文本+图双冻结 SHA = `b6f36204b`**（文字终核 `96d560d97` 通过、图 A 窄核通过）。后续：fresh 零上下文逐问冷读验收（新阶段，不属本章程 scope）。

**基线**：article 冻结点 `1b502c715`；paradigm 当前版（r19 + 图）。
**授权**：sol 闭环判定与开工指令（thread 消息 `657f0393`）；lang 内容校准已给完（五点回应 + 上下文推导体补充 `fd4a0ac2`），不再反问技术细节。
**验收**：全部落地后固定 SHA 交 sol 做**语义强度与本体一致性 review**。

## 1. 唯一骨架（sol 十步主线 → article 新结构）

```text
证据与适用范围
→ 责任连续性 + scope 职权续接 + 上下文就绪
→ Actor/Run 运行时图
→ 核心本体与状态联合
→ 计划性交接
→ 崩溃恢复重放
→ 从安全续接推导上下文/记忆要求
→ 解耦式选择判据
→ 当前实现、成本与未验证边界
→ shadow 最小实践
```

映射到章节（对照章与附录不入主线、语义不动只顺位）：

| 主线步 | 新章节 | 主要动作 |
|---|---|---|
| 1 证据与适用范围 | §1 | 开场故事保留；**evidence box 前移**（定位=实测失效+已验证局部机制+结构缺口+待验证统一组合，即"当前阶段理解与演进方向"）；**范围声明**（单 operator、多 Agent Actor；两个 Claude 需身份/会话记忆边界/责任记录三者独立才算两个 Actor；实现开放性——codex/claude 混编、skill/系统提示词/MCP 均合法承载）；三类行业工作保留 |
| 2 主轴与失效 | §2 | 五类失效保留；**动机桥条件句**（责任与职权本就跨 session 存续才需要稳定锚点，不鼓励人为长期化）；主轴统一措辞=**责任连续性 + 按 scope 的职权续接 + 上下文就绪**（不得揉回"职责"一词） |
| 3 运行时图 | §3 开篇 | **"Actor 的一天"全景**（常驻 Actor/事件唤醒/回合制/义务注入/门禁——标注为我们事件驱动形态的实例，不变量只有"Run 可灭、责任继续"）；**最低限度术语桥**（lease/CAS/背压/水合首现处一行效果级解释，fencing ④ 已有的写法为模板） |
| 4 本体与状态联合 | §3 本体 | **本体表分两层**：核心协调本体（Actor/WorkUnit/Assignment/Grant/Ledger）与可靠执行扩展（Run/心跳/checkpoint/reconciler）；**Assignment 状态链入正文** + 条件字段（discriminated union 写法）；**P1 修法**：offered/suspended 态带 dispositionActor（见 §3 本章程） |
| 5 计划性交接 | §3 续 | ④ 两阶段事务保留并**显式标注为计划性路径**（前任在场）；三条纪律保留 |
| 6 崩溃恢复重放 | §3 新段 | **开场故事端到端重放**：静默失联→有界探测→suspend+fence→RecoveryPolicy 授权→checkpoint+ledger+知识+admission records 多源重建→继任者确认→commit 或继续 suspended→迟到 receipt 对账；**effect admission 前提**+manifest 推导式（已准入∧未见可信终态）+降级边界；**诚实保证边界前移**：保证"有界发现并进入安全处置态"，不保证"有界找到继任者恢复执行"；**RecoveryPolicy 写成版本化、可引用的 first-class policy/trust root**（非第三核心实体） |
| 7 上下文/记忆推导体 | §3 末/独立节 | **从 succession/readiness 反推**：接手者要安全继续必须知道什么→四要素快照（事实/意图/边界/行动）；跨 session 什么必须外化→责任状态不得只存在工作记忆+各域权威存储；什么可按需重建→推送传意图回读传细节双通道；effect manifest 与接收者确认在链条中的位置；四层记忆通过稳定 ID 连接**降为一句实例注脚**；**账本≠共享数据湖** |
| 8 解耦式判据 | §6 | 两族解法、选择判据、Pareto 可反驳性保留（本轮语义基本不动，检查与新主轴措辞一致） |
| 9 实现与边界 | §8 | 四分披露保留但**三态标注精神前移**（§3 的斩钉截铁现在时逐个标注"设计目标/已上线/未验证"）；**成本承认**：effect admission 需要工具网关/适配器接入、额外持久写与对账，低价值可整单重跑负载不适用 |
| 10 shadow 最小实践 | §9 | takeaway 三件套修正：最小闭环=owner + 带 nextCheckAt 的非终态 + **定期检查推动处置的循环**（第三样可以先是人）；shadow 迁移路径标注 |

对照章：§4（Anthropic）、§5（行业分层）语义不动，位置随主线顺延；附录 A/B/References 不动。

## 2. 合并修订清单（终稿，v2 九条 × sol 三分处置去重合并）

sol 确认必补 9 条（消息 `657f0393` 第二节）与 v2 九条（消息 `29782ca4`）合并后全部落入上表主线步 1–10；无孤儿项。逐条来源：

1. Assignment 状态链+条件字段 ←v2⑦+冷读者3 → 主线步 4
2. 本体分层 ←冷读者4 → 主线步 4
3. 开场事故完整恢复重放 ←v2⑤+冷读者2 → 主线步 6
4. effect admission+manifest 推导+降级边界 ←v2⑤+冷读者1 → 主线步 6
5. RecoveryPolicy first-class/trust root ←冷读者5 → 主线步 6
6. 保证边界（发现+安全冻结≠恢复执行）前移 ←冷读者Q4残留3 → 主线步 6
7. 证据/实现状态前移 ←v2①+冷读者8 → 主线步 1+9
8. runtime 全景+术语桥 ←v2④⑥+冷读者6/7 → 主线步 3
9. 上下文/记忆推导体 ←v2⑧(lang 修正)+sol 约束4 → 主线步 7
10. 范围声明+实现开放性 ←v2②+sol 约束2 → 主线步 1
11. 动机桥条件句 ←v2③+sol 护栏1 → 主线步 2
12. takeaway+shadow ←v2⑨+sol 第5答 → 主线步 10

## 3. paradigm 同步项（P1 模型缺口，sol 升级）

**缺口**：offered/unassigned 窗口缺明确处置责任 holder——正文只说"交授权主体"，未在 Assignment 状态中钉死谁有义务让处置走到终点。

**修法**（sol 给定，不新增核心实体）：§2.2 状态 schema 收紧为 discriminated union：

```text
offered   { candidates, offerVersion, dispositionActor, offerExpiresAt, escalationPolicyRef }
assigned  { responsibleActor, assignmentVersion, sla }
suspended { dispositionActor, suspendedAssignmentVersion, policyRef }
```

**不变量**（I 系列同步）：每个非终态 WorkUnit 要么有 responsibleActor，要么有 dispositionActor + 有界处置路径。reconciler 仍只发现和推动，不获得选人/取消/审批权。

**落点**：paradigm §2.2（schema）、§7 I1/I6（检验式）、§3.4/§5.4 相关表述；article 主线步 4；本体图 figure-v3-1（offered 态与 dispositionActor 的表达——若 SVG 手术量大，标注待更新项交 review 时说明）。

## 4. Push back 边界（写作红线，来自 sol 第三节——不得越过）

1. **不写"所有副作用一律经长命适配器"**。写行为性质：高风险 effect 离开受控边界前已有 durable admission；终态证据不能只依赖可能死亡的 Run；回执有可验证来源；做不到就诚实降级为检测与对账。实现拓扑开放（durable outbox/adapter、供应商签名 webhook、独立 poller、原生事务系统均合法）。
2. **不写"每条 Bash/API 都进重型 effect 协议"**。边界从安全要求推导：跨 Run 存续、对外可见、或重复/乱序有不可接受后果的操作才需要 admission/fence/receipt；纯读取、可丢弃计算、已被底层事务或天然幂等吸收的动作不逐条上账。同时必须承认成本（见主线步 9）。
3. RecoveryPolicy first-class 但**不升为第三核心实体**（版本化治理策略）；reconciler 入可靠执行/治理层图，**不入核心本体**（它无 Assignment/Grant，不伪装成 Actor）。

## 5. 分块 commit 计划

- C1 本章程（review-notes，先行落账）
- C2 paradigm P1 同步（§2.2 + I 不变量 + 关联段）
- C3 article 前段（主线步 1–2：§1 evidence box/范围/动机桥/主轴措辞）
- C4 article 中段（主线步 3–6：运行时全景/术语桥/分层本体/状态联合/计划交接标注/崩溃重放段）
- C5 article 后段（主线步 7–10：上下文推导体/判据一致性/实现状态前移+成本/takeaway；§4/§5 顺位）
- C6 图同步（v3-1 状态联合表达；量大则标注待更新）
- 终点：固定 HEAD SHA 交 sol review（语义强度 + 本体一致性）

**纪律**：每块自检——新增措辞不越 §4 红线；三态标注（已上线/设计目标/未验证）不漂移；主轴三词组不揉回"职责"。
