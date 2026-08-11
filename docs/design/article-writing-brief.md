---
title: "Writing Brief：Multi-Agent 对外双篇"
doc_kind: plan
version: 1
status: draft
feature_ids: [F117]
related_docs:
  - design/article-1-what-we-talk-about-multiagent.md
  - design/teamact-v2-tech-article.md
  - design/teamact-v2-paradigm.md
topics: [multi-agent, article, writing-brief, external]
created: 2026-08-11
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
provenance: >
  lang 结构指令（000700/000705）+ Fable 思考（000707）+ sol 论证主线与
  source-audit（000710）三方收敛的写作契约。对齐后据此重写第一篇、
  新写第二篇；本 brief 变更需三方再对齐。
---

# Writing Brief：Multi-Agent 对外双篇

## 中心论点（一句，第一篇全文为它服务）

> 当我们谈论 Multi-Agent，我们谈的不是界面上有几个角色，而是**为了不同的问题，有意识地拆开执行上下文、协作关系、责任与授权——并为每一步拆分支付对应的协调成本**。

（四种形态是我们的**分析分层**，不是历史阶梯也不是成熟度排名：每层为不同的问题拆开不同的东西、付不同的成本。排序只表示"拆开的东西变多"，不表示"后者更好"，也不表示它们按此顺序诞生。）

## 第一篇《当我们谈论 Multi-Agent 的时候，我们在谈什么》

**读者**：用过或考虑用 multi-agent 产品、"不知道什么时候该用"的用户。
**结构**：问题 — 演变 — 案例 — 抽象 — 选择。每节只承担一件论证：

| 节 | 内容 | 承担的论证 |
|---|---|---|
| 1 开场 | 两个用户原话问题（"什么时候该用" / "和 agent teams、workbuddy 专家角色什么区别"）+ 声明结合我们系统（发布稿用公开品牌名）几个月实践回答 | 不论证，建立回答的合法性与视角 |
| 2 这个词为什么混乱 | 三锚点时间地图（传统 MAS / LLM 会话协作 / 工程化分支——带分支呈现，非单线），一页以内 | **同一个词跨时代、跨产品被反复复用，积累了不同的问题域**——名字撞车有结构性原因。不主张四形态按时间演进 |
| 3 贯穿案例 | 同一个真实任务（"提高这篇文章的质量"）的四种做法：换审稿提示词 / 派 subagents 并行读 / 独立 agent 互相挑战 / 稳定成员跨轮负责写审修验收；案例后一张表收四层 | 四种做法是**同一问题的对照路径**（非升级推荐）：每种拆开不同的东西、付不同的成本（中心论点的具象化） |
| 4 冷读实验（证据中心） | 团队自以为设计完整 → 零上下文读者连扎三个承重缺口 → 作者拿内部规范"校准"读者被当场抓获；按"观察/推断/选择"三级表述（见证据纪律） | **分工 ≠ 独立性**——直接观察撑事实，机制推断给解释，两者不混写 |
| 5 回答标题 | 两层收束：Multi-Agent 购买三类**收益**（执行容量与并行 / 独立的观察、质疑与验证 / 跨任务的身份与记忆连续性），而**责任与授权的分离是让这些收益可治理的边界**——与中心论点四项显式映射，不硬凑四收益；成本清单（token、协调、交接、相关失效）；五问选择器；引第二篇 | 收束中心论点 + 给读者可执行判断 |

## 证据纪律（冷读案例按三级表述，不得混写）

1. **直接观察**（可落账的事实）：只拿发布文本的零上下文读者发现了三个承重缺口和一次校准反转；此前的内部作者与审稿链没有发现它们。校准反转直接证明的是"作者把内部状态误当成已发布的正文"。
2. **机制推断**（本案例强支持，不作普适因果）：独立上下文使读者不携带作者群体的隐含前提——这个解释与全过程高度一致，但没有做过有/无隔离的受控对照，不写成 proof。
3. **设计选择**（据此我们做了什么）：fresh-context 审读 + 跨模型家族审查，目的是**降低相关性失效**——表述为"降低相关"，不承诺"必然产生异见"。角色提示可以制造分工、决定审查焦点，但分工不等于独立性。

> 对 lang 的显式说明：你原话"模型一致会导致思维趋向一致，这是我们验证过的"——冷读实验可落账的是第 1 级（隔离读者发现了内部链没发现的问题），"同模型趋同"属于促使我们定跨家族审查铁律的动机观察，还没有受控对照。写成观察级不是丢掉你的点，是让它在技术读者面前更硬——如实标注的 anecdote 比包装成 proof 可信。若有我们没想起的具体趋同实证，提出来即升档。

## 外部 claim → 一手来源（全清单，超出即删）

| Claim | 一手来源（精确链接，防二手页） | audit 档位 |
|---|---|---|
| 1990 年代 agent theory / architecture / cooperative AI 已成体系讨论 | https://www.cs.ox.ac.uk/people/michael.wooldridge/pubs/ker95/ker95-html.html | use-with-scope：**不支撑四层线性历史** |
| LLM 会话协作框架代表（2023） | https://arxiv.org/abs/2308.08155 | use |
| workflow/agent patterns 总结（2024） | https://www.anthropic.com/engineering/building-effective-agents | use（描述其自身实践） |
| orchestrator-worker 实践 + ~15× token | https://www.anthropic.com/engineering/multi-agent-research-system | use-with-caveat：vendor 自报、特定系统、非通用 benchmark |
| subagent 能力边界（稳定 ID / transcript 持久） | https://code.claude.com/docs/en/sub-agents | use |
| agent teams 边界（session-scoped / task list 持久）+ token 成本提示 | https://code.claude.com/docs/en/agent-teams | use |

- Anthropic 定位措辞：**把某类 LLM Multi-Agent 模式产品化并公开工程经验**——不是"提出了 Multi-Agent"。
- 第三方产品零点名评价；workbuddy 只存在于用户提问原话中。
- 我方实践按四级证据边界披露（与技术文同义）。
- **第二篇动笔前门禁**：~~账本未建~~ → **已建**（2026-08-11 核验，见下节）。

## 第二篇框架来源账本（2026-08-11 官方文档逐项核验）

| 框架 | 官方定位（逐字） | 官方一等能力（逐字短语） | 责任归属 / 身份持久 / accountability |
|---|---|---|---|
| LangGraph | "a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents"；"focused entirely on agent orchestration" | persistence（"persist through failures"）、durable execution、streaming、human-in-the-loop、comprehensive memory（short/long-term） | **未出现** |
| AutoGen | "An event-driven programming framework for building scalable multi-agent AI systems" | conversational single/multi-agent、event-driven、distributed agents、deterministic and dynamic agentic workflows | **未出现** |
| CrewAI | "the leading open-source framework for orchestrating autonomous AI agents and building complex workflows" | Flows（"State Management: Persist data across steps and executions" / event-driven / control flow）、Crews（role-playing agents / task delegation / autonomous collaboration） | **未出现** |

来源：LangGraph overview（docs.langchain.com/oss/python/langgraph/overview）· AutoGen stable index（microsoft.github.io/autogen/stable/）· CrewAI introduction（docs.crewai.com/en/introduction）。

**使用纪律**：第二篇引用三框架时只使用上表逐字短语；"未出现"只能表述为"其官方文档/模型未把 X 作为一等概念"，**不得**写成"它们做不到 X"（能力缺席 ≠ 官方声明缺席；我们核验的是后者）。三家均持续演进，发布前按当日文档复核。

## 三张图各证明什么（无装饰图；每张替掉正文至少一段解释）

1. **带分支的时间地图**（传统 MAS / LLM 会话协作 / 工程化分支——图上显式标注"概念复用，不是演进路线"）：证"一词多域"。
2. **四层图**（方法 / 执行 / 任务协作 / 组织连续性——分析分层，非成熟度阶梯）：证"层次不是竞品"。
3. **冷读泳道图**（作者内部稿 → 冻结发布文本 → 隔离冷读 → 三个承重问题 → 修订与 exact-HEAD 验收）：证"独立上下文的机制怎么运转"。

制作流程：SVG 初稿 → Sharp 实渲染检查 → sol 图审（沿用 TeamAct 图审规程）。

## 两篇边界

**第一篇**：怎么理解、怎么选。不进设计推导。
**第二篇**《我们期望中的 Multi-Agent 是怎样的》——读者是 multi-agent 系统开发者：

1. 从"执行恢复了，但工作已经没有人负责"的真实事故开场；
2. 现有框架（LangGraph / AutoGen / CrewAI 等）各自解决什么、留给应用层什么——公允表述：**执行编排、恢复与消息协作是它们的一等能力；跨执行与会话的责任状态是它们官方模型默认不负责的层**，不写"它们为什么不行"；
3. 五类实测失效 → 推导中立设计目标；
4. 依次：身份锚点 / WorkUnit / 责任与授权分离 / 上下文就绪 / 两阶段交接 / 记忆与上下文的区别 / 独立探活；
5. 异构模型与系统提示词只是运行时绑定——协议不能依赖"给它一个角色提示"维持安全性质；
6. 四级证据边界收尾（已验证 / 未实现 / 组合效果未知）；
7. 给读者：设计自己的 Multi-Agent 前要回答的问题清单。

**三个概念显式拆开**（防滑回"怎么写提示词"）：上下文 = 本次工作安全继续所需的证据；记忆 = 跨任务保留的知识与经验；交接 = 责任和职权发生迁移的事务。

## 文风基线

表层（禁模板）：
- 无四联加粗模板、无导游句（"让我们""值得注意的是"）；
- 结构化信息进图表，正文只做叙事与论证；图表后只解释读者应看到的**关系**，不复述图中文字；
- 加粗每节至多一个关键句；场景具体化（"一次生产迁移"而非"高风险不可重试场景"）；
- 引用只挂来源表内的精确链接。

深层（防 AI 味的生成习惯）：
- 抽象结论必须由前文的具体动作/结果推出，不悬空下定义；
- 除中心句外，少用"不是 X，而是 Y"与"真正/本质/关键"式裁决句；
- 控制破折号、括号、斜杠串联——一句只做一个逻辑动作；
- 相邻段落不得重复相同节奏（长短、句式、收尾方式错落）；
- "我们"只用于确有坐标的实践（可指认的事件/数据），不用来包装一般性知识。
