---
title: "从执行编排到责任协调：一个长时人机混合团队的多 Agent 协作范式"
doc_kind: publication-draft
version: 1
status: draft-pending-publish
topics: [multi-agent, teamact, coordination, tech-article, publication]
created: 2026-07-25
---

<!-- Export boundary: frontmatter 之上（含本注释）发布时全部剥离；正文自足、
     无内部文档/线程/系统坐标引用。byline 与发布渠道由发布决策定。
     内部治理关系（本文属 TeamAct v2 文档族）见 multi-agent-collaboration-paradigm.md 导航页。 -->

# 从执行编排到责任协调：一个长时人机混合团队的多 Agent 协作范式

> **写给谁**：如果你用过 orchestrator + subagents、agent team、crew 或 graph 编排——
> 你已经知道"任务怎么被执行"这层（execution orchestration）解决得如何了：
> durable execution、断点恢复、human-in-the-loop 都日趋成熟。
> 我们在生产中运行一个多 agent 团队数月后发现还有一层缺少 first-class 支持：
> **"团队怎么对工作负责"（responsibility coordination）**——谁认领了什么、义务推进到哪、
> 谁掉了球、人如何作为有 SLA 的一等执行者被纳入协调。本文分享我们对这一层的
> 设计（TeamAct），以及它与 Anthropic 模式、主流框架的关系、用处和边界。

![图 A：执行编排层与责任协调层](./assets/teamact/figure-a-two-layers.svg)

*图 A：执行编排层与责任协调层*

## 1. 我们的系统形态：为什么"执行编排"对我们不够

我们运行着一个持续数月的多 agent 协作系统（一个人类 operator + 多只有持久身份的 AI "猫"协作开发一个软件产品）：

- **Agent 是长命的**：每个 agent 有持久身份、独立记忆、能力画像、责任记录。异构模型混编（Claude / GPT / Gemini / Kimi 同队），累计协作交付 250+ 功能。
- **人是团队成员，不是调用者**：operator 拍板愿景、审批不可逆操作、也**承接工作**（配环境、做决策）——因此人也会成为瓶颈、也会掉球。
- **工作跨 session**：一个功能以天计，横跨多次进程重启、上下文压缩，乃至模型供应商的额度与服务中断。
- **结果要审计**：谁在什么时候对什么负责，事后必须可追溯（跨模型家族 code review 是我们的铁律）。

现代编排框架在 durable execution 上已经走了很远（LangGraph 的 checkpointing 与跨 session 状态、OpenAI Agents SDK 的可序列化 RunState、CrewAI Flows 的持久化恢复——见 §5）。但它们持久化的对象是**执行状态**（图走到哪个节点、run 等待什么输入）。我们的生产实践反复指向另一类状态的缺失：**责任状态**——这个工作单元被谁认领、义务算谁的、认领者失联了谁来发现、人类成员的承诺怎么被跟踪。执行状态回答"程序怎么继续跑"，责任状态回答"团队怎么不掉球"。

## 2. 当 agent 变成长期队友：五类新失效

如果你搭过一次性的 orchestrator + subagents，下面这些问题你可能从未遇到——它们只在 agent **长命、跨会话、与人混编**时出现。以下场景是我们数月生产实践中反复出现的失效模式的抽象（具体案例数据属于内部工程记录，此处只保留结构）：

**F1 — 义务误归属。** 群体频道里进来一条不指名的消息。路由器按规则（比如"最近发言者优先"）把它派给 A——没问题。但 B 稍后因另一件事被唤醒时，系统把频道里的"未读消息"一股脑算进 B 的义务：A 名下的消息被注入 B 的执行上下文，B 的行动还被"你有未读消息"的门禁拦住。**根因：唤醒、义务、可读三个正交维度被压成了一个"频道可见性"。**

**F2 — 时序失真。** 两个 agent 并行工作，回复按到达时间交错渲染成一根时间线——读者看到精确到毫秒的混乱。**根因：审计需要到达序、理解需要因果树、追踪需要执行泳道，三种视图被迫共用一根时间线。**

**F3 — 续接断链。** agent 的会话中断后重启。执行框架能恢复"程序跑到哪了"，却回答不了：我**认领**的是哪项工作？这是第几次尝试？上次尝试对外承诺了什么？**执行状态恢复了，责任状态没有。**

**F4 — 人类黑洞。** 一件事升级给人审批，然后……没有然后了。agent 侧有超时与重试，人这一侧什么都没有——**人是系统里唯一没有掉球保护的执行者**。几天后有人偶然想起来问"那件事怎么样了"。

**F5 — 静默死亡。** agent 因供应商额度耗尽或 API 中断悄然消失。没有失败事件——因为"报告失败"也需要执行者活着，而它已经死了。工作停在原地，直到人类注意到不对劲。

五类失效同源：**系统持久化了执行状态与消息内容，却没有持久化责任状态**——谁认领了什么、义务推进到哪、承诺是否还活着。消息（说了什么）、执行（跑到哪了）、责任（谁该做什么）被耦合在同一根管道里，粒度各自都不对。

## 3. TeamAct v2：责任协调范式的核心思想

我们把几个月的实践机制 + 多轮内部对抗讨论收敛成一套协调范式。核心是**六个实体 + 一本账**：

| 实体 | 一句话 |
|------|--------|
| **WorkUnit** | 可独立认领的工作单元——包括"等一个人类决策"（HumanGate 也是 WorkUnit） |
| **Offer** | 把工作提供给候选执行者（1:N；定向 @ 或 pull pool 广播；带"无人认领"超时 SLA） |
| **Claim** | 排他认领（1:1，CAS；带租约心跳与防僵尸的完整 fencing token（工作纪元 + 认领代数））；**认领跨 session 存续** |
| **Attempt** | 认领之下的一次实际执行（一次 session）；中断 = 记终态，认领不动，恢复 = attempt+1 |
| **Outcome** | 产出的**不可变坐标**（commit hash / 内容摘要）——独立验证绑定的对象 |
| **Transition** | 类型化的状态迁移：handoff / complete / fail / escalate / park / cancel / transfer |

所有协调迁移写入一本 **append-only coordination ledger**（协调账本）；消息内容、代码产物、知识各有自己的权威存储，账本只记"谁在何时对什么负责"，通过稳定 ID 联接。会话视图、执行泳道、责任归属都是从账本+各存储投影出来的**读模型**——可重建，不权威。

九条最有用的设计判断（①–⑤ 各自回应 §2 的一类失效，⑥–⑨ 是协作机制的正面设计）：

**① 三维分离：唤醒 ≠ 义务 ≠ 可读。** F1 的病根是三个正交维度被耦合成一个"可见性"。唤醒（谁被这条消息叫起来）和义务（谁背处理责任、注入谁的上下文）必须 per-recipient 收窄；但**投递状态不决定阅读权限**——可读性由独立的 ACL 管，协作域默认可读。隔离的是注意力和义务，不是信息：事后接手他人工作、审计复盘，都依赖"义务之外仍可读"。

**② 人是一等执行者。** "等人批准"不是把球扔进虚空，而是一个执行者为 human 的 WorkUnit——因此它有认领前/认领后两层 SLA、超时提醒与升级路径，被掉球探测统一覆盖（修复 F4：不把人建模进协调层，就没有地方挂人的超时策略）。唯一的硬边界：审批超时只能提醒/升级/搁置/取消，**系统永远不能替人批准**。

**③ 静默死亡靠"生命迹象"探测，不靠终态。** 只记录"任务失败了"永远探测不到"任务没了动静"。attempt 有 started 事件和心跳；心跳断供 + 租约过期 + SLA 超时 = 判定掉球 → 探测、唤醒、升级或转移（修复 F5）。

**④ 易主安全需要三层防护。** 认领可以转移（agent 中断、额度耗尽、人工改派），但旧 session 可能还活着——它迟到的写入和外部动作（发消息、开 PR）必须被挡住。我们的方案：fencing token（epoch + generation）覆盖账本落账、可变状态 CAS、以及**外部副作用的准入**（准入与认领迁移在同一串行化域内提交——把 TOCTOU 窗口收敛到一个线性化点）；做不到校验的外部系统诚实降级为"检测 + 对账"，不冒称"阻止"。转移本身 = 定向授权 offer + 原子 CAS 接棒，**并发前置条件不冒充权限凭据**。

**⑤ 验证有两种，第二种要绑定不可变坐标。** 自检（quality gate）在认领内完成；**独立验证是一个新的 WorkUnit**，约束"产出者不得验证自己的产出"（我们跨模型家族 review 铁律的形式化），且验证绑定产出的内容摘要——产出改了，旧的验证结论自动过期（防"审的是旧版、盖章盖在新版上"）。这条我们自己先吃了狗粮：本范式的每轮内部 review 都以内容 hash 为 review 坐标。

**⑥ 委派是递归的。** 一个 agent 在执行中 spawn 的临时 helper（无独立责任）留在执行内部；有独立责任、SLA、验证边界的被委派者升格为 child WorkUnit——child 内部又是完整的协作回合。分形嵌套，同一套账。

**⑦ push 与 pull 是策略，责任结构是不变量。** 先分清两层：**消息投递**（内容到达与接收确认——普通信息消息不自动产生工作责任）与**工作分发**（谁来认领一项有义务的工作）。工作分发有两种模式：**push（定向传球）**——上一棒完成自己的单元后为后继工作定向 offer 指名下一棒，适合专长匹配明确、上下文连续性重要的工作；**pull（工作池）**——offer 广播进池，空闲执行者评估后竞争认领（CAS 保证唯一赢家），适合可并行、执行者可互换的工作。可靠性铁律贯穿两层：**push 只唤醒（尽力而为，允许丢失），durable pull 才兜底**——唤醒丢了，义务在持久的归属记录里还在，接收者下次干活时拉取。两种模式可以在同一团队共存，因为它们共享同一套认领 / 义务 / 探测语义——分发模式怎么选是策略，"认领排他、义务明确、掉球可探测"是不变量。

**⑧ 上下文传递走双通道：契约传意图，回读传细节。** 跨执行者的交接不能依赖转述——转述随交接链衰减（telephone game 的本质）。每次交接附带**结构化交接契约**，最小完备集四要素：*事实*（做了什么 + 产出坐标）、*意图*（为什么这样做 + 放弃了什么权衡）、*边界*（开放问题 + 已知风险）、*行动*（期望下一棒做什么）。细节不塞进契约——接手者按需**回读**原始协作历史（①里"可读性不隔离"的用处正在这里）。只有推送会丢细节，只有拉取会丢意图——原始记录里没有"为什么不那样做"。

**⑨ 失忆是常态，记忆分四层管理。** 上下文窗口会压缩、会话会重启、执行者会更换——记忆设计的目标不是避免失忆，而是**让失忆不致命**。四层：**工作记忆**（会话内推理状态，易失）、**团队知识**（跨 agent 共享可检索——**候选**写入是 Commit 的副产品，候选晋升为结论需要 provenance：谁产出、是否经独立验证；检索是接手工作的标准步骤而非可选优化）、**agent 私有记忆**（身份/关系/偏好，不共享但影响行为）、**责任记忆**（协调账本——注意"我们决定了什么"是知识，"谁负责做的这个决定"是责任，两者分开存、以稳定 ID 互相引用）。会话更替后的恢复靠**契约 + 检查点 + 账本 + 知识**多源重建：交接契约或执行中留下的 durable 检查点给意图与进度（检查点是静默死亡场景的唯一进度来源——正常收尾才有契约），账本回放给责任状态，知识检索与历史回读给细节。铁律：**任何决定协作状态的信息不得只存在于工作记忆**，"我记得我答应过"在下一个会话里不存在。

![图 B：协作回合与上下文双通道](./assets/teamact/figure-b-loop-context.svg)

*图 B：协作回合与上下文双通道*

> 完整的形式化规范（实体定义、闭合事件集、运行时语义、设计决议与被否决的替代方案）超出本文篇幅；此处保留核心思想与设计判断。

## 4. 与 Anthropic 多 agent 模式的关系：组合，不是竞争

Anthropic 的三份实践参照：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)（五种 workflow patterns；"简单可组合模式优于框架"）、[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（orchestrator-worker：lead agent 并行派生 subagents；**其内部 research eval** 上相对单 agent +90.2%，token 用量约为单次 chat 的 15×——两个数字都限定在其研究场景）、[When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)（三个使用信号；"先从单 agent 开始"）。

| 维度 | Anthropic patterns / research system | TeamAct v2 |
|------|--------------------------------------|-----------|
| 回答的问题 | 一次任务内如何编排执行 | 团队如何对工作负责 |
| agent 生命周期 | 任务期（orchestrator 派生、任务毕回收） | persistent（身份、记忆、责任跨任务累积） |
| 拓扑 | 层级：orchestrator 拥有并管理 worker | 对等 + 治理：peer 协作，operator 是治理者与一等执行者 |
| 协调状态 | orchestrator context 为主；research system 已辅以外部 memory、filesystem artifacts 与 checkpoint | 外化的 coordination ledger |
| 人的角色 | 发起者 / 结果消费者 | 团队成员（HumanGate WorkUnit，双层 SLA） |
| 失败模型 | retry / respawn / checkpoint 恢复 | attempt 链 + claim 存续 + fencing + 统一掉球探测 |

**两层按 §3-⑥ 的递归边界组合**：orchestrator-worker、evaluator-optimizer 等 patterns 可以完整活在一个 WorkUnit 的执行内部（临时 helper），也可以升格为 child WorkUnits（独立责任）。Anthropic 的 when-not-to 判据我们完全采纳：单任务能单 agent 做就不要多 agent。他们记录的失败模式与我们机制的对应也能交叉验证：telephone game ↔ 结构化 handoff 契约 + 可读性不隔离（接手者读原始上下文，不依赖转述）；early victory ↔ 独立验证 WorkUnit + 否定约束 + 不可变坐标绑定；context pollution ↔ 唤醒/义务 per-recipient 隔离。

## 5. 与行业框架与协议的对照

> 方法注记：下表针对各框架 2026 年的官方文档口径（链接见文末），刻意避免"把整个框架压成一句话"。这些 runtime 与 TeamAct v2 在 durable execution 与 HITL 上**能力有重叠**；差异集中在**责任本体**——是否存在跨 actor 的 claim/custody、执行者身份与权限、人机统一的 liveness 语义。

| 框架 / 协议 | 编排单位 | 持久化的对象 | 人的位置 | 跨 actor 责任本体（first-class?） |
|---|---|---|---|---|
| LangGraph | graph 节点（静态定义 + `Send`/`Command` 动态派生） | 执行状态：graph state + checkpointer（durable、跨 session、可恢复） | interrupt / HITL 节点 | 非 first-class——state 是应用定义的图状态，claim/custody/授权需应用自行建模 |
| CrewAI | role-based crew / Flows | Flows 持久化与恢复 | 输入与审批点 | 非 first-class（需应用自行建模） |
| AutoGen / AG2 | AgentChat 会话层 + Core 分布式 actor runtime（event-driven、resilient） | actor 运行时状态 | 会话参与者 | 非 first-class——actor 是执行单元，认领/义务语义需应用自行建模 |
| OpenAI Agents SDK | handoff + sessions | 执行状态：可序列化 RunState（支持跨 run 的 HITL 中断恢复） | HITL 审批（tool 级中断） | 非 first-class（需应用自行建模） |
| Claude Agent SDK | subagent spawn + sessions | 执行状态：session resume / fork、外部持久化、hooks 与 permissions | operator + permission gates | 非 first-class（需应用自行建模） |
| Google A2A protocol | Task（跨厂商互操作） | 协议态任务状态（含异步、poll/subscribe/push、取消） | 协议范围外 | **scope 外**——custody/liveness 有意留给参与方自行负责 |
| **TeamAct v2** | **WorkUnit** | **责任状态：coordination ledger（+ 各域权威 store）** | **一等执行者 + 治理者** | **first-class——本文的主体** |

**LangGraph 是最接近的邻居，分界线在本体不在能力。** 它的 durable execution、跨 session 状态、动态派生 worker 都与我们的需求重叠——如果你要的是"程序可靠地继续跑"，LangGraph 已经给出了好答案。它没有作为 first-class 概念提供的是："这个工作被哪个身份认领、义务算谁的、认领者失联谁发现"——应用可以在 graph state 里自行建模这些，但认领协议、掉球探测与治理约束都要自己搭；HITL 是图的暂停点，人不是有 SLA、被掉球探测覆盖的执行者。这不是 LangGraph 的缺陷——是它的问题域止于执行。（同样的分析适用于 Agents SDK 的 RunState 与 AutoGen Core。）

**Google A2A protocol：命名澄清与 scope 互补。** 本文说的 "A2A"（agent-to-agent 协作，通名）与 Google 发起、现由 [Linux Foundation 治理的 Agent2Agent protocol](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)（2025-04 发布，2026 年已获 [150+ 支持组织、并报告部分行业生产部署](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)）是不同的东西——后者解决**跨厂商 agent 的互操作**：Agent Card 能力发现、任务状态同步。它的 scope 止于协议面：**custody 与 liveness 责任留给参与方自己**——这正是 TeamAct 作为参与方内部协调层的位置。两者互补：与外部 agent 互操作时，A2A 是天然的边界协议候选，WorkUnit 可桥接为 A2A Task（审批型 HumanGate ≈ `auth-required`；`input-required` 对应缺补充输入的阻塞态，不特指人类审批）。

**MCP 正交。** MCP 解决 agent↔工具，本文解决 agent↔agent↔human 的责任协调，两层无重叠。

**行业协作模式 → TeamAct 原语映射**（你熟悉的协作拓扑都能用六实体表达）：

| 行业协作模式 | TeamAct v2 表达 |
|---|---|
| supervisor / orchestrator-worker | 父 WorkUnit 的 claimer split child WorkUnits → offer 定向 → join(all) |
| handoff / router | handoff offer（定向）→ 授权校验 → 原子 transfer accept |
| peer mesh（对等协作） | offer/claim + 结构化 handoff 契约——我们团队的日常形态 |
| fan-out / fan-in | split N → 并行 claim → join（all / quorum / first-success） |
| blackboard | versioned shared state（CAS）+ wake 订阅 |
| debate / consensus | 同输入 N 个平行 WorkUnit（不同执行者）→ 聚合 WorkUnit（vote / judge） |
| pull pool（工作队列） | offer 广播到 pool → claim CAS 竞争 |
| evaluator-optimizer | execute ↔ verify-WorkUnit 迭代：verify fail → Transition 回 rework |

## 6. 为什么这样设计：从约束到结论

每条设计都由一条系统约束推出。**判断本范式是否适用于你，就看你是否共享这些约束**——不共享某条，就不需要对应的设计：

| # | 约束 | 推出的设计 | 若无此约束 |
|---|------|-----------|-----------|
| C1 | agent 长命、有身份与责任记录 | claim 挂身份、能力画像辅助传球判断、责任可追溯 | ephemeral worker + orchestrator 即可 |
| C2 | 人是团队成员，且**人也会掉球** | HumanGate WorkUnit + 双层 SLA + 统一掉球探测 | 人只做发起者，HITL 暂停点即可 |
| C3 | 工作跨 session / 进程 / 供应商故障，且**执行者可能被更换** | 责任状态外化 ledger；attempt 链；claim 跨 attempt 存续；fencing | 编排框架的 durable execution 即可 |
| C4 | 结果要审计、验证要独立 | append-only event sourcing + 不可变 Outcome 坐标 + verify 否定约束 | 普通日志即可 |
| C5 | 异构模型 / 异构框架混编 | 协调协议定义在事件与消息层，不绑任何 agent 框架 | 用单一框架的内建编排即可 |

## 7. 有什么用 & 适用判据

**具体收益**（每条回应 §2 的一类失效）：掉球可探测且**人与 agent 统一覆盖**；球权有 chain of custody 可复盘；中断可恢复且易主安全（attempt 链 + fencing）；并发安全（claim CAS 消灭"都以为对方在做"）；注意力隔离而不牺牲协作感知；治理约束（跨家族 review、决策边界）从"团队约定"变成可校验的协议。

**适用判据**——核心是两条**必需条件**：

- **责任会转移**：工作跨执行者生命周期——执行者可能中断、被替换、或把球传给别人？
- **掉球有代价**：需要发现"没人在做"并追溯"谁该做"，而不是任其超时重跑？

两条都"是"→ 你需要某种责任协调层。增强信号越多，完整形态越划算：人深度参与执行路径、多模型混编、审计要求高、任务以天计跨 session。

**不适用**的判据同样看责任而非时长或次数：无责任转移（单执行者从头到尾）、执行者不可替换也无需探活、掉球无代价（超时重跑即可）——此时编排框架的 durable execution 已足够。典型：单次 pipeline 任务（→ Anthropic patterns）、高频低延迟在线服务（协调开销不可摊）、大规模同质 swarm 的 map-reduce（→ orchestrator-worker）。注意反例：**一次性但高风险的跨 actor 流程**（如一次生产迁移，多方交接 + 人工审批）依然值得责任账本——判据是责任转移与审计需求，不是运行次数。

## 8. 局限（诚实清单）

**范式固有**：

1. **协议遵守不是硬约束。** LLM agent 靠提示词约定 + 运行时门禁兜底，仍会漏——我们自己就经历过执行者因供应商中断静默消失、最终靠人工发现的案例（正是 §2 的 F5）。账本让掉球**可见**，不让掉球**不可能**。
2. **人的 SLA 是社会约定。** 超时只能提醒与升级，不能强制人类行动，更不能绕过授权。
3. **协调开销真实存在。** 多 agent 本身就贵（参照 Anthropic 研究场景 ~15× token 的量级），协调层再加感知/落账成本。只适合价值密度高的工作（开发、研究、审计敏感协作）。

**我们实现的诚实披露**（四分，避免读者高估落地进度）：

- **已上线**：系统整体已运行数月；以下局部先行机制已上线（**各自落地时间不一，最近的在近一个月内**）——球权观测的事件溯源引擎（append-only log + 可重建投影 + 探测唤醒）、会话续接协调器、义务新鲜度门禁、结构化等待声明、能力画像辅助的传球判断；
- **尚未开始实现**：本文的核心——CoordinationLedger 与 WorkUnit 本体。目前只有设计与迁移计划（shadow 先行、逐路径 authority 晋升），代码改造未启动；
- **已验证**：事件溯源模式在球权域的生产可行性（rebuild = replay 无漂移）、§2 的失效模式与根因归纳、多轮跨模型对抗 review 的收敛过程本身；
- **未验证**：目标范式的整体运行效果、10+ agent 与多 operator 规模。

一句话：**本文是"从实测问题收敛出的目标范式"，不是"已上线系统的功能说明"。** 实证规模 3~7 agent、单 operator、单机；账本设计上只要求逻辑单一的协调历史（物理复制/分区是工程问题）。

## References

- Anthropic, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic, [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- Anthropic, [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- LangChain, [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) / [Workflows & agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) / [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- Microsoft, [AutoGen Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html)
- OpenAI, [Agents SDK](https://openai.github.io/openai-agents-python/) / [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- CrewAI, [Documentation](https://docs.crewai.com/)
- A2A Project, [Specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)；Linux Foundation [立项通报](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents) / [一周年通报](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
