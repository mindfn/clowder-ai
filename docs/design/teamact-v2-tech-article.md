---
title: "从执行编排到责任协调：一个长时人机混合团队的多 Agent 协作范式"
doc_kind: publication-draft
version: 2
status: draft-pending-publish
topics: [multi-agent, teamact, coordination, tech-article, publication]
created: 2026-07-25
updated: 2026-08-03
---

<!-- Export boundary: frontmatter 之上（含本注释）发布时全部剥离；正文自足、
     无内部文档/线程/系统坐标引用。byline 与发布渠道由发布决策定。
     内部治理关系（本文属 TeamAct v2 文档族）见 multi-agent-collaboration-paradigm.md 导航页。 -->

# 从执行编排到责任协调：一个长时人机混合团队的多 Agent 协作范式

> **写给谁**：你已经用编排框架把 multi-agent 跑起来了，或者正打算这么做。
> 这篇文章讲我们在生产里跑了几个月之后才撞上的一类问题——它不在
> "任务怎么执行"这层，而在"团队怎么对工作负责"这层。如果你的 agent
> 是一次性的，你可能永远遇不到它们；如果你的 agent 是长期的、和人混编的，
> 它们几乎一定会找上门。

## 1. 我们撞上的问题：执行编排之外，还缺一层

先讲一次真实的失败。我们的一个 agent 在夜里停了下来——模型供应商的额度耗尽了。没有报错，没有失败事件，什么都没有：**报告失败这件事，也需要执行者还活着**。它负责的工作就停在原地，直到人翻进度时才发现"这事怎么没人在做了"。

这不是编排框架的 bug。我们执行层该有的都有：持久化状态、断点恢复、重试。问题在别处——系统里没有任何一个地方记录着"这件工作此刻归谁管、多久没推进算异常、异常了谁来发现"。**执行状态**（程序跑到哪）恢复得很好；**责任状态**（谁对什么负责）根本不存在。

这个失败发生在一个这样的系统里：

- **逻辑 Actor 是长命的**：运行它的 session、模型乃至供应商可以更换，但稳定的 Actor 锚点不变；记忆、能力画像和责任记录都通过这个锚点连续关联。异构模型混编（Claude / GPT / Gemini / Kimi 同队），围绕一个长期软件产品持续协作与迭代。
- **人是团队成员，不是调用者**：operator 拍板愿景、审批不可逆操作、也**承接工作**（配环境、做决策）——因此人工职责同样可能逾期或失去跟进。
- **工作跨 session**：一个功能以天计，横跨多次进程重启、上下文压缩，乃至模型供应商的额度与服务中断。
- **结果要审计**：谁在什么时候对什么负责，事后必须可追溯（跨模型家族 code review 是我们的铁律）。

**为什么这层一直缺？看看行业各自在忙什么就明白了。** 今天的 multi-agent 生态大致分三类工作，三类都很成熟，也都不覆盖上面那个问题：

- **编排与执行框架**（LangGraph、CrewAI、AutoGen、OpenAI / Claude Agent SDK）解决"**程序怎么可靠地跑**"：graph 怎么定义、状态怎么持久化、断了怎么恢复、人怎么插进来审批。LangGraph 的 checkpointing、OpenAI Agents SDK 的可序列化 RunState、CrewAI Flows 的持久化恢复，都是这一层的扎实成果。但它们持久化的是**执行状态**——图走到哪个节点、run 在等什么输入；
- **多 agent 模式实践**（Anthropic 的 orchestrator-worker 研究系统与 workflow patterns）解决"**任务怎么拆、什么时候值得多 agent**"：lead agent 并行派生 subagents、evaluator 迭代 optimizer，以及那条被反复验证的忠告——能单 agent 就别多 agent。这些模式里的 worker 是**任务期**的：编排者创建它、任务完了回收它，"某个 worker 对某件事长期负责"不在问题域里；
- **互操作与工具协议**（A2A、MCP）解决"**跨边界怎么通**"：不同厂商的 agent 怎么发现彼此、交换任务状态，agent 怎么调用工具。协议管边界上的握手，不管参与方内部谁认领了什么。

三类我们全在用，它们都对。但当 agent 从"任务的执行器"变成"团队的长期成员"——工作在成员间流动、人也承接工作、执行者会静默消失——就出现了一类三层都不覆盖的问题：**这个工作单元被谁认领？义务推进到哪了？认领者失联了谁来发现？人类成员的承诺怎么被跟踪？** 这就是本文要补的一层：**责任协调**（responsibility coordination）。

![图 A：执行编排层与责任协调层](./assets/teamact/figure-a-execution-vs-responsibility.svg)

*图 A：执行编排层解决"程序怎么继续跑"，责任协调层解决"每项职责是否始终有明确承担者"。*

先划清一个边界：这不是说去中心化比中心化更先进。任务图已知、编排者合法持有全部分派/回收权、worker 可随时替换时，orchestrator-workers 更简单；当长期 Actor 各自持有不可随意代行的责任或职权、工作边做边长出来、没有一个上下文能合法代表全局时，才需要 peer coordination。现实系统往往混合两者：一个 WorkUnit 内用中心化编排完成执行，WorkUnit 之间与长期 Actor 之间用责任协调维持连续性。后者的代价是真实的——要多付账本、交接、失效探测与对账循环的复杂度；§6–§8 给出选择条件与不适用域。

## 2. 当 agent 变成长期队友：五类新失效

开头那次静默失联不是孤例，只是五类失效里最戏剧性的一类。下面五个场景都是我们数月生产实践中反复出现的失效模式的抽象（具体案例数据属于内部工程记录，此处只保留结构），共同点是：**只在 agent 长命、跨会话、与人混编时出现**——一次性的 orchestrator + subagents 遇不到它们：

**F1 — 义务误归属。** 群体频道里进来一条不指名的消息。路由器按规则（比如"最近发言者优先"）把它派给 A——没问题。但 B 稍后因另一件事被唤醒时，系统把频道里的"未读消息"一股脑算进 B 的义务：A 名下的消息被注入 B 的执行上下文，B 的行动还被"你有未读消息"的门禁拦住。**根因：唤醒、义务、可读三个正交维度被压成了一个"频道可见性"。**

**F2 — 时序失真。** 两个 agent 并行工作，回复按到达时间交错渲染成一根时间线——读者看到精确到毫秒的混乱。**根因：审计需要到达序、理解需要因果树、追踪需要执行泳道，三种视图被迫共用一根时间线。**

**F3 — 续接断链。** agent 的会话中断后重启。执行框架能恢复"程序跑到哪了"，却回答不了：我**认领**的是哪项工作？这是第几次尝试？上次尝试对外承诺了什么？**执行状态恢复了，责任状态没有。**

**F4 — 人工责任悬置。** 一件事升级给人审批后长期未处理。agent 侧有超时与重试，人工环节却没有等价的 SLA、提醒与升级路径；系统无法区分“仍在等待合理处理”与“职责已失去跟进”。

**F5 — 执行静默失联。** 就是开头那个故事：agent 因供应商额度耗尽或 API 中断停止活动，没有失败事件——报告失败同样需要执行者继续运行。工作停在原地，直到人类注意到异常。

五类失效共同暴露的是：**责任协调没有被建模为一等系统状态**。F1/F2 首先缺责任归属与投影视图；F3/F4/F5 除了缺 Run lineage、人工 SLA、权威心跳等状态机制，还共同缺少一个持续检查并推进这些状态的运行时驱动。消息（说了什么）、执行（跑到哪了）、责任（谁该做什么）被耦合在同一根管道里，粒度各自都不对。

下文严格区分故障状态与合法迁移：**职责悬置**指义务仍有受监督的工作提供（offer）或升级路径，但超过 SLA 规定的推进窗口后，仍未被承接、处理或升级；**执行失联**指活跃的执行实例（Run）失去心跳与租约；**职责失去有效承接**指既没有有效的责任指派，也没有受监督的后续处理路径。与这些故障不同，**职责转移**是同一 WorkUnit 经授权更换承担者，**顺序移交**则是当前 WorkUnit 完成后创建后继单元。

## 3. TeamAct v2：责任协调范式的核心思想

我们把几个月的实践机制 + 多轮内部跨模型对抗 review 收敛成一套协调范式。本体压到最小——**两个实体、两个版本化关系、一本账**：

| 概念 | 一句话 |
|------|--------|
| **Actor** | 由稳定身份锚点指认的逻辑参与者——agent 是本命形态，**人是扩展形态**；Run/session/模型可更换，责任与审计仍通过锚点连续关联 |
| **WorkUnit** | 可移交的工作单元——包括"等一个人类决策"（审批同样是 WorkUnit） |
| **ResponsibilityAssignment** | 责任指派：**谁有推进义务**（每个 WorkUnit 恒有且仅有一份；版本化；中断时由谁承担恢复义务） |
| **AuthorityGrant** | 职权授予：**谁被允许决策/提交某类副作用**——按 scope（execute / decide / approve…）独立持有、独立版本、独立 fence。责任与职权分离后，"B 干活但 A 保留决策权"（委派）与"agent 执行、人持审批权"（审批门）都是同一结构的配置 |
| **Run** | 一次实际执行（一次 session）；中断 = 记终态，Assignment 不动，恢复 = 新 Run |
| **动作与账本** | offer / accept / transfer / delegate / suspend / resume / resolve——每个动作是 **append-only 协调账本**上的事务事件；责任与职权状态**只能**经账本事务改变，不能由"消息到了""会话启动了"推断 |

消息内容、代码产物、知识各有自己的权威存储，账本只记"谁在何时对什么负责"，通过稳定 ID 联接。会话视图、执行泳道、责任归属都是从账本+各存储投影出来的**读模型**——可重建，不权威。

**一个重要的诚实声明**：TeamAct **不主张**这是去中心化 multi-agent 的普适核心。它针对一个明确问题域——**同一未完成 WorkUnit 的责任或职权跨 Actor 迁移，且继任者的安全行动依赖前任产生的状态**。该域内必须同时解决两个问题：职权续接安全（无双主、无伪造、可追溯）与继任者上下文就绪。解法有两族：**解耦式**（lease 失效 → fence 旧权 → 从共享状态重新认领并自行重建——许多任务队列系统的形态）与**耦合式**（把两者绑成一个事务）。TeamAct 选择耦合式是**带判据的设计选择，不是逻辑必然**（判据见 §6/§7）；解耦式在崩溃主导、共享状态即是全部上下文的负载下更优。

九条判断不是九个同权重的段落，而是四组有先后关系的机制：先划清责任边界，再解决存活、职责转移与验证；协作扩展、上下文与恢复建立在这两层之上。

![图 C：九条设计判断的四组结构](./assets/teamact/figure-c-design-mechanisms.svg)

*图 C：九条判断的阅读地图。中央账本连接四组机制，但不取代各域自己的权威存储。*

### 3.1 先划清责任边界：①–②

**① 唤醒 ≠ 义务 ≠ 可读。** 唤醒回答“谁现在进入回合”，义务回答“谁必须处理、注入谁的工作上下文”，可读回答“谁主动回看时有访问权”。前两者按 recipient 收窄，可读性由独立 ACL 决定；隔离的是注意力和责任，不是协作信息。否则路由给 A 的任务，会在 B 稍后被别的事件唤醒时混进 B 的上下文（F1）。

**② 人是一等执行者。** “等人批准”同样是 WorkUnit：有认领前/后的 SLA、提醒和升级路径，也被职责悬置探测覆盖。系统因此能看见“人工审批处于未处理状态”，但授权边界不变——超时可以提醒、升级、搁置或取消，**不能替人批准**。

### 3.2 再处理存活、职责转移与验证：③–⑤

**③ 执行静默失联看生命迹象，不等失败终态。** Run 从 `started` 开始持续心跳；心跳断供、lease 过期且 SLA 超时，才说明执行者可能已经失联。没有这条正向生命线，"供应商断了，agent 连失败都没来得及报告"永远不可见。

**④ 职责转移 = 授权 → 就绪 → 原子生效，三步不并作一步。** 同一件工作从 A 转到 B，走两阶段事务。第一步集齐授权：责任易主由当前承担者签字，每个随迁的职权由它的持有者**分别**签字——执行者不能替人转走审批权；前任失联时由预先声明的恢复政策代行。第二步 prepare：冻结随迁职权、定版上下文快照、封存一份**在途副作用清单**——A 已经发出去、还没返回的外部调用。B 必须知道这份清单，否则会把同样的事再做一遍。B 确认过快照与清单，commit 才原子生效：职权迁移，旧凭据作废。**所以 B 拿到职权的那一刻，就是他准备好的那一刻**——不存在"接了工作但两眼一抹黑"的窗口。中途失败就 abort，一切原样恢复。

旧执行实例稍后复活了怎么办？防复活靠四段凭据：{工作单元 ID、职权 scope、职权版本、执行代数}——commit 之后旧凭据整体作废，旧 session 再醒过来，也写不进账、发不出新副作用。

那探测到失联、却一时没人能安全接手呢？治理层可以把工作**显式悬置**：失联者在这件工作上的全部行动性职权被冻结（别人的职权不受牵连——比如人持有的审批权），处置责任记在**治理角色**名下，只能经显式事务退出。工作停在可审计的安全状态，而不是无人负责地悬着。

![图：同一 WorkUnit 的两阶段责任与职权转移](./assets/teamact/figure-v3-2-handoff-transaction.svg)

*图：WorkUnit 没有被"重新创建"；prepare 冻结随迁职权并定版上下文与在途副作用，接收者确认后才原子 commit。责任与各 scope 的职权分别迁移，旧凭据失效。*

**⑤ 自检与独立验证是两种工作。** Quality gate 在当前 Assignment 内完成；独立验证则是新的 verify-WorkUnit，由非产出者承接，并绑定产出的**不可变坐标**（commit hash / 内容摘要）。产出一变，旧结论自动过期——防止"审的是旧版，盖章盖在新版上"。

### 3.3 协作如何扩展：⑥–⑧

**⑥ 委派按责任边界递归。** 临时 helper 没有独立责任，留在当前 Run 内；一旦被委派者有独立 SLA、验证边界或可被单独追责，就 split 成 child WorkUnit，进入完整的 offer / accept / Run 回合。**当系统选择为这些执行节点建立独立责任边界时**，orchestrator-worker、fan-out/fan-in、evaluator-optimizer 可以按这个递归边界映射进责任层——它们原生并不依赖 TeamAct，在各自框架内已工作良好（附录 B 同此立场）。

**⑦ push、pull 与 ACK 要分层看。**

| 模式 | 它实际做什么 | 主要代价 / 必需控制 |
|---|---|---|
| **push** | 定向投递 offer / envelope，主动排队或启动目标 agent，并可注入上下文 | 延迟低，但注意力耦合；需逐接收者 ACK、幂等、背压，且上下文水合必须与路由目标一致 |
| **pull** | 从共享黑板或 offered WorkUnit pool 发现待处理项，再用 CAS 竞争承接 | 生产者/消费者解耦，但有发现延迟；需公平性、积压与"长期无人承接"治理 |
| **hybrid** | durable shared state 保存事实，push 降低延迟，pull 找回漏触发的工作 | 两条路径共享同一责任指派、义务、职责连续性与失联探测语义 |

**扫描群聊猜谁该做什么不叫 pull。** pull 的前提是共享状态已经表达 WorkUnit、候选人、义务和版本。push 也不是只能发空唤醒：它可以携带 envelope、注入上下文、启动 invocation；只是这些动作不能替代 durable state 和 `enqueued → delivered → seen → processed` 的接收证据。

![动图：消息 ACK 与责任指派独立推进](./assets/teamact/animation-transport-vs-responsibility.gif)

*动图：消息 `processed` 只说明接收者已分类或回应；ResponsibilityAssignment 是否进入 `assigned(v)` 或 `resolved`，由独立账本事务决定。Run 在 assigned 期间可以独立启动、结束与替换。*

**⑧ 上下文走双通道。** 交接时用窄而结构化的契约传**事实、意图、边界、行动**；接手者再从共享历史与团队知识按需回读细节。只有推送会丢细节，只有拉取会丢意图——原始记录通常没有“为什么没有选另一个方案”。

![图 B：责任循环与上下文双通道](./assets/teamact/figure-b-context-channels.svg)

*图 B：规范责任循环只有 Bind → Act → Handoff/Resolve；push 传窄而有意图的快照，pull 从账本、原始历史和团队知识回读细节，两者共同满足 ContextReady 门槛。*

### 3.4 失忆之后怎样恢复：⑨

**⑨ 失忆是常态，记忆分四层。** 工作记忆随 Run 生灭；团队知识跨 actor 共享；私有记忆承载个体偏好与关系；责任记忆由协调账本保存。稳定 Actor 锚点负责把四层中属于同一逻辑参与者的记录跨 Run/session 关联起来，但它不等于一套不可变的身份画像。新会话或新 holder 的恢复不是读一份“大摘要”，而是从**交接契约/最后检查点 + 账本回放 + 知识检索/历史回读**多源重建：前者给意图与未完成进度，账本给责任真相，知识与历史给细节。

![图 D：四层记忆与恢复路径](./assets/teamact/figure-d-memory-recovery.svg)

*图 D：任何决定“谁负责什么、做到哪”的信息，都不能只存在于易失的工作记忆。*

### 3.5 账本不会自己推进：跨 agent、跨 session 的义务循环

把责任状态持久化只是第一步。我们的运行时仍是事件驱动的：消息到达才唤醒参与者，回合结束后执行实例就休眠；如果负责者静默消失，让它自己报告失败本身就是悖论。因此系统还需要一个常驻 **reconciler**，持续对账账本上的 Assignment/SLA/处置时限与实际心跳、进度及处置记录，在时限内触发催办、唤醒、升级或授权提案。

这个 reconciler 是**确定性的系统服务，不是又一个 LLM agent**——对账靠比对时间戳、版本号与落账记录，不需要语义理解（LLM 只出现在它的下游：被它唤醒的执行者、签授权提案的治理者）。它没有替参与者决策、审批或选人的权力；它只负责发现差异并推动既有 policy 被执行。它也不同于单 agent 的 goal loop：goal loop 让**单个 Run 内**的 agent 围绕目标持续行动，reconciler 保证义务在 **Run、session 与 Actor 之间**仍有人跟进。执行者自设的定时唤醒或声明式等待仍有用，但只是局部等待机制，不能替代协作层的义务连续性。

> 完整的形式化规范（实体定义、闭合事件集、运行时语义、设计决议与被否决的替代方案）超出本文篇幅；此处保留核心思想与设计判断。

## 4. 与 Anthropic 多 agent 模式的关系：组合，不是竞争

§1 把"多 agent 模式实践"列为三类行业工作之一；这里说清 TeamAct 与其中最系统的一支——Anthropic 三份实践——具体怎么组合。参照：[Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)（五种 workflow patterns；"简单可组合模式优于框架"）、[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（orchestrator-worker：lead agent 并行派生 subagents；**厂商内部 research eval 自报**相对单 agent +90.2%，token 用量约为单次 chat 的 15×——两个数字都限定在其 2025 年特定模型与研究系统，不是通用 benchmark）、[When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)（三个使用信号；"先从单 agent 开始"）。

| 维度 | Anthropic patterns / research system | TeamAct v2 |
|------|--------------------------------------|-----------|
| 回答的问题 | 一次任务内如何编排执行 | 团队如何对工作负责 |
| agent 生命周期 | 任务期（orchestrator 派生、任务毕回收） | 逻辑上 persistent（稳定 Actor 锚点、记忆与责任跨任务累积；Run/session 可生灭） |
| 拓扑 | 层级：orchestrator 拥有并管理 worker | 对等 + 治理：peer 协作，operator 是治理者与一等执行者 |
| 协调状态 | orchestrator context 为主；research system 已辅以外部 memory、filesystem artifacts 与 checkpoint | 外化的 coordination ledger |
| 人的角色 | 发起者 / 结果消费者 | 团队成员（审批 WorkUnit + approve 职权保留在人，双层 SLA） |
| 失败模型 | retry / respawn / checkpoint 恢复 | Run 链 + Assignment 存续 + fencing + 统一职责连续性探测 + 显式悬置处置 |

**两层按 §3-⑥ 的递归边界组合**：orchestrator-worker、evaluator-optimizer 等 patterns 可以完整活在一个 WorkUnit 的执行内部（临时 helper），也可以升格为 child WorkUnits（独立责任）。Anthropic 的 when-not-to 判据我们完全采纳：单任务能单 agent 做就不要多 agent。他们记录的失败模式与我们机制的对应也能交叉验证：telephone game ↔ 结构化 handoff 契约 + 可读性不隔离（接手者读原始上下文，不依赖转述）；early victory ↔ 独立验证 WorkUnit + 否定约束 + 不可变坐标绑定；context pollution ↔ 唤醒/义务 per-recipient 隔离。

## 5. 与行业框架与协议的对照

§1 的三分类在这里落成精确分层。不要按产品名比较，先按它们回答的问题分层：

| 层 | 典型框架 / 协议 | 主要回答 | 与 TeamAct 的关系 |
|---|---|---|---|
| **执行运行时** | LangGraph、CrewAI、AutoGen、OpenAI / Claude Agent SDK | 程序怎样编排、暂停、恢复与继续执行 | TeamAct 可运行在其上；不重复实现 durable execution |
| **跨厂商互操作** | Google / Linux Foundation A2A | 不同组织与厂商的 agent 怎样发现能力、交换 Task 状态 | WorkUnit 可桥接为边界 Task；内部责任连续性 / liveness 仍由参与方负责 |
| **工具协议** | MCP | agent 怎样调用工具与资源 | 与责任协调正交 |
| **责任协调** | TeamAct | 谁认领、谁有义务、谁失联、如何安全转移职责与独立验证 | 本文的问题域 |

**LangGraph 是最接近的邻居，分界线在本体而非能力。** 它已很好地回答"程序可靠地继续跑"；应用也完全可以在 graph state 里自建责任指派与归属跟踪。TeamAct 提供的是一套可复用的责任本体与约束：基于稳定 Actor 锚点的承接、责任/职权分离、人机统一 liveness、两阶段授权转移、产出绑定的独立验证。HITL 暂停点与审批 WorkUnit 有能力重叠，但后者把人建模为带 SLA、可被职责悬置探测覆盖的执行者。

本文的 "A2A"（agent-to-agent 通名）与 Google 发起、现由 Linux Foundation 治理的 Agent2Agent protocol 不是同一概念。后者负责边界互操作；TeamAct 负责参与方内部责任。详细的逐框架比较移至附录 A，常见协作模式到责任语义的映射见附录 B。

## 6. 为什么这样设计：约束、设计选择与可反驳性

每条设计对应一条系统约束。**判断本范式是否适用于你，先看你是否共享这些约束**——不共享某条，就不需要对应的设计：

| # | 约束 | 对应的设计 | 若无此约束 |
|---|------|-----------|-----------|
| C1 | 逻辑 Actor 跨 Run/session 存续，有稳定身份锚点与责任记录 | 责任指派挂 Actor 锚点、能力画像辅助分派与移交、责任可追溯 | ephemeral worker + orchestrator 即可 |
| C2 | 人是团队成员，且**人工职责也会逾期或失去跟进** | 审批 WorkUnit + 双层 SLA + 统一职责悬置探测 | 人只做发起者，HITL 暂停点即可 |
| C3 | 工作跨 session / 进程 / 供应商故障，且**执行者可能被更换** | 责任状态外化 ledger；Run 链；Assignment 跨 Run 存续；四段凭据 fencing | 编排框架的 durable execution 即可 |
| C4 | 结果要审计、验证要独立 | append-only event sourcing + 产出不可变坐标 + 验证否定约束 | 普通日志即可 |
| C5 | 异构模型 / 异构框架混编 | 协调协议定义在事件与消息层，不绑任何 agent 框架 | 用单一框架的内建编排即可 |

还有一条**约束之外的诚实边界：即使五条约束全部成立，耦合式交接也不是唯一解**。解耦式 fence-and-reclaim（§3 诚实声明）在同样约束下完全合法。我们选耦合式的具体判据：**计划性易主为主**（前任在场，可合作封存在途副作用、移交未外化意图）、**审计要求责任连续无空窗**、**继任者含人类**（人需要推送式策展上下文与显式接受，难以"回放重建"）。反向负载（崩溃主导、共享状态即是全部上下文、承接竞争便宜）应选解耦式。这个选择判据本身**可以被推翻**，而且怎么算推翻有精确规则。前提三个"同"：同一工作负载、同一环境假设、同一结果门槛（副作用不重复、责任可归属、接手者能安全继续、失效有界处置——探测与处置的时限阈值也要一样）。在判据说"该选耦合式"的负载上，如果解耦方案在所有代价维度都不更差、且至少一个维度严格更好（Pareto 支配），我们的选择规则就被证伪了。有好有坏的混合结果不算数——既不推翻本文，也不给本文背书。裁判用的标准是结果性质，不是本文自己的机制。

## 7. 有什么用 & 适用判据

**具体收益**（每条回应 §2 的一类失效）：职责悬置与执行失联可探测且**人与 agent 统一覆盖**；职责归属链全程可复盘；中断可恢复且职责转移安全（Run 链 + 两阶段事务 + fencing）；并发安全（账本 CAS 消灭"都以为对方在做"）；注意力隔离而不牺牲协作感知；治理约束（跨家族 review、决策边界）从"团队约定"变成可校验的协议。

**适用判据**——核心是两条**必需条件**：

- **职责会转移**：工作跨执行者生命周期——执行者可能中断、被替换、或把职责移交给其他执行者？
- **职责失去有效承接有代价**：需要发现"没人在做"并追溯"谁该做"，而不是任其超时重跑？

两条都"是"→ 你需要某种责任协调层。增强信号越多，完整形态越划算：人深度参与执行路径、多模型混编、审计要求高、任务以天计跨 session。

| 职责转移 | 职责失去有效承接的代价 | 建议 |
|---|---|---|
| 无：一个执行者从头做到尾 | 任意 | 不引入责任层；使用单 agent / durable execution |
| 有，但失败可直接整单重跑 | 低 | 只保留轻量 owner + status，不必上完整账本 |
| 有，且需要知道“谁该做、做到哪” | 中高 | 至少引入 WorkUnit + offer/accept 责任指派与超时探测 |
| 有，执行者可替换、人参与审批、外部副作用不可盲重试 | 高 | 使用完整 TeamAct：Run lineage、两阶段转移、fencing、审批 WorkUnit、产出绑定验证、悬置处置 |

**不适用**的判据同样看责任而非时长或次数：无职责转移（单执行者从头到尾）、执行者不可替换也无需探活、职责失去有效承接也无业务代价（超时重跑即可）——此时编排框架的 durable execution 已足够。典型：单次 pipeline 任务（→ Anthropic patterns）、高频低延迟在线服务（协调开销不可摊）、大规模同质 swarm 的 map-reduce（→ orchestrator-worker）。注意反例：**一次性但高风险的跨 actor 流程**（如一次生产迁移，多方交接 + 人工审批）依然值得责任账本——判据是职责转移与审计需求，不是运行次数。

## 8. 局限（诚实清单）

**范式固有**：

1. **协议遵守不是硬约束。** LLM agent 靠提示词约定 + 运行时门禁兜底，仍会漏——我们自己就经历过执行者因供应商中断静默消失、最终靠人工发现的案例（正是 §2 的 F5）。账本让职责无人承接或执行失联**可见**，却不能使这些失效**不可能发生**。
2. **人的 SLA 是社会约定。** 超时只能提醒与升级，不能强制人类行动，更不能绕过授权。
3. **协调开销真实存在。** 多 agent 本身就贵（参照 Anthropic 研究场景 ~15× token 的量级），协调层再加感知/落账成本。只适合价值密度高的工作（开发、研究、审计敏感协作）。
4. **范式收敛自我们自身的实践，存在自指风险。** §2 的失效目录采自一个已按交接方式运转的团队——它证明该形态下协调破损真实且有代价，**不证明**交接是普适核心。对冲方式：问题域显式声明（§3 诚实声明）、承认解耦式替代并给出选择判据（§6）、反驳标准使用模型中立的结果性质而非本文自己的机制（§6 末段）。
5. **恢复治理有信任根。** 失联恢复与悬置的授权者集合是协议的信任根：合法授权者恶意停工无法由协议消除，只能由 quorum / 职责分离缓解；协议保证的是滥用全程落账、可见可追溯。

**我们实现的诚实披露**（四分，避免读者高估落地进度）：

- **已上线**：系统整体已运行数月；以下局部先行机制已上线（**各自落地时间不一，最近的在近一个月内**）——责任归属观测的事件溯源引擎（append-only log + 可重建投影 + 探测唤醒）、会话续接协调器、义务新鲜度门禁、结构化等待声明、能力画像辅助的工作分派判断；
- **尚未开始实现**：本文的核心——CoordinationLedger 与 WorkUnit 本体。目前只有设计与迁移计划（shadow 先行、逐路径 authority 晋升），代码改造未启动；
- **已验证**：事件溯源模式在责任归属域的生产可行性（rebuild = replay 无漂移）、§2 的失效模式与根因归纳、多轮跨模型对抗 review 的收敛过程本身；
- **未验证**：目标范式的整体运行效果、10+ agent 与多 operator 规模。

一句话：**本文是"从实测问题收敛出的目标范式"，不是"已上线系统的功能说明"。** 实证规模 3~7 agent、单 operator、单机；账本设计上只要求逻辑单一的协调历史（物理复制/分区是工程问题）。

## 9. 写在最后：三条 takeaway

如果只带走三句话：

1. **先判断你在不在这个问题域。** 两条判据（§7）：职责会不会转移？职责失去承接有没有代价？两条都"否"，你不需要责任协调层——单 agent 或 durable execution 就够，这也是"能单 agent 就别多 agent"这条行业忠告在责任层的对应物。
2. **在，也别一步上全套。** 最小起步是给每个工作单元记两样东西：明确的 owner，和带超时的 status（§7 的分级表）。完整的账本、两阶段转移、悬置处置，等失效真的疼了再加。
3. **人是最容易被漏掉的执行者。** 我们最深的教训不是 agent 会失联，而是"升级给人之后"成了责任盲区——人工环节没有 SLA、没有探测、没有升级路径。把人当一等执行者建模（有承诺、会逾期、可提醒不可强制），很多"石沉大海"就变成了可见的状态。

执行编排回答"程序怎么继续跑"，行业已经把它解决得很好；我们花了几个月才看清的是另一个问题——**"团队怎么对工作负责"需要自己的状态、自己的事务、自己的巡检循环**。系统能跑，和团队能负责，中间隔着的正是这一层。

## Appendix A：逐框架能力边界

> 方法注记：下表按 2026-07-29 审计时的官方文档口径（版本与链接见文末）。这些 runtime 与 TeamAct 在 durable execution 与 HITL 上有能力重叠；差异集中在是否把跨 actor 的责任指派/职权授予、归属审计和人机 liveness 作为 first-class 本体。**表格只主张"所审官方文档是否提供 first-class 本体"，不主张能力不可自建，也不保证后续版本不新增。**

| 框架 / 协议 | 编排单位 | 持久化的对象 | 人的位置 | 跨 actor 责任本体（first-class?） |
|---|---|---|---|---|
| LangGraph | graph 节点（静态定义 + `Send`/`Command` 动态派生） | graph state + checkpointer（durable、跨 session、可恢复） | interrupt / HITL 节点 | 非 first-class——责任指派 / 归属审计 / 授权需应用自行建模 |
| CrewAI | role-based crew / Flows | Flows 持久化与恢复 | 输入与审批点 | 非 first-class |
| AutoGen / AG2 | AgentChat 会话层 + Core actor runtime | actor 运行时状态 | 会话参与者 | 非 first-class——认领/义务语义需应用自行建模 |
| OpenAI Agents SDK | handoff + sessions | 可序列化 RunState（支持跨 run 的 HITL 恢复） | tool 级 HITL 审批 | 非 first-class |
| Claude Agent SDK | subagent spawn + sessions | session resume / fork、外部持久化、hooks 与 permissions | operator + permission gates | 非 first-class |
| Google / Linux Foundation A2A v1.0 | 跨厂商 Task | 协议态任务状态（异步、poll/subscribe/push、取消） | `INPUT_REQUIRED` / `AUTH_REQUIRED` + Message 可承载 HITL 输入与授权 | 人类作为责任主体、人的 SLA / liveness、跨 actor 职权版本与责任连续性非 first-class，留给参与方 |
| **TeamAct v2** | **WorkUnit** | **责任状态：coordination ledger（+ 各域权威 store）** | **一等执行者 + 治理者** | **first-class** |

## Appendix B：常见协作模式怎样落到责任语义

这张表用于从熟悉的框架术语回到责任语义；它不是新的模式分类法，也不主张这些模式"属于"TeamAct——多数模式在其原生框架内已工作良好，此处只回答"若你需要责任层，它们如何表达"。

| 行业协作模式 | TeamAct v2 表达 |
|---|---|
| supervisor / orchestrator-worker | 父 WorkUnit 的承担者 split child WorkUnits → 定向 offer → join(all) |
| handoff / router | 顺序移交创建后继 WorkUnit；同一 WorkUnit 更换承担者时走两阶段授权转移事务（授权集 → 冻结+快照 → 确认 → 原子提交） |
| peer mesh（对等协作） | offer / accept + 结构化交接契约 |
| fan-out / fan-in | split N → 并行 accept → join（all / quorum / first-success） |
| blackboard | versioned shared state（CAS）+ wake 订阅 |
| debate / consensus | 同输入 N 个平行 WorkUnit（不同执行者）→ 聚合 WorkUnit（vote / judge） |
| pull pool（工作队列） | offer 广播到 pool → accept CAS 竞争 |
| evaluator-optimizer | 执行 ↔ verify-WorkUnit 迭代；验证不通过 → 账本事务回 rework |

## References

- Anthropic, [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)（2024；厂商实践文章）
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic, [When to use multi-agent systems (and when not to)](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- Anthropic, [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- LangChain, [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) / [Workflows & agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) / [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)（访问于 2026-07-29）
- Microsoft, [AutoGen Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html) / [Managing State](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html)（访问于 2026-07-29）
- OpenAI, [Agents SDK](https://openai.github.io/openai-agents-python/) / [RunState](https://openai.github.io/openai-agents-python/ref/run_state/) / [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)（访问于 2026-07-29）
- CrewAI, [Flows v1.15.8](https://docs.crewai.com/v1.15.8/en/concepts/flows)
- A2A Project, [v1.0.0 Specification](https://a2a-protocol.org/v1.0.0/specification/)；Linux Foundation [立项通报](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- Model Context Protocol, [Architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) / [Specification](https://modelcontextprotocol.io/specification/2026-07-28)
- Smith, [The Contract Net Protocol](https://doi.org/10.1109/TC.1980.1675516)（1980）
- Nii, [Blackboard Systems, Part Two](https://doi.org/10.1609/aimag.v7i3.550)（1986）
- Cohen & Levesque, [Teamwork](https://www.sri.com/publication/teamwork/)（1991）
- Grosz & Kraus, [Collaborative plans for complex group action](https://doi.org/10.1016/0004-3702%2895%2900103-4)（1996）
- Tambe, [Towards Flexible Teamwork](https://arxiv.org/abs/cs/9709101)（1997）
- FIPA, [Communicative Act Library Specification](https://www.fipa.org/specs/fipa00037/SC00037J.html)（2002）
- Gray & Lamport, [Consensus on Transaction Commit](https://arxiv.org/abs/cs/0408036)；Burrows, [The Chubby lock service](https://static.usenix.org/events/osdi06/tech/full_papers/burrows/burrows_html/)
