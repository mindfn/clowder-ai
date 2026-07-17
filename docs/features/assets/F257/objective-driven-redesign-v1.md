---
feature_ids: [F257]
topics: [harness, objective-driven, tracing, condition-registry]
doc_kind: design
created: 2026-07-17
status: v1.2 — 评估模型 per-objective 实体化 + 置信度分层 + 多归属部分影响（operator 修正 msg 0001784264045844）；切片顺序 2→1→3→4
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
  attributions:                         # exact 单归属 weight=1.0；inferred 可多归属部分权重
    - { objectiveId: obj-routing-delivery, segmentIds: [L3, D21], weight: 0.8 }
    - { objectiveId: obj-collab-review,   segmentIds: [S4],       weight: 0.3 }
  anchors: { threadId, messageId, catId, invocationId?, timestamp }
  note?: 登记者一句话（inferred 必填）

eval_model:                             # 每 objective 一个，外置 YAML（与 condition registry 同目录族）
  id: em-routing-delivery
  objectiveId: obj-routing-delivery
  metrics: [ { id, numerator, denominator, confidence_scope, thresholds } ]
  verdict_rules: 指标→verdict 的确定性映射（EM-6 特例：0 容忍）
```

**指标双口径（置信度分层的直接推论）**：每个率类指标产两条曲线——`strict`（仅 exact）/ `broad`（exact + Σ weight×inferred）。console 同图双线：确证背离率 + 疑似背离率。

**阈值纪律**：v1 全部 `thresholds: null` —— 先跑 ≥2 周拿真实基线再定阈值，无基线不拍数字（防假精确）。阈值未定期间 verdict 只产 `keep_observe / needs-attention(broad 与 strict 显著分叉时)`。

### 3.2 八个评估模型逐个设计

> 分母全部来自既有持久化流（P1 消息 / P2 工具调用 / P3 生命周期 / InjectionTrace），逐条标注来源；标 ⚠ 的 = v1 观测成熟度低、以 inferred 为主，如实呈现不装可测。

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

### 4.2 三层架构

```
┌─ 层1 观察面（已存在的全量流，零新增采集）────────────────┐
│ P1 消息流（TTL=0）：文本 / @ 结构 / routing_warnings / 签名   │
│ P2 工具调用流（session events）：tool 名 / 参数 / 结果 / 错误码 │
│ P3 生命周期流：invocation / ack / hold / seal / 路由决策      │
│ P4 HTTP guard 流：4xx 结构拒绝                              │
└──────────────────────────┬───────────────────────────┘
                           │ 每个面一个统一 post-hook（唯一接入点）
┌─ 层2 Condition Registry（外置声明式，docs/harness-feedback/conditions/*.yaml）─┐
│ condition:                                                                 │
│   id: mention_unknown_handle                                               │
│   objectiveId: obj-routing-delivery                                        │
│   segmentIds: [L3, D21]          # 归因挂靠                                 │
│   plane: P1                                                                │
│   predicate: { field: routing_warnings, op: not_empty }                    │
│   emit: { kind: deviation, severity: P2 }                                  │
│   status: active                 # condition 本身是 harness unit：           │
│                                  # 可版本化 / 可评估 / 可退役（自举）          │
│ 谓词 v1 有限集：exists / eq / gte / regex / not_empty —— 不做图灵完备 DSL     │
└──────────────────────────┬───────────────────────────────────────────┘
┌─ 层3 通用求值器（一个引擎，两种模式）────────────────────────┐
│ 实时：面事件落库 → 按 plane 索引匹配 active conditions →       │
│       命中 emit deviation event（objectiveId+segmentIds+坐标锚）│
│ 离线：同一求值器对历史流回放——新 condition 上线回测历史 /       │
│       backfill / regression fixture（改条件不丢历史）           │
└─────────────────────────────────────────────────────────┘
```

### 4.3 语义层（conditions 判不了的）

复杂语义背离（"跑了但跑歪""回复敷衍""绕路"）**不进 condition**——谓词语言撑不住且不该撑。走三源标注：`operator_correction / peer_observation / self_report`，MCP 工具 `cat_cafe_report_harness_signal` 一步登记，落同一 deviation 账本（sourceKind 区分）。人/猫就是语义 condition 的求值器。

### 4.4 评估与治理（下游不变，坐标系换）

deviation 账本（分子）+ 观察面计数（分母）→ per-objective 指标 → eval 猫归因（weekly + 阈值插队，机制保留）→ governance 四动作作用于段（合并/禁用/修改 override 现成 / 新增 base 级）→ PatchTrial 差分验证 → 生命线呈现（console 组件复用，数据源换 objective join）。

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

## 6. 实施切片（定稿顺序 **2→1→3→4**，每片独立可验收）

> 排序判据（自决落账）：**语义信号不可回放——不记即永远丢**（operator 纠偏每天都在发生，此刻只能人肉 markdown）；**结构信号可离线回放补采**（P1-P4 流全量持久化 TTL=0，求值器上线后可回测历史，§4.2 离线模式就是为此设计）。所以先堵正在漏的（三源工具），再建随时能补的（通用求值器）。deviation 统一 schema 由切片 2 先定（两者共享）。

1. **切片 2（第一优先）**：DeviationEventLog 统一 schema + 三源标注工具 `cat_cafe_report_harness_signal`（prompt 触发反射 + 挂 objective/segment + 对话坐标锚）→ AC：operator 纠偏 30 秒内成为结构化 deviation，且 backfill LI-001~006
2. **切片 1**：condition registry schema + 通用求值器（P1 消息面先行，实时+离线双模式）+ obj-routing-delivery 落账 + 4 个路由签名 conditions → AC：console 见第一条 objective 指标真数据 + 离线回放跑通历史窗口
3. **切片 3**：判定引擎 per-objective 重构（无兼容路径）+ 两处硬编码 emit 迁移删除 → AC：hold_ball routes 无任何 F257 代码
4. **切片 4**：46 段分类学 + objective 归组全量落账（渐进）+ 新段未挂 objective 的 CI lint

## 7. 已决事项（operator 2026-07-17 03:51 授权自决后落账）

1. **口径**：正文按实测 46 hooks（可复算）；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52" 不再作为工作口径
2. **归组粒度**：8 objectives 定稿。OBJ-7/8 判据补充——OBJ-7 = 运行时现场供给（每 turn 变化：队友/世界/导航/模式，背离修数据源）；OBJ-8 = 静态治理与偏好供给（低频变化：宪法/花名册/铲屎官参考，背离修内容）
3. **切片顺序**：2→1→3→4（判据见 §6 头注）
4. **兼容性**：零兼容包袱（operator 授权），存储/引擎/schema 直接换代，历史 guard events 不迁移
