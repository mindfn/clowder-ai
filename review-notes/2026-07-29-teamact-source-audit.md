---
title: "TeamAct v3 外发文档一手来源审计"
doc_kind: source-audit
feature_ids: []
topics: [teamact, multi-agent, source-audit, publication]
created: 2026-07-29
updated: 2026-07-29
source_thread: thread_mruayc4owlyzazbx
reviewed_sha: 28a066432b21641a88e9bd0a806a21afff156cef
reviewer: "砚砚 / gpt-5.6-sol"
---

# TeamAct v3 外发文档一手来源审计

审计对象：

- `docs/design/teamact-v2-paradigm.md`
- `docs/design/teamact-v2-tech-article.md`

审计口径：搜索结果只作为候选线索；结论追到原论文、正式规范或框架官方文档。负向能力判断只允许写成“所审官方文档未把 X 定义为 first-class 本体”，不据此推断框架“做不到 X”。官方厂商博客和厂商内部 benchmark 即使是一手自报，也必须披露商业利益、内部评测与对象边界。

## 发布门禁结论

**Verdict：REQUEST CHANGES。** 无 P1；4 个 P2 在修正前阻断外发。

### P2-1｜A2A 的 human-in-the-loop 边界写错

Article Appendix A 把 Google / Linux Foundation A2A 的“人的位置”写成“协议范围外”。A2A v1.0.0 明确把长时任务和 human-in-the-loop 列为原生目标，并定义 `TASK_STATE_INPUT_REQUIRED`、`TASK_STATE_AUTH_REQUIRED`；授权请求还允许 client 联系 human、agent 或 service 完成。

建议改为：

> `INPUT_REQUIRED` / `AUTH_REQUIRED` + Message 可承载 HITL 输入与授权；人类作为责任主体、人的 SLA / liveness、跨 actor 职权版本与责任连续性不是 A2A 的一等本体。

“内部责任连续性 / liveness 仍由参与方负责”可以保留，但必须明确这是 **TeamAct 所需本体不在 A2A 规范内**，不能写成 A2A 不支持人。

### P2-2｜“累计协作交付 250+ 功能”把编号规模误写成交付量

仓库当前确有 257 份 `docs/features/F*.md`，但仅 14 份在 frontmatter 中显式标为 `status: done`；大量旧 feature 没有统一完成态字段。`docs/architecture/collaboration-landscape.md` 的“250+ feature”也是内部概括，不是逐项交付审计。

因此现有证据只支持：

> 累计沉淀 250+ 份编号 feature 规格。

它不支持：

> 累计协作交付 250+ 功能。

文章若不需要解释内部 feature 口径，最稳妥的修法是删除该精确数字，改成“围绕一个长期软件产品持续协作与迭代”。

### P2-3｜联合意图 / SharedPlans / STEAM 的能力归因压成了一团

Paradigm §1.4 把 Cohen–Levesque、Grosz–Kraus、Tambe 合写为“含失败监测、团队重组、任务再分配”。一手来源支持的精确归因是：

- Cohen–Levesque：联合活动的共同心智性质，以及对某些失败和误解的鲁棒性；
- Grosz–Kraus：partial SharedPlans，以及 contracting-out actions；
- STEAM / Tambe：以联合意图和 partial hierarchy 为基础，**显式监测团队与成员表现，并在必要时重组团队**。

因此“失败监测 / 团队重组”应明确归给 STEAM，不能无差别归给整组理论。

### P2-4｜引用缺少版本锚与历史一手文献

Article 目前引用多为可变的官方文档入口，Paradigm OQ6 仍写“待 source-audit”。外发前至少需要：

- 把 A2A 的 GitHub `main` 链接替换为正式 v1.0.0 specification；
- CrewAI 固定到审计时实际跳转的 v1.15.8 Flows 页面；
- MCP 补官方 architecture / specification 链接，并注明本次审计版本或访问日；
- 给 §1.4 补 Smith 1980、Nii 1986、Tambe 1997、FIPA ACL、Cohen–Levesque 1991、Grosz–Kraus 1996、Chubby fencing / transaction commit 的一手锚点；
- OQ6 改为“已审计”，并链接本文件；“近期 LLM-MAS / 勿建多 agent 讨论”若没有具体 claim 与具体来源，不应作为一个模糊引用类别留下。

## Claim ledger

五问摘要顺序：**一手性 / 利益冲突 / 评审性质 / 时效 / 适用对象**。

| Claim | 原始来源 | 类型、年份 / 对象 | 五问摘要 | Verdict | Provenance |
|---|---|---|---|---|---|
| Contract Net 以协商完成分布式任务分配，节点可递归转包，award 可携带执行所需信息 | Smith, [The Contract Net Protocol](https://doi.org/10.1109/TC.1980.1675516)；[可读原文](https://cse-robotics.engr.tamu.edu/dshell/cs631/papers/smith80contract.pdf) | peer-reviewed paper, 1980 / CNP | 一手；低商业冲突；IEEE 论文；历史模型；对象匹配 | `use` | `[一手｜peer-reviewed paper｜1980｜Contract Net｜高]` |
| 原始 CNP 没有定义职权版本 fence、换手期在途副作用继承和持久归属审计 | Smith 1980 原协议 | primary paper, 1980 / CNP 规范边界 | 一手；低冲突；历史论文；以“未规定”而非“做不到”表述；对象匹配 | `use-with-caveat` | `[一手｜原协议缺席性审读｜1980｜CNP 规范边界｜中高]` |
| Blackboard 的控制可以位于知识源、黑板、独立控制模块或其组合，模型不固定单一控制位置 | Nii, [Blackboard Systems, Part Two](https://doi.org/10.1609/aimag.v7i3.550)；[Stanford Part One report](https://i.stanford.edu/pub/cstr/reports/cs/tr/86/1123/CS-TR-86-1123.pdf) | survey / technical report, 1986 / blackboard | 一手综述；低冲突；学术发表；历史模型；对象匹配 | `use` | `[一手｜学术综述｜1986｜Blackboard 控制模型｜高]` |
| Blackboard 本身不规定 TeamAct 式 authority / fencing / succession / ownership audit | Nii 1986 | primary survey, 1986 / 模型语义边界 | 一手；低冲突；缺席性判断；只写“未规定”；对象匹配 | `use-with-caveat` | `[一手｜模型边界审读｜1986｜Blackboard｜中高]` |
| 联合意图给出共同活动的心智性质，并解释对某些失败与误解的鲁棒性 | Cohen & Levesque, [Teamwork](https://www.sri.com/publication/teamwork/) | peer-reviewed paper, 1991 / joint intentions | 作者机构一手页；低冲突；Nous 论文；历史理论；对象匹配 | `use` | `[一手｜peer-reviewed paper｜1991｜联合意图｜高]` |
| partial SharedPlans 形式化部分计划并覆盖 contracting-out actions | Grosz & Kraus, [Collaborative plans for complex group action](https://doi.org/10.1016/0004-3702%2895%2900103-4) | peer-reviewed paper, 1996 / SharedPlans | 出版社一手；低冲突；AI Journal 论文；历史理论；对象匹配 | `use` | `[一手｜peer-reviewed paper｜1996｜SharedPlans｜高]` |
| STEAM 以联合意图与 partial hierarchy 为基础，监测团队和成员表现并按需重组 | Tambe, [Towards Flexible Teamwork](https://arxiv.org/abs/cs/9709101) | peer-reviewed paper, 1997 / STEAM | 作者论文；低冲突；JAIR 论文；历史实现；对象精确匹配 | `use` | `[一手｜peer-reviewed paper｜1997｜STEAM｜高]` |
| FIPA ACL 为 communicative acts 定义形式模型 / 语义效果 | FIPA, [Communicative Act Library Specification](https://www.fipa.org/specs/fipa00037/SC00037J.html) | formal standard, 2002 / ACL | 正式规范；低商业冲突；标准；历史但语义稳定；对象匹配 | `use` | `[一手｜formal standard｜2002｜FIPA ACL｜高]` |
| FIPA ACL 没有定义持久 authority ledger 和 fencing contract | FIPA00037 | formal standard, 2002 / 规范边界 | 正式规范；低冲突；缺席性审读；只写“规范未定义”；对象匹配 | `use-with-caveat` | `[一手｜规范边界审读｜2002｜FIPA ACL｜中高]` |
| fencing token / sequencer 可使资源服务器拒绝过期职权持有者的迟到请求 | Burrows, [The Chubby lock service](https://static.usenix.org/events/osdi06/tech/full_papers/burrows/burrows_html/) | peer-reviewed systems paper, 2006 / Chubby | 一手实现论文；厂商作者但机制可复核；OSDI；历史机制稳定；对象匹配 | `use` | `[一手｜peer-reviewed systems paper｜2006｜fencing / sequencer｜高]` |
| 2PC 是经典事务提交基线，故障时可阻塞 | Gray & Lamport, [Consensus on Transaction Commit](https://arxiv.org/abs/cs/0408036)；Gray, [Notes on Data Base Operating Systems](https://doi.org/10.1007/3-540-08755-9_9) | peer-reviewed papers, 1978/2006 / transaction commit | 一手；低冲突；系统论文；历史机制稳定；只用于事务基线 | `use` | `[一手｜peer-reviewed systems paper｜1978/2006｜transaction commit｜高]` |
| Anthropic 的五类常用 agent workflow 和“从简单、可组合模式开始” | Anthropic, [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | vendor engineering blog, 2024 / Anthropic 客户与实践 | 厂商一手经验；有产品利益；非同行评审；2024；只作模式分类与实践建议 | `use-with-caveat` | `[一手自报｜vendor engineering blog｜2024｜agent workflow taxonomy｜中]` |
| Anthropic 研究系统约 15× chat token；Opus 4 + Sonnet 4 多 agent 在其内部 research eval 比单 Opus 4 高 90.2% | Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | vendor internal eval, 2025 / 特定研究系统 | 厂商一手自报；强产品利益；非独立评测；2025 特定模型；不可外推所有 multi-agent | `use-with-caveat` | `[一手自报｜vendor internal eval｜2025｜Opus 4 + Sonnet 4 research system｜中]` |
| 多 agent 更适合上下文污染、可并行探索、强专门化等情形；应先从简单方案开始 | Anthropic, [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) | vendor blog, 2026 / Claude 生态实践 | 厂商一手经验；有产品利益；非同行评审；当前；只作设计建议 | `use-with-caveat` | `[一手自报｜vendor blog｜2026｜multi-agent 选型建议｜中]` |
| LangGraph checkpointer 持久化线程内 graph state，store 保存跨线程应用数据，用于恢复、HITL 与容错 | LangChain, [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | official docs, accessed 2026-07-29 / LangGraph | 官方一手；产品利益低到中；非论文；当前可变文档；正向能力匹配 | `use` | `[一手｜official docs｜accessed 2026-07-29｜LangGraph persistence｜高]` |
| OpenAI Agents SDK `RunState` 可序列化并在之后恢复，HITL 审批可跨 run 持久化 | OpenAI, [RunState](https://openai.github.io/openai-agents-python/ref/run_state/) / [HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/) | official docs, accessed 2026-07-29 / Agents SDK | 官方一手；产品利益中；非论文；当前可变文档；正向能力匹配 | `use` | `[一手｜official docs｜accessed 2026-07-29｜OpenAI Agents SDK｜高]` |
| AutoGen 可保存 / 恢复 agent 与 team state | Microsoft, [Managing State](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html) | official docs, accessed 2026-07-29 / AutoGen stable | 官方一手；产品利益中；非论文；stable 文档可变；正向能力匹配 | `use` | `[一手｜official docs｜accessed 2026-07-29｜AutoGen state｜高]` |
| CrewAI Flows `@persist` 默认使用 SQLite，可按 UUID resume 或 fork | CrewAI, [Flows v1.15.8](https://docs.crewai.com/v1.15.8/en/concepts/flows) | official docs, v1.15.8 / CrewAI Flows | 官方一手；产品利益中；非论文；已固定版本；正向能力匹配 | `use` | `[一手｜official docs｜v1.15.8｜CrewAI Flows｜高]` |
| Claude Agent SDK session 支持 resume / fork，并提供 hooks 与 permission gates | Anthropic, [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | official docs, accessed 2026-07-29 / Claude Agent SDK | 官方一手；产品利益中；非论文；当前可变文档；正向能力匹配 | `use` | `[一手｜official docs｜accessed 2026-07-29｜Claude Agent SDK｜高]` |
| A2A v1.0.0 是独立 agent 系统间的互操作协议，Task 支持异步、订阅 / push / cancel 和 HITL 中断态 | A2A Project, [v1.0.0 specification](https://a2a-protocol.org/latest/specification/) | formal specification, v1.0.0 / A2A | 正式一手规范；基金会治理；非论文；版本明确；对象匹配 | `use` | `[一手｜formal specification｜v1.0.0｜A2A Task / HITL｜高]` |
| A2A 由 Google 发起，2025 年转入 Linux Foundation 治理 | Linux Foundation, [launch announcement](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents) | official governance announcement, 2025 / A2A | 治理方一手；组织宣传动机；非学术；时间明确；只用于治理事实 | `use-with-caveat` | `[一手｜official governance announcement｜2025｜A2A governance｜中高]` |
| MCP 核心范围是 client-server 上下文交换及 tools / resources / prompts 等 primitives，不规定 AI 应用怎样管理所获上下文 | MCP, [Architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) / [Specification](https://modelcontextprotocol.io/specification/2026-07-28) | official docs/spec, 2026-07-28 / MCP | 正式一手；生态利益中；规范；版本明确；对象匹配 | `use` | `[一手｜official specification｜2026-07-28｜MCP scope｜高]` |
| 上述运行时都没有 first-class 的跨 actor 责任指派、职权版本、归属审计与人机 liveness 本体 | 各框架官方文档，见上 | cross-doc absence audit, accessed 2026-07-29 | 只审公开文档；厂商能力可能继续演进；不证明不可扩展；适用于“官方 first-class API / 本体” | `use-with-caveat` | `[一手集合｜官方文档缺席性审读｜accessed 2026-07-29｜documented first-class surface｜中]` |

## 被拒绝或降级的候选

| 候选 | Verdict | 原因 |
|---|---|---|
| 用“近期 LLM-MAS 文献”整体证明 TeamAct 是普适核心 | `reject` | 没有单一、清晰、对象匹配的 claim；容易把不同编排形态、benchmark 与组织模型混为一谈。本文已明确不主张普适核心，无需用宽泛文献背书。 |
| 用 Anthropic 90.2% 内部 eval 证明多 agent 普遍优于单 agent | `reject` | 仅适用于其 2025 Research 系统、特定模型与内部评测；文章也不需要这个强结论。 |
| 用 257 个 feature 文件证明已交付 250+ 功能 | `reject` | 编号文档数不是完成态或生产交付数；仓库没有统一完成态审计支持该转换。 |
| 用 Kleppmann 的二手解释替代 fencing / 2PC 原始来源 | `reject` | 可作导读，不应在有 Chubby / Gray 一手论文时承担核心机制证据。 |

## 外发前验证清单

- [x] 修正 A2A “人的位置”与 scope 边界。
- [x] 删除或精确降级“交付 250+ 功能”；避免把 feature 编号当完成量。
- [x] 把失败监测 / 团队重组明确归给 STEAM。
- [x] Anthropic `~15×` 紧邻标注“厂商内部研究系统自报，非通用 benchmark”。
- [x] 固定 A2A / CrewAI / MCP 版本；其余可变官方文档写访问日。
- [x] Paradigm OQ6 标记审计完成并链接本文件。
- [x] Article References 补历史一手来源与 MCP。
- [x] 最终引用链接检查通过。

[砚砚/gpt-5.6-sol🐾]
