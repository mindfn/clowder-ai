---
feature: F257
title: F257 Harness Ledger — 终态契约 v1（operator 口述定稿，唯一真相源）
status: authoritative
supersedes:
  - feature-specs/2026-08-04-f257-objective-eval-redesign.md §0 / §2.4 中"冻结 raw corpus"的表述
  - F257-harness-ledger.md KD-21 中"触发时冻结 raw corpus"的表述
source: co-creator 2026-08-20 / 08-21 / 08-26 / 09-02 04:07 / 04:50 / 06:09 / 06:32 / 06:42 / 07:17（thread_mrdip0u5aw4ysi97）
recorded_by: 宪宪(cat-8zfu14fb) 2026-09-02
---

> ✅ **已解冻（operator 2026-09-02 07:37 "确认了"）**，附条件：实施只按 `complete-design-v1.md` §14 切片进行：base = `develop_base`、**一条分支每片一个 commit、最后一个 PR**、commit/PR 描述映射 TC-#、Fable 逐 commit review 并以 §15 把关尺裁决、每片在隔离实例跑 §4 falsifier（不过不进下一片）、合入重启后在运行实例跑完整 falsifier 再交 operator 体验。sol 冻结前的 A/B/C worktree 改动**不直接沿用**：按 §14 重新对表，能复用的部分进对应切片。
>
> 这份文件存在的原因：同一个预期 operator 口头纠正了 ≥4 次，每次实现都偏。**从本文件起，F257 任何实现/review/验收都以下面 TC-# 编号为准；PR 描述必须逐条映射 TC-#；对话里的"理解了"不作数。**

## 1. 终态（operator 原话整理，不加工）

tracing 是**一个线性累积的池子**，一直在采，不分组。结构化反例 / MCP 举报只是池子里的**高置信度标记**，作用是评估时不用从海量数据里筛。

系统不断 check：周期内累计 ≥ 200，或周期内反例 ≥ 阈值，或距上次评估满 7 天——任一满足就**冻结一个时间窗**（起点 = 上次评估周期的结束时间，终点 = 现在），**不复制任何 tracing 数据**。然后拉起**固定的评估线程**，告诉它：时间窗、评估范围、指标；它去池子里拿这个时间窗的数据（反例优先）、按指标给出结论、**调工具回写 eval 状态**。如果它没回写，系统能观察到，用一条系统 message 再触发一次。

回写后**自动进入 governance**：再次触发同一评估线程，决定 保持 / 回退 / 演进到下一版。回退或演进 → 给 operator 一张审批卡；点完（或跳过）都进入下一周期。~~跳过时周期起点不动（可能只是数据不够）~~（08-20 原话；**09-02 06:32 operator 自纠 → 以 TC-10 为准：起点始终刷新 = 本周期终点，skip 只改变下次评估的取数窗口**）；新周期起点 = 这次周期的终点。v1、v2、v3 各自独立评估，**没有跨版本对比**——governance 看的就是当前版本这个时间窗的指标结论。

就这一个环，循环。

## 2. 契约条款（TC-#，实现与 review 的唯一编号锚点）

| # | 条款 | 反例（出现即违约） |
|---|---|---|
| TC-1 | tracing 是 owner 级**单一线性池**；采集不做判定、不分组 | 引入第二个池 / 预分类后才入池 |
| TC-2 | 结构化反例 / MCP 举报 = 池内**高置信度标记**，仅用于评估时优先阅读 | 把标记当证据准入门；无标记就不评 |
| TC-3 | 触发三路 **anyOf**：周期内累计 ≥ N / 周期内去重反例 ≥ M / 距上次评估 ≥ D 天；N/M/D 与最小评估间隔（默认 2h）**按 Objective 可配**；**由系统触发** | 写成"三路都满足"；阈值全局硬编码；需要人点按钮；任一路被其它步骤前置阻塞；关闭周期后无最小间隔地连续触发 |
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
| D-1 | snapshot 内嵌整份 corpus | D1 pending snapshot 6,148,472 bytes（200 episode 正文） | TC-4 | sol · §14 S1（删 snapshot corpus → CycleRecord） | open → S1 |
| D-2 | sweep 预分类层是主路径前置门 `if (!semantic)` | 1240 待分类永远清不空 → D1 阈值满足后 9 天无评估 | TC-3/5/13 | sol · §14 S1（删 `if (!semantic)`，sweep 移出主路径） | open → S1 |
| D-3 | 未回写 → 无限续租 | drain state generation 1899、in_flight 8 天 | TC-7 | sol · §14 S1 删 drain fence / S2 建有界重触发 | open → S1/S2 |
| D-4 | ~~insufficient_evidence 不该推进起点~~ → 按 06:32 修正：起点始终刷新是对的；**缺的是 skip 回看取数**（连续 skip 周期合并进下次评估窗口）与 skip 理由存档 | 现无 skip 状态与回看逻辑 | TC-10 | sol · §14 S1（skip 回看 `windows[]` + 理由存档） | open → S1 |
| D-5 | judgment 写完后无 governance 自动进入 | 代码仅一行注释；opus blocked 球 | TC-8/9 | 契约已确认（complete-design §1 步 6–8、§5.1）；sol · §14 S3 | open → S3 |
| D-6 | 评估猫 invocation 被 F299 recorder `sourceRefs.max(64)` 打断（上游 #1390，8/25 入 base） | 域 thread 每 10 分钟重派 + `too_big` 报错 | 止血项 | sol · §14 S2（assignment 引用 ≤ 64 或聚合为 source map，见 complete-design §6） | open → S2 |
| D-7 | Console 仍有"待分类"，两组命名不对 | `SegmentTraceTheater.tsx` L54/65/100 | TC-12 | sol · §14 S4；输入 = **只 cherry-pick `88cc67154`**（7 files +41/−46；对 develop_base@635acbc97 dry-run merge 零冲突），**勿 merge 整条 `fix/f257-tracing-two-groups`**（含 485 个 rebuild 前恢复文件） | open → S4 |

台账更新规则：修一条改一条状态，附 PR 号；**不得在对话里声明"已修"而不改本表**。本轮六片合为唯一 PR（§14）：各行在该 PR 合入后统一改 fixed 并附 PR 号。

## 4. 验收：只认真实运行实例（非作者执行）

> 09-02 对齐 `complete-design-v1.md` §14（切片 / 删留）与 06:32 修正（TC-10）：F-4 原文"completed-window-end 不变"与 TC-10 相反，已改；F-2 / F-3 的旧对象（pending snapshot / drain generation）换成 S1 之后的对象；新增 F-7（触发口径，S1 片）与 F-8（单一路径，S5 片）。F-1~F-6 编号不重排。
> 执行：每片 push 后由 Fable 在**隔离实例**（抛弃式 Redis 装载运行实例 dump 副本 + 该分支 build）跑该片对应的 F；唯一 PR 合入并重启后在**运行实例**全跑 F-1~F-8。脚本 `scripts/f257-falsifiers/`：检查项的观察面尚未绑定时输出 `unbound`，**不算通过**。

| # | Falsifier（跑不过 = 没修好） | 观察面（只读） | 条款 | 切片 |
|---|---|---|---|---|
| F-1 | 重启后 30 分钟内，某个周期内累计 ≥ N 的 Objective（如 identity-truth，1436/200）的 CycleRecord 到达 `evalStatus=written`，且 `evaluation.metrics[]` 覆盖该 Objective 全部指标、每条有 conclusion | CycleRecord 读面 + 该 Objective 系统 thread 消息（assignment → 回写工具调用） | TC-3/5/6 | S2 |
| F-2 | 该 Objective 的 CycleRecord 序列化 < 64 KB（`requested` 态 < 1 KB），不含任何 episode 正文；S0 清场后 Redis 中不再新出现 `harness-evaluation-snapshot:*`（traceCorpus）/ unit job / sweep job / drain 类键 | Redis `MEMORY USAGE` + `SCAN`（只读） | TC-4/14 | S1 |
| F-3 | 评估 thread 未回写：T=30 分钟后系统恰投 **1** 条重触发消息（`evalStatus=retriggered`）；再 30 分钟仍无 → `stalled` + 本 thread 告警，此后不再重试；Redis 中不存在 drain / lease / generation 类键 | CycleRecord 读面 + thread 消息计数 + Redis SCAN | TC-7 | S2 |
| F-4 | 一次 insufficient_evidence（= skip）后：周期关闭且**下一周期 `cycleStart` = 本周期 `cycleEnd`**（起点刷新）；下一次 assignment 的 `windows[]` 长度 ≥ 2、包含该 skip 周期窗口，并携带 `priorSkipReasons` | CycleRecord 历史 + 下一次 assignment 消息体 | TC-10 | S1（回看）/ S2（assignment） |
| F-5 | 评估回写后 ≤ 5 分钟，同一 Objective thread 收到 governance assignment（含历史周期摘要）且 `CycleRecord.governance` 写入；keep 不产卡；rollback / evolve 产卡且卡含 §5.1 五段（含逐段 diff）；reject 附理由后 ≤ 5 分钟出现新卡；approve(evolve) 后 registry 重扫、新版本对下一次 session-init 生效、无需重启 | thread 消息 + 提案卡（F276 store）+ override versions + registry 快照 | TC-8/9/16/17 | S3 |
| F-6 | Console 段详情页：无"待分类"；Tracing 面两组（周期内反例 n/M、周期内累计 m/N）+ 第三路 d/D 天 + 周期起点，名词与数值同口径；Eval 面平时只列指标目录、无假空态，有评估时显示 verdict 卡；Governance 面显示 decision / 理由 / 卡状态 / 版本链 | 真实浏览器（Playwright）对隔离 / 运行实例 | TC-12 | S4 |
| F-7 | 触发口径：三路 anyOf——累计 ≥ N、去重反例 ≥ M、cadence ≥ D 天（且累计 ≥ 1）任一满足即 `requested`；N/M/D/最小间隔来自该 Objective 评估模型定义（改定义即改行为，代码无硬编码）；同一 Objective `requested/retriggered` 期间不重复开启；周期关闭后最小间隔（默认 2h）内不再触发；首周期起点 = 最早有效 trace 时间，池空则服务启动写当前时间 | CycleRecord 读面 + 评估模型定义 + 隔离实例可调阈值 / 时钟 | TC-3/15 | S1 |
| F-8 | 单一路径：native 猫（Claude / Codex）与 pipeline 猫的 session-init 段 ID 集合一致；tracing 中不存在 L1–L7 独立 ID；`compile-system-prompt-l0.mjs` / `l0-compiler.ts` / `native-l0-trace.ts` 与 manifest 协议已删除；native 猫启动零 L0 报错，system-prompt 文件由同一 pipeline 输出 | 代码树 + 启动日志 + tracing 段投影 + 一次真实 native 猫 invocation | complete-design §13 | S5 |

## 5. 与其它文档的关系

- 详细 schema：`assets/F257/objective-driven-redesign-v1.md` §3（不变）
- 实施计划：`feature-specs/2026-08-04-f257-objective-eval-redesign.md`——其 §0/§2.4 中"冻结 raw corpus"表述已由 TC-4 取代
- KD 台账：`F257-harness-ledger.md` KD-23 指向本文件
