---
feature_ids: [F257]
topics: [harness, objective-driven, tracing, condition-registry]
doc_kind: design
created: 2026-07-17
status: v1.3 — sol 落地性 review BLOCK 全收（msg 0001784264491386，5 P1 带代码锚点）：观察面现状实测化、"零新增采集"作废、谓词分层重构、三源 provenance 强化、producer health 新增、切片重排为 vertical slice
---

# F257 全量重设计：Objective-Driven 段评估体系 v1

> 触发：operator 2026-07-17 03:43 全量重整指令。判定成立："之前猛猛干了很多，对目标的实际提升基本是 0"——tracing 底座是资产，但**对"段的评估分析迭代"这个目标，已交付能力 = 0**。本文档是确认材料，不是实施记录。
>
> 设计链条（operator 给定）：段怎么设计 → 构建评估 → 指标怎么设计 → 该 tracing 什么 → 怎么 tracing（通用逻辑 + condition 外置）。

## 0. 口径先行（KD-6）

- **46 个 prompt hook 段**，how_counted: `ls -d assets/prompt-hooks/*/ | wc -l` @ develop_base `c0e2f1b96`
- operator 口径"52 个规则协作段"——**口径假设：46 hooks + SOP 6 步 = 52**（Phase A 一直"段+SOP"并提）。⚠️ 待 operator 确认；本文档正文盘 46 hooks，SOP 6 步作为 OBJ 归组的独立附录段落
- 段分布：session-init 20 个 / per-turn 26 个

## 1. 第一个发现：段有两类，评估模型必须分开

逐段盘点 46 段后的结构性发现——"段"不是同质的：

| 类型 | 定义 | 例子 | 背离含义 | 评估模型 |
|------|------|------|---------|---------|
| **指令段（directive）** | 要求猫做/不做某事 | L3 传球三选一、L4 五条铁律、S4 协作格式、D1 身份锚定 | 信息给对了，猫没照做 | 背离率 =背离事件/机会数（段效力问题→改写/升结构/退役） |
| **信息段（informative）** | 向猫供给现场状态 | D6 队友上下文、D18 世界上下文、N1 导航、D14 SOP 阶段 | 供给的信息错/过时，导致猫行为错 | 信息错误事故数（段内容/数据源问题→修供给链路） |

不分开的后果：信息段永远测不出"违规"（它不是命令），会被误判 dormant；指令段的背离被误归因为信息问题。**这个分类学是 46 段 backfill 的第一个字段。**

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

附录：SOP 6 步（若确认入册）归 OBJ-4/OBJ-8 或独立 OBJ-9（SOP 阶段合规——eval:sop 域已有 trace/predicate，委托不重写，KD-8 不变）。

## 3. 评估模型详细设计（v1.2 重写——operator 修正落地，msg 0001784264045844）

### 3.0 三条 operator 修正（本节的公理）

1. **评估模型是 per-objective 实体**——每个 objective 有自己的评估模型（指标集），不是全局"指令/信息"两类。两类分类学降级为**设计参考维度**（指令型目标测背离率、供给型目标测供给质量），不再是架构实体。
2. **tracing 数据按置信度分层**：`confidence: exact`（condition 精确命中）| `inferred`（语义判断/三源标注）。
3. **语义事件多归属 + 部分影响**：非黑即白不成立——一个 inferred 事件可挂多个 objective，每个归属带影响权重。

### 3.1 统一数据模型（置信度 + 多归属）

```yaml
deviation_event:
  eventId: uuid
  sourceKind: condition_hit | operator_correction | peer_observation | self_report
  confidence: exact | inferred          # condition_hit 恒 exact；三源恒 inferred
  reporterCatId: <callback principal 注入，不可自报>     # v1.3 sol P1-4
  subjectCatId: <被纠/被观察对象>                        # v1.3：谁报告谁必须分离
  sourceMessageId?: <operator_correction 必填且校验 author=operator>
  registryVersion: <当时的 condition/objective registry 版本>
  incidentKey: <同事故去重键——三源对同一事故不得重复加权>   # v1.3
  attributions:                         # exact 强制单归属 weight=1.0（写入校验）；
    - { objectiveId: obj-routing-delivery, segmentIds: [L3, D21], weight: 0.8 }   # inferred 校验权重∈(0,1]、objective 不重复
    - { objectiveId: obj-collab-review,   segmentIds: [S4],       weight: 0.3 }
  anchors: { threadId, messageId, catId, invocationId?, timestamp }
  note?: 登记者一句话（inferred 必填）

# DeviationEventLog 存储规格（v1.3 定稿，sol review）：
#   TTL=0（Console 可见治理证据，非 7 天观测缓存；≥14 天基线窗是底线）
#   查询带分页/完整聚合——不沿用现默认 200 条静默截断
#   exact-only 指标不画 strict/broad 两条相同曲线（仅有 inferred 贡献时才双线）

eval_model:                             # 每 objective 一个，外置 YAML（与 condition registry 同目录族）
  id: em-routing-delivery
  objectiveId: obj-routing-delivery
  metrics: [ { id, numerator, denominator, confidence_scope, thresholds } ]
  verdict_rules: 指标→verdict 的确定性映射（EM-6 特例：0 容忍）
```

**指标双口径（置信度分层的直接推论）**：每个率类指标产两条曲线——`strict`（仅 exact）/ `broad`（exact + Σ weight×inferred）。console 同图双线：确证背离率 + 疑似背离率。

**阈值纪律**：v1 全部 `thresholds: null` —— 先跑 ≥2 周拿真实基线再定阈值，无基线不拍数字（防假精确）。阈值未定期间 verdict 只产 `keep_observe / needs-attention(broad 与 strict 显著分叉时)`。

### 3.2 八个评估模型逐个设计

> **v1.3 勘误（sol review 逐锚点核验）**：v1.2 "分母全部来自既有持久化流"**不成立**——P1 缺路由诊断字段、P2 仅 7 天、P3 无统一流、P4 不存在（详 §4.2 现状表）。逐模型 verdict：EM-1 NEEDS-CHANGE（仅 void_ack 率 + @送达率两项可先证实，@失效/掉球分母 blocked on RoutingDecisionFact/P3 fact）；EM-2 NEEDS-CHANGE（hold 429 率 7 天窗内可算；wake outcome 缺统一 fact）；EM-3 NEEDS-CHANGE（签名缺失可机判；"错误"需身份版本；403 未入流）；EM-4 **exact 降级为候选**（正则只算候选不证语义完整）；EM-5 NEEDS-CHANGE（continuation join 可离线做；P2 7 天限制）；EM-6 **REFUTED**（"既有结构护栏统一命中流"不存在，重写为逐 guard 渐进接入）；EM-7 NEEDS-CHANGE（分子只取 `template_missing` 等失败 reason，普通 condition-false 的 `skipped` 不算；分母 = eligible render attempts）；EM-8 CONFIRMED with scope（词条出现 exact 可计，"出现≠真实拉闸"由 confidence grader 处理语境）。下表保留 v1.2 原设计作为**目标态**，实施以本勘误 + §6 切片为准，未证实分母的指标一律标 `blocked-on-fact`，不上线假指标。

**EM-1 球权路由送达**（结构信号最全，首落地）
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| @ 失效率 | mention_unknown_handle + mention_disabled_cat + mention_not_line_start | @ 出现总数（P1 正则） | exact |
| 假接率 | ack_without_trigger（void_ack 已合入） | A2A 接球数（P3） | exact |
| 掉球率 | 无路由出口且无 hold/task（ack-liveness 反面） | invocation 数（P3） | exact |
| 乒乓拦截率 | route_decision_block（迁通用面） | A2A 路由数（P3） | exact |
| 语义误路由率 | 三源标注加权和 | 路由决策数（P3） | inferred |

**EM-2 等待与存活纪律**
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| hold 429 率 | http_rate_limit（迁通用面） | hold_ball 调用数（P2） | exact |
| 唤醒零产出率 | 唤醒后无 action-or-routing-exit（LI-001 guard 判据现成） | 唤醒数（P3） | exact |
| 无检测死等 | 三源标注 | — 计数型 | inferred |

**EM-3 身份完整性**
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| 签名缺失/错误率 | 消息尾无 `[昵称/模型🐾]` 模式（P1 正则可机判） | 猫消息总数（P1） | exact |
| 冒名/越权计数 | publish_verdict 403 类 guard 命中（迁通用面） | — 计数型 | exact |
| 身份漂移 | 三源（自称错模型等） | — 计数型 | inferred |

**EM-4 协作与 review 纪律** ⚠（结构信号最少，v1 以 inferred 为主——如实标注）
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| 五元组缺失率 | handoff 消息缺 What/Why 标记（P1 半结构正则，宽松版） | A2A handoff 数 | exact(弱) |
| review 后未回传 | 三源（"review 完成"语义判定谓词写不出精确版） | — | inferred |
| 同族 review | 三源 + D3 段命中展示 | — | inferred |

**EM-5 记忆与能力唤醒**
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| 压缩后零 recall 率 | continuation session 前 3 invocation 无 memory 工具调用（P2 可精判！） | continuation session 数 | exact |
| skill 加载计数 | Skill tool 调用（P2） | ⚠ 分母（该触发场景数）不可机判——绝对数呈现 | exact(无分母) |
| "猜代替查"纠偏 | 三源（含 magic word「我能猜出来」P1 正则捕获） | — | inferred+exact混合 |

**EM-6 安全边界**（特例：0 容忍计数型，任何 1 例 → verdict=action）
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| 铁律违规计数 | 既有结构护栏命中（迁通用面）+ 三源 | — 计数型 | exact+inferred |

**EM-7 运行时现场供给**（供给型参考维度：测供给质量，不测猫违规）
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| 段渲染失败/空率 | hook 渲染失败或空 fallback（InjectionTrace fired/skipped 状态现成） | 该段注入次数 | exact |
| 信息过时/缺失事故 | 三源（标注 involved segments：D6/D18/N1…） | — 计数型 | inferred |

**EM-8 治理与偏好对齐**
| 指标 | 分子 | 分母 | 置信度 |
|------|------|------|--------|
| magic word 触发计数 | operator 消息含 magic word 表词条（P1 正则精确）——word 本身归 EM-8 计数，事件的 objective 归属由登记时 attributions 分流（如「补锅匠」挂当时上下文 objective） | — 计数型 | exact |
| 决策漏斗违规 | 三源（该自决的上抛/该上抛的自决） | — 计数型 | inferred |
| Decision Packet 缺失 | 三源 | — | inferred |

### 3.3 Console 归属链（operator UX 模型直译）

- **段详情页头部**：`本段归属 → obj-xxx → 评估模型 em-xxx`（可点跳）；段生命线保持 `v1 → tracing → eval → governance` 不变
- **eval 节点展开** = 所属评估模型的指标实况：strict/broad 双曲线 + 分子事件列表 + 阈值状态（未定基线期显示"基线收集中 N/14 天"）
- **tracing 节点展开** = 相关 events 按置信度分组：exact 命中列表（condition id + 锚点）/ inferred 标注列表（source + weight + note + 锚点）；点击锚点 → join 回对话上下文

## 4. 通用 Tracing 架构（condition 外置——本次重设计的核心）

### 4.1 病根承认

现状两处 emit 全是**主流程硬编码**（hold_ball routes 里 15 行、A2A generator 里同款）——operator 判定正确：hotfix 形态。每加一个信号改一处业务代码，46 段 × N 签名不可扩展。**修正原则：业务代码只在通用管道埋一次钩子，此后新增信号 = 加一条外置 condition 配置，永不再改业务代码。**

### 4.2 三层架构（v1.3：观察面改为现状实测——sol review 证伪"零新增采集"）

**观察面现状实测（sol 逐锚点核验，2026-07-17）**——v1.2 声称"已存在的全量流、零新增采集"**不成立**：

| 面 | v1.2 声称 | 实测现状（代码锚点见 sol review） | v1.3 处置 |
|----|----------|--------------------------------|----------|
| P1 消息流 | TTL=0 含 @ 结构/routing_warnings | 落库仅 `id/threadId/timestamp/content`；**routing_warnings 只走 WebSocket 广播不落库**；mentions 存解析后目标非原始 token/失败诊断 | **新增 `RoutingDecisionFact` 持久化**（首切片核心）：原始 mention token / 语境 user-vs-A2A / resolved-unknown-disabled / actor / registryVersion / message anchor |
| P2 工具调用流 | TTL=0 可回放 | **ToolEventLog TTL=7 天**，且 Skill tool 只覆盖部分 provider | 7 天窗口内指标可算；跨窗评估 blocked，P2 留存策略进 OQ |
| P3 生命周期流 | 统一流可查 | **不存在统一流**；`sourceCategory/completionRequirement` 等关键字段在 InvocationRecord 持久化时**被丢弃**（进程内 QueueEntry 独有） | per-fact 渐进补齐（wake outcome fact 等），每个 fact 是独立小 PR |
| P4 HTTP guard 流 | 已存在 | **不存在通用流**——现 GuardRejectionEventLog 仅 2 硬编码 kind + 7 天清理 | 由 DeviationEventLog（TTL=0）取代并扩面 |

**排序判据修正（v1.2 的"结构信号可回放"被打掉一半）**：可回放性只对**已持久化**的面成立——路由诊断、guard 命中此刻也在不可逆丢失。语义与结构两侧都在漏 → 首切片必须同时堵两个口（vertical slice，见 §6）。

```
层1 观察面 → per-plane adapter 产 typed fact（RoutingDecisionFact 先行，字段 typed 非裸 JSON）
层2 Condition Registry（外置 YAML）——谓词分层（sol 方案）：
    · condition 层最小谓词：exists / eq / gte / regex / not_empty + all / any / not / in
    · 窗口逻辑、跨事件 join、去重 → 不进谓词，归 metric aggregator 层
    · eligibility（如"仅评估带 completionRequirement 的 wake"）→ adapter 在 fact 上标记，condition 只读标记
层3 求值器两模式：实时（fact 落库后单点 post-hook）+ 离线（对已持久化 fact 回放）
```

### 4.3 语义层（conditions 判不了的）——v1.3 provenance 强化（sol P1-4）

三源标注工具 `cat_cafe_report_harness_signal`，但**不承诺全量捕获**——"依赖被纠偏的猫记得调工具"与 F257 要消灭的失忆路径同构（sol 点破）。分层承诺：

- **magic word**：P1 正则自动采集（exact，不依赖猫自觉）
- **operator_correction**：必须锚定真实 operator 消息（校验 `sourceMessageId` 存在且 author=operator）；`reporterCatId`（callback principal 注入，不可自报）与 `subjectCatId`（被纠对象）分离
- **其他语义纠偏**：inferred candidate 定位 + operator 一键确认通道；prompt 反射提高召回但不算保证
- schema 增补：`reporterCatId / subjectCatId / sourceMessageId / registryVersion / incidentKey`（同事故去重键——防 operator/peer/self 三源对同一事故重复加权）

### 4.4 评估与治理（下游不变，坐标系换）

deviation 账本（分子）+ typed fact 计数（分母）→ per-objective 指标 → eval 猫归因（weekly + 阈值插队，机制保留）→ governance 四动作作用于段（合并/禁用/修改 override 现成 / 新增 base 级）→ PatchTrial 差分验证 → 生命线呈现（console 组件复用，数据源换 objective join）。

### 4.5 Producer Health（v1.3 新增——sol P1-5："exact 只证判据确定，不证采集完整"）

零事件必须可区分"零违规"与"采集器坏了"：每个 producer（adapter/emit 点）落**写入成功/失败计数 + outage marker**；评估窗口内 producer 不健康 → 该指标 verdict 强制 `unmeasurable`，禁止产零事件结论。业务侧保持 fail-open（观测故障不阻塞业务），但故障本身必须被记账。Console 指标卡带 collection-health 徽标。

## 5. 既有资产处置表（诚实盘点）

| 资产 | 处置 | 理由 |
|------|------|------|
| InjectionTrace 注入账 | **保留** | 分母基础设施，objective 模型直接用 |
| GuardRejectionEventLog 存储层（ZSET+queryWindow） | **直接重构**为 `DeviationEventLog`（统一 schema：结构 condition 命中 + 三源标注同一账本，sourceKind 区分）——**无兼容层**（operator 授权：客户端应用不需要接口兼容）；存量 7 天 TTL guard events 不迁移，自然到期 | 账本形态（ZSET+时间窗）正确，schema 换代 |
| 阈值升级钩子 | **保留** | 挂账本不挂业务代码，模式正确，改挂 DeviationEventLog |
| hold_ball / A2A 两处硬编码 emit | **承认 hotfix，迁移后删除** | 迁入 P4/P3 通用求值器 |
| 判定引擎 | **直接重构** per-objective（不留 per-segment 兼容路径）：ObjectiveJudgment + 段明细，段分类学感知，"测不到≠alive"修正 | 同上无兼容约束 |
| 生命线 console + 审批执行器 + override store | **保留** | governance 执行面与呈现面，数据源换 join |
| ledger YAML schema（锅面向） | **废弃** | 零实例；被 objective / condition / segment 三实体模型取代 |
| eval:harness-ledger 域注册 | **保留** | 域不变，评估单位换 objective |

## 6. 实施切片（v1.3 重排——sol vertical slice，替代 v1.2 的 2→1→3→4）

> 排序判据 v1.3 修正：v1.2 判据（"结构信号可回放"）被 sol 证伪一半——**路由诊断与 guard 命中此刻也在不可逆丢失**（不落库/7 天 TTL）。语义与结构两侧都在漏 → 第一切片必须是**一条端到端可验真的垂直切片**同时堵两个口，先证明"非零采集 + 可信分母"，再扩面。不先建空账本。

1. **切片 V1（vertical slice，第一优先）**：
   - `RoutingDecisionFact` 持久化（原始 mention token / user-vs-A2A 语境 / resolved-unknown-disabled / actor / registryVersion / message anchor）
   - `DeviationEventLog`（TTL=0 + 分页 + incidentKey 去重 + exact 单归属校验）
   - 三源标注工具（严格 provenance：reporter/subject 分离 + operator 消息锚校验 + magic word 自动采集）
   - **只上线 EM-1 两项已证实指标：@送达率、void_ack 率**（分子分母全部可验真）
   - Console：分子 + 分母 + join anchor + **collection-health** 全展示
   - AC：真实窗口跑出非零采集 + operator 纠偏 30 秒入账 + backfill LI-001~006
2. **切片 V2**：condition registry + 求值器双模式泛化（P1 adapter 抽象成 per-plane 模式）+ EM-2/EM-3 可证实指标接入（hold 429 率 / 签名缺失率）+ P3 wake-outcome fact 补齐
3. **切片 V3**：判定引擎 per-objective 重构（无兼容路径）+ 两处硬编码 emit 迁移删除 + producer health 全面接入 → AC：hold_ball routes 无任何 F257 代码
4. **切片 V4**：46 段分类学 + objective 归组全量落账（渐进）+ 新段未挂 objective 的 CI lint + 其余 EM blocked-on-fact 逐个解锁

## 7. 已决事项（operator 2026-07-17 03:51 授权自决后落账）

1. **口径**：正文按实测 46 hooks（可复算）；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52" 不再作为工作口径
2. **归组粒度**：8 objectives 定稿。OBJ-7/8 判据补充——OBJ-7 = 运行时现场供给（每 turn 变化：队友/世界/导航/模式，背离修数据源）；OBJ-8 = 静态治理与偏好供给（低频变化：宪法/花名册/铲屎官参考，背离修内容）
3. **切片顺序**：2→1→3→4（判据见 §6 头注）
4. **兼容性**：零兼容包袱（operator 授权），存储/引擎/schema 直接换代，历史 guard events 不迁移
5. **sol 落地性 review（2026-07-17 05:01，msg 0001784264491386）**：BLOCK 判定，5 P1 全收零 pushback——观察面声称 vs 代码现状的落差（"存在于解析层/进程内"≠"持久化可查"，A2 公理数据层变体）是本轮根因；v1.3 全部修入。**修订后需 sol 复核解除 BLOCK 才进切片 V1**
6. **P2 ToolEventLog 留存策略**（7 天 → ? ）：EM-5 跨窗评估的前置，进 OQ 随切片 V2 决
