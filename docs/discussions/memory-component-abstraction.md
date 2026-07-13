---
title: "记忆能力抽象 — MemoryComponent 契约"
participants: [opus, fable, sol, codex, lang]
status: design-draft
created: 2026-06-30
updated: 2026-07-13
doc_kind: decision
decision_id: ADR-candidate-memory-abstraction
feature_ids: [F102]
topics: [memory, componentization, abstraction, MemoryComponent]
related: ["memory-service-componentization.md"]
---

# 记忆能力抽象 — MemoryComponent 契约

> **Status**: design-draft（2026-07-13，基于方向纠正重写）
> **Issue**: [#1047](https://github.com/zts212653/clowder-ai/issues/1047)
> **前身文档**: [记忆服务组件化 — 三原语模型](memory-service-componentization.md)（已标 `superseded`，三原语 SPI 降为可选 transport 附录）
> **设计前提**：Clowder AI 是客户端应用（跑在用户 Mac 上），不是多租户 SaaS
> **设计目标**：按能力做抽象，使记忆后端可替换，不是同时对接多个后端

## 变更历史

本文前身是 "EchoMem 协作方案 — 三层架构设计"（1190 行，7 轮 review）。
co-creator 指出两个根本前提错误后重写：

1. **我们是客户端应用**：用户拥有全部数据，不存在多租户隐私边界。之前设计的 egress filter / thread sensitivity / agentId 分区等全部是 SaaS 思维。
2. **组件化 = 按能力抽象**：目标是让后端可替换（今天 SQLite，明天可以换 EchoMem），不是同时跑两个后端做 shadow 对比。

之前版本的 git 历史保留在本分支（`59281f6ab`..`f2bed3d62`）。

---

## 1. 图书馆比喻

记忆系统 = 图书馆。上层应用（LLM / 猫猫）只需要知道：

| 能力 | 图书馆 | 我们的系统 |
|------|--------|-----------|
| **入库** | 书入库，图书馆分类上架 | `upsert()` / `IndexBuilder.rebuild()` |
| **找书** | 按关键词、分类找 | `KnowledgeResolver.resolve(query, options)` |
| **取书** | 拿到书翻看内容 | `getByAnchor()` + drill-down — **两种模式**见下 |
| **下架** | 过期/失效的书下架 | `LifecycleState` 转换（dormant/superseded/invalidated） + `supersededBy` |
| **内部管理** | 图书馆自己处理 | 索引重建、向量嵌入、去重、矛盾检测、消费加权排序 |

**取书的两种模式**（`depth` 参数控制）：
- **文档类**：索引命中 → LLM 用 drill-down 工具 grep 原文件取全文（索引是摘要，原文在 repo）
- **对话类**：内容就在 passages 里，直接返回（对话消息本身就是内容，不需要回源）

上层不需要知道书架怎么组织、用的什么数据库、索引怎么建。**这就是组件化的目标**。

> **核心原则：索引可重建**。真相源始终是 docs/*.md + thread 消息历史（前身 ADR（已 superseded）最早的正确决策，本文继承）。
> 记忆服务是编译索引，不是真相源。索引丢了 → `IndexBuilder.rebuild()` 重建，等同于缓存失效。
> 这意味着入库的可靠性要求是**缓存重建级**（同步写 + 失败重建），不是消息队列级（at-least-once / exactly-once）。

---

## 2. 现有架构（从代码提取）

```
上层应用（search_evidence / list_recent / graph_resolve）
    │
    ▼
IKnowledgeResolver ← 图书馆前台
    │  resolve(query, options) → KnowledgeResult
    │  - FTS + 向量 + 混合三种搜索
    │  - RRF 融合多源结果
    │  - scope/dimension/depth 过滤
    │
    ├── projectStore: IEvidenceStore ← 项目书架（SQLite）
    │   包含：文档类 + 对话类（混在一起）
    │
    ├── globalStore: IEvidenceStore ← 全局书架（SQLite）
    │   包含：跨项目知识
    │
    └── LibraryCatalog → N 个 Collection stores
        包含：外部知识库
```

**问题**：当前记忆能力散落在多个类中（KnowledgeResolver 做搜索、IndexBuilder 做入库且直写 SQL、deleteByAnchor 不级联 passage），没有统一的能力契约。想替换整个记忆后端 → 不知道替换边界在哪，因为完整能力由 4+ 个类拼接而成，且 IndexBuilder 有 12 处 `getDb` 直接调用点逃逸绕过了 `IEvidenceStore` 接口。

### 2.1 现有能力清单

| 能力 | 接口 | 实现 | 说明 |
|------|------|------|------|
| 搜索 | `IKnowledgeResolver.resolve()` | `KnowledgeResolver` | 跨 store 联邦搜索 + RRF 融合 |
| 存储 | `IEvidenceStore.upsert/search/getByAnchor/deleteByAnchor` | `SqliteEvidenceStore` | 单 SQLite 文件 |
| 扫描入库 | `IIndexBuilder.rebuild/incrementalUpdate` | `IndexBuilder` | 扫描 repo → 文档 + passages |
| 向量嵌入 | `IEmbeddingService` | `EmbeddingService` | passage 向量化 |
| 关系图 | `GraphResolver` + `Edge` | `SqliteEvidenceStore` | 文档间关系 |
| 实体识别 | `EntityRecord` + `resolveEntityAliases` | `SqliteEvidenceStore` | 别名解析增强搜索 |
| 标记物化 | `IMarkerQueue` → `IMaterializationService` | `MarkerQueue` | 读者笔记 → 正式文档 |
| 浏览最近 | `RecentBrowseResolver` | `RecentBrowseResolver` | 最近 N 条 |
| 消费加权 | F200 consumption-weighted ranking | `SqliteEvidenceStore` | 常被翻的书排前面 |
| 矛盾检测 | F163 `contradicts[]` + `invalidAt` | `f163-review-queue` | 发现内容冲突 → 标记 |
| 质量分层 | `provenance: authoritative/derived/soft_clue` | scanner | 来源可信度 |

---

## 3. 已有数据（实测快照 2026-06-30）

### 3.1 evidence_docs（291 条）

| kind | 数量 | 数据来源 | 类别 |
|------|------|---------|------|
| `feature` | 236 | scanner 扫描 repo | 文档类 |
| `plan` | 38 | scanner 扫描 repo | 文档类 |
| `decision` | 10 | scanner 扫描 repo | 文档类 |
| `thread` | 7 | IndexBuilder 编译对话 | 对话类 |
| `session` | 0 | scanner（session digest） | 文档类 |
| `lesson` | 0 | scanner | 文档类 |
| `discussion` | 0 | scanner | 文档类 |
| `research` | 0 | scanner | 文档类 |
| `pack-knowledge` | 0 | scanner | 文档类 |

**284 文档类 + 7 对话类。**

### 3.2 evidence_passages（21,946 条）

- doc_anchor 模式：100% `thread-*`（全部是对话消息）
- 去重 doc_anchor：193 个对话 thread
- 有对应 evidence_docs 的：5 个
- 孤儿 anchor（doc 已删但 passage 保留）：188 个

> **孤儿根因**：`deleteByAnchor()` 只删 `evidence_docs`，不级联删 `evidence_passages`。
> 这是治理问题（历史 thread 记忆保留策略矛盾），需要在组件化前或过程中解决。

### 3.3 edges（2,437 条）

100% 文档间关系（`feature_ref` 1288 / `related_to` 719 / `related` 309 / `doc_link` 113 / `wikilink` 8）。

### 3.4 数据结论

| 数据 | 内容类型 | 说明 |
|------|---------|------|
| kind ∈ {feature, plan, decision, lesson, session, discussion, research, pack-knowledge} | 文档类 | scanner 产物，LLM 取书时 grep 原文件 |
| kind = thread + 全部 passages | 对话类 | 对话编译产物，内容直接在 passages 里 |
| 全部 edges | 文档间关系 | 文档间引用关系 |
| entities | 共享基础设施 | 两类都需要实体解析增强搜索 |

文档/对话是**内容类型和入库来源**，不是上层选择不同后端的路由轴——MemoryComponent 内部自行处理这个区分。

---

## 4. 目标架构

### 4.1 统一的记忆组件（MemoryComponent）

**一个 Clowder runtime 暴露一个 MemoryComponent 实例**。project / global / collections 是组件内部的 namespaces，federation（跨 namespace RRF 融合）是组件的内部能力，不暴露给宿主：

```
上层应用（search_evidence / list_recent / graph_resolve）
    │
    ▼
MemoryComponent ← 唯一的记忆能力契约（一 runtime 一实例）
    │ remember — 入库
    │ recall   — 检索（relevance 语义搜索 / recent 最近浏览）
    │ read     — 取书（inline content 或 resource reference）
    │ related  — 关系图查询（"这本书引用了谁/被谁引用"）
    │ transition — 生命周期转换（可逆 dormant/supersede/invalidate + 不可逆 hard delete）
    │ maintain — 内部管理（sunset 执行 / compaction / 向量重建 / federation 健康）
    │ health
    │
    └── 当前实现：LocalMemoryComponent
        内部 namespaces: project / global / collection_1..N
        跨 namespace RRF 融合——组件内部能力
        SqliteEvidenceStore + EmbeddingService（SunsetManager 为 Phase 2 交付）
        doc/conv 内容类型路由——实现细节
        源扫描（IndexBuilder scanner 部分）——组件外部，重放到 remember()
```

**实例边界（Sol 定案，Fable 同意）**：federation 属于"完整记忆管理能力"（F186 原话："你们查询可以 recall 本 project 以外的知识"），归组件内部。若 per-namespace 替换（project 用 EchoMem、global 用 SQLite），宿主就要做跨实例融合/去重/降级——正是已删掉的 coordinator 借尸还魂。

**rebuild 与 maintain 的分离**：
- **rebuild** = 宿主重放全量 ingest（扫描真相源 → 逐条 `remember()`），宿主发起
- **maintain()** = 组件内部索引健康（compaction / 向量重建 / sunset 执行），组件自治
- 当前 IndexBuilder 混合了这两个语义（既做源扫描又直写 SQL），正是 `getDb` 逃逸 12 处的根因——这个拆分不是新增工作，是把已知的抽象穿透修正掉

### 4.2 能力契约

```typescript
interface MemoryComponent {
  // ── 应用层（上层直接使用）──
  remember(input: MemoryInput): Promise<MemoryRecord>;
  recall(query: MemoryQuery): Promise<MemorySearchResult>;
  read(key: MemoryKey): Promise<MemoryRecord | null>;
  related(target: MemoryKey | { query: string }, options?: RelationOptions): Promise<RelationResult>;

  // ── 系统层（系统事件触发）──
  transition(command: LifecycleCommand): Promise<void>;
  recordFeedback(event: MemoryFeedback): Promise<void>;
  maintain(): Promise<MaintenanceReport>;

  // ── 运维层 ──
  health(): Promise<MemoryHealth>;
}
```

上层应用直接使用前四项；`transition` / `recordFeedback` 来自系统事件；`maintain` 由组件内部调度。

**`related()` 扩展说明**：真实 graph 入口（`GraphQueryResolver.resolve`）是 query-based，不只是 key-based——从模糊字符串解析到 anchor 是能力的前半段（fuzzy matching + candidates），key-based 遍历是后半段。`target` 支持 `MemoryKey`（精确遍历）和 `{ query: string }`（模糊解析），返回 3-state 判别联合。

**`invalidate()` → `transition()`**：原 `invalidate(key, reason)` 同时承担 dormant、superseded、invalidated 和硬删除，语义过载。改为 `transition(command: LifecycleCommand)` 判别联合，显式区分可逆状态转换和不可逆硬删除。

**MemoryQuery 判别联合**（覆盖现有三入口）：

```typescript
// ── 馆选择（一对一映射 SearchDimension 五值，Fable 定案）──
// 'project'       — 本项目馆
// 'global'        — 全局馆
// 'all'           — legacy project + global 融合（默认；现有 dimension='all' 行为，不含 collections）
// 'library'       — 全部 routable collections 扇出（现有 dimension='library'）
// { collections } — 指定 collection IDs（现有 dimension='collection'）
type NamespaceSelector = 'project' | 'global' | 'all' | 'library' | { collections: string[] };

// ── 馆内内容类型过滤（收紧为枚举）──
type ScopeFilter = 'docs' | 'threads' | 'sessions' | 'memory' | 'all';

type MemoryQuery =
  | {
      mode: 'relevance';
      // ── 必填 ──
      text: string;                          // ← SearchOptions query 参数
      // ── 馆选择 ──
      namespace?: NamespaceSelector;         // ← dimension（默认 'all'）
      // ── 馆内过滤 ──
      scope?: ScopeFilter;                   // ← content-type filter
      kind?: EvidenceKind[];                 // ← kind（升级为数组——多 kind OR 过滤）
      status?: EvidenceStatus[];             // ← 业务状态过滤（done/active/archived…）——见 §4.3 两维度区分
      searchMode?: 'lexical' | 'semantic' | 'hybrid'; // ← mode（保留语义命名，不泄露实现技术）
      limit?: number;                        // 默认 10
      depth?: 'summary' | 'raw';             // ← 结果详细度（summary=摘要 / raw=全 passage）
      dateFrom?: string;                     // ← ISO8601 下界
      dateTo?: string;                       // ← ISO8601 上界
      keywords?: string[];                   // ← 预提取关键词 AND 过滤
      threadId?: string;                     // ← F148 限定 thread scope
      contextWindow?: number;                // ← 每个命中周围 passage 数（默认 0）
      provenanceTier?: ProvenanceTier[];     // ← F152 来源可信度过滤（升级为数组）
      explain?: boolean;                     // ← F200 可解释性字段（返回 rankingFactors）
      intent?: 'topk' | 'coverage';         // ← F200 搜索意图（topk=默认 / coverage=穷举多 scope）
      includeBackstop?: boolean;             // ← F163 drill-down backstop docs
      worldId?: string;                      // ← F093 世界观过滤
      sceneId?: string;                      // ← F093 场景过滤
    }
  | {
      mode: 'recent';
      // ── 时间范围 ──
      since?: string;                        // ← "7d"|"24h"|ISO8601（默认 "7d"）
      // ── 共享过滤 ──
      namespace?: NamespaceSelector;         // 默认 'all'
      scope?: ScopeFilter | 'trajectories';  // trajectories 仅 recent 模式有效
      kind?: EvidenceKind[];
      limit?: number;                        // 默认 20
      verified?: boolean;                    // ← 仅返回已验证条目
    };
```

- `mode: 'relevance'` → 映射 `search_evidence`（现有 `KnowledgeResolver.resolve`）
- `mode: 'recent'` → 映射 `list_recent`（现有 `RecentBrowseResolver`）
- `related()` 独立方法 → 映射 `graph_resolve`（支持 key-based 精确遍历 + query-based 模糊解析，返回 3-state 判别联合）

`scope` 是馆内内容类型过滤（threads/docs/sessions/all），`namespace` 是选哪些馆（NamespaceSelector 五值）——两个独立小表替代原来的 30 格矩阵。现有 `search_evidence` 的对外参数不变，组件内部翻译 scope → filter、dimension → namespace。

**SearchOptions 19 字段 → MemoryQuery 完整映射**：

| # | SearchOptions 字段 | MemoryQuery 字段 | 映射说明 |
|---|-------------------|-----------------|---------|
| 1 | `kind` | `kind` | 升级为数组（多 kind OR 过滤） |
| 2 | `status` | `status` | **业务状态过滤**（EvidenceStatus: done/active/archived…）——与 LifecycleState（检索生命周期）正交，见 §4.3 两维度区分 |
| 3 | `keywords` | `keywords` | 直接映射 |
| 4 | `limit` | `limit` | 直接映射 |
| 5 | `scope` | `scope` | 直接映射（content-type filter） |
| 6 | `mode` | `searchMode` | **重命名**避免与 `MemoryQuery.mode` 歧义；保留语义命名 `lexical/semantic/hybrid`（不泄露 fts/vector 实现） |
| 7 | `depth` | `depth` | 直接映射（控制结果详细度） |
| 8 | `dateFrom` | `dateFrom` | 直接映射（ISO8601） |
| 9 | `dateTo` | `dateTo` | 直接映射（ISO8601） |
| 10 | `contextWindow` | `contextWindow` | 直接映射（周围 passage 数） |
| 11 | `threadId` | `threadId` | 直接映射（F148 thread scope） |
| 12 | `dimension` | `namespace` | **翻译**：`SearchDimension` 五值 → `NamespaceSelector` 判别联合（含 `library` = 全 routable collections 扇出） |
| 13 | `collections` | `namespace.collections` | `dimension=collection` + `collections` → `namespace: { collections: [...] }` |
| 14 | `provenanceTier` | `provenanceTier` | 升级为数组（多 tier OR 过滤） |
| 15 | `includeBackstop` | `includeBackstop` | 直接映射（F163） |
| 16 | `worldId` | `worldId` | 直接映射（F093） |
| 17 | `sceneId` | `sceneId` | 直接映射（F093） |
| 18 | `explain` | `explain` | 直接映射（F200 可解释性） |
| 19 | `intent` | `intent` | 直接映射（F200 搜索意图） |

**ListRecentOptions → MemoryQuery `recent` 模式映射**：

| ListRecentOptions 字段 | MemoryQuery 字段 | 映射说明 |
|-----------------------|-----------------|---------|
| `since` | `since` | 直接映射（"7d"/"24h"/ISO8601） |
| `limit` | `limit` | 直接映射 |
| `scope` | `scope` | 直接映射 |
| `kinds` | `kind` | 统一字段名为 `kind`（数组） |
| `callerCollections` | `AccessContext.authorizedCollections` | **不翻译为 NamespaceSelector**（Sol P1）：这是 server-derived ACL，与客户端选择器严格分离。adapter 注入 `AccessContext`（§4.3），组件内部执行 selector ∩ ACL 过滤 |
| `verified` | `verified` | 直接映射 |

### 4.3 数据模型

```typescript
// ── 标识与引用 ──

// 记忆的唯一标识——现有 anchor 直接作为 id
// namespace = 馆标识（project / global / collection-id），组件内部用于 federation 路由
type MemoryKey = { namespace: string; id: string };

// ── 授权上下文（Sol P1 定案：ACL 与 namespace selection 严格分离）──
// callerCollections 是 server-derived authorization（route 层解析产生），
// NamespaceSelector 是调用方选择的搜索范围（客户端可控）。
// 二者不共用类型：AccessContext 由 adapter/server 注入（不是应用契约方法参数），
// 组件内部执行 有效范围 = selector ∩ authorizedCollections。
// 混用会重新制造"客户端 collections 自授私有 collection 可见性"的漏洞。
interface AccessContext {
  authorizedCollections?: string[]; // undefined = 无限制（本地单用户默认）
}

// 真相源引用（"索引可重建"的基础——知道从哪重建）
// revision 必填（Sol P1 定案）——replay-safe 幂等判定的基础，映射现有 sourceHash；
// 手动记忆（无外部真相源）：source='manual'，revision = content hash
type SourceRef = { source: string; sourceId: string; revision: string };

// ── 内容 ──

// 记忆内容——文本或资源引用（预留媒体扩展）
type MemoryContent =
  | { type: 'text'; text: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType: string; indexText?: string };

// ── 生命周期 ──

// 生命周期状态——默认持久化，sunset 是可逆检索过滤
type LifecycleState = 'active' | 'dormant' | 'superseded' | 'invalidated';
// active     — 正常可检索
// dormant    — 真相源暂时缺失或长期零消费候选；数据保留可 read()，默认不出现在 recall()
// superseded — 被新版本取代（supersededBy 指向新 key）；数据保留
// invalidated — F163 矛盾检测标记无效；数据保留
// 硬删除（DELETE）不是状态——是操作，仅响应用户明确删除或 source-delete 事件

// ── 两维度区分：EvidenceStatus × LifecycleState ──
// EvidenceStatus = 'active'|'done'|'archived'|'review'|'invalidated'
//   → 内容的业务状态（feature 开发中/完成/归档…），上层查询可过滤
// LifecycleState = 'active'|'dormant'|'superseded'|'invalidated'
//   → 记忆的检索生命周期（是否可被搜索到），组件内部管理
// 两者正交：一个 done 的 feature doc 仍是 active 记忆；
//           一个 active 的 thread doc 可能是 dormant 记忆（真相源暂时缺失）
// recall() 默认只返回 LifecycleState=active 的记忆，但 EvidenceStatus 可自由过滤

// ── 入库输入 ──

interface MemoryInput {
  key: MemoryKey;                  // 必填——replay-safe 幂等 upsert 的基础
  content: MemoryContent;
  kind: EvidenceKind;
  status?: EvidenceStatus;         // 业务状态（默认 'active'）——源派生记录由 scanner 提供
  sourceRef: SourceRef;            // "索引可重建"的基础——知道从哪重建（revision 必填）
  provenance: { tier: ProvenanceTier; source: string }; // authoritative / derived / soft_clue
  relations?: Array<{ target: MemoryKey; type: string }>;
  metadata?: Record<string, unknown>;
}
// ⚡ replay-safe identity 规则（Sol P1-5 定案）：
//   key 必填（不允许缺省）——源派生记录的 key 由宿主生成（anchor 即 id）
//   同 key + 同 revision → no-op（已有相同版本，跳过）
//   同 key + 异 revision → 覆盖内容 + 刷新 updatedAt
// SourceRef.revision 映射现有 sourceHash（computeThreadSourceHash 等），
// Phase 1 零行为变更——这是把已有行为写进契约
// 备选规则（若有无 key 场景）：(namespace, source, sourceId) 确定性生成 key

// ── 记忆记录（读出）──

interface MemoryRecord {
  key: MemoryKey;
  content: MemoryContent;
  kind: EvidenceKind;
  status: EvidenceStatus;          // 业务状态（必填——EvidenceItem.status 必填，round-trip 忠实）
  lifecycle: LifecycleState;
  provenance: { tier: ProvenanceTier; source: string };
  sourceRef: SourceRef;            // 必填——input 必填则 record 不得降级为可选（round-trip 无损）
  createdAt: string;               // ISO8601
  updatedAt: string;               // ISO8601
  supersededBy?: MemoryKey;        // lifecycle=superseded 时指向新版本
  metadata?: Record<string, unknown>; // input.metadata 原样返回——transport round-trip 不丢扩展字段
}

// ── 消费反馈（F200 事件链：recall → consumed → abandoned）──

// 所有 variant 共享关联键（Sol P1-6——跨 transport/乱序到达后可靠归因）
interface FeedbackCorrelation {
  recallId: string;                // 关联到同一次检索（强制）
  invocationId?: string;           // 关联到同一次 agent invocation
  timestamp: string;               // ISO8601
  resultSetId?: string;            // F200 HW-4: bundle ID
  attributionClarity?: 'clean' | 'ambiguous'; // F200 HW-4 根因③
}

type MemoryFeedback = FeedbackCorrelation & (
  | { event: 'recalled';           // 检索返回了一组候选
      keys: MemoryKey[];           // 候选 keys
      query: string;               // 检索 query
      toolName: string;            // search_evidence / graph_resolve / list_recent
      ranks: number[]; }           // 每个 key 的排名位置（0-indexed）
  | { event: 'consumed';           // 候选被下游工具实际读取
      key: MemoryKey;
      method: string;              // Read / Grep / graph_resolve / drill-down
      rank: number;                // 该 key 在原 recall 中的排名
      distance?: number; }         // 距 recall 调用的工具步数
  | { event: 'abandoned';          // 检索有结果但全部未消费
      query: string;
      toolName: string;
      resultCount: number; }
);
// recordFeedback() 收集这些事件 → 组件内部的消费加权排序（consumption-prior）闭环：
// 被频繁 consumed 的记忆 → recall() 排名提升；被 abandoned 的 → 排名不变（不惩罚）

// ── 检索结果（recall 返回值）──

interface MemorySearchResult {
  items: MemoryRecord[];
  meta: {
    degraded: boolean;                  // scope/namespace 不匹配等降级情况
    degradeReason?: SearchDegradeReason; // 闭集联合（interfaces.ts:268-272），不用裸 string
    effectiveMode?: 'lexical' | 'semantic' | 'hybrid'; // 实际搜索模式（semantic 不可用时降级为 lexical）
    totalCount?: number;                // 命中总数（limit 截断前）
  };
}
// 附录 scope/namespace 不匹配承诺（"返回空结果 + degraded: true，不偷路由"）
// 安放在 meta.degraded 字段上

// ── 生命周期命令（transition 输入）──

type LifecycleCommand =
  | { action: 'dormant'; key: MemoryKey; reason: string }      // 可逆——真相源暂时缺失/零消费候选
  | { action: 'supersede'; key: MemoryKey; supersededBy: MemoryKey } // 可逆——被新版本取代
  | { action: 'invalidate'; key: MemoryKey; contradicts?: MemoryKey[] } // 可逆——F163 矛盾检测
  | { action: 'reactivate'; key: MemoryKey }                   // 可逆——从 dormant/invalidated 恢复
  | { action: 'delete'; key: MemoryKey; reason: 'user_explicit' | 'source_deleted' };
    // ⚠️ 不可逆——仅用户明确删除或真相源确认删除事件。cascade 删除关联 passages
    // 铁律 #5（用户状态默认持久化）要求 delete 的 reason 必须是上述两值之一

// ── 关系查询（related 参数和返回值）──

interface RelationOptions {
  depth?: number;                  // 遍历深度（默认 1）
  relations?: string[];            // 关系类型过滤（feature_ref/related_to/doc_link...）
  namespace?: NamespaceSelector;   // 限定搜索范围（尊重 ACL）
}

// 3-state 判别联合（映射真实 GraphQueryResolution）
type RelationResult =
  | { status: 'graph';             // 精确命中——返回子图拓扑
      resolvedAnchor: string;
      graph: { nodes: GraphNode[]; edges: GraphEdge[]; depth: number; truncated?: boolean };
    }
  | { status: 'candidates';        // 模糊命中——返回候选列表
      candidates: Array<{ key: MemoryKey; title: string; kind: string; matchReason: string }>;
    }
  | { status: 'no_match';          // 无匹配
      message: string;
      examples: string[];           // 示例查询建议
    };

// ── 维护报告 ──

interface MaintenanceReport {
  sunsetActions: { dormant: number; deleted: number; reactivated: number };
  compaction: { passagesMerged: number; orphansClassified: number };
  vectorHealth: { staleEmbeddings: number; reindexed: number };
  timestamp: string;
}

// ── 健康检查 ──

interface MemoryHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  stores: Record<string, { available: boolean; docCount: number; lastUpdated?: string }>;
  degradeReasons?: string[];
}
```

### 4.4 现有代码如何映射

| MemoryComponent 方法 | 现有实现 | 说明 |
|---------------------|---------|------|
| `remember` | IndexBuilder 的写入部分 (docs) + session compiler (conv) | 入库路径按内容类型不同——实现细节。IndexBuilder 的源扫描部分归宿主，写入走 `remember()`，依赖稳定 `MemoryKey/SourceRef` 做 replay-safe 幂等 upsert |
| `recall` | KnowledgeResolver.resolve() + RRF fusion + 消费加权 | 联邦搜索（跨 namespace RRF）是组件内部能力 |
| `read` | IEvidenceStore.getByAnchor() + drill-down | doc=grep 原文 / conv=passages 直返（实现细节） |
| `related` | GraphQueryResolver.resolve(query) + GraphResolver.buildSubgraph(anchor) | 覆盖 graph_resolve 入口：精确遍历 + 模糊解析 → 3-state RelationResult |
| `transition` | deleteByAnchor() + status/supersededBy | ⚠️ 部分实现——LifecycleCommand union 中仅 delete/supersede 有现有代码对应 |
| `recordFeedback` | F200 consumption tracking | 已有，但作为 store 副作用，不是显式能力 |
| `maintain` | 无统一实现 | ⚠️ 需新建 SunsetManager：sunset 执行 + compaction + 向量重建 |
| `health` | IEvidenceStore.health() | ✅ 已有 |

### 4.4b 现有 13 项能力 → MemoryComponent 穷举映射

> **Fable review 验收标准**：新契约必须映射全部 13 项现有能力。映射不上 = 契约有洞或能力该废。

| # | 现有能力（§2.1） | 映射到 | 覆盖度 |
|---|-----------------|--------|--------|
| 1 | 搜索（KnowledgeResolver.resolve） | `recall()` | ✅ 含跨 namespace federation（同 #13） |
| 2 | 存储（SqliteEvidenceStore.upsert/get） | `remember()` + `read()` | ✅ |
| 3 | 扫描入库（IndexBuilder.rebuild） | 源扫描归宿主 → 逐条 `remember()`；`remember()` 做 replay-safe 幂等 upsert。对话类增量入库：宿主消息事件→`remember()`（与周期扫描均合法——"索引可重建"兜底） | ✅ 分离更清晰，瓦解 getDb 逃逸 12 处调用的大头 |
| 4 | 向量嵌入（EmbeddingService） | `remember()` 内部触发 | ✅ 组件内部实现 |
| 5 | 关系图（GraphResolver + edges） | `related()` | ✅ key-based 遍历 + query-based 模糊解析（3-state RelationResult） |
| 6 | 实体识别（resolveEntityAliases） | `recall()` 内部增强——搜索增强，随 recall 透明生效 | ✅ 内部能力，不出现在契约方法上 |
| 7 | 标记物化（MarkerQueue → MaterializationService） | **宿主侧治理流程**——MarkerQueue→MaterializationService 产出 .md 写入真相源，组件通过后续 rebuild 以 `remember()` 入库其产物。物化不穿透 MemoryComponent 边界 | ✅ 归属显式化 |
| 8 | 浏览最近（RecentBrowseResolver） | `recall()` + filter/sort 模式 | ✅ |
| 9 | 消费加权（F200） | `recordFeedback()` → `recall()` 排序 | ✅ |
| 10 | 矛盾检测（F163 contradicts） | `maintain()` 内部逻辑 | ✅ |
| 11 | 质量分层（provenance: authoritative/derived/soft_clue） | `MemoryInput.provenance`（一等字段，非 metadata）+ `recall()` 的 `provenanceTier` filter | ✅ 两处覆盖 |
| 12 | Drill-down（depth 参数控制取全文） | `read()` 返回 inline/resource union | ✅ |
| 13 | 联邦搜索（跨 store RRF 融合） | `recall()` 内部跨 namespace RRF 融合 | ✅ 组件内部能力 |

### 4.5 为什么是 MemoryComponent 而不是 IEvidenceStore

| 层级 | 职责 | 作为替换边界的问题 |
|------|------|------------------|
| `IEvidenceStore` | 存储 SPI（search/upsert/delete/get） | 只换书架没换图书管理员——缺入库管道、联邦搜索、生命周期管理 |
| `KnowledgeResolver` | 联邦搜索 + scope 路由 | 只是部分能力，不含入库/下架/维护 |
| **`MemoryComponent`** | **完整记忆能力** | **应用契约——"含图书管理员的完整图书馆"** |

之前版本的错误坐标系：`DocProvider + ConversationProvider`——让宿主用内容类型路由把两个半组件拼成一个"完整组件"。正确坐标系：宿主只看到一个 MemoryComponent，内容类型的区别是组件内部实现。

### 4.6 之前设计中的概念去向

| 之前设计的 | 处置 | 理由 |
|-----------|------|------|
| `DocProvider + ConversationProvider` | **删除**（本轮新增否决） | 宿主不应按内容类型路由到不同 provider |
| `RetrievalProvider`（Layer 2 域接口） | 删除 | MemoryComponent 已是正确的能力层 |
| `Wire Contract`（Layer 3 独立架构层） | **降级为 transport adapter** | "客户端应用"≠"一定进程内"；EchoMem 可能是独立进程。HTTP/socket 是 MemoryComponent 的可选 transport，不是独立架构层 |
| `RouteSlot`（primary/fallback/shadow） | 删除 | 不同时跑两个后端 |
| `CanonicalId` domain grammar（`doc:/conv:`） | **简化为 MemoryKey** | 无路由含义，现有 anchor 直接作为 id |
| `ProviderFailure`（分类错误） | 删除 | `health()` 已够用 |
| `isProjectLocalScope` scope 路由 | **保留为内部 scope→filter 翻译** | 组件内部按 scope 过滤内容类型，一行代码 |
| Federation Layer（外部跨馆） | **收回组件内部** | federation 属于完整记忆管理能力（Sol 定案），per-namespace 替换 = coordinator 借尸还魂 |

---

## 5. 能力缺口（组件化前或过程中必须解决）

### 5.1 Sunset 能力缺失

co-creator 的能力清单里有"无效的记忆逐渐 sunset"。现有机制（status lifecycle / supersededBy / F163 contradicts）覆盖了**文档类**的下架，但**对话类的 sunset 是断的**：

**症状**：188 个孤儿 passage（doc 被 cleanup 删除，passage 永久堆积）

**根因**：`deleteByAnchor()` 只删 `evidence_docs`，不级联删 `evidence_passages`（全 codebase 无 `DELETE FROM evidence_passages`）。更深层：thread 记忆保留策略矛盾——doc 层有清理机制，passage 层没有。

**按图书馆模型**：下架是图书馆的内部职责，上层不该知道细节，但**两个书架都必须实现下架能力**。

| 内容类型 | 现有 sunset | 缺口 |
|---------|-----------|------|
| 文档类 | status lifecycle + supersededBy + F163 | ⚠️ 有字段和信号，无统一执行器 |
| 对话类 | 无 | ❌ 需要：父子 lifecycle 一致性（doc 转 dormant 时 passage 跟随） + thread 记忆保留策略 |

组件化后，`MemoryComponent.maintain()` 必须覆盖对话类记忆的 sunset。这是 `maintain()` 的核心实现内容之一。

**Sunset 信号→状态映射表**（Fable + Sol 联合定稿——188 孤儿 passages 是新契约的第一个验收用例）：

| 信号 | 状态转换 | 说明 |
|------|---------|------|
| `supersededBy` 写入 | active → superseded | ✅ 已有 |
| F163 `contradicts[]` + `invalidAt` | active → invalidated | ✅ 已有 |
| 扫描发现真相源**暂时缺失** | active → dormant（保留数据可 read，默认不搜） | ❌ **当前硬删 doc + 漏删 passage**——孤儿根因 |
| F200 长期零消费（阈值待定） | active → dormant 候选（进 review queue，不自动下架） | ❌ 需实现 |
| 用户**明确删除** / 明确 source-delete 事件 | hard delete + cascade | 仅此情况才硬删 |

> **关键区分（Sol 精化）**：第三行（暂时缺失）和第五行（明确删除）必须分开。"父 doc 不在了"不等于"用户要求删除"——孤儿 passage 是用户对话数据，级联硬删违反**铁律 #5（用户状态默认持久化，TTL/删除只能用户 opt-in）**。188 个孤儿应先按删除原因分类，dormant 而非清空。
>
> 现有文档类 lifecycle 也不能写"基本完整"——有字段和 review 信号，但没有统一执行器（SunsetManager 不存在）。**这张表让孤儿问题从 bug 变成 `maintain()` 的第一个验收用例。**

**188 孤儿 passages 分类程序**（`maintain()` 第一个验收用例）：

1. **扫描**：检测所有 `evidence_passages` 中 `doc_anchor` 无对应 `evidence_docs` 的记录（当前 188 个 orphan anchor，去重后 188 thread-id）
2. **逐 anchor 判定删除原因**：
   - a. transcript JSONL / Redis 仍存该 thread 消息 → **dormant**（真相源存在，可 rebuild `remember()` 重入库）
   - b. 真相源确认已被用户**明确删除**（有 delete 事件记录） → **hard delete + cascade**（passages 同步删除）
   - c. 无法确定（找不到 thread 也找不到删除事件） → **dormant**（保守默认——铁律 #5）
3. **执行状态转换**：dormant 记录保留数据，可 `read()` 按 key 直取，默认不出现在 `recall()` 结果中
4. **记录到 MaintenanceReport**：分类统计（N dormant / M deleted / K uncertain→dormant）供 review queue 审查
5. **后续 rebuild 周期**：dormant 中真相源恢复的 → 自动 `active`；长期 dormant 无消费的 → 进 F200 零消费 review queue

### 5.2 媒体扩展点

co-creator 提到记忆数据可以有"文本、图之类的"。当前 `EvidenceItem` 是纯文本。§4.3 的 `MemoryContent` union（`text | resource`）已预留扩展位——图片等资源用 URI/blob reference + 可检索文本投影（`indexText`），核心接口不存二进制。具体实现延后到有实际需求时。

---

## 6. 后端替换模式（按需）

MemoryComponent 的替换有两种诚实定位（以 EchoMem 为例）：

### 6.1 完整组件替换

EchoMem 实现全部 MemoryComponent 契约 → 整体替换 LocalMemoryComponent：

```
步骤 1: 实现 EchoMemComponent implements MemoryComponent
         - remember/recall/read/related/transition/recordFeedback/maintain/health 全部实现
         - 入库管道、生命周期管理、联邦搜索、搜索语义 全部自治

步骤 2: 数据迁移（停机迁移——客户端应用重启即可）
         - 从 SQLite 导出全部数据（docs + passages + edges）
         - 批量导入新后端
         - 验证：相同 query 结果一致

步骤 3: 切换配置 → 完成
```

### 6.2 内部子模块（future/non-goal for this round）

EchoMem 只处理部分能力（如对话记忆）→ 作为 LocalMemoryComponent 的内部 adapter，宿主不知道它的存在。**本轮不设计内部 backend SPI**——需要时再加 `LibraryBackend` 接口：

```
MemoryComponent (LocalMemoryComponent)
    ├── 文档类：仍用 SqliteEvidenceStore + IndexBuilder
    ├── 对话类：内部委托给 EchoMem adapter
    └── 路由/融合/生命周期：LocalMemoryComponent 自行管理
```

这等价于图书馆把期刊管理外包——读者不知道，只看到一个图书馆前台。

### 6.3 不纳入 Abstract 1047

如果 EchoMem 的能力与我们的 MemoryComponent 不匹配 → 不硬塞，作为独立工具使用。

**共同原则**：没有 shadow 双跑、没有 fallback、没有渐进式切换。客户端应用——停机迁移是正常模式。

---

## 7. 实施计划

### Phase 1: 形式化 MemoryComponent 接口（零行为变更）

1. 定义 `MemoryComponent` 接口（remember/recall/read/related/transition/recordFeedback/maintain/health）+ `MemoryQuery` / `LifecycleCommand` / `RelationResult` 判别联合
2. 实现 `LocalMemoryComponent`：组合现有 KnowledgeResolver（含 federation）+ SqliteEvidenceStore（SunsetManager 是 Phase 2 交付物，Phase 1 不组合）。**IndexBuilder 的源扫描部分留在组件外**，通过 `remember()` 写入
3. 上层 MCP 工具（search_evidence / list_recent / graph_resolve）改为调用 MemoryComponent
4. 行为兼容测试：重构前后，相同调用产出相同结果

**交付物**：现有测试全部通过，搜索结果 diff = 0，上层无感知。IndexBuilder 的 `getDb` 逃逸显著减少

### Phase 2: Sunset 治理（与 Phase 1 并行或之后）

1. 实现 SunsetManager：统一 lifecycle 执行器，按 §5.1 信号→状态映射表接线
2. 188 孤儿 passages 分类处理：按删除原因分为 dormant（真相源暂时缺失）或 hard delete（明确删除事件），不整批清空
3. `transition()` 实现 LifecycleCommand 联合：可逆状态转换（dormant/supersede/invalidate/reactivate）+ 不可逆硬删除（仅 user_explicit/source_deleted）
4. `maintain()` 定期执行：dormant 候选审查（零消费检测）、过期 dormant 清理建议（进 review queue）

### Phase 3: 后端替换（按需）

如果决定用 EchoMem 或其他外部记忆服务（见 §6 两种模式）：
1. 选择替换模式：完整组件（§6.1）或内部子模块（§6.2）
2. 实现对应接口（MemoryComponent 或内部 adapter）
3. 数据迁移 + 配置切换

### 验收

| 阶段 | 验收条件 |
|------|---------|
| Phase 1 | 搜索结果 diff = 0（重构前后行为完全一致）；上层工具无感知 |
| Phase 2 | 188 孤儿按 §5.1 分类程序完成（dormant/delete/uncertain→dormant）；信号→状态映射全部接线；`maintain()` 返回 MaintenanceReport 含分类统计 |
| Phase 3 | F200 Memory Recall Eval：换后端后召回率 ≥ 0.95 × 基线 |

---

## 8. 与前身文档的关系

前身文档（memory-service-componentization.md，1679 行）已标 `superseded`。它定义了三原语模型（TextBlock / RelationEdge / Timeline）和完整的服务 SPI。那是面向**独立记忆服务**的设计，包含 shadow、DocMemory/ConversationMemory、Provider/Wire 等已被本文档否决的架构概念。

**本文档是记忆组件化的唯一决策真相源**（三方共识：Sol + Fable + opus）。处置：

- `MemoryComponent` 是**唯一逻辑契约**
- 进程内调用或 HTTP/socket 是该契约的**可选 transport adapter**，不是独立架构层
- 前身文档的三原语 SPI 可作为一种 transport 实现方案的附录参考，但不拥有架构决策权
- Storage SPI（IEvidenceStore）是具体实现内部细节，不是应用契约
- 前身文档中仍有效的通用教训（LL-090..093）已独立沉淀，不依赖该文档的架构叙述

---

## 9. 显式否决记录

### 从前一版继承的否决（与 SaaS/客户端无关，仍然成立）

| # | 否决方向 | 理由 |
|---|---------|------|
| 1 | Conversation 伪装成 external collection | CollectionManifest 必填字段（root/scannerLevel/indexPolicy）对对话无意义 |
| 2 | 三原语 MemoryStore 直接充当跨团队协议 | MemoryStore 是存储 SPI，跨团队需要域接口 |
| 3 | scope=sessions 路由到 ConversationProvider | `sessions` 在 store 层映射为 `kind=session`（scanner 产物），归 Doc |

### 本轮新增否决

| # | 否决方向 | 理由 |
|---|---------|------|
| 4 | 同时跑两个后端 + shadow 对比 | 客户端应用不需要渐进式切换，停机迁移是正常模式 |
| 5 | 隐私过滤层（egress filter / thread sensitivity） | 客户端应用，用户数据在用户机器上，不存在"出境"概念 |
| 6 | 新增 RetrievalProvider / RouteSlot 抽象层 | MemoryComponent 已是正确的能力层 |
| 7 | 消息队列级可靠性（outbox / at-least-once / exactly-once） | 索引可重建（缓存语义），hook + 定期 rebuild 补漏是合法方案 |
| 9 | 宿主按内容类型路由到 DocProvider + ConversationProvider | 让宿主用 doc/conv 路由把两个半组件拼成一个"完整组件"——破坏可替换性（Sol pushback） |
| 10 | 宿主持有多个 MemoryComponent 实例做 per-namespace 替换 | Federation 是完整记忆管理能力的一部分，归组件内部。per-namespace 替换 = coordinator 借尸还魂（Sol 定案，Fable 撤回"一实例一馆"后同意） |
| 11 | 级联硬删 188 孤儿 passages 作为 sunset 默认修复 | 违反铁律 #5（用户状态默认持久化）。"父 doc 不在"是索引状态不是用户删除意图。正确做法：dormant（Fable + Sol 联合） |

### 从前一版降级的决策（内核保留，结论调整）

| # | 原否决 | 调整 |
|---|--------|------|
| 8 | "先 shadow 后补 ID" 被否决 | 改写：shadow 没了，但"统一 ID 映射先于数据迁移"仍是迁移前置条件 |

---

## 附录：关键源码锚点

| 组件 | 文件 | 说明 |
|------|------|------|
| 搜索路由 | `KnowledgeResolver.ts:240-242` | `isProjectLocalScope()` — 组件内部 scope→filter 翻译 |
| 存储接口 | `interfaces.ts:340-352` | `IEvidenceStore` — 组件内部存储 SPI（非应用契约） |
| 搜索选项 | `interfaces.ts:231-266` | `SearchOptions` — scope/dimension/depth |
| 数据类型 | `interfaces.ts:33-43` | `EVIDENCE_KINDS` — 9 种 kind |
| 向量嵌入 | `interfaces.ts:398+` | `EmbedConfig` |
| RRF 融合 | `KnowledgeResolver.ts:249-270` | 多源结果融合排序 |
| 孤儿根因 | `SqliteEvidenceStore.ts:1362-1367` | `deleteByAnchor` 不级联 |
| scope→kind 映射 | `SqliteEvidenceStore.ts:176-177` | `sessions → kind=session` |

## 附录：scope 与 namespace 映射（LocalMemoryComponent 实现参考）

> 两个独立的内部过滤维度（替代原来的 30 格矩阵），不是 MemoryComponent 应用契约。

**scope（馆内内容类型过滤）**：

| scope 值 | 过滤为 kind | 说明 |
|----------|-----------|------|
| `threads` | kind=thread + passages | 对话消息 |
| `sessions` | kind=session | scanner 产物（source-based ownership） |
| `docs` / `memory` | kind ∈ {feature,plan,decision,...} | 文档知识 |
| `undefined` / `all` | 不过滤 | 全内容类型 |

**namespace（NamespaceSelector 五值，选哪些馆）**：

| NamespaceSelector 值 | 搜索范围 |
|---------------------|---------|
| `'project'` | 本项目馆 |
| `'global'` | 全局馆 |
| `'all'` | project + global 融合（**legacy 行为**，不含 collections——对应现有 `dimension='all'`） |
| `'library'` | 全部 routable collections 扇出（对应现有 `dimension='library'`） |
| `{ collections: [id...] }` | 指定外部知识库（对应现有 `dimension='collection'`） |
| `undefined` | 默认 = `'all'`（沿用现有 resolver defaulting，零行为变更） |

> 有效搜索范围 = selector ∩ `AccessContext.authorizedCollections`（§4.3——ACL 由 adapter 注入，不进 selector）。

> scope 与 namespace 不匹配时：返回空结果 + `degraded: true`，**不偷路由**。

## 附录：被替换的前一版

前一版 "EchoMem 协作方案 — 三层架构设计"（1190 行，commit `f2bed3d62`）基于两个错误前提设计：

1. 把 Clowder AI 当 SaaS 服务（设计了隐私过滤、多租户分区）
2. 把组件化当多后端同时运行（设计了 shadow 双跑、fallback routing、渐进式迁移）

经过 co-creator 方向纠正后，以正确前提（客户端应用 + 按能力抽象）重写为本版。
前一版的 review 过程（codex/Fable/Sol 7 轮）中沉淀的教训（LL-090..093）仍然有效——它们是关于协议设计的通用教训，不依赖 SaaS 假设。
