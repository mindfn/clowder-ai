---
feature: F257
title: F257 Harness Ledger — 终态契约 v1（operator 口述定稿，唯一真相源）
status: authoritative
supersedes:
  - feature-specs/2026-08-04-f257-objective-eval-redesign.md §0 / §2.4 中"冻结 raw corpus"的表述
  - F257-harness-ledger.md KD-21 中"触发时冻结 raw corpus"的表述
source: co-creator 2026-08-20 / 08-21 / 08-26 / 09-02 04:07 / 04:50 / 06:09 / 06:32 / 06:42（thread_mrdip0u5aw4ysi97）
recorded_by: 宪宪(cat-8zfu14fb) 2026-09-02
---

> ⛔ **代码冻结（operator 2026-09-02 04:5x）**：在 `complete-design-v1.md` 被 operator 逐节确认之前，**F257 任何猫不得提交/合入代码改动**（含 sol 进行中的 A/B/C）。已开的 worktree 保留，不 push 不开 PR。解冻以 operator 在本 thread 的明确一句为准，并同步改本行。
>
> 这份文件存在的原因：同一个预期 operator 口头纠正了 ≥4 次，每次实现都偏。**从本文件起，F257 任何实现/review/验收都以下面 TC-# 编号为准；PR 描述必须逐条映射 TC-#；对话里的"理解了"不作数。**

## 1. 终态（operator 原话整理，不加工）

tracing 是**一个线性累积的池子**，一直在采，不分组。结构化反例 / MCP 举报只是池子里的**高置信度标记**，作用是评估时不用从海量数据里筛。

系统不断 check：周期内累计 ≥ 200，或周期内反例 ≥ 阈值，或距上次评估满 7 天——任一满足就**冻结一个时间窗**（起点 = 上次评估周期的结束时间，终点 = 现在），**不复制任何 tracing 数据**。然后拉起**固定的评估线程**，告诉它：时间窗、评估范围、指标；它去池子里拿这个时间窗的数据（反例优先）、按指标给出结论、**调工具回写 eval 状态**。如果它没回写，系统能观察到，用一条系统 message 再触发一次。

回写后**自动进入 governance**：再次触发同一评估线程，决定 保持 / 回退 / 演进到下一版。回退或演进 → 给 operator 一张审批卡；点完（或跳过）都进入下一周期。跳过时周期起点不动（可能只是数据不够）；否则新周期起点 = 这次周期的终点。v1、v2、v3 各自独立评估，**没有跨版本对比**——governance 看的就是当前版本这个时间窗的指标结论。

就这一个环，循环。

## 2. 契约条款（TC-#，实现与 review 的唯一编号锚点）

| # | 条款 | 反例（出现即违约） |
|---|---|---|
| TC-1 | tracing 是 owner 级**单一线性池**；采集不做判定、不分组 | 引入第二个池 / 预分类后才入池 |
| TC-2 | 结构化反例 / MCP 举报 = 池内**高置信度标记**，仅用于评估时优先阅读 | 把标记当证据准入门；无标记就不评 |
| TC-3 | 触发三路 anyOf：周期内累计 ≥ 200 / 周期内去重反例 ≥ 阈值 / 距上次评估 ≥ 7 天；**由系统触发** | 需要人点按钮；任一路被其它步骤前置阻塞 |
| TC-4 | 冻结 = **只冻结时间窗**（start=上次周期终点，end=now）+ 目标/指标/版本引用；**不复制 tracing 数据** | snapshot 内嵌 episode 正文（现状 6 MB/个） |
| TC-5 | 评估在**每个 Objective 专属的系统 thread** 中由其**默认成员**执行（不单独指定评估猫；不合理在 thread 侧改）；跨 Objective 可并发，同 Objective 严格串行；输入 = **评估目标（Objective statement）** + 时间窗 + 范围 + 指标；从池子按窗读取，反例优先 | 全域共用一个评估 thread；评估依赖预先分类结果；评估在主请求路径上跑；assignment 只列指标不声明目标 |
| TC-6 | 评估必须**调工具回写 eval 状态**（每指标结论 + 整体结论） | 只在对话里说结论 |
| TC-7 | 未回写 → 系统可观察 → **一条系统 message 重触发一次**（有界） | 无限续租/重试；同一 job 滚动上千代 |
| TC-8 | 回写后**自动进入 governance**：再次触发同一评估 thread → 保持 / 回退 / 演进 | 停在 eval；需要人手动进 governance |
| TC-9 | 仅"回退 / 演进"发**提案卡**（evolve 时含评估猫直接写的 v2 草案）；三选一 **approve / skip / reject**：approve、skip 进入下一周期；reject 附理由对同窗重评估并**必须产生新提案卡**——终态只有 approve/skip | 保持也发卡；reject 无理由；reject 自动进下一周期；reject 后不再出卡 |
| TC-10 | 周期起点**始终刷新** = 本周期终点；skip / insufficient_evidence 不停住起点，而是让**下次评估逆序回看并纳入连续 skip 周期的时间窗**（连续 k 次 skip → 合并 k+1 个窗口） | skip 后起点不动导致累计触发立即重触发；下次评估只看本周期忽略前序 skip 数据 |
| TC-11 | v1/v2/v3 的**评估**各自只看本版本时间窗，不做跨版本对比；**governance** 以本周期结论判断 keep/rollback/evolve，历史周期结论在同一 Objective thread 中天然可见、可参考 | 把"与上一版比较"当作当前版本的闭环条件 |
| TC-12 | Console：Tracing 面只有两组——**周期内反例 / 周期内累计**，触发条件带进度（x/阈值、y/200、7 天）；无"待分类" | 出现全局管道数字；名词与数值口径不一致 |
| TC-13 | Semantic Sweep（后台批量打标）若保留，只是**可选的反例发现器**，绝不能是主路径的一环或前置门 | "sweep 未清空就不评 Unit" |
| TC-14 | tracing 是自管的**不可变只增**数据：每周期只记录 时间窗、指标、结论、起始版本内容指针；**不需要 cursor receipt / evidence digest** | 为防"源漂移"复制或摘要正文 |
| TC-16 | governance 活性：处于 governance 阶段、预期有提案卡、Objective thread 无成员运行且无挂起外部条件、却无卡 → 系统发一条提醒要求产卡，按天节流 | 无卡时无人知晓；或高频刷屏 |
| TC-17 | 所有进化动作（禁用/修改/合并=禁用A+改B/新增=放入目录）都是运行时 overlay 或目录扫描动作；approve 后系统重扫 registry 并刷新 snapshot | 把合并/新增做成需人合入的 base 级 PR；新增段要重启才可见 |
| TC-15 | 首周期起点：池中已有 tracing → 最早有效 trace 时间；没有 → 服务启动检查到缺失时写当前时间 | 首周期永远 not-ready；或从 0 起算 |

## 3. 现实现偏离台账（2026-09-02 运行实例实查，全部只读取证）

| # | 偏离 | 证据 | 违约条款 | Owner | 状态 |
|---|---|---|---|---|---|
| D-1 | snapshot 内嵌整份 corpus | D1 pending snapshot 6,148,472 bytes（200 episode 正文） | TC-4 | sol | open |
| D-2 | sweep 预分类层是主路径前置门 `if (!semantic)` | 1240 待分类永远清不空 → D1 阈值满足后 9 天无评估 | TC-3/5/13 | sol（A 刀进行中） | open |
| D-3 | 未回写 → 无限续租 | drain state generation 1899、in_flight 8 天 | TC-7 | sol（C 刀需按 TC-7 收缩） | open |
| D-4 | ~~insufficient_evidence 不该推进起点~~ → 按 06:32 修正：起点始终刷新是对的；**缺的是 skip 回看取数**（连续 skip 周期合并进下次评估窗口）与 skip 理由存档 | 现无 skip 状态与回看逻辑 | TC-10 | sol | open（球 D-4 的 why 已被本行取代） |
| D-5 | judgment 写完后无 governance 自动进入 | 代码仅一行注释；opus blocked 球 | TC-8/9 | 交互契约先由 Fable 起草，operator 确认后实现 | open |
| D-6 | 评估猫 invocation 被 F299 recorder `sourceRefs.max(64)` 打断（上游 #1390，8/25 入 base） | 域 thread 每 10 分钟重派 + `too_big` 报错 | 止血项 | sol（B 刀） | open |
| D-7 | Console 仍有"待分类"，两组命名不对 | `SegmentTraceTheater.tsx` L54/65/100 | TC-12 | Fable（分支 `fix/f257-tracing-two-groups`） | open |

台账更新规则：修一条改一条状态，附 PR 号；**不得在对话里声明"已修"而不改本表**。

## 4. 验收：只认真实运行实例（非作者执行）

| # | Falsifier（跑不过 = 没修好） |
|---|---|
| F-1 | 重启后 30 分钟内，某个累计 ≥ 200 的 Unit（如 D1/identity-truth）出现 latestJudgment ≠ null，且两个指标均有结果 |
| F-2 | 该 Unit 的 pending snapshot 体积 < 64 KB（只含窗口/引用） |
| F-3 | 评估线程未回写时，系统只重触发 1 次并留记录；drain/lease 状态不出现 generation > 10 |
| F-4 | 一次 insufficient_evidence 结果后，completed-window-end 不变 |
| F-5 | judgment 写入后 ≤ 5 分钟，同一评估 thread 出现 governance 决策（保持/回退/演进）；仅回退/演进产生审批卡 |
| F-6 | Console 段详情页：无"待分类"；两组名词与数值同口径；触发条件显示 x/阈值、y/200、7 天 |

## 5. 与其它文档的关系

- 详细 schema：`assets/F257/objective-driven-redesign-v1.md` §3（不变）
- 实施计划：`feature-specs/2026-08-04-f257-objective-eval-redesign.md`——其 §0/§2.4 中"冻结 raw corpus"表述已由 TC-4 取代
- KD 台账：`F257-harness-ledger.md` KD-23 指向本文件
