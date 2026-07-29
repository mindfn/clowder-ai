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

**TeamAct 是去中心化一族的协调范式**，中心化仅作对照边界。它的核心论断：去中心化协作的原子事务是 **Handoff——职权迁移（authority line）与上下文交接（context line）的耦合闭环**。本文给出支撑这一事务的最小本体（两个实体、一个版本化关系）、最小协作循环（三步）、闭环的判据与六条可检验不变量；push/pull、执行心跳、检查点、fencing、消息确认等此前的机制成果全部归位为闭环的**实现与可靠性策略**，不再占据内核。

---

## 1. 问题与定位

### 1.1 两族 multi-agent，本文只为其一

| | 中心化（orchestrator-workers） | 去中心化（peer collaboration） |
|---|---|---|
| 全局状态 | 在编排者上下文中 | 不存在单一全局；外化在共享协调状态 |
| 工作流向 | 中心分派、中心回收 | 在对等参与者间移交 |
| 交接需求 | worker 间无交接；上下文经中心中转 | **职权与上下文必须点对点安全移交** |
| 生命周期 | worker 由编排者创建与回收 | 参与者长命自治，跨任务存续 |
| 成熟度 | 已被编排框架与 agent-team 模式充分覆盖 | 协调语义缺少 first-class 支持——本文的对象 |

诚实边界：TeamAct **不冒称覆盖全部 multi-agent**。中心化场景请直接使用编排模式；本模型与它的关系仅在 §2.2 的 delegation 配置处作对照说明。

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

<!-- FIGURE v3-1（待绘）：两实体一关系。Actor ↔ Binding{responsibleActor, authorityScope, version, status} ↔ WorkUnit；
     Binding 状态线 unbound→offered→bound(v)→transfer-pending→bound(v+1)|resolved；事件全部落账本。 -->

### 2.1 两个实体

- **Actor**：有身份的参与者。**Agent 是本命形态，human 是扩展形态**（§6）——同一抽象，不同接入。profile 三维：capability（擅长什么）、relation（与谁同源，独立验证的回避依据）、authority class（可持有哪些权限范围）。
- **WorkUnit**：可移交的工作单元。判据不变：**有独立的生命周期与验证边界**。可 split 出子单元。

其余一切皆非实体：offer、accept、transfer 是**动作**；它们的痕迹是账本上的**事件**；动作作用的对象是下面这个关系。

### 2.2 一个关系：Binding（版本化的责任-职权绑定）

```
Binding(WorkUnit ↔ Actor) = { responsibleActor, authorityScope, version, status }
status: unbound → offered(1:N 候选) → bound(v) → transfer-pending(A→B) → bound(v+1) | resolved
```

**Responsibility 与 Authority 是 Binding 的两个正交分量，不再用一个词压平**：

- **Responsibility（责任）**：推进义务——谁该干这件事，掉了算谁的；
- **Authority（职权）**：决策与副作用权——谁被允许提交变更、做出裁决、批准动作。scope 化：`execute / decide / approve` 可以分离持有。

两分量的三种典型配置，恰好是三种协作模式的坐标：

| 配置 | Responsibility | Authority | 对应场景 |
|---|---|---|---|
| **peer transfer** | 迁移给 B | 相应 scope 随迁 | 对等团队传球（本模型的主场景） |
| **delegation** | B 承担执行责任 | A 保留 decide/approve | 中心化编排在本模型中的表达——orchestrator 就是持续 delegate 且不放权的 Actor（对照边界） |
| **approval gate** | 执行责任在 agent | approve 留在 human | 人类审批（§6） |

**version 是安全的根**：Binding 每次变更 version 递增；旧 version 的一切权限随新 version 生效而失效（§7-I2）——这是所有 fencing 机制的语义源头。

### 2.3 动作与账本

动作集：`offer / accept / transfer / delegate / escalate / revoke / resolve(complete|fail|cancel)`。每个动作是账本（append-only 协调账本）上的一个事务事件；**Binding 状态只能经账本事务改变**——不能由消息到达、会话启动或任何旁路推断。账本仍只记协调迁移；产物、消息内容、知识各归权威存储，以稳定 ID 联接。

## 3. 核心事务：Handoff 闭环

去中心化协作的一切复杂性集中在这一个事务上。**Handoff = 职权迁移与上下文交接的耦合闭环**：

<!-- FIGURE v3-2（待绘）：双状态线图。上线 Authority: held(A,v) → transfer-pending(A→B) → held(B,v+1)[旧权 fence]；
     下线 Context: snapshot(vN) → delivered/discoverable → acknowledged(B)；
     汇合点 readiness(B) = validAuthority ∧ contextAcknowledged → B 开始 Act。 -->

### 3.1 双状态线

```
Authority line:  held(A, v) ──→ transfer-pending(A→B) ──→ held(B, v+1)
                                                          （B 激活即 A 的 v 全面失效）
Context line:    snapshot(vN) ──→ delivered / discoverable ──→ acknowledged(B)

readiness(B) = validAuthority(B) AND requiredContext(vN) acknowledged(B)
```

三条纪律，各堵一类事故：

1. **消息到达 ≠ 职权改变**。上下文包送达 B（context line 推进）不改变 authority line——职权只经账本上的 transfer 事务变更。堵住"我收到了所以我接手了"的幻觉。
2. **职权改变 ≠ 上下文就绪**。B 拿到职权但未确认所需上下文 → not ready；B 此刻的第一义务是补齐（从共享状态拉取回读），而不是带着半份上下文开工。堵住"接了球但不知道球从哪来"的断链。
3. **只有双线俱齐（readiness）才进入 Act**。handoff 的完成判据是接收方 readiness，**不是发送方"我已交出"**。

### 3.2 交接的上下文：快照与最小完备集

上下文以**带版本的快照**交接，最小完备集四要素（沿用交接契约）：**事实**（做了什么 + 产出坐标）、**意图**（为什么 + 放弃的权衡）、**边界**（开放问题 + 风险）、**行动**（期望下一棒做什么）。快照传意图与边界；细节由接收方按需从共享协作历史回读——**推送传意图，回读传细节**的双通道原则不变。requiredContextVersion 在 offer 中声明，acknowledged 针对该版本。

### 3.3 三种迁移动作，语义不混用

| 动作 | 语义 | Binding 变化 |
|---|---|---|
| **transfer** | 同一 WorkUnit 换承担者（可含 authority 随迁或部分保留） | 同一 Binding：v → v+1，responsibleActor 变更；声明本次迁移的是**责任、职权还是二者** |
| **delegate** | 派生子 WorkUnit（或部分 scope）给 B，A 保留监督/决策权 | 新建子 Binding；父 Binding 不失效 |
| **resolve** | 终结：complete / fail / cancel | Binding → resolved；职权线闭合。complete 的产出以不可变坐标落账，供独立验证绑定 |

**顺序移交（sequential handoff）**是组合动作：当前 WorkUnit resolve(complete) + 为后继工作创建新 WorkUnit 并 offer 给下一棒——**不在同一 WorkUnit 上换手**（那是 transfer），二者混用会破坏职权唯一性。

### 3.4 失效恢复即闭环修复

- 职权持有者失联（F5）→ 生命迹象断供被探测 → 经授权的 transfer 把职权线接到新 Actor；
- 上下文线断（F3）→ 接收方从快照 + 账本回放 + 共享历史三源重建；
- 人类节点悬置（F4）→ approval gate 的 Binding 带 SLA 与升级路径（§6）。

## 4. 核心循环（最小）

```
Establish/Bind ──→ Act ──→ Handoff or Resolve
```

- **Establish/Bind**：通过 offer/accept（或接受 transfer）确立 Binding——从此责任与职权归属明确；
- **Act**：执行。**单 agent 内循环（ReAct：思考-行动-观察）完整地活在这一步**，含自检与产出落地；
- **Handoff or Resolve**：显式出口，二选一——移交出去（transfer / delegate / 顺序移交）或终结（resolve）。**"不了了之"不是合法出口。**

与 ReAct 的关系一句话：**ReAct 回答一次执行内怎么思考与行动；TeamAct 在它外面包两端——Bind 回答"责任从哪合法地来"，Handoff/Resolve 回答"责任到哪合法地去"。** 此前八步中的 Wake/Discover、Inspect、Orient、Verify、Commit 都是这三步的实现细化，归入 §5。

## 5. 实现与可靠性策略层

以下机制是闭环的**实现手段**，不是内核语义——同一闭环可以有不同实现取舍。

### 5.1 push 与 pull（精确定义）

push / pull **只描述 transfer offer、通知与上下文包如何流动**：

- **push**：主动送达——可携带上下文包、可立即触发接收方执行实例（低延迟；需要逐接收者确认、幂等与背压）；
- **pull**：从 durable 共享协调状态**发现与取得**——接收方在空闲/定时/回合起点查询待办的 offer 与未确认上下文（解耦；需要发现延迟与积压治理）。

**二者都不能单独建立责任关系**——Binding 只由账本事务建立。push 送达不等于 accept；pull 发现不等于 bound。可靠组合：durable 共享状态为真相，push 降延迟，pull 兜底发现。消息确认链（created → enqueued → delivered → seen → processed）是 context line "delivered → acknowledged" 的工程实现；**消息 processed 仍不等于义务 fulfilled**。

### 5.2 可靠执行（A3 成立时启用）

- **Run**：Binding 下的一次执行实例（一次会话）。started / 心跳 / 终态；中断恢复 = 同一 Binding 下新 Run。**Run 是可靠执行层的概念，不是协作内核**——它存在只因为执行者会死。
- **检查点**：Run 在关键点落 durable 检查点（进度 + 未观测副作用 + 恢复点）——静默失联后新 Run 的进度来源。
- **Fencing**：一切写入与副作用携带 `{binding version, run generation}` 凭据；Binding 变更（含 cancel、transfer）使旧 version 整体失效，Run 更替使旧 generation 失效——分区复活的旧执行实例既不能覆盖检查点也不能提交副作用；副作用准入与 Binding 事务同一串行化域提交，无法校验凭据的外部系统诚实降级为"检测 + 对账"。

### 5.3 记忆与上下文重建

四层记忆分工不变：**工作记忆**（Run 内，易失）/ **团队知识**（共享检索；候选经 provenance 晋升）/ **私有记忆**（per-Actor）/ **责任记忆**（协调账本）。铁律：**任何决定 Binding 状态的信息不得只存在于工作记忆**。会话更替后的重建三源：交接快照或最后检查点（意图与进度）+ 账本回放（责任与职权状态）+ 知识检索与历史回读（细节）。

## 6. 人类作为 Actor（扩展，不占内核）

人类是 Actor 的扩展形态——内核对人机一视同仁（同样的 Binding、同样的账本、同样的探测），扩展处理人的特殊性：

- **approval gate 配置**：执行责任在 agent，approve scope 留在 human——人的批准事项是一个带 Binding 的 WorkUnit，因此有 offer 级与 bound 级双层 SLA、有掉球探测；
- **授权不可降级**：SLA 超时只能催促、升级、搁置、取消——系统永远不能代行 approve；
- **人的 SLA 是社会约定**：可提醒不可强制——这是本模型对人类节点的诚实边界。

## 7. 不变量（可检验；gap 文档逐条映射现状与缺口）

| # | 不变量 | 检验方式 |
|---|---|---|
| **I1 职权唯一** | 任一 WorkUnit 的任一 authority scope，任一时刻至多一个 valid holder；变更唯经账本事务 | 账本回放中同 scope 无重叠 held 区间 |
| **I2 版本 fence** | Binding v+1 生效即 v 的全部写入与副作用权失效（transfer、cancel 同理） | 持旧 version 凭据的提交被拒或成为已记账的进行中义务 |
| **I3 交接完整** | handoff 完成判据 = 接收方 readiness（validAuthority ∧ contextAcknowledged），不是发送方已交出 | 账本中 transfer 完成事件必须晚于 context acknowledged 事件 |
| **I4 全程落账** | Binding 生命周期与所有迁移 append-only 可回放 | 任意时刻的职权归属可由回放重建，无需询问任何 Actor |
| **I5 验证独立** | resolve(complete) 的验证者 ≠ responsibleActor（同源按 relation 回避）；结论绑定产出的不可变版本 | 验证记录的 actor 与版本字段可审计；产出新版本使旧结论过期 |
| **I6 有界与可探测** | 每个 Binding 有 SLA；authority holder 需给出生命迹象；**悬置**（offered 无人接超时）、**失联**（bound 但无生命迹象）、**无承接**（既无 valid Binding 也无受监督路径）三态可从账本判定 | 三态各有账本判定式与对应恢复动作（催办 / 探测后 transfer / 重建监督路径） |

## 8. 讨论与局限

- **只覆盖去中心化一族**：中心化编排请直接用 orchestrator-workers 模式；本模型的 delegation 配置只说明二者的连续性，不主张替代。
- **协议遵守不是硬约束**：LLM 参与者靠约定 + 运行时门禁兜底；账本让破损可见，不让破损不可能。
- **人的节点只能软治理**（§6）。
- **协调有开销**：只适合责任真实转移、掉球有代价的工作。
- **验证边界**：收敛自个位数参与者、单治理者的实践；更大规模未验证。

## 附录 A：old → new 概念迁移表

| v2（六实体 + 八步） | v3 | 说明 |
|---|---|---|
| WorkUnit | WorkUnit | 不变 |
| Actor profile（§2.2） | Actor（实体） | 升为两实体之一；agent 本命、human 扩展 |
| Offer（实体） | Binding 的 offered 态 + offer 动作 | 去实体化 |
| Claim（实体；lease/generation） | Binding 的 bound 态 + accept 动作；**Responsibility 与 Authority 拆分为 Binding 两分量** | 去实体化 + 语义细化 |
| Attempt（实体） | **Run**（§5.2 可靠执行层） | 移出内核；改名避免与协作语义混淆 |
| Outcome（实体） | resolve(complete) 的产出坐标 | 并入 Binding 终结记录 |
| Transition（实体） | 账本事件类型集（§2.3 动作） | 回归事件本质 |
| 八步回合 | 三步循环（Bind → Act → Handoff/Resolve） | Wake/Inspect/Orient/Verify/Commit 降为实现细化 |
| HumanGate（内核 §2.3） | 人类 Actor 扩展（§6）+ approval gate 配置 | 移出内核 |
| 三分量 fencing token {纪元, 认领代数, 尝试代数} | `{binding version, run generation}`：纪元与认领代数并入 binding version（cancel 与 transfer 都是 Binding 变更），尝试代数即 run generation | 语义等价、结构更简 |
| 悬置 / 失联 / 无承接三态 | I6 的账本判定式 | 不变，落到不变量 |
| wake/obligation/readability 三维 | 上下文线的实现策略（§5.1 收窄交接范围 + readability 独立） | 归实现层 |
| 消息 ACK 五态链 | context line delivered→acknowledged 的工程实现（§5.1） | 归实现层 |

## 附录 B：Open Questions（v3 待收敛）

1. **authorityScope 粒度**：`execute / decide / approve` 三档是否够用？是否需要资源级 scope（如"只可改文档不可发消息"）？
2. **delegation 链**：A delegate B、B 再 delegate C 时，A revoke 是否级联？委托深度是否设界？
3. **requiredContextVersion 的声明者**：由交接方在 offer 中声明，还是由 WorkUnit 的验收契约预先定义？两者冲突时以谁为准？
4. **多 scope fence 粒度**：approve 在 human、execute 在 agent 时，transfer execute scope 是否影响 approve Binding 的 version？（倾向：per-scope 独立 version，待推演并发场景）
5. **delegation 下的验证独立**：A 保留 decide 权时，A 可否担任 resolve 的 verifier？（倾向：可以 decide 不可 verify，理由待写实）
