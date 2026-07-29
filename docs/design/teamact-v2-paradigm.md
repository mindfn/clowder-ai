---
title: "TeamAct：去中心化 Agent 协作中的职权迁移与上下文交接"
doc_kind: design
version: 3
status: draft
feature_ids: [F117, F167, F224, F233, F254]
related_docs:
  - design/teamact-v2-gap-migration.md
  - design/teamact-v2-tech-article.md
topics: [multi-agent, teamact, decentralized, handoff, authority, responsibility, context, workunit, actor]
created: 2026-07-25
updated: 2026-07-29
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
provenance: >
  v3 方向级重构（co-creator 两轮校准 + sol 七条硬约束）：范式重心从
  "六实体 + 八步回合"改为"去中心化协作中职权迁移与上下文交接的耦合闭环"；
  Responsibility 与 Authority 显式分离；push/pull、fencing、Run、检查点、ACK
  等此前成果归入实现与可靠性策略层。old→new 概念迁移表见附录 A。
  独立草稿分支迭代中，未合入共享分支；article/gap 待本文向 review 收敛后同步。
---

# TeamAct：去中心化 Agent 协作中的职权迁移与上下文交接

## Abstract

Multi-agent 系统有两族。**中心化**一族（orchestrator-workers / agent team）由一个主 agent 分派并管理子 agent：全局状态活在编排者的上下文里，worker 之间不需要相互交接。**去中心化**一族由长命的、有身份的对等 agent（和人）组成：工作在参与者之间流动，没有任何一个上下文拥有全局。前者已被成熟的编排模式充分覆盖；后者暴露出两个中心问题——**此刻职权在谁手上（且只在一处）？上下文能否随职权完整到达？**

**TeamAct 是去中心化一族的协调范式**，中心化仅作对照边界。它的核心论断：去中心化协作的原子事务是 **Handoff——职权迁移（authority line）与上下文交接（context line）的耦合闭环**。本文给出支撑这一事务的最小本体（两个实体、两个版本化关系——责任指派与 per-scope 职权授予）、两阶段交接事务、最小协作循环（三步）与六条可检验不变量；push/pull、执行心跳、检查点、fencing、消息确认等此前的机制成果全部归位为闭环的**实现与可靠性策略**，不再占据内核。

---

## 1. 问题与定位

### 1.1 两族 multi-agent，本文只为其一

中心化与去中心化是**光谱的两个极端原型**，现实系统多为混合；**区分轴是"谁有权创建与迁移职权"，不是状态存放在哪**（中心化系统同样可以外化持久状态、甚至允许 worker 间交接——只要创建与迁移权集中在编排者，它仍是中心化的）：

| | 中心化极端（orchestrator-workers） | 去中心化极端（peer collaboration） |
|---|---|---|
| **职权的创建与迁移权** | 集中于编排者：分派、回收、改派皆经中心 | 分布于对等参与者：任何 Actor 可发起 offer 与 transfer |
| 交接形态 | worker 间通常无点对点交接，经中心中转 | **职权与上下文必须点对点安全移交** |
| 参与者生命周期 | worker 通常由编排者创建与回收 | 参与者长命自治，跨任务存续 |
| 成熟度 | 已被编排框架与 agent-team 模式充分覆盖 | 协调语义缺少 first-class 支持——本文的对象 |

诚实边界：TeamAct **不冒称覆盖全部 multi-agent**。它针对去中心化端与混合形态中的对等协作部分；纯中心化场景请直接使用编排模式，本模型与它的连续性仅在 §2.2 的 delegation 配置处说明。

### 1.2 系统形态假设

- **A1**：参与者长命且有身份（跨任务存续，积累能力档案与责任记录）；
- **A2**：人是参与者之一（会拍板、会承接工作、也会成为瓶颈）；
- **A3**：工作跨会话（进程重启、上下文压缩、供应商中断；执行者可能中途更换）；
- **A4**：责任要可审计（谁在何时对什么负责，事后可追溯；验证独立于产出者）。

### 1.3 五类失效 = 闭环破损的五种形态

数月生产实践反复出现的失效（实测记录见 gap 文档），在本模型中获得统一解释——**每一类都是职权线或上下文线的断点**：

| 失效 | 断的是哪条线 |
|---|---|
| F1 义务误归属（旁观者被塞进别人的工作） | 上下文线过宽：交接范围未按接收者收窄 |
| F2 时序失真（并行协作渲染成混乱时间线） | 两条线的事件被压进一根壁钟序 |
| F3 续接断链（会话恢复了，不知道"续的是谁的哪份职权"） | 职权线与执行记录断开 |
| F4 人工责任悬置（升级给人后石沉大海） | 职权线在人类节点处没有状态与探测 |
| F5 执行静默失联（执行者悄然消失无信号） | 职权持有者失去生命迹象，线上无人察觉 |

## 2. 最小本体

<!-- FIGURE v3-1（待绘）：两实体两关系。Actor 与 WorkUnit 之间：ResponsibilityAssignment（恒唯一，
     unassigned→offered→assigned(v)→transfer-pending→assigned(v+1)|resolved）与 AuthorityGrant（per-scope：
     execute/decide/approve 各自 granted→frozen→superseded|revoked）；事件全部落账本。 -->

### 2.1 两个实体

- **Actor**：有身份的参与者。**Agent 是本命形态，human 是扩展形态**（§6）——同一抽象，不同接入。profile 三维：capability（擅长什么）、relation（与谁同源，独立验证的回避依据）、authority class（可持有哪些权限范围）。
- **WorkUnit**：可移交的工作单元。判据不变：**有独立的生命周期与验证边界**。可 split 出子单元。

其余一切皆非实体：offer、accept、transfer 是**动作**；它们的痕迹是账本上的**事件**；动作作用的对象是下面这个关系。

### 2.2 两个关系：责任指派与职权授予

责任与职权是**两个独立版本化的关系**，不能压进一个结构——单一 Binding 无法记录"每个 scope 由谁持有"，delegation 与 approval gate 就无法真正表达：

```
ResponsibilityAssignment { workUnit, responsibleActor, version, status }
  status: unassigned → offered(1:N 候选) → assigned(v) → transfer-pending(A→B) → assigned(v+1) | resolved

AuthorityGrant { workUnit, scope, holderActor, authorityVersion, status }
  scope: execute | decide | approve | …（可扩展）
  status: granted → frozen（交接期冻结）→ superseded | revoked
```

- **Responsibility（责任）**：推进义务——谁该干这件事，中断了算谁的。每个 WorkUnit 恒有且仅有一份 Assignment；
- **Authority（职权）**：决策与副作用权——**per-scope 独立持有、独立版本、独立 fence**。execute 的转移不牵连 approve 的持有。

三种协作模式成为两关系的三种配置：

| 配置 | ResponsibilityAssignment | AuthorityGrants | 对应场景 |
|---|---|---|---|
| **peer transfer** | 迁移给 B | 相关 scope（如 execute）随迁给 B | 对等团队移交（本模型的主场景） |
| **delegation** | B 承担执行责任 | decide / approve 留在 A | 中心化编排在本模型中的表达——orchestrator 就是持续 delegate 且不放权的 Actor（对照边界） |
| **approval gate** | 执行责任在 agent | approve 在 human | 人类审批（§6） |

**版本是安全的根**：Assignment 与每个 Grant 各自版本化；变更即递增，旧版本随新版本生效而失效（§7-I2）——这是所有 fencing 机制的语义源头。**前提：WorkUnit ID 全局唯一且永不复用，resolved 是不可复活的终态**——否则跨单元/跨代的版本号可被混淆。

### 2.3 动作与账本

动作集：`offer / accept / transfer / delegate / escalate / revoke / resolve(complete|fail|cancel)`。每个动作是账本（append-only 协调账本）上的一个事务事件；**Assignment 与 Grant 的状态只能经账本事务改变**——不能由消息到达、会话启动或任何旁路推断。账本仍只记协调迁移；产物、消息内容、知识各归权威存储，以稳定 ID 联接。

## 3. 核心事务：Handoff 闭环

去中心化协作的一切复杂性集中在这一个事务上。**Handoff = 职权迁移与上下文交接的耦合闭环**：

<!-- FIGURE v3-2（待绘）：两阶段交接事务图。阶段一 prepare：freeze(A,v)+snapshot(vN)；
     阶段二 accept：B accept + context.ack(vN)；提交 transfer.commit：原子激活 B(v+1) 并 fence A(v)；
     旁路：超时 → abort → A 解冻。标注"commit 必然晚于 ack"的账本序。 -->

### 3.1 双状态线与两阶段事务

职权线与上下文线必须在一个**两阶段事务**中收敛——否则会出现"A 已失权、B 又不能行动"的悬空窗口：

```
阶段一  prepare：freeze(A, v) + snapshot(vN)
        A 的 Grants 进入 frozen（不得发起新副作用；可完成已准入者）；
        上下文快照定版为 vN；探测与 custody 仍指向 A

阶段二  accept：B accept + context.ack(vN)
        B 确认接受责任，并对快照 vN 给出显式确认；此刻 A 仍持冻结职权

提交    transfer.commit：原子激活 B（Assignment v+1、相关 Grants 易主）并 fence A 的旧版本
        ——B 获权的那一刻即已 ready（validAuthority ∧ contextAcknowledged 是 commit 的前置条件）

超时/失败 → abort：解除 freeze，A 恢复完整职权；账本记录 abort 原因
```

三条纪律，各堵一类事故：

1. **消息到达 ≠ 职权改变**。上下文包送达 B（context line 推进）不改变职权——职权只经账本上的 transfer 事务变更。堵住"我收到了所以我接手了"的幻觉。
2. **确认先于获权**。context.ack 是 transfer.commit 的前置条件——B 不存在"拿到职权但没有上下文"的状态；若 B 无法确认（快照缺失、版本不符），事务 abort 而不是让 B 带着半份上下文开工。堵住"接受了职权却不知道工作从哪来"的断链。
3. **完成判据在账本事务序**。handoff 完成 = transfer.commit 落账，且账本中 commit 必然晚于 context.ack（§7-I3 可检验）——**不是发送方"我已交出"，也不是接收方"我收到了消息"**。

### 3.2 交接的上下文：快照与最小完备集

上下文以**带版本的快照**交接，最小完备集四要素（沿用交接契约）：**事实**（做了什么 + 产出坐标）、**意图**（为什么 + 放弃的权衡）、**边界**（开放问题 + 风险）、**行动**（期望下一棒做什么）。快照传意图与边界；细节由接收方按需从共享协作历史回读——**推送传意图，回读传细节**的双通道原则不变。requiredContextVersion 在 offer 中声明，acknowledged 针对该版本。

### 3.3 三种迁移动作，语义不混用

| 动作 | 语义 | 关系变化 |
|---|---|---|
| **transfer** | 同一 WorkUnit 换承担者 | Assignment：v → v+1（两阶段事务，§3.1）；**显式声明随迁的 Grant scope 集合**——迁责任不自动迁全部职权，未声明的 scope 原持有者不受影响 |
| **delegate** | 派生子 WorkUnit（或部分 scope）给 B，A 保留监督/决策权 | 子 WorkUnit 新建 Assignment 给 B；decide/approve Grants 留 A；父 Assignment 不失效 |
| **resolve** | 终结：complete / fail / cancel | Assignment → resolved（终态不可复活）；全部 Grants → revoked。complete 的产出以不可变坐标落账，供独立验证绑定 |

**顺序移交（sequential handoff）**是组合动作：当前 WorkUnit resolve(complete) + 为后继工作创建新 WorkUnit 并 offer 给下一棒——**不在同一 WorkUnit 上换手**（那是 transfer），二者混用会破坏职权唯一性。

### 3.4 失效恢复即闭环修复

- 职权持有者失联（F5）→ 生命迹象断供被探测 → 经授权的 transfer 把职权线接到新 Actor；
- 上下文线断（F3）→ 接收方从快照 + 账本回放 + 共享历史三源重建；
- 人类节点悬置（F4）→ approval gate 的 Assignment 带 SLA 与升级路径（§6）。

## 4. 核心循环（最小）

```
Establish/Bind ──→ Act ──→ Handoff or Resolve
```

- **Establish/Bind**：通过 offer/accept（或两阶段 transfer）确立 Assignment 与所需 Grants——从此责任与职权归属明确；
- **Act**：执行。**单 agent 内循环（ReAct：思考-行动-观察）完整地活在这一步**，含自检与产出落地；
- **Handoff or Resolve**：显式出口，二选一——移交出去（transfer / delegate / 顺序移交）或终结（resolve）。**"不了了之"不是合法出口。**

与 ReAct 的关系一句话：**ReAct 回答一次执行内怎么思考与行动；TeamAct 在它外面包两端——Bind 回答"责任从哪合法地来"，Handoff/Resolve 回答"责任到哪合法地去"。** 此前八步中的 Wake/Discover、Inspect、Orient、Verify、Commit 都是这三步的实现细化，归入 §5。

## 5. 实现与可靠性策略层

以下机制是闭环的**实现手段**，不是内核语义——同一闭环可以有不同实现取舍。

### 5.1 push 与 pull（精确定义）

push / pull **只描述 transfer offer、通知与上下文包如何流动**：

- **push**：主动送达——可携带上下文包、可立即触发接收方执行实例（低延迟；需要逐接收者确认、幂等与背压）；
- **pull**：从 durable 共享协调状态**发现与取得**——接收方在空闲/定时/回合起点查询待办的 offer 与未确认上下文（解耦；需要发现延迟与积压治理）。

**二者都不能单独建立责任关系**——Assignment 与 Grant 只由账本事务建立。push 送达不等于 accept；pull 发现不等于 assigned。可靠组合：durable 共享状态为真相，push 降延迟，pull 兜底发现。

**传输确认与语义确认必须分开**：消息确认链（created → enqueued → delivered → seen → processed）只是**传输层**证据——它证明"包到了、被读了"，不证明"上下文被理解并足以开工"。context line 的 acknowledged 消费的是**显式语义确认事件** `context.ack(snapshotId, version|hash, requiredRefs)`——接收方核对快照版本与必需引用后主动发出；消息 processed 不自动产生 context.ack，更不等于义务 fulfilled。

### 5.2 可靠执行（A3 成立时启用）

- **Run**：Assignment 下的一次执行实例（一次会话）。started / 心跳 / 终态；中断恢复 = 同一 Assignment 下新 Run。**Run 是可靠执行层的概念，不是协作内核**——它存在只因为执行者会死。
- **检查点**：Run 在关键点落 durable 检查点（进度 + 未观测副作用 + 恢复点）——静默失联后新 Run 的进度来源。
- **Fencing**：一切写入与副作用携带完整凭据 **`{workUnitId, authorityScope, authorityVersion, runGeneration}`**——四段各有职责：workUnitId 防跨单元混淆（依赖 ID 永不复用 + resolved 不可复活的前提，§2.2）；authorityScope + authorityVersion 做 **per-scope fence**（execute 易主不牵连 approve 的持有；涉多 scope 的操作须绑定相应 grant 集合）；runGeneration 隔离分区复活的旧执行实例。Assignment/Grant 变更（含 cancel、transfer、revoke）使对应 scope 的旧 authorityVersion 失效，Run 更替使旧 generation 失效——旧实例既不能覆盖检查点也不能提交副作用。副作用准入与账本事务同一串行化域提交；无法校验凭据的外部系统诚实降级为"检测 + 对账"。

### 5.3 记忆与上下文重建

四层记忆分工不变：**工作记忆**（Run 内，易失）/ **团队知识**（共享检索；候选经 provenance 晋升）/ **私有记忆**（per-Actor）/ **责任记忆**（协调账本）。铁律：**任何决定 Assignment / Grant 状态的信息不得只存在于工作记忆**。会话更替后的重建三源：交接快照或最后检查点（意图与进度）+ 账本回放（责任与职权状态）+ 知识检索与历史回读（细节）。

## 6. 人类作为 Actor（扩展，不占内核）

人类是 Actor 的扩展形态——内核对人机一视同仁（同样的 Assignment 与 Grant、同样的账本、同样的探测），扩展处理人的特殊性：

- **approval gate 配置**：执行责任在 agent，approve Grant 在 human——人的批准事项是一个带 Assignment 的 WorkUnit，因此有 offered 级与 assigned 级双层 SLA、有职责悬置探测；
- **授权不可降级**：SLA 超时只能催促、升级、搁置、取消——系统永远不能代行 approve；
- **人的 SLA 是社会约定**：可提醒不可强制——这是本模型对人类节点的诚实边界。

## 7. 不变量（可检验；gap 文档逐条映射现状与缺口）

| # | 不变量 | 检验方式 |
|---|---|---|
| **I1 职权唯一（per scope）** | 任一 `(workUnit, scope)` 任一时刻至多一个 valid AuthorityGrant holder；Assignment 恒唯一；变更唯经账本事务 | 账本回放中同 `(workUnit, scope)` 无重叠 granted 区间 |
| **I2 版本 fence（per scope）** | Grant 被 supersede/revoke 即旧 authorityVersion 对该 scope 失效；Assignment v+1 生效即旧 v 失效；**不牵连未涉及的 scope**。前提：WorkUnit ID 永不复用、resolved 不可复活 | 持旧凭据（§5.2 四段式）的提交被拒或成为已记账的进行中义务；跨 scope 无误伤 |
| **I3 交接两阶段有序** | transfer 完成 = `transfer.commit` 落账，且账本序中 commit 必然晚于对应 `context.ack(vN)`；prepare 后超时必有 abort 或 commit，无永久 frozen | 账本序可机械检验：每个 commit 前存在匹配 ack；每个 prepare 有终结事件 |
| **I4 全程落账** | Assignment 与 Grant 的生命周期及所有迁移 append-only 可回放 | 任意时刻的责任与职权归属可由回放重建，无需询问任何 Actor |
| **I5 验证独立** | resolve(complete) 的验证者 ≠ responsibleActor（同源按 relation 回避）；结论绑定产出的不可变版本 | 验证记录的 actor 与版本字段可审计；产出新版本使旧结论过期 |
| **I6 有界与可探测** | 每个 Assignment 有 SLA；responsibleActor 需给出生命迹象；**职责悬置**（offered 无人接超时）、**执行失联**（assigned 但无生命迹象）、**职责无承接**（既无 valid Assignment 也无受监督路径）三态可从账本判定 | 三态各有账本判定式与对应恢复动作（催办 / 探测后 transfer / 重建监督路径） |

## 8. 讨论与局限

- **只覆盖去中心化一族**：中心化编排请直接用 orchestrator-workers 模式；本模型的 delegation 配置只说明二者的连续性，不主张替代。
- **协议遵守不是硬约束**：LLM 参与者靠约定 + 运行时门禁兜底；账本让破损可见，不让破损不可能。
- **人的节点只能软治理**（§6）。
- **协调有开销**：只适合责任真实转移、职责中断有代价的工作。
- **验证边界**：收敛自个位数参与者、单治理者的实践；更大规模未验证。

## 附录 A：old → new 概念迁移表

| v2（六实体 + 八步） | v3 | 说明 |
|---|---|---|
| WorkUnit | WorkUnit | 不变 |
| Actor profile（§2.2） | Actor（实体） | 升为两实体之一；agent 本命、human 扩展 |
| Offer（实体） | Assignment 的 offered 态 + offer 动作 | 去实体化 |
| Claim（实体；lease/generation） | Assignment 的 assigned 态 + accept 动作；**Responsibility 与 Authority 拆分为两个独立关系**（Assignment / per-scope Grant） | 去实体化 + 语义细化 |
| Attempt（实体） | **Run**（§5.2 可靠执行层） | 移出内核；改名避免与协作语义混淆 |
| Outcome（实体） | resolve(complete) 的产出坐标 | 并入 Assignment 终结记录 |
| Transition（实体） | 账本事件类型集（§2.3 动作） | 回归事件本质 |
| 八步回合 | 三步循环（Bind → Act → Handoff/Resolve） | Wake/Inspect/Orient/Verify/Commit 降为实现细化 |
| HumanGate（内核 §2.3） | 人类 Actor 扩展（§6）+ approval gate 配置 | 移出内核 |
| 三分量 fencing token {纪元, 认领代数, 尝试代数} | 四段凭据 `{workUnitId, authorityScope, authorityVersion, runGeneration}`：纪元的复活防护由 WorkUnit ID 永不复用 + resolved 终态承接；认领代数演进为 per-scope authorityVersion；尝试代数即 runGeneration | **非同构映射**——新增 scope 维度、显式 ID 前提；安全性论证见 §5.2 与 I2 |
| 悬置 / 失联 / 无承接三态 | I6 的账本判定式 | 不变，落到不变量 |
| wake/obligation/readability 三维 | 上下文线的实现策略（§5.1 收窄交接范围 + readability 独立） | 归实现层 |
| 消息 ACK 五态链 | context line delivered→acknowledged 的工程实现（§5.1） | 归实现层 |

## 附录 B：Open Questions（v3 待收敛）

1. **authorityScope 粒度**：`execute / decide / approve` 三档是否够用？是否需要资源级 scope（如"只可改文档不可发消息"）？
2. **delegation 链**：A delegate B、B 再 delegate C 时，A revoke 是否级联？委托深度是否设界？
3. **requiredContextVersion 的声明者**：由交接方在 offer 中声明，还是由 WorkUnit 的验收契约预先定义？两者冲突时以谁为准？
4. **frozen 期间已准入副作用的边界**：prepare 冻结后 A "可完成已准入者"——已准入清单的定版与 B 接手后的对账协议需细化（与检查点的未观测副作用清单如何合并）？
5. **delegation 下的验证独立**：A 保留 decide 权时，A 可否担任 resolve 的 verifier？（倾向：可以 decide 不可 verify，理由待写实）
