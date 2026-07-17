---
feature_ids: [F257]
topics: [harness, objective-driven, tracing, condition-registry]
doc_kind: design
created: 2026-07-17
status: v1.8 — sol R6 四 P1 两 P2 全收（msg 0001784268104795，"已接近收口"）：T-A 补 attempt 流唯一性契约（RoutingAttemptDraft[] source-span 去重每 token 恰一条 / messageId 后 finalize / user 表补 duplicate+group_keyword_skip / A2A 截断整批 metricEligible=false 防有偏样本）；§4.5.1 投影覆盖率契约（owner-scoped high-watermark + 评估前对账 + 缺口同步重建失败→unmeasurable + fail-open 适用范围显式列表）；T-B 补采集完整性（评估前 owner-scoped cursor 自动 reconcile + watermark，未完成→unmeasurable；graded 行标 future capability 出汇总口径）；condition_hit key 补 ownerUserId namespace。等 sol R7（范围 = 本轮四处修改点）
---

# F257 全量重设计：Objective-Driven 段评估体系 v1

> 触发：operator 2026-07-17 03:43 全量重整指令。判定成立："之前猛猛干了很多，对目标的实际提升基本是 0"——tracing 底座是资产，但**对"段的评估分析迭代"这个目标，已交付能力 = 0**。本文档是确认材料，不是实施记录。
>
> 设计链条（operator 给定）：段怎么设计 → 构建评估 → 指标怎么设计 → 该 tracing 什么 → 怎么 tracing（通用逻辑 + condition 外置）。

## 0. 口径先行（KD-6）+ 文档架构规则（v1.7，五轮 review 根因 A 的结构修法）

> **规范位唯四**：§3.1（union schema）/ T-A §3.4（routing tokenization+outcome）/ T-B §3.5（magic word 口径）/ T-C §3.6（manual provenance/auth）。**其余任何章节（含主 spec 摘要）一律 `→ 见 X` 引用式，禁止复述定义**——五轮 review 中"残留双真相"三次成为 P1（R2/R3/R5 同型），根因即多处复述；本规则是其结构拦截。

- **46 个 prompt hook 段**，how_counted: `ls -d assets/prompt-hooks/*/ | wc -l` @ develop_base `c0e2f1b96`
- operator 口径"52 个规则协作段"——已决（§7.1，operator 03:51 授权自决）：**正文按实测 46 hooks 为工作口径**；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52"不再作为工作口径
- 段分布：session-init 20 个 / per-turn 26 个

## 1. 第一个发现：段有两类——**设计输入维度**（v1.6 措辞收敛，sol R4 P2：评估模型实体是 per-objective 的，见 §3.0，本节不再自带"评估模型必须分开"的旧表述）

逐段盘点 46 段后的结构性发现——"段"不是同质的，这影响每个 objective 的评估模型**怎么设计指标**：

| 类型 | 定义 | 例子 | 背离含义 | 对指标设计的含义 |
|------|------|------|---------|---------|
| **指令段（directive）** | 要求猫做/不做某事 | L3 传球三选一、L4 五条铁律、S4 协作格式、D1 身份锚定 | 信息给对了，猫没照做 | 该段所挂 objective 倾向背离率型指标（段效力问题→改写/升结构/退役） |
| **信息段（informative）** | 向猫供给现场状态 | D6 队友上下文、D18 世界上下文、N1 导航、D14 SOP 阶段 | 供给的信息错/过时，导致猫行为错 | 该段所挂 objective 倾向供给质量型指标（段内容/数据源问题→修供给链路） |

不区分的后果：信息段永远测不出"违规"（它不是命令），会被误判 dormant。**分类学是 46 段 backfill 的第一个字段，作为评估模型设计的输入，不是独立的评估模型分类。**

## 2. Objective 归组表（46 段 → 8 objectives，草案）

> objective = 评估单位（KD-20）。同 objective 段共指标、一起评估；governance 判读单段合并/禁用/修改/新增。

| Objective | statement | 挂靠段 | 类型构成 |
|-----------|-----------|--------|---------|
| **OBJ-1 球权路由送达** | 球经 @ 准确送达、不掉地、不假接 | L3, D21, D8, D9, D13, D5, D4, R1, R2 | 指令为主 + R1/R2 机制供给 |
| **OBJ-2 等待与存活纪律** | 不空等不死等，等待必带检测与触发器 | （L3/D21 的 hold 条款；无独立段——本身是发现：高频事故区无专段，靠工具 GOTCHA 兜底） | 指令 |
| **OBJ-3 身份完整性** | 签名/身份/能力边界始终正确 | S1, D1, S2, S3 | 指令 |
| **OBJ-4 协作与 review 纪律** | 跨个体 review、五元组 handoff、review 后回传 | S4, D3, S6, D10 | 指令 |
| **OBJ-5 记忆与能力唤醒** | 压缩后 recall 不从零开始；场景触发对的 skill/工具 | B1, L5, L6, D11, S13, D20, L1 | 指令+信息混合 |
| **OBJ-6 安全边界** | 铁律零违规 | L4, S10, L2 | 指令（低频高危） |
| **OBJ-7 现场状态供给** | 猫的行为基于准确、新鲜的现场状态 | D6, D18, D12, D2, D7, D15, N1, D14, D16, D17 | 信息段 |
| **OBJ-8 治理与偏好对齐** | 决策走漏斗、沟通符合 operator 偏好 | D19, S9, S11, S12, S5, S7, S8, C1 | 信息为主 |

附录：SOP 6 步——**已决**（§7.1）：独立对象委托 eval:sop（既有 trace/predicate，KD-8 不变），不入本 46 段册。

## 3. 评估模型详细设计（v1.2 重写——operator 修正落地，msg 0001784264045844）

### 3.0 三条 operator 修正（本节的公理）

1. **评估模型是 per-objective 实体**——每个 objective 有自己的评估模型（指标集），不是全局"指令/信息"两类。两类分类学降级为**设计参考维度**（指令型目标测背离率、供给型目标测供给质量），不再是架构实体。
2. **tracing 数据按置信度分层**：`confidence: exact`（condition 精确命中）| `inferred`（语义判断/三源标注）。
3. **语义事件多归属 + 部分影响**：非黑即白不成立——一个 inferred 事件可挂多个 objective，每个归属带影响权重。

### 3.1 统一数据模型（置信度 + 多归属）

```yaml
# v1.6（sol R4）：写入支收敛为两支；magic word 不再独立写入——Event Memory 已是其
# single source of truth（EventMemoryStore.ts:5 归一裁定 2026-06-06，owner-scoped 唯一键 + dead-letter），
# 再建一支 = 第二真相源违反 P4。EM-8 指标 = Event Memory 只读投影（唯一 message-word hit 数口径）。
deviation_event:                        # union by `kind`，公共字段：
  eventId / timestamp / registryVersion / incidentKey
  ownerUserId                           # v1.7：单一 auth scope（T-C 定死）——server-trusted，进事实/索引/
                                        # 全部查询授权路径；workspaceId 不进 V1（HookOverride 命名空间 ≠ 认证 owner）
  attributions:
    - { objectiveId, segmentIds[], weight }   # exact 支强制单条 weight=1.0；manual 权重∈(0,1] objective 不重复
  anchors: { threadId, messageId?, invocationId? }

  kind=condition_hit:                   # confidence 恒 exact
    conditionId: <registry 条目>
    sourceFactRef: <指向 typed fact（可回放可审计）>
    recordedBy: system
    subjectCatId: <取自 fact 的 actor 字段>

  kind=manual_observation:              # confidence 恒 inferred
    source: operator | peer | self
    subjectCatId: 必填
    note: 必填
    # recordedBy 注入 / sourceAnchor typed union 与三条服务端校验 / incidentKey / 幂等 / Lua 原子 /
    # 无锚 candidate 转正通道——唯一定义 = T-C（§3.6），此处不复述

# incidentKey / 幂等 / 原子性 / anchor 校验 / auth scope：唯一定义 = **T-C（§3.6）**，此处不复述。
#   condition_hit 的 incidentKey = hash(**ownerUserId** + conditionId + sourceFactRef)（v1.8：owner
#   namespace 进 key 与公共隔离契约一致，防 owner-scoped fact ref 跨用户互压）；Redis claim key 同样
#   owner namespace 化（服务端生成，非 manual 通道）

# DeviationEventLog 存储规格：
#   TTL=0（Console 治理证据；≥14 天基线窗是底线）
#   查询带分页/完整聚合——不沿用现默认 200 条静默截断
#   注意（sol R2 P2-2）：本账本只存 condition 求值后的分子事件；观察面的原始 typed fact
#   （RoutingDecisionFact / GuardDecisionFact…）是独立存储——分母与离线回放能力来自 fact 层，两层不得合并

eval_model:                             # 每 objective 一个，外置 YAML（与 condition registry 同目录族）
  id: em-routing-delivery
  objectiveId: obj-routing-delivery
  metrics: [ { id, numerator, denominator, confidence_scope, thresholds } ]
  verdict_rules: 指标→verdict 的确定性映射（EM-6 特例：0 容忍）
```

**指标双口径（置信度分层的直接推论）**：分子含 inferred 贡献的率类指标产两条曲线——`strict`（仅 exact）/ `broad`（exact + Σ weight×inferred）；**exact-only 指标只画单线**（sol R2：不画两条相同曲线）。

**阈值纪律**：v1 全部 `thresholds: null` —— 先跑 ≥2 周拿真实基线再定阈值，无基线不拍数字（防假精确）。阈值未定期间 verdict 只产 `keep_observe / needs-attention(broad 与 strict 显著分叉时)`。

### 3.2 八个评估模型逐个设计（v1.4 全表重写——单一真相，无"目标态"残留）

> 每个指标带 `status`：**active-V1 / active-V2**（分子分母已验真，标注上线切片）｜**candidate**（启发式或三源，恒 inferred，只产候选不进 strict）｜**blocked-on-fact**（缺 typed fact，列明缺哪个，fact 落地前不上线不展示）。没有"目标态表格"——写在这里的就是要实现的。

**EM-1 球权路由送达**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| @ 解析成功率（per parserMode） | **active-V1** | 定义唯一来源 = **T-A decision table（§3.4）**：tokenization / outcome 互斥优先级 / 逐 outcome eligibility+success / 现 parser 可产性 / V1 parser 改造①②——本行不复述任何细节；group mention 退出 V1 | exact |
| void_ack 率 | **blocked-on-fact（v1.6 自 active 降级，sol R4 P1-1）** | `ball.handed`（invocation 开始，fire-and-forget）与 `ball.void_ack`（结束，另一次旁路写）是两个时间点独立写丢的信号——同窗相除纳入未完成 invocation + 跨窗右删失，不是可验真 exact。需 **per-attempt terminal decision fact**（attemptId / invocationId / subjectCatId / outcome，invocation 终态单点写），按完成 cohort 计算；P3 面工作，V2 | exact(目标) |
| @ 送达率 | blocked-on-fact | 需 attemptId join 实际 `ball.handed`——解析≠送达；V2（与 terminal fact 同期） | exact(目标) |
| 掉球率 | blocked-on-fact | 需 wake-outcome fact；eligibility 仅带 `completionRequirement` 的 wake invocation，不是全部 invocation | exact(目标) |
| 乒乓拦截计数 | active-V2 | GuardDecisionFact 面接入后由 fact 计数（迁自现硬编码 emit） | exact |
| 语义误路由 | candidate | manual_observation 加权 | inferred |

**EM-2 等待与存活纪律**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| hold 429 率 | active-V2 | GuardDecisionFact(hold_429) / hold_ball 调用数（P2 ToolEventLog）——**分子分母同取 7 天窗**（P2 TTL 限制，如实标注） | exact |
| 唤醒零产出率 | blocked-on-fact | 需 wake-outcome fact（completionRequirement 字段现在持久化时被丢弃）；eligibility 同上 | exact(目标) |
| 无检测死等 | candidate | manual_observation | inferred |

**EM-3 身份完整性**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 签名缺失率 | active-V2 | 消息尾无签名模式（P1 正则离线可算）/ 猫消息总数——**只测"缺失"** | exact |
| 签名错误率 | blocked-on-fact | "错误"需身份 registry 版本快照对照（哪只猫当时该签什么） | exact(目标) |
| 冒名/越权计数 | blocked-on-fact | 需 publish_verdict 403 等接入 GuardDecisionFact 面（现不入流） | exact(目标) |
| 身份漂移 | candidate | manual_observation | inferred |

**EM-4 协作与 review 纪律**（v1.4：**无 active exact 指标**——结构信号在本 objective 天然稀薄，如实呈现）
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 五元组缺失候选 | candidate | What/Why 正则**只产 candidate**（分母 A2A handoff 数存在，但正则不能证语义完整——sol REFUTED as exact） | inferred |
| review 后未回传 | candidate | manual_observation | inferred |
| 同族 review | candidate | manual_observation | inferred |

**EM-5 记忆与能力唤醒**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 压缩后零 recall 率 | active-V2（离线 job） | continuation session + transcript **离线 join**；实时窗受 P2 7 天 TTL 限制；`Skill` tool 只覆盖部分 provider——口径注明 per-provider | exact(窗口限定) |
| skill 加载计数 | active-V2 | 绝对数呈现（该触发场景数不可机判，无分母如实标注） | exact(无分母) |
| "猜代替查" | candidate | manual_observation（多归属带权重）——**命中置信度≠归因置信度**（sol R3 P1-2）：「我能猜出来」词条出现的 exact 事件只归 EM-8 计数；它对本 objective 的影响另产 manual_observation inferred 表达 | inferred |

**EM-6 安全边界**（0 容忍 verdict 规则**仅对已接入 GuardDecisionFact 的 guard 生效**——"既有结构护栏统一命中流"不存在，sol REFUTED，逐 guard 渐进接入）
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 铁律违规（逐 guard） | blocked-on-fact | 第一个接入：publish_verdict 403 → GuardDecisionFact；其余 guard 逐个入面，接一个算一个 | exact(渐进) |
| 铁律违规（语义） | candidate | manual_observation，任何 1 例 → 人工升级通道 | inferred |

**EM-7 运行时现场供给**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 段渲染失败率 | active-V2 | 分子**只取失败 reason（`template_missing` 等）——普通 condition-false 的 `skipped` 不算失败**（HookPipeline:153，sol 修正）；分母 = eligible render attempts | exact |
| 信息过时/缺失事故 | candidate | manual_observation（标注 involved segments） | inferred |

**EM-8 治理与偏好对齐**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| magic word 词面出现数 | **active-V1**（Event Memory 只读投影） | 口径唯一来源 = **T-B（§3.5）**：raw substring 口径，**不解释为治理拉闸**（live 路径实测强制 confidence:high、grader 只跑 backfill——sol R5 证伪"grader 处理语境"的 v1.6 声称）；graded 拉闸数 = blocked-on-fact（T-B 第二行）；上下文影响另产 manual_observation | exact(raw 口径) |
| 决策漏斗违规 | candidate | manual_observation | inferred |
| Decision Packet 缺失 | candidate | manual_observation | inferred |

**汇总（how_counted: **仅 §3.2 八张 EM 表逐行**，规范表 T-A/B/C 内的 future capability 行不计入——v1.8 口径精确化，sol R6 P2-1）**：active-V1 = **2** 项（@解析成功率 / magic word 词面出现数）；active-V2 = 6 项；blocked-on-fact = **7** 项；candidate = 11 项。**V1 收窄原则：只对马上实现的部分做采集语义级声称，其余一律 blocked/candidate 不预支精确性**——V1 上线的每个数字可验真。

### 3.3 Console 归属链（operator UX 模型直译）

- **段详情页头部**：`本段归属 → obj-xxx → 评估模型 em-xxx`（可点跳）；段生命线保持 `v1 → tracing → eval → governance` 不变
- **eval 节点展开** = 所属评估模型的指标实况：曲线（含 inferred 贡献的指标才双线，exact-only 单线）+ 分子事件列表 + 阈值状态（未定基线期显示"基线收集中 N/14 天"）+ collection-health 徽标
- **tracing 节点展开** = 相关 events 按置信度分组：exact 命中列表（condition id + 锚点）/ inferred 标注列表（source + weight + note + 锚点）；点击锚点 → join 回对话上下文

### 3.4 规范表 T-A：RoutingAttemptFact decision table（V1 唯一 tokenization/outcome 真相源）

> 从 parser 代码逐路径 derive（`a2a-mentions.ts` analyzeA2AMentions / `AgentRouter.ts` parseMentionsRaw），每行带现状锚点。**fact 由 parser 内部产**（parser 是 tokenization 唯一真相源；外部 re-tokenize = 第二真相源，禁止）。`attemptId = (messageId, parserMode, tokenOrdinal)`，tokenOrdinal = 该 parserMode 单次扫描内 attempt 形成顺序（0-based）。

**parserMode=a2a（行首语法，analyzeA2AMentions）——outcome 互斥优先级自上而下：**

| 优先级 | outcome | 触发条件（代码现状） | 现 parser 可产？ | V1 实现动作 | eligible（进分母）？ | success？ |
|---|---|---|---|---|---|---|
| 1 | `self_excluded` | token 匹配 self pattern——现状：self patterns 在 pattern build 时预删（`continue`），匹配时与 unknown 不可区分 | ✗ | parser 改造①：self patterns 保留参与匹配，命中时标记 self_excluded 后跳过（不路由） | ✓ | ✗ |
| 2 | `disabled_cat` | pattern 匹配但 `resolveCatTarget` 返回 error（F182 KD-10 match-time 检查）→ routing_warnings | ✓ | 直接采 | ✓ | ✗ |
| 3 | `duplicate` | pattern 匹配但 catId 已在 `seen` ——现状静默跳过 | 半（需标记） | parser 内标记 emit | ✗（去重语义，不代表路由质量；不进分子分母） | — |
| 4 | `resolved` | pattern 匹配 + boundary 通过 + resolver 通过 → `found` | ✓ | 直接采 | ✓ | ✓ |
| 5 | `unknown_token` | cursor 处 `@` 开头但无 pattern 匹配——现状 `if (!matched) break` **静默放弃该行剩余，零痕迹** | ✗ | parser 改造②：break 前对 cursor 处 token（`@` 至下一 boundary）emit unknown_token attempt | ✓ | ✗ |
| — | （右截断） | `found.length >= MAX_A2A_MENTION_TARGETS` → 外层 break，后续行不扫 | — | **整批 `metricEligible=false`**（v1.8，sol R6 P1-1：只排除未扫尾部 = 保留成功前缀 = 有偏样本虚高成功率；截断消息的全部 attempt 不进指标，batch 记 `truncated=true`） | — | — |

**parserMode=user（任意位置 prose，parseMentionsRaw）**——现状是 route-line + prose **两遍扫描**且按 `seenCats` 折叠（AgentRouter.ts:386/1005），同一 source 位置可被访问两次；group mention 先过 parseMentionsRaw 再过滤（AgentRouter.ts:1162）：

| outcome | 触发条件 | 现 parser 可产？ | V1 实现动作 | eligible？ | success？ |
|---|---|---|---|---|---|
| `resolved` | route-line 或 prose `@` 候选位匹配 pattern | ✓ | draft 化 | ✓ | ✓ |
| `unknown_token` | 显式 `@handle` 无匹配且非 domain-suffixed（codex 6949db49） | ✓ | draft 化 | ✓ | ✗ |
| `disabled_cat` | resolver error → routing_warnings | ✓ | draft 化 | ✓ | ✗ |
| `duplicate` | 同 source span 二次访问 / 同猫多 token 被 seenCats 折叠——**现状无此 outcome** | ✗ | parser 改造③：span 级去重时标记 | ✗ | — |
| `group_keyword_skip` | `@all` 等 group 关键词——**现状在 parseMentionsRaw 后才过滤，parser 内产 fact 会误标 unknown_token** | ✗ | parser 改造④：group 关键词在 draft 层先行识别标记，不落 unknown | ✗（非单播路由意图） | — |
| `domain_suffixed_skip` | `hasDomainSuffixedMentionPatternAt` 排除 | ✓ | draft 化 | ✗ | — |

**Attempt 流唯一性契约（v1.8 新增，sol R6 P1-1 核心）**：parser 返回 **`RoutingAttemptDraft[]`——按 source span 去重，每个语法 token 恰好一条 draft**（两遍扫描在 draft 层合并，二次访问标 duplicate）；`tokenOrdinal` = draft 数组序（span 起点排序，稳定）；draft 在 **MessageStore 生成 messageId 之后** finalize 为 fact（attemptId 补全）——**禁止任何 parser 外部 re-tokenize**。

**指标定义（唯一来源）**：`@解析成功率(parserMode) = resolved / (resolved + disabled_cat + self_excluded + unknown_token)`，仅 `metricEligible=true` 的 batch 计入；两 parserMode 分开报，不合并。`mention_not_line_start` 启发式（#417）永不进此表——candidate 通道。V1 前置：parser 改造①②③④（同一 PR，测试基线先行）。

### 3.5 规范表 T-B：MagicWordProjection eligibility（V1 唯一 magic word 指标真相源）

> live 路径实测（sol R5）：substring detector（`messages.ts:225`）+ **live hit 强制 `confidence: high`**（`index.ts:1762`）；deterministic grader 只跑 backfill（`event-backfill.ts:4` 自注 "live is always high"）。

| 指标 | 口径 | status |
|---|---|---|
| magic word **词面出现数** | Event Memory 只读投影，owner-scoped 唯一键去重（"唯一 message-word hit"）；**raw substring 口径——不解释为治理拉闸/偏好背离**（定义、引用旧消息同样计入，如实标注） | **active-V1** |
| magic word **治理拉闸数**（graded） | 需 live 路径接通同一 deterministic grader + 定义准入 confidence 集合——live/backfill 口径归一是前置 | **future capability（非 §3.2 指标汇总口径成员）** |

**采集完整性契约（v1.8，sol R6 P1-3——raw 口径诚实了，完整性还没证明）**：live 路径是 `void tryDetectMagicWords`（messages.ts:207，异常直接 catch 连 dead-letter 都不到），corpus backfill 是手动 HTTP（events.ts:170）——Event Memory 漏记时 raw count 静默偏低。**V1 前置**：指标计算前按 **owner-scoped message cursor 自动 reconcile**——对窗口内消息幂等重扫 detector（纯函数）补账 Event Memory，**high-watermark 持久化**；reconcile 未完成的窗口 → `unmeasurable`。producer heartbeat 不能替代此项（heartbeat 证明进程活着，不证明每条消息被扫描）。投影只读 Event Memory，不写任何第二份存储。

### 3.6 规范表 T-C：ManualObservation provenance/auth（V1 唯一 manual 契约真相源）

| 契约项 | V1 定义 |
|---|---|
| auth scope | **`ownerUserId` 单一 scope**（运行时消息与 Event Memory 的既有授权边界）；`workspaceId` **不进 V1 schema**（HookOverride 命名空间 ≠ 认证 owner，留 future） |
| sourceAnchor（typed union，必填） | `{kind:'thread_message', messageId}` ｜ `{kind:'operator_confirmation', confirmationId}` |
| 服务端校验（写入时，三条全过） | ① anchor 指向的实体存在；② anchor 与 authenticated ownerUserId 同域；③ `source=operator` 时 anchor 作者必须为 operator |
| recordedBy | callback principal 注入（猫）/ console 会话注入（operator）——不可自报 |
| subjectCatId | 必填，与 recordedBy 分离 |
| incidentKey | `hash(ownerUserId + sourceAnchor + subjectCatId + sorted(objectiveIds 全集))`——owner namespace 进 key（防跨 owner 互压）+ 服务端排序完整 objective 集（防换序绕过去重） |
| 原子性 | claim incidentKey + append event 同一 **Lua** 脚本（BallCustody APPEND_LUA 先例）；失败无 phantom claim |
| 幂等 | client 可带 idempotencyKey（principal+threadId scoped，仅防网络重试） |
| 无 anchor 的口头纠偏 | 停留 candidate 态；operator 一键确认产生 `operator_confirmation` anchor 后转正 |

## 4. 通用 Tracing 架构（condition 外置——本次重设计的核心）

### 4.1 病根承认

现状两处 emit 全是**主流程硬编码**（hold_ball routes 里 15 行、A2A generator 里同款）——operator 判定正确：hotfix 形态。每加一个信号改一处业务代码，46 段 × N 签名不可扩展。**修正原则（v1.4 收紧，sol R2 P2-1）：业务现场只负责发稳定的 typed fact；新增 condition 不再改业务代码。**（新增一类 fact 仍需业务侧一次接线——"永不再改业务代码"不成立，边界如实）

### 4.2 三层架构（v1.3：观察面改为现状实测——sol review 证伪"零新增采集"）

**观察面现状实测（sol 逐锚点核验，2026-07-17）**——v1.2 声称"已存在的全量流、零新增采集"**不成立**：

| 面 | v1.2 声称 | 实测现状（代码锚点见 sol review） | v1.3 处置 |
|----|----------|--------------------------------|----------|
| P1 消息流 | TTL=0 含 @ 结构/routing_warnings | 落库仅 `id/threadId/timestamp/content`；**routing_warnings 只走 WebSocket 广播不落库**；mentions 存解析后目标非原始 token/失败诊断 | **新增 `RoutingDecisionFact` 持久化**（首切片核心）——tokenization/outcome/eligibility 唯一定义 = **T-A（§3.4）**；持久化形态 = 权威记录一次写（§4.5.1） |
| P2 工具调用流 | TTL=0 可回放 | **ToolEventLog TTL=7 天**，且 Skill tool 只覆盖部分 provider | 7 天窗口内指标可算；跨窗评估 blocked，P2 留存策略进 OQ |
| P3 生命周期流 | 统一流可查 | **不存在统一流**；`sourceCategory/completionRequirement` 等关键字段在 InvocationRecord 持久化时**被丢弃**（进程内 QueueEntry 独有） | per-fact 渐进补齐（wake outcome fact 等），每个 fact 是独立小 PR |
| P4 HTTP guard 流 | 已存在 | **不存在通用流**——现 GuardRejectionEventLog 仅 2 硬编码 kind + 7 天清理 | 演进为 **`GuardDecisionFact` 观察面**（原始 guard 决策事实：可回放、供分母）；**不由 DeviationEventLog 吸收**——fact 是观察面、deviation 是求值分子，合并会丢回放与分母能力（sol R2 P2-2） |

**排序判据修正（v1.2 的"结构信号可回放"被打掉一半）**：可回放性只对**已持久化**的面成立——路由诊断、guard 命中此刻也在不可逆丢失。语义与结构两侧都在漏 → 首切片必须同时堵两个口（vertical slice，见 §6）。

```
层1 观察面 → per-plane adapter 产 typed fact（RoutingDecisionFact 先行，字段 typed 非裸 JSON）
层2 Condition Registry（外置 YAML）——谓词分层（sol 方案）：
    · condition 层最小谓词：exists / eq / gte / regex / not_empty + all / any / not / in
    · 窗口逻辑、跨事件 join、去重 → 不进谓词，归 metric aggregator 层
    · eligibility（如"仅评估带 completionRequirement 的 wake"）→ adapter 在 fact 上标记，condition 只读标记
层3 求值器两模式：实时（fact 落库后单点 post-hook）+ 离线（对已持久化 fact 回放）
```

### 4.3 语义层（conditions 判不了的）——v1.7：纯引用节，零定义

- 语义背离唯一写入通道 = `manual_observation`（工具 `cat_cafe_report_harness_signal`）：schema → §3.1；provenance/auth/incidentKey/原子性 → **T-C（§3.6）**
- magic word 不在本层写入任何事件：指标 = Event Memory 只读投影 → **T-B（§3.5）**
- 覆盖承诺：**不承诺全量捕获**（"依赖被纠偏的猫记得调工具"与 F257 要消灭的失忆路径同构）；无 anchor 口头纠偏走 candidate → operator 确认转正（T-C 末行）

### 4.4 评估与治理（下游不变，坐标系换）

deviation 账本（分子）+ typed fact 计数（分母）→ per-objective 指标 → eval 猫归因（weekly + 阈值插队，机制保留）→ governance 四动作作用于段（合并/禁用/修改 override 现成 / 新增 base 级）→ PatchTrial 差分验证 → 生命线呈现（console 组件复用，数据源换 objective join）。

### 4.5 Producer Health（v1.4 机制化——sol R2 P1-4："只有目标没有机制"不放行）

零事件必须可区分"零违规"与"采集器坏了"。**具体机制（V1 可执行）**：

1. **关键 fact 权威记录一次写 + 投影覆盖率契约**（v1.8 补全，sol R6 P1-2——"可回放"必须配"知道何时需要回放"）：`RoutingDecisionFact` 内嵌消息持久化记录一次写入（同一权威值物理共命运；Redis MULTI 无 rollback、pipeline.exec 不查逐命令 error——此路径不依赖 MULTI 语义）；查询投影（ZSET 时间索引）异步派生，**配套三件**：① **owner-scoped high-watermark**（投影记录已处理到的权威序号，持久化）② **评估前覆盖校验**：窗口内 authority 计数 vs projection 计数对账，缺口 → 先同步幂等重建（从权威记录 re-derive），重建失败 → 该窗口指标强制 `unmeasurable` ③ 现有 MessageStore 异步 listener 的静默吞错形态（RedisMessageStore.ts:193）**不得复用**——投影 worker 错误必须落 heartbeat 缺口
   **fail-open 适用范围显式列表（v1.8）**：仅限 best-effort producer（guard fact、ball-custody 类旁路写）；**内嵌 RoutingFact 不适用 fail-open**（它与消息共命运，消息写成功即 fact 存在）；manual_observation 不适用（T-C await-append）
2. **manual_observation 不 fail-open**：工具 `await append`，写失败**显式返回错误**给调用者（猫可见可重试）——手工上报静默丢失 = 三源通道自我否定
3. **best-effort producer**（guard fact 等 fire-and-forget 类）：**时间桶 heartbeat 序列**（每分钟一桶，ZSET/bitmap；不是最新值型 key——最新值会被恢复后覆盖，weekly 无法回看历史缺口，sol R3 P2）；评估时计算期望桶 vs 实际桶覆盖率，**缺桶窗口** → 依赖该 producer 的指标 verdict 强制 `unmeasurable`，禁产零事件结论
4. **入账时效 AC 拆三条**（不再泛写"operator 纠偏 30 秒入账"）：
   - magic word：operator 消息落库后 **30s 内自动**入账
   - manual/candidate：operator 确认或 report 调用成功起 **30s 内**入账
   - 未确认的语义纠偏：**不承诺捕获**——覆盖率如实呈现为 candidate 通道指标

业务侧对 fact 写入保持 fail-open（观测不阻塞业务），但故障必须经 heartbeat 缺口可见。Console 指标卡带 collection-health 徽标。

## 5. 既有资产处置表（诚实盘点）

| 资产 | 处置 | 理由 |
|------|------|------|
| InjectionTrace 注入账 | **保留** | 分母基础设施，objective 模型直接用 |
| **Event Memory（EventMemoryStore）** | **保留并复用**（v1.6 新盘入，sol R4 P1-3 抓获此前漏盘）——magic-word single source of truth（归一裁定 2026-06-06），EM-8 指标 = 其只读投影；DeviationEventLog 不双写 | P4 单一真相源；owner-scoped 唯一键 + dead-letter 现成 |
| GuardRejectionEventLog 存储层（ZSET+queryWindow） | **演进为 `GuardDecisionFact` 原始事实面**（观察面 P4：可回放、供分母；形态 ZSET+时间窗保留）——不与 DeviationEventLog 合并（v1.5 修正 sol R3 P1-1：§4.2/§5 曾互相矛盾）；存量 7 天 events 不迁移自然到期 | fact 是观察面、deviation 是求值分子，合并丢回放与分母 |
| DeviationEventLog | **新建**（求值结果账本：**两写入支** union → §3.1；magic word 为 Event Memory 只读投影不入此账 → T-B；TTL=0）——无兼容包袱（operator 授权） | 与 fact 层分离的分子账本 |
| 阈值升级钩子 | **保留** | 挂账本不挂业务代码，模式正确，改挂 DeviationEventLog |
| hold_ball / A2A 两处硬编码 emit | **承认 hotfix，迁移后删除** | 迁入 P4/P3 通用求值器 |
| 判定引擎 | **直接重构** per-objective（不留 per-segment 兼容路径）：ObjectiveJudgment + 段明细，段分类学感知，"测不到≠alive"修正 | 同上无兼容约束 |
| 生命线 console + 审批执行器 + override store | **保留** | governance 执行面与呈现面，数据源换 join |
| ledger YAML schema（锅面向） | **废弃** | 零实例；被 objective / condition / segment 三实体模型取代 |
| eval:harness-ledger 域注册 | **保留** | 域不变，评估单位换 objective |

## 6. 实施切片（vertical slice V1→V4，sol 方案；v1.4 指标与机制修正已入）

> 排序判据 v1.3 修正：v1.2 判据（"结构信号可回放"）被 sol 证伪一半——**路由诊断与 guard 命中此刻也在不可逆丢失**（不落库/7 天 TTL）。语义与结构两侧都在漏 → 第一切片必须是**一条端到端可验真的垂直切片**同时堵两个口，先证明"非零采集 + 可信分母"，再扩面。不先建空账本。

1. **切片 V1（vertical slice，第一优先；v1.7 全部引用规范表，本节零细节复述）**：
   - `RoutingDecisionFact`：tokenization / outcome / eligibility / parser 改造①② → **T-A（§3.4）**；持久化 = 权威记录一次写 + 投影异步派生 → §4.5.1；ownerUserId scope → T-C
   - `DeviationEventLog`：schema → §3.1；TTL=0 / 分页 / Lua 原子 / exact 单归属校验 / owner scope 进索引与查询授权 → §3.1 存储规格 + T-C
   - 标注工具 `cat_cafe_report_harness_signal`：契约全集 → **T-C（§3.6）**
   - **只上线 2 项 active-V1 指标**：@ 解析成功率（per parserMode → T-A）+ magic word 词面出现数（raw 口径 → T-B）；void_ack 率 blocked-on-fact（V2 terminal fact）；group mention 退出 V1
   - Console：分子 + 分母 + join anchor + **collection-health（时间桶 heartbeat 覆盖率）** 全展示
   - AC（拆分口径见 §4.5）：真实窗口非零采集 + magic word 30s 投影可见 + manual 确认后 30s 入账 + backfill LI-001~006
2. **切片 V2**：condition registry + 求值器双模式泛化（P1 adapter 抽象成 per-plane 模式）+ EM-2/EM-3 可证实指标接入（hold 429 率 / 签名缺失率）+ P3 wake-outcome fact 补齐
3. **切片 V3**：判定引擎 per-objective 重构（无兼容路径）+ 两处硬编码 emit 迁移删除 + producer health 全面接入 → AC：hold_ball routes 无任何 F257 代码
4. **切片 V4**：46 段分类学 + objective 归组全量落账（渐进）+ 新段未挂 objective 的 CI lint + 其余 EM blocked-on-fact 逐个解锁

## 7. 已决事项（operator 2026-07-17 03:51 授权自决后落账）

1. **口径**：正文按实测 46 hooks（可复算）；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52" 不再作为工作口径
2. **归组粒度**：8 objectives 定稿。OBJ-7/8 判据补充——OBJ-7 = 运行时现场供给（每 turn 变化：队友/世界/导航/模式，背离修数据源）；OBJ-8 = 静态治理与偏好供给（低频变化：宪法/花名册/铲屎官参考，背离修内容）
3. **切片顺序**：~~2→1→3→4（v1.2）~~ → **v1.3 起改为 vertical slice V1→V4（§6）**——v1.2 判据"结构信号可回放"被 sol 证伪（路由诊断/guard 命中当下也在丢），保留此改判痕迹防止旧顺序被引用
4. **兼容性**：零兼容包袱（operator 授权），存储/引擎/schema 直接换代，历史 guard events 不迁移
5. **sol 落地性 review R1→R5（05:01/05:16/05:26/05:34/05:49）**：五轮 BLOCK 全收零 pushback。五轮根因收敛为两条：**A 多处复述 = 残留永生**（R2/R3/R5 三犯同型——修法 = §0 文档架构规则：规范位唯四 + 全文引用化）；**B exact 声称先于代码验证**（R1/R4/R5 三犯——修法 = 规范表从 parser/写路径代码 derive，每行带锚点 + 现 parser 可产性列）。R5 增量：解析分母需 decision table + parser 改造①②；magic word live 路径实测强制 confidence:high → 指标降 raw 口径；auth scope 定死 ownerUserId；MULTI≠rollback → 权威记录一次写。**v1.7 = 46 协议第 5 轮系统性重整产物。等 sol R6 复核（边界 = V1 契约面）解除 BLOCK 才进切片 V1**
6. **P2 ToolEventLog 留存策略**（7 天 → ? ）：EM-5 跨窗评估的前置，进 OQ 随切片 V2 决
