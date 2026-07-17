---
feature_ids: [F257]
topics: [harness, objective-driven, tracing, condition-registry]
doc_kind: design
created: 2026-07-17
status: v1.5 — sol R3 三 P1 一 P2 全收（msg 0001784265982272）：§4.3/§5 双真相残留清除（union 单源引用 + GuardDecisionFact/DeviationEventLog 处置行拆分）、magic word 命中置信度与归因置信度分离（exact 只归 EM-8，上下文影响另产 manual_observation）、incidentKey 防伪造+防 phantom claim（强制 durable anchor / scoped idempotency / Lua 原子 claim+append）、heartbeat 改时间桶序列、汇总复算修正（blocked 6 / candidate 11）。等 sol R4 复核
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
# v1.4（sol R2 P1-2）：discriminated union——不同来源的字段责任不同，不再共用一张宽表
deviation_event:                        # union by `kind`，公共字段：
  eventId / timestamp / registryVersion / incidentKey / attributions / anchors{threadId, messageId?, invocationId?}

  kind=condition_hit:                   # confidence 恒 exact
    conditionId: <registry 条目>
    sourceFactRef: <指向 typed fact（可回放可审计）>
    recordedBy: system                  # 无 reporter 概念——系统求值产物
    subjectCatId: <取自 fact 的 actor 字段>

  kind=magic_word_hit:                  # confidence 恒 exact（自动采集，不依赖猫自觉）
    word: <magic word 表词条>
    operatorMessageId: <必填，写入时校验消息存在且 author=operator>
    recordedBy: system
    subjectCatId?: <当时被纠对象；上下文可解析则填，否则留空由 operator 操作面补>

  kind=manual_observation:              # confidence 恒 inferred
    source: operator | peer | self
    recordedBy: <authenticated principal——猫由 callback principal 注入不可自报；operator 由 console 会话注入>
    subjectCatId: 必填                   # 谁被观察，与 recordedBy（谁报告）强制分离
    sourceMessageId: <source=operator 时必填且校验 author=operator>
    note: 必填

# incidentKey 规则（v1.5 重写——sol R3 P1-3：防伪造碰撞与 phantom claim）：
#   condition_hit   = hash(conditionId + sourceFactRef)          # 服务端生成
#   magic_word_hit  = hash(operatorMessageId + word)             # 服务端生成
#   manual          = 强制 durable source anchor（sourceMessageId 或等价持久锚）→ 服务端
#                     hash(anchor + subjectCatId + 首 objectiveId)；**无 anchor 时服务端生成
#                     唯一事件 ID——只保证本次请求幂等，不声称跨 reporter 语义去重**
#   client 提供的 key 仅作 scoped idempotency key（绑定 principal + threadId），
#   不能预占全局 incidentKey 命名空间（防压掉他人治理证据）
# 去重原子性：claim incidentKey + append event 在**同一 Lua/MULTI**中完成——
#   两步分离时进程中途退出会留下"已去重、无事件"的 phantom claim（sol R3 实锤）
# 写入校验：exact 两支强制单归属 weight=1.0；manual 权重∈(0,1] 且 objective 不重复

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
| @ 解析成功率 | **active-V1** | RoutingDecisionFact(resolved) / eligible routing attempts；user-anywhere 与 A2A-line-start **分开 eligibility 统计**；group mention 退出 V1 | exact |
| void_ack 率 | **active-V1** | `ball.void_ack / A2A ball.handed(payload.fromCatId 存在)` | exact |
| @ 送达率 | blocked-on-fact | 需 `attemptId=(messageId, tokenOrdinal, targetCatId)` join 实际 `ball.handed`——解析≠送达（sol R2 P1-3）；V2 增强 | exact(目标) |
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
| magic word 出现计数 | **active-V1**（magic_word_hit 自动采集） | 词条出现 = exact 事件，**单归属、只归本 EM-8 计数**（sol R3 P1-2：命中是 exact，"影响哪个 objective"是语义判断——上下文影响一律另产 manual_observation inferred 多归属表达，不复用此 exact 事件）；出现 ≠ 真实拉闸，语境由 confidence grader 处理 | exact |
| 决策漏斗违规 | candidate | manual_observation | inferred |
| Decision Packet 缺失 | candidate | manual_observation | inferred |

**汇总（how_counted: 上表逐行数，sol R3 复算修正）**：active-V1 = 3 项（@解析成功率 / void_ack 率 / magic word 计数）；active-V2 = 6 项；blocked-on-fact = **6** 项（各自列明缺的 fact）；candidate = **11** 项（EM-5"猜代替查"随 P1-2 修正转纯 candidate 后口径不变仍 11）。V1 上线的每一个数字都可验真——这是对 operator "真的能采集起来"判据的直接回答。

### 3.3 Console 归属链（operator UX 模型直译）

- **段详情页头部**：`本段归属 → obj-xxx → 评估模型 em-xxx`（可点跳）；段生命线保持 `v1 → tracing → eval → governance` 不变
- **eval 节点展开** = 所属评估模型的指标实况：曲线（含 inferred 贡献的指标才双线，exact-only 单线）+ 分子事件列表 + 阈值状态（未定基线期显示"基线收集中 N/14 天"）+ collection-health 徽标
- **tracing 节点展开** = 相关 events 按置信度分组：exact 命中列表（condition id + 锚点）/ inferred 标注列表（source + weight + note + 锚点）；点击锚点 → join 回对话上下文

## 4. 通用 Tracing 架构（condition 外置——本次重设计的核心）

### 4.1 病根承认

现状两处 emit 全是**主流程硬编码**（hold_ball routes 里 15 行、A2A generator 里同款）——operator 判定正确：hotfix 形态。每加一个信号改一处业务代码，46 段 × N 签名不可扩展。**修正原则（v1.4 收紧，sol R2 P2-1）：业务现场只负责发稳定的 typed fact；新增 condition 不再改业务代码。**（新增一类 fact 仍需业务侧一次接线——"永不再改业务代码"不成立，边界如实）

### 4.2 三层架构（v1.3：观察面改为现状实测——sol review 证伪"零新增采集"）

**观察面现状实测（sol 逐锚点核验，2026-07-17）**——v1.2 声称"已存在的全量流、零新增采集"**不成立**：

| 面 | v1.2 声称 | 实测现状（代码锚点见 sol review） | v1.3 处置 |
|----|----------|--------------------------------|----------|
| P1 消息流 | TTL=0 含 @ 结构/routing_warnings | 落库仅 `id/threadId/timestamp/content`；**routing_warnings 只走 WebSocket 广播不落库**；mentions 存解析后目标非原始 token/失败诊断 | **新增 `RoutingDecisionFact` 持久化**（首切片核心）：原始 mention token / 语境 user-vs-A2A / resolved-unknown-disabled / actor / registryVersion / message anchor |
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

### 4.3 语义层（conditions 判不了的）——v1.5：仅引用 §3.1 union，本节不再自带 schema

语义通道产两种 §3.1 事件，**不承诺全量捕获**（"依赖被纠偏的猫记得调工具"与 F257 要消灭的失忆路径同构）：

- **`magic_word_hit`**（自动，exact）：P1 正则采集词条出现，锚 `operatorMessageId`——不依赖猫自觉
- **`manual_observation`**（工具 `cat_cafe_report_harness_signal`，恒 inferred）：`source=operator|peer|self`；字段责任、provenance 校验、incidentKey 规则**全部以 §3.1 union 定义为准**，本节零重复定义
- 未经确认的语义纠偏：prompt 反射提高召回但**不算保证**；operator 一键确认通道把 candidate 转正式 manual_observation

### 4.4 评估与治理（下游不变，坐标系换）

deviation 账本（分子）+ typed fact 计数（分母）→ per-objective 指标 → eval 猫归因（weekly + 阈值插队，机制保留）→ governance 四动作作用于段（合并/禁用/修改 override 现成 / 新增 base 级）→ PatchTrial 差分验证 → 生命线呈现（console 组件复用，数据源换 objective join）。

### 4.5 Producer Health（v1.4 机制化——sol R2 P1-4："只有目标没有机制"不放行）

零事件必须可区分"零违规"与"采集器坏了"。**具体机制（V1 可执行）**：

1. **关键 fact 原子写**：`RoutingDecisionFact` 与消息持久化在**同一 Redis MULTI** 提交（同库原子）；跨存储做不到原子的 fact 走 outbox（先记 intent 再确认）
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
| GuardRejectionEventLog 存储层（ZSET+queryWindow） | **演进为 `GuardDecisionFact` 原始事实面**（观察面 P4：可回放、供分母；形态 ZSET+时间窗保留）——不与 DeviationEventLog 合并（v1.5 修正 sol R3 P1-1：§4.2/§5 曾互相矛盾）；存量 7 天 events 不迁移自然到期 | fact 是观察面、deviation 是求值分子，合并丢回放与分母 |
| DeviationEventLog | **新建**（求值结果账本：condition_hit / magic_word_hit / manual_observation 三支 union，TTL=0）——无兼容包袱（operator 授权） | 与 fact 层分离的分子账本 |
| 阈值升级钩子 | **保留** | 挂账本不挂业务代码，模式正确，改挂 DeviationEventLog |
| hold_ball / A2A 两处硬编码 emit | **承认 hotfix，迁移后删除** | 迁入 P4/P3 通用求值器 |
| 判定引擎 | **直接重构** per-objective（不留 per-segment 兼容路径）：ObjectiveJudgment + 段明细，段分类学感知，"测不到≠alive"修正 | 同上无兼容约束 |
| 生命线 console + 审批执行器 + override store | **保留** | governance 执行面与呈现面，数据源换 join |
| ledger YAML schema（锅面向） | **废弃** | 零实例；被 objective / condition / segment 三实体模型取代 |
| eval:harness-ledger 域注册 | **保留** | 域不变，评估单位换 objective |

## 6. 实施切片（vertical slice V1→V4，sol 方案；v1.4 指标与机制修正已入）

> 排序判据 v1.3 修正：v1.2 判据（"结构信号可回放"）被 sol 证伪一半——**路由诊断与 guard 命中此刻也在不可逆丢失**（不落库/7 天 TTL）。语义与结构两侧都在漏 → 第一切片必须是**一条端到端可验真的垂直切片**同时堵两个口，先证明"非零采集 + 可信分母"，再扩面。不先建空账本。

1. **切片 V1（vertical slice，第一优先）**：
   - `RoutingDecisionFact` 持久化（原始 mention token / user-vs-A2A 语境 / resolved-unknown-disabled / actor / registryVersion / message anchor；**与消息持久化同 MULTI 原子写**）
   - `DeviationEventLog`（TTL=0 + 分页 + incidentKey 按 kind 规则原子去重 + exact 单归属校验；与 fact 层分离）
   - 三源标注工具（union schema §3.1：manual await-append 不静默失败 + operator 消息锚校验 + magic_word_hit 自动采集）
   - **只上线 3 项 active-V1 指标：@ 解析成功率（解析≠送达，不冒名"送达率"）、void_ack 率（`ball.void_ack / ball.handed(fromCatId 存在)`）、magic word 计数**；group mention 退出 V1；真送达率（attemptId join ball.handed）= V2
   - Console：分子 + 分母 + join anchor + **collection-health（heartbeat 缺口可见）** 全展示
   - AC（拆分口径见 §4.5）：真实窗口非零采集 + magic word 30s 自动入账 + manual 确认后 30s 入账 + backfill LI-001~006
2. **切片 V2**：condition registry + 求值器双模式泛化（P1 adapter 抽象成 per-plane 模式）+ EM-2/EM-3 可证实指标接入（hold 429 率 / 签名缺失率）+ P3 wake-outcome fact 补齐
3. **切片 V3**：判定引擎 per-objective 重构（无兼容路径）+ 两处硬编码 emit 迁移删除 + producer health 全面接入 → AC：hold_ball routes 无任何 F257 代码
4. **切片 V4**：46 段分类学 + objective 归组全量落账（渐进）+ 新段未挂 objective 的 CI lint + 其余 EM blocked-on-fact 逐个解锁

## 7. 已决事项（operator 2026-07-17 03:51 授权自决后落账）

1. **口径**：正文按实测 46 hooks（可复算）；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52" 不再作为工作口径
2. **归组粒度**：8 objectives 定稿。OBJ-7/8 判据补充——OBJ-7 = 运行时现场供给（每 turn 变化：队友/世界/导航/模式，背离修数据源）；OBJ-8 = 静态治理与偏好供给（低频变化：宪法/花名册/铲屎官参考，背离修内容）
3. **切片顺序**：~~2→1→3→4（v1.2）~~ → **v1.3 起改为 vertical slice V1→V4（§6）**——v1.2 判据"结构信号可回放"被 sol 证伪（路由诊断/guard 命中当下也在丢），保留此改判痕迹防止旧顺序被引用
4. **兼容性**：零兼容包袱（operator 授权），存储/引擎/schema 直接换代，历史 guard events 不迁移
5. **sol 落地性 review R1（05:01）+ R2（05:16）+ R3（05:26）**：三轮 BLOCK 全收零 pushback。R1 根因 = "存在于解析层/进程内"≠"持久化可查"（A2 公理数据层变体）；R2 根因 = 勘误头注盖旧表 = 双真相源（补锅匠模式）；R3 抓 v1.4 的 sweep 仍不彻底（§4.3/§5 漏扫——同型第二犯）+ 两个真数据模型缺陷（命中置信度≠归因置信度 / incidentKey 可伪造可留 phantom claim）+ 汇总复算错误（KD-6 自违）。**v1.5 修入；sweep 关键词表扩展后全文验证。等 sol R4 复核解除 BLOCK 才进切片 V1**
6. **P2 ToolEventLog 留存策略**（7 天 → ? ）：EM-5 跨窗评估的前置，进 OQ 随切片 V2 决
