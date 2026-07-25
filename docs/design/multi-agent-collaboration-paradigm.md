---
title: "TeamAct v2 — 长时人机混合团队的多 Agent 协作范式"
doc_kind: design
version: 5
feature_ids: [F117, F167, F224, F233, F254]
related_docs:
  - architecture/collaboration-landscape.md
  - architecture/at-mention-routing-system.md
  - architecture/ownership/cells/ball-custody.md
topics: [multi-agent, a2a, teamact, coordination, paradigm, workunit, claim, ledger]
created: 2026-07-25
status: draft-for-review
author: "宪宪/claude-fable-5"
reviewed_by: >
  砚砚/gpt-5.6-sol — cross-family review r1 (7 P1 + 5 P2, addressed in v2),
  r2 (4 P1 runtime semantics + 1 P1 external + 4 P2, addressed in v3:
  effect-typed fencing, atomic claim transfer, immutable Outcome coordinates,
  recursive pattern boundary, collaboration-pattern mapping)
source_thread: thread_mruayc4owlyzazbx
provenance: >
  本文收敛自 2026-07-21~25 三轮内部对抗讨论：Sol（gpt-5.6）可靠性轴审视与七条收敛稿、
  opus（claude-opus-4-6）GAM/WOCEY 范式分析与逐条校准、宪宪（claude-fable-5）残余分歧裁决；
  v2 按 Sol 跨家族 review（r1）修订：incident 事实链修正、本体补 Outcome/lease/fencing、
  ledger 事件集闭合、F233 边界回归、行业对照按一手资料重写。
  GAM / WOCEY 是讨论过程中的工作名，最终决议不引入新术语，升级既有 TeamAct（见 D6）。
---

# TeamAct v2 — 长时人机混合团队的多 Agent 协作范式

> **一句话**：主流多 agent 栈回答的是"任务怎么被执行"——execution orchestration，如今已包括
> durable execution、断点恢复、human-in-the-loop。我们在生产中运行一个多 agent 团队几个月后
> 发现还有一层没人管："团队怎么对工作负责"——**responsibility coordination**：谁认领了什么、
> 义务推进到哪、谁掉了球、人如何作为有 SLA 的一等执行者被纳入协调。
> TeamAct v2 是我们对这一层的回答：一套以 **WorkUnit / Claim / coordination ledger** 为核心的
> 责任协调范式。它与 Anthropic workflow patterns、LangGraph 等框架在能力上有重叠，但优化的
> 对象不同——它们持久化**执行状态**，我们还要持久化**责任状态**；两层可以组合使用。

---

## 1. 我们的系统形态：为什么"执行编排"对我们不够

Clowder AI（Cat Café）是一个持续运行数月的多 agent 系统：

- **Agent 是长命的**：每只"猫"有持久身份、独立记忆、能力画像、责任记录。异构模型混编（Claude / GPT / Gemini / Kimi 同队），跨 250+ feature 协作。
- **人是团队成员，不是调用者**：operator 深度参与——拍板愿景、审批不可逆操作、也**承接工作**（配环境、做决策），因此人也会成为瓶颈、也会掉球。
- **工作跨 session**：一个 feature 以天计，横跨多个 thread、多次进程重启、context 压缩，乃至 agent 供应商的额度/服务中断。
- **结果要审计**：谁在什么时候对什么负责，事后必须可追溯（跨家族 code review 是铁律）。

现代编排框架在 durable execution 上已经走了很远（LangGraph 的 checkpointing 与跨 session 状态、OpenAI Agents SDK 的可序列化 RunState、CrewAI Flows 的持久化恢复——见 §6）。但它们持久化的对象是**执行状态**（图走到哪个节点、run 等待什么输入）。我们的 incident（§2）反复指向另一类状态的缺失：**责任状态**——这个工作单元被谁认领、义务算谁的、认领者失联了谁来发现、人类成员的承诺怎么被跟踪。执行状态回答"程序怎么继续跑"，责任状态回答"团队怎么不掉球"。本文的范式为后者设计；若你的系统没有 §7 列出的约束，你不需要它的大部分设计。

## 2. 经验根基：实测暴露的结构缺陷

本范式不是从理论推导的，而是从生产 incident 归纳的。触发本次整理的一组实测（2026-07，消息可见性测试）与既往诊断：

| # | Incident | 表层现象 | 结构根因 |
|---|----------|---------|---------|
| 1a | 无 @ 消息"1+1=?"按 last-replier 规则**正确**路由给 A 猫；B 猫随后被一条显式 @ 唤醒，初始上下文水合却把 A 猫名下的这条消息注入了 B 猫的 invocation | 路由没错，**水合范围错了** | 上下文注入（context hydration）不区分 recipient 与 invocation scope |
| 1b | B 猫行动前又被 thread 级 freshness 门禁拦下——"未读"判定引用的是 A 猫对话中的回复（"2"） | 路由没错，**义务算错了** | freshness 的 unseen 按 thread 粒度计算，把他人对话的消息算成自己的处理义务 |
| 2 | UI 消息序混乱、并行回复交错显示、上下文断裂 | 会话流按壁钟到达序渲染 | 缺投影分层：到达序审计视图 / 会话因果树 / 执行泳道混在一根时间线里（`replyTo` 已存在但只表达消息父子） |
| 3 | Session 断片、重影、冗余触发（F224 诊断） | 协作中断后状态不可靠 | 会话续接已有协调器（prepare/commit 已接线），但续接与"哪个工作、谁的认领、第几次尝试"没有 lineage 关联 |
| 4 | 升级给 operator 的事项无限期搁置（F233 诊断） | "唯一没有掉球保护的 agent 是 operator" | 人不在协调模型内：人的待办无认领状态、无 SLA、无探测 |
| 5 | 本次讨论期间一只猫因供应商 API 中断两次静默掉球 | 靠人工"继续"手动救活 | 失败的唤醒没有尝试记录与心跳，静默死亡无信号可探测 |

五个 incident 指向同一件事：**我们有消息系统，也有局部的执行可靠性机制，但没有统一的责任协调模型**。消息（说了什么）、执行（跑到哪了）、责任（谁该做什么）被耦合在同一根管道里，各自的粒度都不对。

## 3. 范式沿革：ReAct → TeamAct v1 → TeamAct v2

**ReAct** 是单 agent 的内循环（Thought → Action → Observation）。我们在 2026-04 提出 **TeamAct** 作为多 agent 团队的外循环（六步：State → Owner → Action → Evidence → Verdict → Route，见 `collaboration-landscape.md`），并确立了分形嵌套：

```
feat 生命周期（系统层）
  └─ TeamAct 回合（团队层）
       └─ ReAct / workflow patterns / subagent 编排（单 agent 层）
```

TeamAct v1 是**行为约定**——写在 agent 系统提示词与家规里，靠 LLM 遵守 + harness 门禁兜底。几个月实践证明了循环本身的正确性，也暴露了极限：**约定没有结构化宿主**。球权靠言语行为推断（"我来做" = 认领？），义务靠 thread 级门禁近似，人的工作完全在模型外。§2 的 incident 全部源于此。

**TeamAct v2 = 同一个循环 + 显式的协调本体（ontology）+ 独立的协调账本（ledger）。** 行为约定升级为可存储、可校验、可审计的结构。

## 4. TeamAct v2 核心设计

### 4.1 协调本体：六个实体 + 一个正交的 Actor 维度

| 实体 | 定义 | 关键属性 |
|------|------|---------|
| **WorkUnit** | 一个可独立认领的工作单元（回答一个问题、修一个 bug、review 一个产出、**等一个人类决策**） | 输入与依赖（dependsOn）、验收契约、预算/权限边界、父子关系（split / join 见附录 C） |
| **Offer** | 把 WorkUnit 提供给一个或多个候选执行者（1:N） | 显式定向、能力画像路由、或 pull pool 广播；**offer 级 SLA**（无人认领超时 → remind / escalate）；可 withdraw / expire |
| **Claim** | 执行者对 WorkUnit 的排他认领（1:1，CAS） | 持有者（ActorRef）、**lease**（心跳/续约）、**generation**（FenceToken 组成部分，每次易主 +1，§4.4-2）；claim 跨 attempt 存续 |
| **Attempt** | claim 下的一次实际执行（一次 invocation / session） | started / heartbeat / 终态（succeeded・failed・interrupted）、parentAttemptId 链 |
| **Outcome** | Attempt 产出的**不可变坐标** | ArtifactRef = `{store, objectId, immutableVersion|digest}`（git = commit hash、message = messageId+contentDigest、文档 = path@commit）；StateDelta 带 base/result version；supersede 链维护当前版本；**独立验证绑定的对象**（附录 C4） |
| **Transition** | WorkUnit 状态的类型化迁移 | handoff / complete / fail / escalate / park / resume / **cancel**（关闭 WorkUnit 并推进 epoch）/ **transfer**（原子接棒，generation+1，附录 C）/ split |

**Actor 是正交维度，不是第二套节点分类。** 讨论中曾出现"governor / worker / tool / event 四层节点"的方案，最终否决（D1）：工作本体只有上面一套；执行者以 **ActorRef（身份）+ actor profile** 引用——profile 含 capability（能力画像）、family（家族/同源关系）、authority（可批准什么、可 review 什么）。路由决策、review 否定约束（§4.4-4）、审批权限都从 profile 判定，粗粒度的 `kind ∈ {cat, human, external}` 只是 profile 的一个字段，决定 SLA 档位与超时后的 Transition 类型。判据始终是：**一个东西是否成为 WorkUnit/Attempt，看它是否有独立生命周期、重试与验证边界——而不是看它"是人还是工具"。**

**人是一等执行者（HumanGate as WorkUnit）。** "等 operator 批准"不是把球扔进虚空，而是一个执行者为 human 的 WorkUnit。SLA 挂在两个层级：**offer 级**（人尚未认领：超时 → remind / escalate）与 **claim 级**（已认领：进度超时 → remind / escalate / park / cancel）。审批类 HumanGate 的超时动作**不含任何绕过授权的降级**——系统可以提醒、升级、搁置、取消，不能替人批准。这直接修复 §2-4：不把人建模进协调层，就没有地方挂人的超时策略。

### 4.2 回合循环：v1 → v2 映射

| TeamAct v1 | TeamAct v2 | 升级点 |
|-----------|-----------|--------|
| — | **Wake / Discover** | 新增。push 形态：被 delivery / timer / 事件唤醒；pull 形态：worker 主动从 pool 发现待认领工作。死信、已被认领的工作在此丢弃 |
| — | **Inspect** | 新增（claim 前的浅评估）：值不值得认领、是否在自己能力/权限内 |
| Owner | **Claim** | 从"言语行为推断球权"升级为带 lease + generation 的结构化 CAS 事件 |
| State | **Orient** | claim 后的深定向：读 shared state / 记忆 / 依赖，制定执行计划 |
| Action | **Execute** | 不变。ReAct、subagent 编排、workflow patterns 都是此步骤的合法内部实现 |
| Verdict（自检半边） | **Verify (self)** | 显式化：quality gate / 测试 / 自检，在 claim 内完成 |
| Evidence | **Commit Outcome** | 产出按 effect 类型分层提交：不可变 artifact 直接写（stale 后成无害 orphan）；可变 state 的 CAS **同时校验 FenceToken**；外部副作用先经**准入**（intent 与 claim 迁移同一串行化域，附录 C2）再执行；最后向 ledger 落 **Outcome 引用（携 token）**。跨 store 不宣称原子，靠 outbox / 对账收敛（附录 C） |
| Route | **Transition** | 从 generic 传球升级为类型化迁移（handoff / complete / fail / escalate / park / cancel） |
| Verdict（跨猫半边） | **独立 verify-WorkUnit** | 移出回合：独立验证是一个**新的 WorkUnit**，验证对象是稳定的 **Outcome 坐标**，受否定约束（§4.4-4） |

### 4.3 三维分离：wake / obligation / readability

§2-1 的病根是三个正交维度被耦合成一个"可见性"：

| 维度 | 语义 | 治理方式 |
|------|------|---------|
| **wake** | 这条消息唤醒谁 | per-recipient（显式路由；无目标时按路由规则定向，如 last-replier / active-claim 持有者，不广播） |
| **obligation** | 谁背处理义务（freshness / claim 责任），以及注入谁的 invocation 上下文 | per-recipient + per-invocation-scope |
| **readability** | pull 时能读到什么 | **独立的 ACL / visibility policy**——协作 thread 默认成员可读；whisper、私密、跨项目边界按各自策略 |

前两维必须收窄到 per-recipient；第三维**不由投递状态决定**——这是本节的核心命题：**投递状态不决定阅读权限**。Orient 阶段读协作历史、事后接手他人工作、审计复盘，都依赖"义务之外仍可读"的默认；而 whisper / 用户隐私 / 跨域边界属于独立的 visibility policy 轴，不因协调层重构而改变。（实现注记：delivery 状态机中的"未投递"态应命名为 `not-delivered` 而非 `invisible`——状态机管投递与义务，不管阅读权。）

### 4.4 不变量与策略的边界

**不变量**（violate = bug）：

1. **Claim 排他（CAS）**：任一时刻一个 WorkUnit 至多一个 active claim。并发需求通过**事前 split** 表达——**split before claim；offer 是 1:N 的，claim 是 1:1 的**。禁止事后把冲突解释成"其实是两个 WorkUnit"。
2. **Fenced effects（完整 token，不只 fence 落账）**：fencing 凭据是 **FenceToken = `{workUnitEpoch, claimGeneration}`**——cancel 推进 epoch、transfer 推进 generation，任一变化都使旧 token 整体失效。校验覆盖三层：ledger 落账、可变状态的 CAS 写入、**外部副作用的准入**（admission 与 transfer/cancel 在同一串行化域内提交，附录 C2）。不可变 artifact 允许先写（stale 后成为无害 orphan）。承诺的准确形式：持 stale token 的动作**要么在准入处被拒，要么是已记账、对新执行者可见的 in-flight obligation**——不存在静默的僵尸副作用；无法校验 token 的外部 sink 显式降级为"检测 + 对账"，不冒称"阻止"（附录 C2）。
3. **协调迁移全部落账**：§4.5 事件集内的每个事件写入 coordination ledger（append-only）。
4. **Verify 否定约束**：按 **ActorRef** 判定（不只按 kind）——产出者不得认领自己 Outcome 的 verify-WorkUnit；家族约束（如跨家族优先）从 actor profile 判定。这是跨家族 review 铁律的形式化。
5. **有界终止**：每个 WorkUnit 有终止控制（最大迭代 / 超时 / 乒乓熔断）——bounded control，不承诺形式化 termination guarantee。
6. **外部副作用有界**：幂等（idempotency key）、可补偿、或显式标记 non-retryable（人工对账）三者必居其一；执行结果不确定时先查询外部真相再决定，不盲目重试（附录 C）。

**策略**（按场景配置）：claim 分配方式（push 定向 / pull pool 竞争）、WorkUnit split 粒度（沿 context boundary 切，见 §5）、各 actor profile 的 SLA 档位与超时 Transition、fan-out 后的 join 策略（附录 C）。

### 4.5 存储架构：coordination ledger + 各域权威 store

```
             coordination ledger（append-only，协调域唯一权威）
             事件集（闭合）：
               workunit.created / .split / .parked / .resumed / .canceled(epoch+1)
               offer.made / .withdrawn / .expired
               claim.acquired / .renewed / .released / .transferred(gen+1)
               attempt.started / .heartbeat / .succeeded / .failed / .interrupted
               effect.intent(token, idempotencyKey) / effect.observed
               outcome.recorded(token) / outcome.superseded
               transition.{handoff|complete|fail|escalate}
               （token = FenceToken{workUnitEpoch, claimGeneration}，§4.4-2）
                        │ 稳定 ID 联接（messageId / commitHash / workUnitId）
     ┌──────────────┬───┴──────────┬────────────────┐
     ▼              ▼              ▼                ▼
 message store   artifact store  shared state    memory system
 (消息内容权威)   (git，产物权威)  (versioned+CAS)  (知识权威)
     │              │              │                │
     └──────┬───────┴──────┬───────┴────────┬───────┘
            ▼              ▼                ▼
      conversation     execution      responsibility     ← 读模型（投影，
      因果树           泳道(claim/attempt) claim 归属        可重建，不权威)
      + arrival-order 审计视图
```

关键决议（D3）：**ledger 只 canonical 协调迁移**——消息内容的权威在 message store，产物在 git，知识在记忆系统。各类视图是跨 store 通过稳定 ID 联接出的**读模型**，不是真相源，也不合并成一张万能图。事件集刻意闭合且带生命周期起点：**静默掉球的探测正是靠 `attempt.started` 之后 heartbeat / lease 续约断供 + claim SLA 超时**来判定（只记终态永远探测不到静默死亡，§2-5）。

与既有系统的关系：F233 球权引擎已经验证了同一模式（append-only event log + 纯函数投影 + 状态机，rebuild = replay 无漂移）——它是**模式先例与未来的首批消费者**，但**不是 v2 的存储基座**：F233 的 cell 契约明确它观测优先、不做 workflow engine、不引入新的球 ID 原语（KD-1 / KD-4），协调账本必须是独立的新 aggregate（见 §10）。

### 4.6 会话续接与故障恢复

**Continuation 关联到 Attempt 链，claim 挂 WorkUnit。** 一次 session 中断（进程死、额度尽、context 压缩）= 当前 attempt 记录终态，claim 不动；恢复 = 同一 claim 下 attempt+1（parentAttemptId 链接）。掉球探测看 attempt 心跳与 claim/offer SLA，而不是 session 存活。现状（F224）已有会话续接协调器（prepare/commit 已接线）；v2 补的是续接与 WorkUnit/Claim/Attempt 的 **lineage**——"续的是哪个工作、谁的认领、第几次尝试"，从而让中断不再产生球权歧义（§2-3/5）。

## 5. 与 Anthropic 多 agent 模式的对照

Anthropic 的三份实践参照：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)（五种 workflow patterns：prompt chaining / routing / parallelization / orchestrator-workers / evaluator-optimizer；"简单可组合模式优于框架"）、[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（orchestrator-worker：lead agent 并行派生 subagents；**其内部 research eval** 上相对单 agent +90.2%，token 用量约为单次 chat 的 15×——两个数字都限定在其研究场景，不可泛化为多 agent 的一般收益/成本）、[When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)（三个使用信号：context protection / parallelization / specialization；"先从单 agent 开始"）。

| 维度 | Anthropic patterns / research system | TeamAct v2 |
|------|--------------------------------------|-----------|
| 回答的问题 | 一次任务内如何编排执行 | 团队如何对工作负责 |
| agent 生命周期 | 任务期（orchestrator 派生、任务毕回收） | persistent（身份、记忆、责任跨任务累积） |
| 拓扑 | 层级：orchestrator 拥有并管理 worker | 对等 + 治理：peer 协作，operator 是治理者与一等执行者 |
| 协调状态 | orchestrator context 为主；research system 已辅以外部 memory、filesystem artifacts 与 checkpoint | 外化的 coordination ledger |
| 人的角色 | 发起者 / 结果消费者 | 团队成员（HumanGate WorkUnit，双层 SLA） |
| 失败模型 | retry / respawn / checkpoint 恢复 | attempt 链 + claim 存续 + fencing + 统一掉球探测 |

**两层是递归组合，边界由本文自己的 WorkUnit 判据决定。** 一个 pattern 落在 Execute 内部还是升格为 child WorkUnit，看被委派者是否有**独立的责任、SLA、重试与验证边界**（§4.1 判据）：

- 同一 claim 下的临时 helper（无独立责任，随 attempt 生灭）→ **Execute 内部**（例：spawn 一个只读检索 subagent）
- 独立负责的 worker → **split → child WorkUnit → offer/claim**——child 内部又是完整的 TeamAct 回合（分形嵌套的准确形式）
- evaluator → **verify-WorkUnit**（绑定不可变 Outcome 坐标）
- parallelization → **child WorkUnits + join**（all / quorum / first-success）
- orchestrator → 父 WorkUnit 的 claimer：split 与聚合就是它 Execute 的内容

Anthropic 的 when-not-to 判据我们完全采纳：单任务能单 agent 做就不要多 agent。

Anthropic 记录的失败模式与我们机制的对应（交叉验证两层一致性）：

| Anthropic 失败模式 | TeamAct v2 的对应机制 |
|---|---|
| Telephone game（信息随 handoff 衰减） | 五元组 handoff 契约（What/Why/Tradeoff/Open-Questions/Next）+ readability 独立于投递：接手者 pull 原始上下文，不依赖转述 |
| Early victory（验证浅尝辄止就放行） | verify 是独立 WorkUnit、验证稳定的 Outcome 坐标 + 否定约束 + "完成必须附证据" |
| Context pollution | wake/obligation per-recipient 隔离（§4.3） |
| Problem-centric decomposition（按工种切分致协调爆炸） | WorkUnit split 沿 context boundary 切（与其 context-centric decomposition 同构） |

## 6. 与行业框架与协议的对照

> 方法注记：下表针对各框架 2026 年的官方文档口径（链接见 References），刻意避免"把整个框架压成一句话"。这些 runtime 与 TeamAct v2 在 durable execution 与 HITL 上**能力有重叠**；差异集中在**责任本体**——是否存在跨 actor 的 claim/custody、执行者身份与权限、人机统一的 liveness 语义。

| 框架 / 协议 | 编排单位 | 持久化的对象 | 人的位置 | 有无跨 actor 责任本体 |
|---|---|---|---|---|
| LangGraph | graph 节点（静态定义 + `Send`/`Command` 动态派生） | 执行状态：graph state + checkpointer（durable、跨 session、可恢复） | interrupt / HITL 节点 | 无——state 是应用定义的图状态，无 claim/custody/授权语义 |
| CrewAI | role-based crew / Flows | Flows 持久化与恢复 | 输入与审批点 | 无 |
| AutoGen / AG2 | AgentChat 会话层 + **Core 分布式 actor runtime**（event-driven、resilient） | actor 运行时状态 | 会话参与者 | 无——actor 是执行单元，无认领/义务语义 |
| OpenAI Agents SDK | handoff + sessions | 执行状态：可序列化 RunState（支持跨 run 的 HITL 中断恢复） | HITL 审批（tool 级中断） | 无 |
| Claude Agent SDK | subagent spawn + sessions | 执行状态：session resume / fork、外部持久化、hooks 与 permissions | operator + permission gates | 无 |
| Google A2A protocol | Task（跨厂商互操作） | 协议态任务状态（submitted / working / input-required / auth-required / completed / failed / canceled / rejected；支持异步、poll/subscribe/push、cancel） | 协议范围外 | **scope 外**——custody/liveness 由参与方自行负责 |
| **TeamAct v2** | **WorkUnit** | **责任状态：coordination ledger（+ 各域权威 store）** | **一等执行者 + 治理者** | **有——本文的主体** |

三点说明：

**LangGraph 是最接近的邻居，分界线在本体不在能力。** 它的 durable execution、跨 session 状态、动态派生 worker 都与我们的需求重叠——如果你要的是"程序可靠地继续跑"，LangGraph 已经给出了好答案。它不提供的是：state 里没有"这个工作被哪个身份认领、义务算谁的、认领者失联谁发现"的语义；HITL 是图的暂停点，人不是有 SLA、被掉球探测覆盖的执行者。这不是 LangGraph 的缺陷——是它的问题域止于执行。（同样的分析适用于 Agents SDK 的 RunState 与 AutoGen Core。）

**Google A2A protocol：命名澄清与 scope 互补。** 我们内部"A2A"一词指 agent-to-agent 协作（通名），与 Google 发起、现由 [Linux Foundation 治理的 Agent2Agent protocol](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)（2025-04 发布，2026 年已获 [150+ 支持组织、并报告部分行业生产部署](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)）是不同的东西——后者解决**跨厂商 agent 的互操作**：Agent Card 能力发现、任务状态同步（含异步任务、poll/subscribe/push、取消）。它的 scope 止于协议面：**custody 与 liveness 责任留给参与方自己**——这正是 TeamAct 作为参与方内部协调层的位置。两者互补：未来我们的 agent 与外部 agent 互操作时，A2A 是天然的边界协议候选，WorkUnit 可桥接为 A2A Task（审批型 HumanGate ≈ `auth-required`；`input-required` 对应缺补充输入的 blocked 态，不特指人类审批）。

**MCP 正交。** MCP 解决 agent↔工具，本文解决 agent↔agent↔human 的责任协调，两层无重叠（我们的 agent 本身是重度 MCP 消费者；上表各框架也已普遍支持 MCP）。

### 6.1 行业协作模式 → TeamAct 原语映射

产品对照回答"和哪个框架比"；协作**模式**是更本质的分类——你熟悉的协作拓扑都能用本文原语表达：

| 行业协作模式 | TeamAct v2 表达 |
|---|---|
| supervisor / orchestrator-worker | 父 WorkUnit 的 claimer split child WorkUnits → offer 定向 → join(all) |
| handoff / router | handoff offer（定向 `toActorRef`）→ 授权校验 → atomic transfer accept（附录 C3）；路由由能力画像驱动 |
| peer mesh（对等协作） | offer/claim + 结构化 handoff 契约——我们团队的日常形态 |
| fan-out / fan-in | split N → 并行 claim → join（all / quorum / first-success） |
| blackboard | versioned shared state（CAS）+ wake 订阅 |
| debate / consensus | 同输入 N 个平行 WorkUnit（不同执行者）→ 聚合 WorkUnit（vote / judge） |
| pull pool（工作队列） | offer 广播到 pool → claim CAS 竞争 |
| evaluator-optimizer | execute ↔ verify-WorkUnit 迭代：verify fail → Transition 回 rework |

## 7. 为什么这样设计：从约束到结论

每条设计都由一条系统约束推出。**判断本范式是否适用于你，就看你是否共享这些约束**——不共享某条，就不需要对应的设计：

| # | 约束 | 推出的设计 | 若无此约束 |
|---|------|-----------|-----------|
| C1 | agent 长命、有身份与责任记录 | claim 挂 ActorRef、能力画像路由、责任可追溯 | ephemeral worker + orchestrator 即可 |
| C2 | 人是团队成员，且**人也会掉球** | HumanGate WorkUnit + offer/claim 双层 SLA + 统一掉球探测 | 人只做发起者，HITL 暂停点即可 |
| C3 | 工作跨 session / 进程 / 供应商故障，且**执行者可能被更换** | 责任状态外化 ledger；attempt 链；claim 跨 attempt 存续；FenceToken fencing | 编排框架的 durable execution 即可 |
| C4 | 结果要审计、验证要独立 | append-only event sourcing + Outcome 坐标 + verify 否定约束 | 普通日志即可 |
| C5 | 异构模型 / 异构 harness 混编 | 协调协议定义在事件与消息层，不绑任何 agent 框架 | 用单一框架的内建编排即可 |

## 8. 有什么用 & 适用判据

**具体收益**（每条对应 §2 的一个实测 incident）：

1. 掉球可探测，且**人与 agent 统一覆盖**（不再有"operator 是唯一没有保护的 agent"）
2. 球权有 chain of custody：谁在何时对什么负责，事后可查、可复盘
3. 中断可恢复且**易主安全**：attempt 链消除续接歧义；FenceToken 拒绝迟到的落账与状态写入，外部副作用要么在准入处被拒、要么是对新执行者可见的 in-flight obligation——无静默僵尸动作
4. 并发安全：claim CAS 消灭"两只猫同时做同一件事 / 都以为对方在做"
5. 注意力隔离而不牺牲协作感知：wake/obligation 收窄，readability 由独立 policy 管
6. 治理可执行：跨族 review、决策漏斗从"家规文本"变成可校验的协议约束

**适用判据**——核心是两条**必需条件**：

- [ ] **责任会转移**：工作跨执行者生命周期——执行者可能中断、被替换、或把球传给别人？
- [ ] **掉球有代价**：需要发现"没人在做"并追溯"谁该做"，而不是任其超时重跑？

两条都"是"→ 你需要某种责任协调层。以下**增强信号**越多，本文的完整形态越划算：

- 人深度参与执行路径（→ HumanGate + 双层 SLA）
- 多模型 / 多框架混编（→ 框架无关的事件层协议）
- 审计与复盘要求高（→ append-only ledger + Outcome 坐标）
- 任务以天计、跨 session / 故障（→ attempt 链 + fencing）

**不适用**的判据同样看责任而非时长或次数：无责任转移（单执行者从头到尾）、执行者不可替换也无需探活、掉球无代价（超时重跑即可）——此时编排框架的 durable execution 已足够。典型：单次 pipeline 任务（→ Anthropic patterns）、高频低延迟在线服务（协调开销不可摊）、大规模同质 swarm 的 map-reduce（→ orchestrator-worker）。注意反例：**一次性但高风险的跨 actor 流程**（如一次生产迁移，多方交接 + 人工审批）依然值得责任账本——判据是责任转移与审计需求，不是运行次数。

## 9. 局限性

**范式固有**（换个团队实现同样存在）：

1. **协议遵守不是硬约束。** LLM agent 靠提示词约定 + harness 门禁兜底（认领检查 / freshness 门禁 / 接球提醒），仍会漏。ledger 让掉球**可见**，不让掉球**不可能**。
2. **人的 SLA 是社会约定。** 超时只能提醒、升级、搁置，不能强制人类行动，更不能绕过授权。
3. **协调开销真实存在。** 多 agent 本身就贵（参照 Anthropic 研究场景 ~15× token 的量级），协调层再加 Orient / recall / 落账成本。只适合价值密度高的工作（开发、研究、审计敏感协作）。
**当前实现成熟度**（Clowder AI 特定，随迭代收敛）：

4. 物理中心化的 ledger 部署：范式只要求**逻辑上**单一的 canonical coordination history，物理上可以复制或分区；当前实现是单机单 store，联邦 / 跨组织不在当前工程范围——这是部署形态限制，不是范式约束。
5. 实证规模：3~7 agent、单 operator、单机。10+ agent、多 operator 未验证。
6. 本体尚未落地：F233（事件溯源基座模式）与 F224（会话续接）是局部先行实现，WorkUnit/Claim/Attempt lineage 还在 §10 的 shadow 阶段之前。

**迁移风险**：

7. shadow 期存在双写与双读复杂度；现有 freshness / mention 机制在过渡期与新语义并存，行为混合期需要额外观测。

## 10. 迁移路径（概要）

决议（D7）：**不从局部 data model 补丁开始，先 shadow ontology。**

1. **Shadow 期**：新建独立的 **CoordinationLedger aggregate**（新 key namespace、新事件 union）——**不复用 F233 event log**：F233 的 cell 契约明确它观测优先、不做 workflow engine、不加第二 canonical store（KD-1 / KD-4），这个边界保持不变。**Day-1 指定两个真实消费者**：F233 球权投影（经适配器消费协调事件做聚合报告）与 freshness gate v2——影子系统没有读者就永远不会被现实修正。
2. **Delivery / obligation 隔离**：wake + obligation + 上下文水合 per-recipient / per-invocation-scope 化（readability 走独立 visibility policy，§4.3），修复 §2-1。
3. **Freshness v2**：义务判定改读 per-recipient delivery / claim 状态。
4. **投影分层**：在 `replyTo`（已有）之上区分三种视图——arrival-order 审计视图、conversation 因果树、WorkUnit/Attempt 执行泳道，修复 §2-2。

代码改造节奏另行与 maintainer 对齐后展开；本文只固化范式与决议。

## 附录 A：设计决议记录（源自三轮内部讨论 + 跨家族 review r1）

| # | 决议 | 否决的替代方案 |
|---|------|--------------|
| D1 | 单一工作本体（WorkUnit 系）；执行者以 ActorRef + profile（capability / family / authority）正交引用，kind 只是 profile 字段 | ①governor/worker/tool/event 四层节点分类；②把身份/权限压扁成 executorKind 枚举（r1 修正） |
| D2 | offer 1:N，claim 1:1 CAS，split-before-claim；FenceToken = {epoch, generation}；**fencing 覆盖落账、可变状态、外部副作用准入三层**（准入与 claim 迁移同一串行化域）；transfer = 定向授权 + expected-token CAS 双条件 | ①无限制并行 claim；②不可参数化的普适 Single Writer；③无 fencing 的跨 attempt 存续（r1 修正）；④只 fence 落账不 fence 副作用、release-then-reclaim 留无主窗口（r2 修正）；⑤generation-only token 漏 cancel、check-then-act 准入、CAS 当授权（r3 修正） |
| D3 | ledger 只 canonical 协调迁移（事件集闭合、含生命周期起点与心跳）；消息/产物/知识各有权威 store，稳定 ID 联接；跨 store 不宣称原子，outbox/对账收敛 | ①万能 mega-graph；②所有数据进同一 event log；③"原子落账"承诺（r1 修正） |
| D4 | wake / obligation per-recipient；**投递状态不决定阅读权限**——readability 由独立 visibility policy 管（协作 thread 默认可读，whisper/私密例外） | ①thread-wide 全耦合；②per-recipient 全隔离；③"协作域内全可读"不变量（r1 修正） |
| D5 | continuation 关联 Attempt 链；claim 挂 WorkUnit 跨 attempt 存续（受 D2 fencing 约束） | continuation 挂 delivery 或挂 session |
| D6 | 升级既有 TeamAct，不引入 GAM/WOCEY 新术语 | 新造范式命名 |
| D7 | 迁移先 shadow：**独立 CoordinationLedger aggregate** + day-1 真实消费者；F233 是模式先例与消费者，不是存储基座 | ①从 parentId 等局部 data model 变更起步；②把 F233 event log 改造成协调引擎（r1 修正，违反 KD-1/KD-4） |

## 附录 B：Incident ↔ 范式条款映射

| 实测 incident（§2） | 范式条款 |
|---|---|
| 1a 上下文水合污染（他人消息注入 invocation） | §4.3 hydration per-recipient / per-invocation-scope |
| 1b freshness 义务误判（他人对话算进 unseen） | §4.3 obligation per-recipient |
| 2 壁钟排序、投影不分层 | §4.5/§10-4 三种投影视图 |
| 3 session 断片缺 lineage | §4.6 attempt 链 + claim/WorkUnit 关联 |
| 4 operator 无掉球保护 | §4.1 HumanGate WorkUnit + offer/claim 双层 SLA |
| 5 API 中断静默掉球 | §4.5 attempt.started + heartbeat/lease 断供探测 |

## 附录 C：运行时语义规范（正文只保不变量，机制细节在此）

### C1. Lease 与掉球探测

active claim 靠 lease 续约维持；`attempt.started` 后心跳断供 + lease 过期 + SLA 超时 → 判定 stalled/dead → 探测（probe）与唤醒（best-effort）→ 仍无响应 → escalate 或 transfer。**Unclaimed 阶段不是无主**：`offer.made` 后无人认领超 offer 级 SLA → remind / escalate，义务监督方 = offer 发起方（父 WorkUnit claimer 或系统调度）。

### C2. Effect 分类与 fencing —— 准入是线性化点

FenceToken = `{workUnitEpoch, claimGeneration}`（§4.4-2）。不同 effect 类型的校验点不同：

| effect 类型 | 处理 | stale token 的下场 |
|---|---|---|
| 不可变 artifact（git object 等内容寻址产物） | 直接写 | 成为无害 orphan（不被 Outcome 引用即不可达） |
| 可变共享状态 | CAS **同时校验** value version 与 FenceToken | 写入被拒 |
| 外部副作用（发消息 / 开 PR / 外部 API） | **两阶段**：①**准入**——`effect.intent(token, idempotencyKey)` 与 claim/workunit 状态迁移在 **coordination ledger 的同一串行化域内 CAS 提交**，token 校验在此刻发生；②**执行**——gateway 对已准入 intent 执行动作，完成落 `effect.observed` | intent 在准入处被拒，动作不发生 |

- **准入即承诺**：准入成功的 intent 是不可撤销的 dispatch obligation——其后发生的 transfer/cancel **必须承认这些 in-flight effects**（接棒者 accept 时可见 in-flight intent 列表，等待其 observed 或走不确定结果协议）。TOCTOU 窗口因此从"校验与执行之间"收敛到准入点本身；代价是"准入后必然执行"成为显式语义，而非隐式竞态。
- **能力下推（严格条件）**：仅当外部 sink 能**持久化并比较完整 FenceToken**、或明确参与同一 admission protocol 时，才可把校验下推到 sink 替代 gateway 准入。普通条件写（ETag / If-Match）只能 fence 外部资源自身的版本，**fence 不了 WorkUnit ownership**，不足以替代 ledger 准入。
- **诚实降级**：既无法准入串行化、也无法下推校验的 sink，该类 effect 只承诺**检测 + 对账**（事后发现 stale 动作并补偿/告警）——文档与实现都不得宣称"阻止"。
- 执行结果不确定（如超时）：先按 idempotencyKey **查询外部真相**，再决定补账或重试；禁止盲重试。
- 不可幂等且不可补偿的动作：显式标记 **non-retryable**，失败进入人工 reconcile 队列——不假设"注册补偿动作"总能成立。
- 旧 attempt 收到任何 fence 拒绝 → 自行终止并记录 `attempt.interrupted`。

### C3. 易主（transfer）与取消（cancel）

- **主模型：授权 + 原子接棒，两个条件缺一不可。**
  1. **授权**：存在待接受的 **TransferOffer** = `{offerId, workUnitId, fromActorRef, toActorRef, expectedFenceToken, issuedBy, expiresAt}`（复用 offer 事件族，kind=transfer）。**签发者（issuedBy）受约束**：必须是与 token 匹配的当前 claim holder，或具备明确 transfer 权限的 scheduler/governor——缺了这条，任何 actor 自造 `toActorRef=self` 的 offer 即可窃取 claim。接棒者还须与 `toActorRef` 一致，并通过 capability/authority policy 校验；
  2. **并发安全**：接棒者携 expected FenceToken 做 CAS——**expected token 是并发前置条件，不是权限凭据**（能读 ledger 的 actor 都知道 token 值，授权只能来自条件 1）。
  **Accept 是单次原子 CAS**：同一提交内校验 offer 未过期、未消费、issuer authority 有效，然后原子执行 `consume(offer) + claim.transferred(from, to, gen+1)`（transferred 事件记录被消费的 offerId）。custody 无缝转移、无无主窗口；接棒完成前旧 claim 持续承担 custody（探测继续指向它）；接棒者 accept 时**可见并承认全部 in-flight effects**（C2）。
- **显式 release**（无指定接收者）：`claim.released` → WorkUnit 回到 offerable，义务回落 offer 级 SLA（C1）。
- **Cancel**：`workunit.canceled` 推进 **workUnitEpoch**，使所有既有 FenceToken **整体失效**（不依赖 generation 单独变化）；运行中 attempt 在下一次心跳 / 检查点 / fence 校验时感知取消（协作式取消，不承诺抢占）；已准入的 in-flight effects 按 C2 处理；级联到子 WorkUnit 按策略。
- **Pause / resume**：`workunit.parked` / `.resumed`；park 时 claim 保留或释放按策略显式声明。

### C4. Outcome 不可变性与 verify 绑定

- ArtifactRef 必须含不可变版本：`{store, objectId, immutableVersion|digest}`——git = commit hash、message = `messageId + contentDigest`（或不可变快照）、文档 = path@commit。StateDelta 记 base/result version。
- verify-WorkUnit 绑定 `{targetOutcomeId, digest, criteriaVersion}`。**失效是投影语义，不是自发事件**：同一 WorkUnit 记录新 Outcome 时，ledger 同步落 `outcome.superseded`（指向被替代者）；current-outcome 投影据此把绑定旧 outcome 的 verdict 标记为 stale。digest 绑定证明"verdict 属于哪个版本"，supersede 链回答"当前版本是谁"——两者合起来才封住 TOCTOU：review 期间作者修改产物，旧 verdict 不会被误读为对新版本有效（实践先例：本文历轮 review 均以内容 hash 为 review 坐标）。

### C5. Join / fan-in

split 的子 WorkUnit 完成后按父 WorkUnit 的 join 策略聚合（all / quorum / first-success）；聚合本身可以是一个 WorkUnit（如"汇总三份 review"）。

### C6. Outbox / 对账

跨 store 序列 = ①权威 store durable 写入 → ②ledger 落引用。中断产生的"产物已写、账未落"由对账任务扫描收敛（以权威 store 为准补账）；反向的"账有、产物无"标记 dangling reference 并告警，不自动伪造产物。

## References

- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — workflow patterns；"简单可组合模式优于框架"
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — orchestrator-worker 实践；+90.2%（内部 research eval）与 ~15× token（相对单次 chat）数字的原始出处与适用范围
- Anthropic, [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) — 使用信号、失败模式、context-centric decomposition
- Anthropic, [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) — sessions（resume / fork）、外部持久化、hooks、permissions、subagents
- LangChain, [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) / [Workflows & agents（Send/Command）](https://docs.langchain.com/oss/python/langgraph/workflows-agents) / [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- Microsoft, [AutoGen Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html) — event-driven distributed actor runtime
- OpenAI, [Agents SDK](https://openai.github.io/openai-agents-python/) / [Human-in-the-loop（RunState）](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- CrewAI, [Documentation（Flows 持久化）](https://docs.crewai.com/)
- A2A Project, [Specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)；Linux Foundation [立项通报](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents) / [一周年采用通报](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- 内部：`architecture/collaboration-landscape.md`（TeamAct v1 + 协作全景）、`architecture/ownership/cells/ball-custody.md`（F233 cell 契约：KD-1/KD-4 边界）、F078（无 @ 消息 last-replier 路由）、F117/F167/F224/F233/F254 feature docs、source thread `thread_mruayc4owlyzazbx`
