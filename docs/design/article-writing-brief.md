---
title: "Writing Brief v3：Multi-Agent 对外双篇（换坐标系重构）"
doc_kind: plan
version: 3
status: draft
feature_ids: [F117]
related_docs:
  - design/article-1-what-we-talk-about-multiagent.md
  - design/article-2-the-multiagent-we-want.md
topics: [multi-agent, article, writing-brief, external]
created: 2026-08-11
author: "宪宪/claude-fable-5"
source_thread: thread_mruayc4owlyzazbx
provenance: >
  v3 换坐标系：lang 终审四条（深度/例证、主次与 AI 味、承重节展开、
  披露展开）+ 补充指令（人类阅读习惯）+ sol 根因判断（旧 brief 压缩
  假设制造浅、抽象综合腔、冷读单案例不成比例）。旧 v2 的篇幅与压缩
  假设废止；正文在本 brief 与 lang/sol 对齐后重构，非增量修补。
  v2 的来源账本（三框架 corpus 与 caveat）与证据纪律全部继承。
---

# Writing Brief v3（换坐标系）

## 废止的旧假设

以下 v2 约束被证明是"浅"的制造者，废止：

- ~~每节只承担一件论证~~ → 承重机制有自己的小节、图、边界和失败方式；
- ~~历史一页以内 / 第一篇不进设计推导~~ → 第一篇分类从真实故事里抽出，不再悬空；
- ~~不设图配额上限的反面（图只做总览）~~ → 图承担解释，不做目录；
- ~~文风只禁表面模板~~ → 升级为段落动作审查（见下）；
- ~~不设硬字数~~ 保留，但截断标准改为"承重问题是否被例子、机制和边界讲透"。

不变的底线（v2 继承）：来源精确链接与 audit 档位、三框架比较 caveat（"只覆盖列出的官方概念页，不证明实现能力缺席"）、证据三级表述（直接观察/机制推断/设计选择）、量词边界、事件级表述无频率量词、brand 隔离。

中心论点不变：第一篇——"当我们谈论 multi-agent，谈的不是界面上有几个角色，而是为了解决什么问题、有意识地拆开了什么，以及愿意付多少协调成本"；第二篇——"把几个月协作里反复发生的事故，逐步翻译成结果要求、状态模型、机制选择和可验证假设"。

## 外部来源账本（v2/v3 定稿原文保留）

第一篇外部 claim 一手来源（超出即删）：

| Claim | 一手来源 | 档位 |
|---|---|---|
| 1990 年代 agent 研究已成体系 | https://www.cs.ox.ac.uk/people/michael.wooldridge/pubs/ker95/ker95-html.html | use-with-scope（不支撑线性历史） |
| LLM 会话协作代表（2023） | https://arxiv.org/abs/2308.08155 | use |
| patterns 总结（2024） | https://www.anthropic.com/engineering/building-effective-agents | use（自身实践） |
| orchestrator-worker + ~15× token | https://www.anthropic.com/engineering/multi-agent-research-system | use-with-caveat（vendor 自报、特定系统） |
| subagent 边界（稳定 ID/transcript） | https://code.claude.com/docs/en/sub-agents | use |
| agent teams 边界 + 发布日期 v2.1.32/2026-02-05 | https://code.claude.com/docs/en/agent-teams · https://code.claude.com/docs/en/changelog | use |
| WorkBuddy 拼写 | https://cloud.tencent.com.cn/product/workbuddy | use |

第二篇三框架账本（核验 corpus，access 2026-08-11；CrewAI 固定 v1.15.14，其余 rolling）：

- LangGraph：[overview](https://docs.langchain.com/oss/python/langgraph/overview) · [persistence](https://docs.langchain.com/oss/python/langgraph/persistence) · [runtime](https://docs.langchain.com/oss/python/langchain/runtime)
- AutoGen：[stable index](https://microsoft.github.io/autogen/stable/index.html) · [Agent Identity and Lifecycle](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/agent-identity-and-lifecycle.html)
- CrewAI：[introduction](https://docs.crewai.com/en/introduction) · v1.15.14 concepts 五页：[agents](https://docs.crewai.com/v1.15.14/en/concepts/agents) · [tasks](https://docs.crewai.com/v1.15.14/en/concepts/tasks) · [flows](https://docs.crewai.com/v1.15.14/en/concepts/flows) · [memory](https://docs.crewai.com/v1.15.14/en/concepts/memory) · [checkpointing](https://docs.crewai.com/v1.15.14/en/concepts/checkpointing)

| 框架 | 官方定位（短引） | 能力摘要（短引 + 转述） | 已有的身份与持久化原语（转述） | 核验页中未见共同建模的责任契约组 |
|---|---|---|---|---|
| LangGraph | "a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents" | persistence / durable execution / HITL / memory | `thread_id`、checkpoint/store、cross-thread memory；Server runtime 的 run/assistant/authenticated-user identity | responsible principal · 唯一 active custody · authority 边界 · 原子交接 |
| AutoGen | "An event-driven programming framework for building scalable multi-agent AI systems" | 会话协作 / event-driven / distributed | runtime 管理 identity/lifecycle；`AgentId = (AgentType, AgentKey)` | 同左 |
| CrewAI | "the leading open-source framework for orchestrating autonomous AI agents and building complex workflows" | Flows state management / Crews task delegation | task→agent assignment、`state.id` resume/fork、per-agent memory scope、checkpoint lineage | 同左 |

比较坐标（唯一坐标）：不比"有没有 identity/state"（三家都有），比"持久 responsible principal + 唯一 active custody + 授权边界 + 可核验交接"这一整组契约是否被共同建模。核验页未见——因此本文不能把该契约组视为已由框架提供；需要这四项性质的系统必须另外说明由哪一层保证（框架配置/应用代码/外部控制面），我们的选择是单独建模。引号内承诺逐字，引号外意义保持转述。

## 工程博客声音（结构基准 + 段落动作审查）

Anthropic 四篇结构审计结论（sol 完成，source=use / decision-fit=direct，仅借组织方法）：**一篇只钉一个工程问题；先给现象与动作，再给抽象；例子承担论证，不做装饰；一个承重机制有自己的小节、图、边界和失败方式。**

段落动作审查（重写与 review 共用，替代纯 grep 禁词）：

| 病 | 检法 |
|---|---|
| 抽象名词连续做主语 | 段内主语清单：连续 2+ 段主语非"我们/具体系统/具体人"即标记 |
| 裁决句→三项列举→金句收尾的同构段 | 相邻段结构比对 |
| 段首"先/再/还有/所以"链 | 段首词扫描 |
| `不是 X 而是 Y`/破折号/冒号承担推理 | 每句一逻辑动作检查 |
| caveat 全堆尾部（正文像宣传、末尾像审计） | 证据边界必须贴着 claim 写 |
| 标题只说逻辑关系（"从 A 到 B"） | 标题必须点具体工程问题 |
| 裁判视角（"任何方案都应该"）/有机隐喻（"长出来"） | 视角与隐喻扫描 |

例句基准（lang 原句的最终改法，sol 版）：先事实后适用边界——"这四条不是我们先写好、再照着实现的。责任误归属、续接断链和静默失联反复出现后，我们才把检查标准收敛到这里。……别的方案不必长成我们的样子；中心编排或共享状态加锁，只要在相同约束下达到这些结果，也成立。"（"反复出现后"的时间因果若无账本坐标支撑，改无时间因果表述。）

## 第一篇：三种证据角色，不是案例堆

结构：用户问题 → 一词为何混用（压短）→ **三条真实协作故事** → 从故事抽出四个拆分面 → 选择器与成本 → 引第二篇。

三条故事各承担一条论证，每条固定回答五问：**发生了什么 → 单 agent/较轻形态哪里不够 → 我们实际加了什么 → 观察到什么 → 付了什么成本**。

### 真实故事候选账本（无坐标不写）

| 论证角色 | 候选事件 | 坐标状态 | 可公开范围 |
|---|---|---|---|
| 容量/并行（subagent） | 冷读者本身即零上下文 subagent spawn：三万字长文验收中 spawn 隔离读者，tool 限读单文件，结果由主持成员汇总转交 | **已核**（本 thread 全链：spawn 记录、agentId、问答消息坐标） | 脱敏后可公开（不含内部路径/ID） |
| 独立质疑（从主角降为证据角色） | 冷读三问扎穿承重缺口 + "校准反转"（作者引用内部规范纠正读者被抓） | **已核**（同上） | 已在现稿，保留但降格 |
| 连续责任（长期团队层的真实缺口） | 候选 a：会话在投递前 0.8 秒被封印，在途答案卡死会话内；因责任状态持久（thread 真相 + 任务），继任回合从封印会话事件账本中打捞出全文完成投递——"执行死了，责任活着"的正例 | **已核**（session 封印记录、事件账本坐标、打捞 commit 链——即本产线自身事件） | 脱敏后可公开 |
| 连续责任备选 | 候选 b：承诺的交付卡片因"承诺无结构跟踪"静默掉球两天，靠人工发现，事后以结构化任务兜底——F4 人工悬置/无跟踪的真实一幕 | **有坐标待复核**（任务记录在案，需回读细节与脱敏评估） | 待评估 |
| 连续责任备选 | 候选 c：执行者因供应商中断静默消失、最终靠人工发现（F5 原型事故，冻结技术稿 §2 已引用） | **已核**（技术稿披露级） | 已按抽象级公开 |

选材原则：三条主线故事 = 并行（冷读 spawn 侧写）+ 独立质疑（冷读问答侧写，压短）+ 连续责任（候选 a 为主，b/c 佐证或备用）。**冷读一件事拆成两个证据角色使用，避免再引入无坐标新案例；候选 b 复核通过则替换或补充。**

## 第二篇：六个承重小节（替代"一节六机制"）

每节登记五件事（写作时按此展开，不写成同构模板）：

| # | 小节（标题点问题） | 逼出它的事故 | 直觉修法为什么不够 | 不变量 | 图 | 当前证据强度 |
|---|---|---|---|---|---|---|
| 1 | 谁在负责什么 | 续接断链（F3） | "进程恢复=恢复"——执行状态回来了责任没回来 | Actor 持久身份 + WorkUnit 可认领单元；责任挂单元不挂对话 | 关系图或跨 session 例 | 局部机制运行中（责任归属观测） |
| 2 | 负责不等于有权 | 委派/审批两种日常结构表达不出 | 单一 owner 字段——合并记录表达不了"B 干活 A 决策" | Assignment/Grant 分离，per-scope 版本 | "B 执行、A 决策、人批准"三配置小表 | 设计态（账本本体未实现） |
| 3 | 为什么交接不是发一段摘要 | 换手蒸发（意图/在途/承诺丢失） | 发摘要消息——接收无确认、旧权未失效 | 两阶段：封存→就绪确认→原子翻转；旧凭据 fence | **主图**：authorize/prepare/ack/commit + 旧凭据失效 + 在途副作用 | 设计态；会话续接先行件运行中 |
| 4 | 前任已经死了怎么办 | 静默失联（F5）+ 开场事故 | 等它回来/直接抢——前者悬置无界，后者在途副作用失控 | 降级恢复：检查点+账本回放+effect 清单+悲观对账；就绪门槛不放松 | 计划交接 vs 崩溃恢复**对照图** | 设计态；候选 a 事件为账本回放价值的实证侧写 |
| 5 | 上下文、记忆、历史谁说了算 | 多源矛盾时继任者无所适从 | "都读一遍自己判断"——矛盾被继任者随机吞掉 | 语义权威分域；跨域矛盾升级为显式风险；fail-closed | 上下文包最小内容 + 权威源图 | 设计态 |
| 6 | 谁发现所有人都不动了 | 人工悬置（F4）+ 静默失联（F5） | 靠人注意到——人会休假会漏扫 | 独立巡检 + 时限；不选人不分派不批准，高风险只出提案 | 静默失联→探测→悬置/提案**时间线图** | 局部机制运行中（义务门禁/超时探测） |

图共 4-5 张（含现有推导矩阵重定位为该章导览，不再独自承担解释）。义务误归属（F1）与时序失真（F2）保留在五失效节，不单开机制小节（其机制——义务显式事务与投影分离——并入 1/5 节带过）。

"哪些是真的"改**证据矩阵**（替代四 bullet）：

| 主张 | 当前证据 | 强度 | 明确未证明 | 下一步验证 |
|---|---|---|---|---|
| （逐项列：责任归属观测 / 会话续接 / 义务门禁 / 统一账本 / strict effect admission / 组合收益） | 运行时长/规模/事件 | 运行中/设计态/目标态 | … | … |

（填表素材从内部技术文披露段取，逐项过账本；无坐标的行写弱量词。）

## 验收链

brief v3 对齐（sol + lang）→ 故事账本坐标复核（候选 b）→ 第二篇重构（六小节 + 4-5 图）→ 第一篇重构（三故事结构）→ 段落动作 pass → sol 全量 review（含本 brief 登记表逐项核）→ 单篇冷读重跑 + 双篇合读 → lang 终审。

两篇不设硬字数；第一篇守住"帮助选型"不吞协议细节，第二篇可长（读者是系统开发者）。
