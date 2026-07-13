---
title: "记忆服务组件化 — 三原语模型"
participants: [opus, codex, fable, sol, lang]
status: superseded
superseded_by: memory-component-abstraction.md
created: 2026-06-25
doc_kind: decision
decision_id: ADR-candidate
feature_ids: [F102]
topics: [memory, architecture, service-contract, componentization, adr]
---

# ADR: 记忆服务组件化 — 三原语模型

> ⚠️ **SUPERSEDED** — 本文档已被 [记忆能力抽象 — MemoryComponent 契约](memory-component-abstraction.md) 取代。
> 三原语 SPI 降为可选 transport 附录参考。Shadow、DocMemory/ConversationMemory、Provider/Wire 等架构概念已被否决。
> **新的记忆组件化真相源**：[memory-component-abstraction.md](memory-component-abstraction.md)

> ~~**Status**: proposed（待 maintainer review）~~
> **Status**: superseded（2026-07-13，三方共识：Sol + Fable + opus）
> **Deciders**: operator + Ragdoll(opus) + Maine Coon(codex)
> **Date**: 2026-06-25
> **Issue**: [#1047](https://github.com/zts212653/clowder-ai/issues/1047)
> **Prior Art**: [ADR-020](../decisions/020-f102-memory-system-architecture.md) — F102 Memory System Architecture

## Context

Clowder AI 的记忆系统（ADR-020 建立）当前紧耦合在宿主进程内：
`SqliteEvidenceStore` + `IndexBuilder` + `EmbeddingService` + `EntityRegistry` 共同构成一个不可替换的整体。

外部需求推动了组件化：
- **EchoMem 团队**希望基于我们的接口规范对齐其三面记忆模型（Atomic Truth + Episode + Association Graph）
- **Memory-System-Eval-Harness** 需要标准化的 MemoryPlugin 接口适配
- **多 collection 联邦**（`KnowledgeResolver` 扇出）已暗示需要可插拔的 backend provider

核心问题：**如何定义宿主和独立记忆组件之间的边界，使检索/存储后端可整体替换，且不破坏现有的 recall 语义？**

## Decision

### 三数据原语模型

按存储语义和操作语义的本质差异，将记忆服务拆分为三种数据类型原语：

| 原语 | 存储语义 | 写入模型 | 查询模型 |
|------|---------|---------|---------|
| **TextBlock** | 文本内容 + 嵌入向量 | upsert（last-write-wins） | 语义/词法/混合搜索 |
| **RelationEdge** | 有向类型化关系 | link（幂等） | 邻居遍历 + 路径查询 |
| **Timeline** | 时序追加事件流 | append-only | 范围查询 + 最新 N 条 |

加 **EntityResolver** 基础设施层（非数据原语）：实体别名解析增强搜索召回，含管理接口（seed/list/get/refreshMentions）。

加 **EmbeddingProvider** 基础设施层：记忆组件是 embedding 的消费者，init 时注入 endpoint 配置；服务生命周期（安装/启停）走宿主统一服务管理。

### 关键边界决策

| 决策 | 立场 |
|------|------|
| 真相源 | 始终是 docs/*.md + thread 消息历史 + 实体种子。服务是编译索引 |
| Project store | 默认本地 SQLite（离线韧性），SPI 允许配置切换 |
| Thread 摘要 / 任务追踪 | 留在宿主（绑定 thread 生命周期） |
| EntityResolver | 服务优先 + 宿主 fallback |
| Embedding | 记忆组件是消费者，不是所有者。服务生命周期（安装/启停）走宿主统一服务管理；记忆组件 init 时注入 endpoint 配置，通过该 endpoint 调用 embedding。宿主通过 capabilities 和 effectiveMode 感知状态 |
| Namespace 隔离 | 硬隔离，每 collection 一个 namespace |
| API 版本控制 | Header-based，仅向后兼容新增 |

### 迁移安全验证策略

1. **行为兼容测试套件**：相同种子数据，`SqliteEvidenceStore` 和 `MemoryServiceAdapter` 产出相同结果集
2. **Shadow mode**：Phase 2 对非核心 collection 双跑对比
3. **SPI 骨架不变量**：Phase 1 纯结构重构，测试输出 diff 为空
4. **Passage hydration 回归**：`depth=raw` + `contextWindow` + `thread-${threadId}` anchor 标准化

## Consequences

**正面**：
- 记忆后端可整体替换（EchoMem、云端服务、其他实现）
- Eval-Harness 9 方法全覆盖，可接入标准化评测
- 渐进实现：最小可用 = textBlock only，逐步加 relationEdge/timeline/entityResolution
- 现有 `KnowledgeResolver` / `GraphResolver` 完全不变

**负面**：
- 接口抽象层增加了间接性（adapter 映射成本）
- EntityResolver 管理接口 vs 搜索透明接口的边界需要持续维护
- 迁移期间两套实现共存

**风险**：
- Passage hydration / threadId anchor 标准化是等价性最脆弱的点
- Embedding 模型版本不一致会导致向量空间不兼容

---

*以下为完整设计规格（§1-§10），供 maintainer 深入审阅。*

---

## 1. 当前架构 — 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                      源数据（真相源）                                │
│                                                                     │
│  docs/*.md          thread messages       config/entity-seeds.json  │
│  （feature/决策/     （每个 thread 的       （人/猫/feature           │
│    计划等文档）       消息，通过              别名定义）               │
│                      messageListFn）                                │
└──────┬──────────────────┬──────────────────────┬────────────────────┘
       │                  │                      │
       ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      编译层（IndexBuilder）                          │
│                                                                     │
│  CatCafeScanner        passage 提取            实体种子加载          │
│  .discover()           content + speaker       upsertEntities()     │
│  → ScannedEvidence     + timestamp                                  │
│  → title/summary/      → passage rows                              │
│    keywords/kind                                                    │
│                                                                     │
│  EmbeddingService（可选，内置小模型）                                │
│  → 文档向量 (evidence_vectors)                                      │
│  → passage 向量 (passage_vectors)                                   │
└──────┬──────────────────┬──────────────────────┬────────────────────┘
       │                  │                      │
       ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  编译索引（SQLite evidence.sqlite）                  │
│                                                                     │
│  evidence_docs ──► evidence_fts (BM25: title + summary)            │
│  evidence_passages ──► passage_fts (BM25: content)                 │
│  evidence_vectors (vec0: 文档嵌入)                                  │
│  passage_vectors (vec0: passage 嵌入)                               │
│  edges（关系图：anchor → anchor）                                   │
│  entity_registry + entity_aliases + entity_mentions                 │
│                                                                     │
│  ──── 仅宿主（不属于检索索引） ────                                 │
│  markers（候选记忆队列，YAML 后端 git-tracked）                     │
│  recall_events + anchor_recall_metrics（F200 消费追踪）             │
│  summary_segments + summary_state（thread 摘要）                    │
│  task_trajectories, scheduler_*, f163_*（治理/分析）                │
└──────┬──────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          检索层                                     │
│                                                                     │
│  KnowledgeResolver（跨 N 个 collection 联邦检索）                   │
│    ├─ project:cat-cafe store (IEvidenceStore)                       │
│    ├─ global:methods store (IEvidenceStore)                         │
│    └─ 外部 collection stores (各自 IEvidenceStore)                  │
│         ↕ RRF 融合 + 脱敏 + 降级元数据                             │
│                                                                     │
│  猫猫面对的三个入口：                                               │
│    search_evidence  → 词法/语义/混合搜索，scope/depth/mode          │
│    graph_resolve    → anchor → 边遍历 → 关联文档                    │
│    list_recent      → 按时间排序的最近证据                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 猫猫实际看到什么

1. 猫调用 `search_evidence("thread memory architecture")`
2. → `KnowledgeResolver.resolve()` 扇出到 N 个 collection store
3. → 每个 store 跑 BM25 + 可选向量搜索，返回 `EvidenceItem[]`
4. → Resolver 做 RRF 融合、脱敏、降级元数据
5. → 猫拿到 title + summary + anchor + drillDown 提示
6. → 猫用 `Read` 工具 grep **原始 .md 文件**获取详情
   （原始文件内容不在 evidence store 里）

### evidence store 实际索引了什么

- **文档级**：title、summary、keywords（从 .md frontmatter + 正文提取）
- **Passage 级**：单条 thread 消息（content + speaker + timestamp）
- **向量**：以上内容的嵌入（embedding service 启用时）
- **实体**：别名注册表，用于查询扩展（"砚砚" → 同时搜索 "缅因猫"）
- **边**：anchor 之间的关系图

---

## 2. 提取边界：什么移出 vs 什么留下

### 移到独立记忆服务

| 数据 | 当前表 | 映射到原语 | 为什么移出 | EchoMem 协作归属（§11） |
|------|--------|-----------|-----------|----------------------|
| 文档级索引 | `evidence_docs` + `evidence_fts` | **TextBlock** | 核心检索 | 按来源切：scanner 产物 → DocMemory；对话事件流 → ConversationMemory |
| Passage 级索引 | `evidence_passages` + `passage_fts` | **TextBlock**（parentId 模式） | 核心检索 | 按来源切：round-result / 消息流 → ConversationMemory |
| 文档嵌入 | `evidence_vectors` | TextBlock 基础设施 | 语义搜索 | 各 provider 自有嵌入索引 |
| Passage 嵌入 | `passage_vectors` | TextBlock 基础设施 | 语义搜索 | 各 provider 自有嵌入索引 |
| 实体注册表 + 别名 | `entity_registry` + `entity_aliases` | **EntityResolver**（基础设施层） | 搜索增强 | provider-local + 可选共享 normalizer（见 [EchoMem 协作方案](memory-component-abstraction.md) §2.2） |
| 关系图 | `edges` | **RelationEdge** | graph_resolve 支持 | 当前 DocMemory；ConversationMemory 后续可自建（见 [EchoMem 协作方案](memory-component-abstraction.md) §5.3） |

### 留在 Clowder 宿主

| 数据 | 当前表 | 为什么留下 | EchoMem 协作归属（§11） |
|------|--------|-----------|----------------------|
| 候选记忆队列 | `markers`（YAML 后端，git-tracked） | 治理流程（捕获 → 审批 → 物化） | 我们 |
| 认知转变事件 | EventMemory（`event_memory` 表） | Timeline 原语，归 DocMemory（见 [EchoMem 协作方案](memory-component-abstraction.md) §5） | 我们 |
| 召回分析 | `recall_events`, `anchor_recall_metrics`, `global_ctr_baseline` | 宿主侧消费行为，用于 rerank | 我们 |
| Thread 摘要 | `summary_segments`, `summary_state` | 绑定 thread 生命周期 | 待定（EchoMem Episode 摘要更强，见 [EchoMem 协作方案](memory-component-abstraction.md) §5） |
| 任务追踪 | `task_trajectories`, `task_run_ledger` | 调度器领域 | 我们 |
| 治理表 | `f163_*`, `scheduler_*`, `index_state` | 宿主内部状态 | 我们 |

### 边界原则

> 独立服务是一个**编译索引服务**，不是真相源。
> 真相源始终是：`docs/*.md` 文件 + thread 消息历史 + 实体种子。
> 服务存储的编译检索索引可以从真相源重建。

---

## 3. 服务契约 v0（按三原语模型重写）

### 3.1 核心概念

| 概念 | 说明 |
|------|------|
| **TextBlock** | 文本内容原语 — 可检索单元，含 id、content、title、summary，自动建立词法和向量索引 |
| **RelationEdge** | 关系原语 — 两个锚点之间的有向类型化关系，支持图遍历 |
| **Timeline** | 时序原语 — 追加制事件流，按时间范围查询 |
| **EntityResolver** | 基础设施层 — 实体别名解析，增强搜索召回（不是数据原语） |
| **Namespace** | 隔离边界 — 每个 Clowder 项目/collection 一个 namespace |

### 3.2 数据模型

> 完整定义见 §10.3-§10.5。此处为 API 视角的精简版。

```typescript
// ── TextBlock（文本内容原语） ──
// 对应 §10.3 的完整定义

interface TextBlock {
  id: string;                           // namespace 内唯一
  content: string;                      // 文本内容（BM25 + 向量索引）
  title?: string;                       // 显示标题
  summary?: string;                     // 摘要
  keywords?: string[];                  // 关键词（BM25 索引维度）
  kind?: string;                        // 类型标签（宿主定义值域）
  status?: string;                      // 生命周期状态（宿主定义值域）
  parentId?: string;                    // 父块 ID（passage-in-document 层级）
  position?: number;                    // 在父块中的排序位置
  supersededBy?: string;                // 被替代块 ID（版本链）
  namespace: string;                    // 隔离边界
  tags?: string[];                      // 自由标签
  createdAt: string;                    // ISO8601
  updatedAt?: string;                   // ISO8601
  validFrom?: string;                   // 时效起始
  validUntil?: string;                  // 时效终止
  source?: Provenance;                  // 来源追踪
  metadata?: Record<string, unknown>;   // 宿主扩展点（不透明）
}

// ── RelationEdge（关系原语） ──
// 对应 §10.4 的完整定义

interface RelationEdge {
  fromId: string;                       // 源锚点
  toId: string;                         // 目标锚点
  relation: string;                     // 关系类型（宿主定义值域）
  weight?: number;                      // 边强度 0-1（默认 1）
  namespace: string;
  tags?: string[];
  createdAt: string;
  source?: Provenance;
  metadata?: Record<string, unknown>;
}

// ── TimelineEvent（时序事件原语） ──
// 对应 §10.5 的完整定义

interface TimelineEvent {
  id: string;                           // 唯一事件 ID
  timelineId: string;                   // 所属时间线 ID
  type: string;                         // 事件类型（宿主定义值域）
  timestamp: string;                    // ISO8601 事件时间
  content: string;                      // 事件内容
  namespace: string;
  tags?: string[];
  createdAt: string;
  source?: Provenance;
  metadata?: Record<string, unknown>;
}

// ── 共享类型 ──

interface Provenance {
  type: string;                         // 'manual' | 'extracted' | 'derived' | ...
  uri?: string;                         // 来源标识
  confidence?: number;                  // 0-1
}

// ── 搜索 ──
// 类型化过滤器 — 已对照 SqliteEvidenceStore.search() 验证。
// 宿主侧路由字段（dimension, collections, intent）不会到达单个 store。

interface TextSearchOptions {
  mode?: 'lexical' | 'semantic' | 'hybrid';  // 默认 hybrid
  limit?: number;
  namespace?: string;
  kind?: string;
  status?: string;
  tags?: string[];                      // 标签过滤（AND 语义）
  keywords?: string[];                  // 关键词过滤（匹配 TextBlock.keywords）
  dateFrom?: string;                    // ISO8601 包含下界
  dateTo?: string;                      // ISO8601 包含上界
  parentId?: string;                    // 限定在某父块下搜索
  depth?: 'block' | 'withChildren';     // block=只返回匹配块;
                                        // withChildren=父块附带 children[] 填充
  contextWindow?: number;               // 返回匹配 passage 周围 N 个兄弟块（填充到 children/context 中）
  explain?: boolean;                    // 在结果中标注匹配原因
  extra?: Record<string, unknown>;      // 宿主专属过滤器扩展点
}

interface TextSearchResult {
  block: TextBlock;
  score: number;
  matchReasons?: string[];              // explain=true 时填充
  children?: TextBlock[];               // depth=withChildren 时填充
  entityMatches?: Array<{               // EntityResolver 匹配到的实体
    entityId: string;
    canonicalName: string;
    matchedAlias: string;
    type: string;                       // 实体类型
    confidence: number;                 // 匹配置信度 0-1
  }>;
}

interface SearchResponse {
  results: TextSearchResult[];
  meta: {
    effectiveMode: 'lexical' | 'semantic' | 'hybrid';
    degraded: boolean;
    degradeReason?: string;               // SPI 用 string（不依赖宿主联合——SPI 可独立发布）
    // 宿主 coordinator 通过 storeMetaToHost() 映射到 SearchDegradeReason（见 EchoMem 协作设计 §2.3）
    totalCandidates?: number;
    traceId?: string;
  };
}

// ── 能力声明 ──

interface StoreCapabilities {
  // 原语支持
  textBlock: boolean;
  relationEdge: boolean;
  timeline: boolean;
  // 搜索模式
  lexicalSearch: boolean;
  semanticSearch: boolean;
  hybridSearch: boolean;
  // 图能力
  graphTraversal: boolean;               // RelationEdge.traverse() 深度遍历
  // 搜索增强
  entityResolution: boolean;             // search() 自动解析实体别名
  // 可观测性
  stats: boolean;                        // 计数统计
  evidenceTrace: boolean;                // 返回匹配原因 + 分数
  // 限制
  maxDocuments?: number;
  // 嵌入索引延迟
  embeddingReadyMode?: 'sync' | 'eventual';
}
```

### 3.3 API 端点

```
# ── 发现与可观测性 ──
GET  /capabilities                      → StoreCapabilities
GET  /health                            → StoreHealth
GET  /stats                             → { blockCount, edgeCount, timelineCount,
                                             indexFreshness, lastRebuildAt }
POST /integrity                         → { ok: boolean, issues: string[] }
                                           （已存储数据与索引数据的一致性检查）

# ── TextBlock（文本内容原语） ──
POST /blocks/search                     → SearchResponse
     body: { query: string, options?: TextSearchOptions }
POST /blocks/put                        → void
     body: TextBlock
POST /blocks/batch-put                  → void
     body: { blocks: TextBlock[] }
GET  /blocks/:id                        → TextBlock | 404
DELETE /blocks/:id                      → 204
POST /blocks/list                       → TextBlock[]
     body: TextBlockFilter

# ── RelationEdge（关系原语） ──
POST /edges/link                        → void
     body: RelationEdge
POST /edges/unlink                      → void
     body: { fromId, toId, relation }
POST /edges/neighbors                   → Neighbor[]
     body: { id, direction?, relation?, namespace?, limit? }
POST /edges/traverse                    → TraversalResult
     body: { startId, maxDepth?, direction?, relation?, limit? }
POST /edges/list                        → RelationEdge[]
     body: EdgeFilter

# ── Timeline（时序事件原语） ──
POST /timelines/append                  → void
     body: TimelineEvent
POST /timelines/range                   → TimelineEvent[]
     body: { timelineId, from?, to? }
POST /timelines/latest                  → TimelineEvent[]
     body: { timelineId, count }
GET  /timelines/:id                     → TimelineEvent | 404
POST /timelines/list                    → TimelineEvent[]
     body: TimelineFilter
POST /timelines/trim                    → { deleted: number }
     body: { timelineId, before }

# ── 索引管理 ──
POST /rebuild                           → { status: 'started' | 'completed', stats? }
GET  /rebuild/status                     → { phase, percent, stats? }
```

### 3.4 Namespace 隔离

每个请求包含 namespace header：

```
X-Memory-Namespace: project:cat-cafe
```

服务按 namespace 隔离数据。单个服务实例可以服务多个 Clowder 项目或 collection。

### 3.5 认证

Phase 1：通过 header 传共享密钥（`Authorization: Bearer <token>`）。
未来：远程部署时使用 mutual TLS 或 OAuth2 client credentials。

### 3.6 错误语义

```
200  成功
400  请求错误（无效查询/body）
404  文档/实体未找到
409  冲突（严格插入时 ID 重复）
429  限频
500  内部错误
503  服务不可用（索引中、依赖故障）
```

所有错误响应包含：
```json
{ "error": "<code>", "message": "<人类可读>", "retryable": true|false }
```

---

## 4. Clowder 宿主适配器

### 4.1 架构

```
┌─ Clowder 宿主 ─────────────────────────────────────────────────┐
│                                                                  │
│  search_evidence / graph_resolve / list_recent（MCP 工具）       │
│       │                                                          │
│       ▼                                                          │
│  KnowledgeResolver ─── 扇出到 N 个 collection store              │
│       │                    │              │                      │
│       ▼                    ▼              ▼                      │
│  SqliteEvidence     SqliteEvidence    MemoryService               │
│  Store (project)    Store (global)    Adapter ◄── 新增            │
│       │                                  │                       │
│       │                    ┌─────────────┘                       │
│       │                    ▼                                     │
│       │              MemoryServiceClient                         │
│       │                    │                                     │
└───────│────────────────────│─────────────────────────────────────┘
        │                    │
   本地 SQLite          HTTP / 本地 socket
                             │
                    ┌────────▼─────────┐
                    │     独立         │
                    │   记忆服务       │
                    │  （服务契约 v0） │
                    └──────────────────┘
```

### 4.2 MemoryServiceAdapter

同时实现 `IEvidenceStore`（供 KnowledgeResolver 搜索）和
`GraphStore`（供 graph_resolve 入口）。
内部通过 MemoryStore 三原语接口与服务通信。
`KnowledgeResolver` 和 `GraphResolver` 看不出与 `SqliteEvidenceStore` 的区别。

```typescript
class MemoryServiceAdapter implements IEvidenceStore, GraphStore {
  private store: MemoryStore;             // 三原语聚合入口
  private capabilities: StoreCapabilities;
  private readOnly: boolean;              // 来自 CollectionManifest.backend.mode
  private namespace: string;              // 来自 CollectionManifest.backend.config.namespace
  private entityResolver?: EntityResolver; // 基础设施层注入

  // ── IEvidenceStore：搜索 ──

  async search(query: string, options?: SearchOptions): Promise<EvidenceItem[]> {
    const searchOpts = this.mapSearchOptions(options);
    const response = await this.store.blocks.search(query, searchOpts);
    return this.hydrateResults(response.results, options?.depth);
  }

  async searchWithMeta(query: string, options?: SearchOptions): Promise<EvidenceSearchExecution> {
    const searchOpts = this.mapSearchOptions(options);
    searchOpts.explain = true;
    const response = await this.store.blocks.search(query, searchOpts);
    const items = await this.hydrateResults(response.results, options?.depth);
    // entityMatches 挂到每个 EvidenceItem 上，与现有 searchWithMeta 返回形状一致
    response.results.forEach((r, i) => {
      if (r.entityMatches?.length && items[i]) {
        items[i].entityMatches = r.entityMatches.map(m => ({
          entityId: m.entityId,
          canonicalName: m.canonicalName,
          matchedAlias: m.matchedAlias,
          type: m.type,
          provenance: m.confidence != null
            ? { type: 'entity-resolution', confidence: m.confidence }
            : undefined,
        }));
      }
    });
    return {
      items,
      meta: storeMetaToHost(response.meta),  // Storage SPI → Host: 通过转换函数映射
      // Storage SPI 用 string reason，宿主用 SearchDegradeReason 封闭联合
      // EchoMem Wire → Host 用 wireMetaToHost()（见 EchoMem 协作设计 §2.3）
    };
  }

  /**
   * depth=raw 时：搜索结果按 parentId 聚合，父块附带 passages[]。
   * 子 TextBlock 到 EvidencePassage 的完整映射：
   *   id → passageId, parentId → docAnchor, createdAt → createdAt,
   *   metadata.threadId → threadId, metadata.messageId → messageId,
   *   metadata.context → context, metadata.speaker → speaker
   */
  private async hydrateResults(
    results: TextSearchResult[], depth?: string,
  ): Promise<EvidenceItem[]> {
    if (depth === 'raw') {
      return results.map(r => {
        const item = this.toEvidenceItem(r.block);
        if (r.children?.length) {
          item.passages = r.children.map(c => ({
            passageId: c.id,
            docAnchor: c.parentId ?? r.block.id,
            content: c.content,
            speaker: c.metadata?.speaker as string,
            threadId: c.metadata?.threadId as string,
            messageId: c.metadata?.messageId as string,
            // context 是上下文 passage 数组（contextWindow 填充），
            // 不是 string — 与 SqliteEvidenceStore.toEvidencePassage 一致
            context: (c.metadata?.context ?? []) as EvidencePassage[],
            createdAt: c.createdAt,
            position: c.position ?? 0,
          }));
        }
        return item;
      });
    }
    return results.map(r => this.toEvidenceItem(r.block));
  }

  async getByAnchor(anchor: string): Promise<EvidenceItem | null> {
    const block = await this.store.blocks.get(anchor);
    return block ? this.toEvidenceItem(block) : null;
  }

  // ── IEvidenceStore：写入 ──

  async upsert(items: EvidenceItem[]): Promise<void> {
    this.assertWritable('upsert');
    const blocks = items.map(item => this.toTextBlock(item));
    await this.store.blocks.batchPut(blocks);
  }

  async deleteByAnchor(anchor: string): Promise<void> {
    this.assertWritable('deleteByAnchor');
    await this.store.blocks.delete(anchor);
  }

  // ── IEvidenceStore：生命周期 ──

  async health(): Promise<boolean> {
    const h = await this.store.health();
    return h.healthy;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.capabilities = this.store.capabilities();
  }

  // ── IEvidenceStore：实体方法（委派到 EntityResolver 基础设施） ──
  // EntityResolver 注入到 TextBlockStore 内部，search() 自动使用。
  // 管理方法通过 EntityResolver 管理接口实现。

  async resolveEntityAliases(query: string): Promise<QueryEntityMatch[]> {
    if (!this.capabilities.entityResolution || !this.entityResolver) return [];
    const matches = await this.entityResolver.resolve(query);
    return matches.map(m => ({
      entityId: m.entityId,
      canonicalName: m.canonicalName,
      matchedAlias: m.matchedAlias,
      type: m.type,
      confidence: m.confidence,
      provenance: [{ type: 'entity-resolution' as const, confidence: m.confidence }],
    }));
  }

  async upsertEntities(entities: EntityRecord[]): Promise<void> {
    if (!this.entityResolver) return;
    await this.entityResolver.seed(entities.map(e => ({
      entityId: e.entityId,
      canonicalName: e.canonicalName,
      type: e.type,
      aliases: e.aliases,
      namespace: this.namespace,
    })));
  }

  async refreshEntityMentions(docAnchors?: string[]): Promise<void> {
    if (!this.entityResolver?.refreshMentions) return;
    // 支持增量刷新：传入 docAnchors 时只刷新指定文档的提及索引
    await this.entityResolver.refreshMentions({
      namespace: this.namespace,
      blockIds: docAnchors,  // docAnchor 即 TextBlock.id
    });
  }

  // ── GraphStore 实现 ──

  async getRelated(anchor: string): Promise<GraphRelatedRow[]> {
    if (!this.capabilities.relationEdge) return [];
    const neighbors = await this.store.edges.neighbors(anchor, { direction: 'both' });
    return neighbors.map(n => ({
      anchor: n.id,
      relation: n.relation,
      fromCollectionId: null,
      toCollectionId: null,
      edgeSensitivity: n.metadata?.sensitivity as string | null ?? null,
      provenance: n.metadata?.provenance as string | null ?? null,
      traversalCount: 0,
      lastTraversedAt: null,
    }));
  }

  // ── 守卫 ──

  private assertWritable(op: string): void {
    if (this.readOnly) {
      throw new Error(
        `MemoryServiceAdapter: 写操作 '${op}' 在只读 collection 上调用。` +
        `请检查 CollectionManifest.backend.mode。`
      );
    }
  }

  // ── 字段映射 ──

  /**
   * Clowder SearchOptions → 通用 TextSearchOptions 映射。
   *
   * Anchor 标准化约定：
   *   Clowder 的 threadId 会被 IndexBuilder 标准化为 `thread-${threadId}`
   *   作为 doc anchor（参考 IndexBuilder.ts 的 passage 写入逻辑）。
   *   因此 threadId 过滤需要同样的标准化才能匹配。
   */
  private mapSearchOptions(options?: SearchOptions): TextSearchOptions {
    if (!options) return { namespace: this.namespace };
    return {
      mode: options.mode,
      limit: options.limit,
      namespace: this.namespace,           // 从 CollectionManifest 注入，不从 item 取
      kind: options.kind,
      status: options.status,
      keywords: options.keywords,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      // threadId → thread anchor 标准化：IndexBuilder 写 passage 时
      // docAnchor = `thread-${threadId}`，搜索时要用相同的 anchor 格式
      parentId: options.threadId ? `thread-${options.threadId}` : undefined,
      depth: options.depth === 'raw' ? 'withChildren' : 'block',
      contextWindow: options.contextWindow,
      explain: options.explain,
      extra: {
        scope: options.scope,
        worldId: options.worldId,
        sceneId: options.sceneId,
        includeBackstop: options.includeBackstop,
      },
    };
  }

  private toTextBlock(item: EvidenceItem): TextBlock {
    const { anchor, title, summary, keywords, kind, status, sourcePath,
            sourceHash, updatedAt, worldId, sceneId,
            authority, activation, ...rest } = item;
    return {
      id: anchor,
      content: summary ?? '',
      title,
      keywords,                            // 保留关键词索引
      kind, status,
      namespace: this.namespace,           // 从 CollectionManifest 注入，不从 item 取
      createdAt: updatedAt,
      updatedAt,
      source: { type: 'compiled', uri: sourcePath },
      metadata: { sourceHash, worldId, sceneId, authority, activation, ...rest },
    };
  }

  private toEvidenceItem(block: TextBlock): EvidenceItem {
    const md = block.metadata ?? {};
    return {
      anchor: block.id,
      title: block.title ?? '',
      summary: block.content,
      kind: (block.kind ?? 'discussion') as EvidenceKind,
      status: (block.status ?? 'active') as EvidenceStatus,
      sourcePath: block.source?.uri,
      updatedAt: block.updatedAt ?? block.createdAt,
      ...md,
    } as EvidenceItem;
  }
}
```

### 4.3 CollectionManifest 扩展

```typescript
interface CollectionManifest {
  // ... 现有字段 ...

  /** 后端配置。省略 = 默认 sqlite。 */
  backend?: {
    /** Provider ID：'sqlite'（默认）| 'memory-service' */
    providerId: string;

    /** Provider 特定配置 */
    config?: {
      /** 服务端点（本地或远程） */
      endpoint?: string;
      /** 此 collection 在服务中的 namespace */
      namespace?: string;
      /** 认证 token（引用环境变量名，不是原始密钥） */
      authTokenEnvKey?: string;
    };

    /** 只读或读写访问 */
    mode?: 'readOnly' | 'readWrite';
  };
}
```

### 4.4 工厂改造

```typescript
// 在 createMemoryServices() 中：

// 1. 构建 provider 注册表
const registry = new MemoryBackendRegistry();
registry.register('sqlite', new SqliteBackendProvider());
registry.register('memory-service', new MemoryServiceBackendProvider());

// 2. Project store：默认 sqlite，但接口允许 service-backed。
//    Phase 1 保持 sqlite 以确保离线韧性；backend SPI 使其
//    无需代码改动即可切换 — 只需修改 manifest 配置。
const projectProviderId = projectManifest?.backend?.providerId ?? 'sqlite';
const projectProvider = registry.get(projectProviderId);
const store = await projectProvider.createStore(projectManifest, ctx);

// 3. 外部 collection：根据 manifest 选择 provider
for (const manifest of externals) {
  const providerId = manifest.backend?.providerId ?? 'sqlite';
  const provider = registry.get(providerId);
  const extStore = await provider.createStore(manifest, ctx);
  stores.set(manifest.id, extStore);
}

// 4. KnowledgeResolver：不变
const knowledgeResolver = new KnowledgeResolver({
  projectStore: store, globalStore, catalog, stores
});
```

### 4.5 消费 Rerank（宿主侧）

服务返回带有自身相关性分数的结果。
宿主适配器在收到服务结果**之后**，使用 `anchor_recall_metrics`（F200）
的消费数据进行额外 rerank。

这确保服务保持通用，同时 Clowder 获得其消费加权排序行为。

---

## 5. 数据同步（编译 → 服务）

### 当前流程（不变）

```
docs/*.md  ──► CatCafeScanner.discover() ──► ScannedEvidence
thread msgs ──► messageListFn() ──► passage rows
entity seeds ──► loadEntitySeeds() ──► EntityRecord[]
```

### 新流程（宿主推送到服务）

```
ScannedEvidence ──► store.blocks.batchPut(docs)    ──► service POST /blocks/batch-put
passage rows    ──► store.blocks.batchPut(passages) ──► service POST /blocks/batch-put
                    （parentId = docAnchor）
EntityRecord[]  ──► EntityResolver 种子注入          ──► 基础设施层，不经过原语
edge changes    ──► store.edges.link(...)           ──► service POST /edges/link
```

编译逻辑（scanner、passage 提取、实体加载）留在 Clowder 宿主。
服务是纯粹的存储 + 检索后端。

### 迁移说明：`getDb()` 逃逸面治理

当前 `SqliteEvidenceStore.getDb()` 被 **13 个 caller**（14 个文件含定义本身）直接调用，绕过
`IEvidenceStore` 接口。对于 service-backed store 这些调用全部断开。

#### 完整逃逸面清单

| 文件 | 调用数 | 风格 | 阻塞 Phase |
|------|--------|------|-----------|
| `IndexBuilder.ts` | 12+ | 直接 | Phase 1 — passage 写入、cleanup、embedding、重建 |
| `factory.ts` | 5 | 直接 | Phase 1 — VectorStore/PassageVectorStore 初始化、summary compaction |
| `CollectionIndexBuilder.ts` | 3 | 直接 | **Phase 2 灰度阻塞** — 外部 collection 重建路径断 |
| `GlobalIndexBuilder.ts` | 1 | 直接 | Phase 1 — global index 重建 |
| `bootstrap-collection-bridge.ts` | 1 | 直接 | Phase 1 — collection 初始化 |
| `f163-admin.ts` | 4 | 直接 | Phase 1 — 管理路由直接读 DB |
| `f163-audit-routes.ts` | 9 | 直接 | Phase 1 — 审计路由直接读 DB |
| `evidence.ts` (routes) | 3 | duck-typed | Phase 1 — evidence 路由直接读 DB |
| `RecentBrowseResolver.ts` | 2 | duck-typed | Phase 1 — `list_recent` 入口（见 [EchoMem 协作方案](memory-component-abstraction.md) §3 路由决策表） |
| `index.ts` (main app) | 8 | 直接 | Phase 1 — IndexStateManager、scheduler、启动流程 |
| `library.ts` (routes) | 5 | duck-typed | Phase 1 — library 管理路由直接读 DB |
| `route-serial.ts` | 1 | duck-typed | Phase 2 — agent 路由搜索 |
| `route-parallel.ts` | 1 | duck-typed | Phase 2 — agent 路由搜索 |

> **§5 原文只提到 IndexBuilder 两处**。实际逃逸面远大于此（Sol 补充 library.ts 5 处后共 14 文件）。
> 特别注意：**Phase 2 灰度计划**（§7 第 11 步"一个非核心 collection 使用 service backend"）
> 第一步就会撞上 `CollectionIndexBuilder.ts:56` 的 `store.getDb()` —
> 外部 collection 的重建路径在 service-backed store 上直接断。

#### duck-typed 调用的额外风险

`RecentBrowseResolver`、`evidence.ts`、`route-serial.ts`、`route-parallel.ts`
使用 `(store as StoreWithDb).getDb?.()` — 可选链让 service-backed store
**静默降级**而不是显式报错。对 `list_recent` 来说，`scope=threads`
（对话数据的主场）会返回空结果且无 `degraded` 提示。

#### 治理优先级

1. **Phase 1 前置**：IndexBuilder / factory / bootstrap — 重构为通过 MemoryStore 接口写入
2. **Phase 1 清理**：routes 层（f163-admin、f163-audit、evidence.ts）— 重构为通过服务接口查询
3. **Phase 2 前置**：CollectionIndexBuilder — 灰度方案的硬前提
4. **Phase 2+**：agent 路由（route-serial/route-parallel）— duck-typed，当前降级安全

### 重建

全量重建：`IndexBuilder.rebuild()` 触发 `store.blocks.batchPut()`
+ `store.edges.link()` 写入所有发现的证据和关系。
服务还可以接受 `POST /rebuild` 来在批量写入后优化其内部索引。

---

## 6. 降级与回退策略

| 场景 | 行为 |
|------|------|
| 服务正常 | 通过 adapter 正常搜索 |
| 服务不可达 | `health()` 返回 false → `KnowledgeResolver` 将 collection 标记为 `status: 'error'`，继续用其他 store |
| 服务超时（>3s） | 超时 → 降级为 `evidence_store_error`，该 collection 返回空结果 |
| 嵌入不可用（服务侧） | 服务返回 `effectiveMode: 'lexical'` → adapter 映射为 `degradeReason: 'passage_embedding_unavailable'` |
| Project store | Phase 1 **默认本地 SQLite** 以确保离线韧性。接口允许通过 manifest 配置切换为 service-backed — 切换是配置改动，不是代码改动 |

---

## 7. 迁移路径

### Phase 1：Backend SPI 骨架（零行为变更）

1. 提取 `MemoryBackendProvider` 接口 + `MemoryBackendRegistry`
2. **`getDb()` 逃逸面治理**（见 §5 完整清单，13 callers）：
   - 2a. `IndexBuilder` 的直接 SQLite 写入 → `TextBlockStore.put()`
   - 2b. `factory.ts` 的 VectorStore/PassageVectorStore 初始化 → 抽到 provider 内部
   - 2c. `GlobalIndexBuilder` / `bootstrap-collection-bridge` → 通过 provider 接口
   - 2d. routes 层（`f163-admin`、`f163-audit-routes`、`evidence.ts`）→ 通过服务接口查询
   - 2e. `RecentBrowseResolver` duck-typed getDb → 新增 `recency` 查询到 `TextBlockStore`（见 [EchoMem 协作方案](memory-component-abstraction.md) §3 路由决策表）
   - 2f. `library.ts` 5 处 duck-typed getDb → 通过服务接口查询
   - 2g. `index.ts` 启动流程（IndexStateManager、scheduler 等 8 处）→ 通过 provider 初始化钩子
3. 将现有 `SqliteEvidenceStore` 包装为 `SqliteBackendProvider`
   （实现 `MemoryStore` 三原语接口：TextBlockStore + RelationEdgeStore + TimelineStore）
4. `EntityRegistry` 包装为 `EntityResolver` 基础设施注入
5. 在 `CollectionManifest` 中添加 `backend?` 字段
6. `createMemoryServices` 通过注册表路由
7. 所有测试通过，零行为变更

### Phase 2：记忆服务适配器

8. 实现 `MemoryServiceClient`（服务契约 v0 的 HTTP 客户端）
9. 实现 `MemoryServiceAdapter`（IEvidenceStore + GraphStore → 内部通过 MemoryStore 通信）
10. 将 `MemoryServiceBackendProvider` 添加到注册表
11. **`CollectionIndexBuilder` getDb 治理**（Phase 2 灰度硬前提）：
    外部 collection 重建路径 `CollectionIndexBuilder.ts:56` 直接调 `store.getDb()` —
    service-backed store 上断。重构为通过 `MemoryStore.blocks.batchPut()`
12. 灰度：一个非核心 collection 使用 service backend
13. agent 路由 duck-typed getDb（`route-serial.ts`、`route-parallel.ts`）→ 降级安全，按需治理

### Phase 3：清理 + 加固

12. 修复 callback 路由（`/api/callbacks/search-evidence`），改为通过
    `KnowledgeResolver` 而非直接 `evidenceStore.search()`
13. 在 adapter 后处理中添加消费 rerank
14. 添加可观测性端点（`/stats`）
15. EntityResolver 的种子加载和刷新策略定义

---

## 8. 与 Maintainer 讨论的开放问题

| # | 问题 | 我们当前的立场 |
|---|------|---------------|
| 1 | Project store 是否应该移到服务？ | 接口允许（和外部 collection 走同一 SPI）。Phase 1 默认本地 SQLite 以确保离线韧性 — 切换是配置改动，不是代码改动 |
| 2 | 服务作为真相源？ | 否 — 真相源始终是 docs/*.md 和 thread 历史；服务是编译索引 |
| 3 | 实体解析：服务侧还是宿主侧？ | 优先服务侧（查询扩展是检索逻辑），但如果服务不支持则宿主侧 adapter fallback |
| 4 | 图查询：服务侧还是宿主侧？ | 优先服务侧（边是索引的一部分），但宿主侧可通过本地边缓存 fallback |
| 5 | Passage 嵌入：谁跑模型？ | 服务侧（服务拥有其向量索引）。宿主提供文本，服务计算和存储嵌入 |
| 6 | 多项目 namespace 隔离？ | 是 — 每个 collection 一个 namespace，连接初始化时设置 |
| 7 | 服务 API 版本控制？ | 基于 header（`X-API-Version: v0`），仅向后兼容的新增 |

---

## 9. 交叉参考 Review：EchoMem + Eval Harness

> 2026-06-26 review 后添加：
> - `/Users/lang/workspace/github/EchoMem`（main 分支：MemRouter，develop 分支：完整 SDK）
> - `/Users/lang/workspace/github/Memory-System-Eval-Harness`（MemoryBench 评测平台）
>
> 目的：验证我们的组件拆分是否正确，不是现在就接入。
> EchoMem 由独立团队开发。评测平台和 EchoMem 的能力都可以
> 基于我们的接口规范来增强。这是一个取长补短的过程，不是单向接入。
>
> **2026-06-30 更新**：基于本节 review 发现和 EchoAgent 代码分析，
> 正式的 EchoMem 协作设计方案已拆分为独立文档——见 [EchoMem 协作方案](memory-component-abstraction.md)。

### 9.1 我们做对了什么

| 拆分决策 | 验证来源 |
|---------|---------|
| **治理留在宿主**（markers、recall_events、权限、脱敏） | EchoMem 的 `SessionService.commit()` 触发记忆提取，但治理/审批是独立关注点。其引擎 `process()` 是纯索引，无审批流。 |
| **实体解析属于记忆组件** | EchoMem 的 `MemoryEngine.recall()` 接受 `EngineRecallReq`，查询扩展是引擎关注点，不是宿主关注点。我们将实体解析纳入服务契约的决定是正确的。 |
| **搜索接口应支持 mode 选择**（词法/语义/混合） | EchoMem 基于意图将查询路由到不同引擎。我们将此内化为 `mode` 参数。两种方式都可行；我们的对调用方更简单。 |
| **能力声明必不可少** | EchoMem 声明每个引擎的能力；评测平台在运行前验证插件能力。我们的 `ServiceCapabilities` 结构体满足同样需求。 |
| **连接初始化时的 namespace 隔离** | EchoMem 使用 `EngineEventScope(tenant_id, user_id, agent_id, session_id)`。我们的 namespace 方式更简单且够用。 |

### 9.2 需要修正的

**9.2.1 缺失：可观测性/诊断端点**

EchoMem 的 HTTP API 有 `/api/v1/system/status`、`/api/v1/system/tasks`、`/api/v1/system/ready`。
评测平台有 `import_integrity()`、`list_imported_memories()`、`memory_timeline()`。

我们的服务契约 v0 原先只有 `GET /health`。已补充：

```
GET  /stats                → { documentCount, passageCount, entityCount,
                               edgeCount, indexFreshness, lastRebuildAt }
POST /integrity            → { ok, issues: [...] }
                              （已存储数据与索引数据的一致性检查）
```

**9.2.2 缺失：搜索结果中的证据溯源**

EchoMem 的 `ContextItemRsp` 有 `evidence_uri` 和 `trace` 字段。
评测平台检查 `report_evidence` 能力。

我们的 `ServiceSearchResponse.meta` 已添加：

```typescript
interface ServiceSearchResponse {
  // ... 现有字段 ...
  meta: {
    // ... 现有字段 ...
    traceId?: string;              // 本次搜索执行的关联 ID
  };
}

// 每个 TextSearchResult 支持：
interface TextSearchResult {
  block: TextBlock;
  score: number;
  matchReasons?: string[];         // explain=true 时填充
}
```

**9.2.3 设计说明：不设独立的 passage 搜索端点**

我们有意不提供单独的 `POST /passages/search` 端点。
Passage 存储为 `TextBlock`（带 `parentId` 指向父文档）。
搜索时通过 `parentId` 过滤可获取特定文档下的 passage。
`contextWindow` 选项返回匹配 passage 的前后兄弟块。

**9.2.4 考虑：基于 session 的写入路径**

EchoMem 以 `create_session → add_message → commit_session` 作为主要写入模型，
不是批量 upsert。

我们当前的写入路径是批量导向的（`store.blocks.batchPut()`），
匹配我们 IndexBuilder 的扫描-批量-写入模式。但对于实时消息索引
（活跃 thread 中的 passage 索引），流式路径可能更自然。

决定：**保持批量写入为主**。宿主的 IndexBuilder 已经处理
scan → batch → batchPut。基于 session 的写入是 EchoMem 的模型，
因为它是对话记忆系统；我们的系统是文档导向的。
实时 passage 索引可通过 `Timeline.append()` 覆盖
（事件先追加到时间线，后异步编译为 TextBlock）。

### 9.3 评测平台协作的经验

当前评测平台评估的是**对话记忆召回**（LoCoMo、LongMemEval、HotpotQA）。
我们的系统需要额外的评估维度：

| 我们的能力 | 需要的评估维度 | LoCoMo 覆盖？ |
|-----------|--------------|--------------|
| BM25 文档搜索 | 文档检索精度/召回率 | ❌ |
| 混合搜索（BM25 + 语义 + RRF） | 模式对比：词法 vs 语义 vs 混合 | ❌ |
| 实体别名扩展 | 实体解析准确率 | ❌ |
| 图边遍历 | 图连通性召回率 | ❌ |
| Passage 级语义搜索 | Passage 检索准确率 | 部分（QA 类似 passage） |
| 消费加权 rerank（F200） | Rerank 提升度量 | ❌ |
| Collection 联邦 + 脱敏 | 多源搜索正确性 | ❌ |

给 EchoMem/评测团队的反馈：

1. 添加**文档检索基准测试**（不仅仅是对话 QA）
2. 添加**实体解析基准测试**（别名 → 规范名 → 正确召回）
3. 添加**混合搜索对比**指标（纯词法 vs 纯语义 vs 混合）
4. 添加**图遍历基准测试**（给定 anchor，通过 N 跳找到关联）
5. 支持**可插拔评估指标**，让每个记忆系统可以注册自己的评估维度

### 9.4 EchoMem 通过能力声明逐步对齐

权威的 `ServiceCapabilities` 定义在 **§3.2**（单一真相源）。
EchoMem 团队可以逐步实现能力：

- Phase 1：`semanticSearch` + `documentWrite`（他们已有的）
- Phase 2：添加 `lexicalSearch` + `hybridSearch`（匹配我们的需求）
- Phase 3：添加 `entityResolution` + `graphQuery`（覆盖我们的完整特性集）

---

## 10. 通用记忆服务：数据类型原语设计

> **设计理念**：像 Redis 为不同使用场景提供 STRING / ZSET / HASH / STREAM 等
> 数据结构原语一样，记忆服务也应按**存储语义和操作语义的本质差异**拆分为
> 独立的数据类型原语，每种原语有自己的 action 集。
>
> 不是 Document/Passage/Entity/Edge（领域模型），
> 也不是单一 MemoryItem（太扁平），
> 而是 **TextBlock / RelationEdge / Timeline** 三种数据原语
> + **EntityResolver** 基础设施层增强。
>
> **定位澄清**（四轮 review 收敛）：三原语是**存储服务的 SPI**——面向存储后端实现者
> （SQLite / 通用 Memory Service / 第三方 backend），不是跨团队协作协议。
> 跨领域协作（如与 EchoMem）需要领域接口（Domain Provider Ports）+
> 语言中立协议（Wire Contract），详见 [EchoMem 协作方案](memory-component-abstraction.md)。
>
> **参考输入**：
> - EchoMem 三面记忆模型（Atomic Truth + Episode + Association Graph）
> - EchoMem 分层基础设施契约（L0 BackendStorage → L6 ProtocolAdapter）
> - Memory-System-Eval-Harness 的 9 方法 MemoryPlugin Protocol
> - Redis 数据结构原语的设计哲学

### 10.1 三种数据类型原语

```
┌─────────────────────────────────────────────────────────────────┐
│                    MemoryStore（聚合入口）                       │
│                                                                  │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────────┐       │
│  │  TextBlock    │  │RelationEdge  │  │   Timeline    │       │
│  │   Store       │  │   Store      │  │    Store      │       │
│  ├───────────────┤  ├──────────────┤  ├────────────────┤       │
│  │put            │  │link          │  │append          │       │
│  │get            │  │unlink        │  │range           │       │
│  │delete         │  │neighbors     │  │latest          │       │
│  │search         │  │traverse      │  │get             │       │
│  │batchPut       │  │edges         │  │list            │       │
│  │list           │  │              │  │trim            │       │
│  └───────────────┘  └──────────────┘  └────────────────┘       │
│                                                                  │
│  共享维度：namespace / tags / createdAt / source / metadata     │
│  基础设施：EmbeddingProvider / EntityResolver / health()        │
└─────────────────────────────────────────────────────────────────┘
```

每种原语的**核心差异**：

| 原语 | 存储语义 | 写入模型 | 查询模型 | Redis 类比 |
|------|---------|---------|---------|-----------|
| TextBlock | 文本内容 + 嵌入向量 | upsert（last-write-wins） | 语义/词法/混合搜索 | STRING + 自动索引 |
| RelationEdge | 有向类型化关系 | link（from+to+relation 幂等） | 邻居遍历 + 路径查询 | 邻接 SET |
| Timeline | 时序追加事件流 | append-only（不可修改） | 范围查询 + 最新 N 条 | STREAM |

> **为什么没有 EntityNode 原语？**
> 实体（命名实体 + 别名解析）不是独立的数据存储类型，而是文本搜索的**增强能力**。
> 在我们的系统里，实体来自配置种子 + 文本自动提取，在搜索时透明增强召回（`searchWithMeta():152`）。
> 搜索热路径上用户不直接操作实体（search() 内部透明调用）。
> 管理路径（种子注入 / Eval-Harness 对接）通过 EntityResolver 管理接口（seed/list/get/refreshMentions）操作。
> 因此实体解析降级为**基础设施层**的 `EntityResolver`，和 `EmbeddingProvider` 平级（§10.7）。

### 10.2 共享元数据维度

所有三种原语共享以下维度（类似 Redis 每个 key 都有 TTL/TYPE 等元信息）：

```typescript
/** 所有原语的共享字段 */
interface CommonDimensions {
  namespace: string;               // 隔离边界（类似 Redis DB number）
  tags?: string[];                 // 自由标签分类
  createdAt: string;               // ISO8601 创建时间
  updatedAt?: string;              // ISO8601 更新时间
  source?: Provenance;             // 来源追踪
  metadata?: Record<string, unknown>;  // 宿主扩展点（不透明）
}

/** 来源追溯 */
interface Provenance {
  type: string;                    // 'manual' | 'extracted' | 'derived' | ...
  uri?: string;                    // 来源标识
  confidence?: number;             // 0-1 置信度
}
```

**设计决策**：
- `namespace` 是硬隔离（不同 namespace 的数据互不可见），不是软标签
- `tags` 是查询维度（可按 tag 过滤），支持多值
- `metadata` 是逃生舱（宿主专属字段全部放这里），通用层不解析其内容
- `source` 统一追溯来源，而非各原语各自定义 provenance 字段

### 10.3 TextBlock — 文本内容原语

文本片段，自动建立词法和向量索引，支持语义/词法/混合三种搜索模式。

```typescript
/** 文本块 — 记忆服务的核心存储单元 */
interface TextBlock extends CommonDimensions {
  id: string;                      // 唯一标识
  content: string;                 // 文本内容
  title?: string;                  // 显示标题
  summary?: string;                // 摘要
  keywords?: string[];             // 自动提取或手动标注的关键词（BM25 索引维度）
  kind?: string;                   // 类型标签（宿主定义值域）
  status?: string;                 // 生命周期状态（宿主定义值域）
  parentId?: string;               // 父块 ID（passage-in-document 层级）
  position?: number;               // 在父块中的排序位置
  supersededBy?: string;           // 被替代块 ID（版本链）
  validFrom?: string;              // 时效起始 ISO8601
  validUntil?: string;             // 时效终止 ISO8601
}

/** TextBlock 存储接口 */
interface TextBlockStore {
  /** 写入/更新（id 幂等，last-write-wins） */
  put(block: TextBlock): Promise<void>;
  /** 批量写入 */
  batchPut(blocks: TextBlock[]): Promise<void>;
  /** 精确获取 */
  get(id: string): Promise<TextBlock | null>;
  /** 删除 */
  delete(id: string): Promise<void>;
  /** 搜索（语义/词法/混合）— 返回结果 + meta（降级/mode/trace） */
  search(query: string, options?: TextSearchOptions): Promise<SearchResponse>;
  /** 条件列表 */
  list(filter?: TextBlockFilter): Promise<TextBlock[]>;
}

/** 搜索选项 */
interface TextSearchOptions {
  mode?: 'lexical' | 'semantic' | 'hybrid';  // 默认 hybrid
  limit?: number;                  // 最大返回数
  namespace?: string;              // 限定 namespace
  kind?: string;                   // 限定类型
  status?: string;                 // 限定状态
  tags?: string[];                 // 限定标签（AND 语义）
  keywords?: string[];             // 关键词过滤（匹配 TextBlock.keywords）
  dateFrom?: string;               // 时间下界 ISO8601
  dateTo?: string;                 // 时间上界 ISO8601
  parentId?: string;               // 限定在某父块下搜索
  depth?: 'block' | 'withChildren';  // block=只返回匹配块（默认）;
                                   // withChildren=搜索返回的父块附带 children[] 填充
  contextWindow?: number;          // 返回匹配 passage 的前后 N 个兄弟块（填充到 children/context 中）
  explain?: boolean;               // 返回结果中标注匹配原因
  extra?: Record<string, unknown>; // 宿主专属过滤器
}

/** 搜索结果 */
interface TextSearchResult {
  block: TextBlock;
  score: number;
  matchReasons?: string[];         // explain=true 时填充
  children?: TextBlock[];          // depth=withChildren 时填充 — 父块下的子块列表
  entityMatches?: EntityMatch[];   // EntityResolver 匹配到的实体（capabilities.entityResolution=true 时）
}

/** 列表过滤器 */
interface TextBlockFilter {
  namespace?: string;
  kind?: string;
  status?: string;
  tags?: string[];
  parentId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
  extra?: Record<string, unknown>;
}
```

**写入语义**：`put()` 是 upsert — 同 id 已存在则覆盖。宿主如需更复杂的合并策略
（如 EchoMem 的 ADD/UPDATE/REPLACE/CONFLICT 四种决策），在适配层实现，
通用层只提供 last-write-wins 基线。

### 10.4 RelationEdge — 关系原语

有向类型化关系，支持图遍历。

```typescript
/** 关系边 */
interface RelationEdge extends CommonDimensions {
  fromId: string;                  // 源锚点（TextBlock.id 或任意宿主定义的 ID）
  toId: string;                    // 目标锚点
  relation: string;                // 关系类型（宿主定义值域）
  weight?: number;                 // 边强度 0-1（默认 1）
}

/** RelationEdge 存储接口 */
interface RelationEdgeStore {
  /** 建立关系（from+to+relation 三元组幂等） */
  link(edge: RelationEdge): Promise<void>;
  /** 解除关系 */
  unlink(fromId: string, toId: string, relation: string): Promise<void>;
  /** 获取邻居 */
  neighbors(id: string, opts?: NeighborOptions): Promise<Neighbor[]>;
  /** 深度遍历 */
  traverse(startId: string, opts?: TraverseOptions): Promise<TraversalResult>;
  /** 条件列出边 */
  edges(filter?: EdgeFilter): Promise<RelationEdge[]>;
}

interface Neighbor {
  id: string;                      // 邻居锚点
  relation: string;                // 关系类型
  direction: 'outgoing' | 'incoming';
  weight?: number;
  metadata?: Record<string, unknown>;
}

interface NeighborOptions {
  direction?: 'outgoing' | 'incoming' | 'both';  // 默认 both
  relation?: string;               // 限定关系类型
  namespace?: string;
  limit?: number;
}

interface TraverseOptions {
  maxDepth?: number;               // 默认 2
  direction?: 'outgoing' | 'incoming' | 'both';
  relation?: string;
  namespace?: string;
  limit?: number;                  // 最大返回节点数
}

interface TraversalResult {
  nodes: Array<{ id: string; depth: number }>;
  edges: RelationEdge[];
  truncated: boolean;              // 是否因 limit 截断
}

interface EdgeFilter {
  fromId?: string;
  toId?: string;
  relation?: string;
  namespace?: string;
  limit?: number;
}
```

**写入语义**：`link()` 幂等 — (fromId, toId, relation) 三元组作为 PK，
重复 link 更新 weight/metadata，不创建新边。

**与 EchoMem 对照**：EchoMem 的 GraphEdge 有三层权重
(`base_weight * significance_weight * temporal_decay`)，
通用层只提供 `weight` 单值；三层权重分解由宿主在 metadata 中自行管理。

### 10.5 Timeline — 时序事件原语

追加制时序事件流，不可修改已追加的事件。

```typescript
/** 时序事件 */
interface TimelineEvent extends CommonDimensions {
  id: string;                      // 唯一事件 ID
  timelineId: string;              // 所属时间线 ID
  type: string;                    // 事件类型（宿主定义值域）
  timestamp: string;               // ISO8601 事件时间
  content: string;                 // 事件内容
}

/** Timeline 存储接口 */
interface TimelineStore {
  /** 追加事件（append-only，不可修改已有事件） */
  append(event: TimelineEvent): Promise<void>;
  /** 时间范围查询 */
  range(timelineId: string, from?: string, to?: string): Promise<TimelineEvent[]>;
  /** 获取最新 N 条 */
  latest(timelineId: string, count: number): Promise<TimelineEvent[]>;
  /** 精确获取 */
  get(id: string): Promise<TimelineEvent | null>;
  /** 跨时间线条件查询 */
  list(filter?: TimelineFilter): Promise<TimelineEvent[]>;
  /** 清理旧事件（before 之前的全部删除，返回删除数） */
  trim(timelineId: string, before: string): Promise<number>;
}

interface TimelineFilter {
  timelineId?: string;
  type?: string;
  namespace?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
```

**写入语义**：`append()` 是追加制 — 一旦写入不可修改（类似 Redis STREAM 的 XADD）。
这保证了事件流的审计可靠性。如需"撤回"，追加一个 type='retraction' 的事件指向原事件。

### 10.6 聚合入口与能力声明

```typescript
/** 记忆服务聚合入口 — 类似 Redis Client 聚合所有数据结构的命令 */
interface MemoryStore {
  readonly blocks: TextBlockStore;
  readonly edges: RelationEdgeStore;
  readonly timelines: TimelineStore;

  /** 健康检查 */
  health(): Promise<StoreHealth>;
  /** 能力声明 */
  capabilities(): StoreCapabilities;
  /** 初始化（建表 / 连接等） */
  initialize(): Promise<void>;
  /** 关闭 */
  close(): Promise<void>;
}

interface StoreHealth {
  healthy: boolean;
  latencyMs?: number;
  message?: string;
}

/** 细粒度能力声明 — 后端按实际能力声明，消费者按需检查 */
// 注：此接口与 §3 的 StoreCapabilities 是同一类型（单一真相源在 §3）
interface StoreCapabilities {
  // 原语支持
  textBlock: boolean;
  relationEdge: boolean;
  timeline: boolean;
  // 搜索模式
  lexicalSearch: boolean;
  semanticSearch: boolean;
  hybridSearch: boolean;
  // 图能力
  graphTraversal: boolean;           // traverse() 深度遍历
  // 搜索增强（基础设施层能力）
  entityResolution: boolean;         // search() 自动解析实体别名
  // 可观测性
  stats: boolean;                    // 计数统计
  evidenceTrace: boolean;            // 返回匹配原因 + 分数
  // 限制
  maxDocuments?: number;
  // 嵌入索引延迟
  embeddingReadyMode?: 'sync' | 'eventual';
}
```

**渐进实现原则**：后端不需要实现所有三种原语。
能力声明让消费者在运行时检查，缺失的原语抛 `NotSupportedError`：

```
最小可用实现：textBlock=true（其余 false）
→ 已能服务 "文本搜索" 用例，覆盖 Eval-Harness 的 add_memory/retrieve

标准实现：textBlock + relationEdge = true
→ 覆盖文本搜索 + 知识图谱遍历

完整实现：全部 true
→ 覆盖 Clowder 全部记忆能力
```

### 10.7 基础设施层（不是原语，是注入依赖）

```typescript
/**
 * 嵌入向量提供者 — 注入到 TextBlockStore 实现。
 *
 * 记忆组件是 embedding 服务的消费者，不是所有者：
 * - 服务生命周期（安装/启停 embed-api.py）走宿主统一服务管理
 * - 记忆组件 init 时注入 endpoint 配置（URL / model / dimensions）
 * - 组件内部通过该 endpoint 调用 embedding，用于写入时生成向量 + 查询时语义搜索
 * - 不可用时降级到 lexical-only（通过 capabilities 和 effectiveMode 上报）
 */
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  batchEmbed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

/**
 * 实体解析器 — 注入到 TextBlockStore 实现，增强搜索召回。
 *
 * 不是数据原语：实体来自配置种子 + 文本自动提取，
 * 在 search() 内部透明调用，调用者无感知。
 * 类比：拼写纠错 / 同义词扩展 — 是搜索管道的一环，不是存储类型。
 *
 * 但需要管理接口：宿主需要注入种子、查询已注册实体、刷新提及索引。
 * 这些管理操作不在搜索热路径上，而是初始化 / 维护阶段使用。
 * 对应 Clowder 的 upsertEntities / getEntity / refreshEntityMentions
 * 和 Eval-Harness 的 add_entity / get_entities。
 */
interface EntityResolver {
  // ── 搜索路径（由 TextBlockStore.search() 内部调用） ──

  /** 解析查询中的实体别名 → 返回规范名称 + 匹配的别名 */
  resolve(query: string): Promise<EntityMatch[]>;
  /** 从文本中自动提取实体（写入时调用） */
  extract?(text: string): Promise<ExtractedEntity[]>;

  // ── 管理路径（初始化 / 维护阶段使用） ──

  /** 注入实体种子（幂等，entityId 重复则更新） */
  seed(entities: EntitySeed[]): Promise<void>;
  /** 精确获取已注册实体 */
  get?(entityId: string): Promise<EntitySeed | null>;
  /** 列出已注册实体（供调试 / Eval-Harness get_entities） */
  list?(filter?: { type?: string; namespace?: string }): Promise<EntitySeed[]>;
  /** 刷新实体提及索引（对已有 TextBlock 重新提取实体引用） */
  refreshMentions?(opts?: {
    namespace?: string;
    blockIds?: string[];            // 增量刷新：只刷新指定 block 的提及
  }): Promise<{ updated: number }>;
}

/** 实体种子 — 注册到 EntityResolver 的实体定义 */
interface EntitySeed {
  entityId: string;                  // 唯一标识
  canonicalName: string;             // 规范名称
  type: string;                      // 实体类型（person / feature / concept / ...）
  aliases?: string[];                // 别名列表
  namespace?: string;                // 所属 namespace（可选，跨 namespace 实体不设）
}

interface EntityMatch {
  entityId: string;
  canonicalName: string;
  matchedAlias: string;
  type: string;
  confidence: number;
}

interface ExtractedEntity {
  name: string;
  type: string;
  confidence: number;
  span: { start: number; end: number };
}
```

基础设施层的**搜索路径**（resolve/extract）不属于通用契约的 API surface，
而是实现侧的插槽。但**管理路径**（seed/list/get/refreshMentions）
需要通过宿主适配层暴露，以支持实体种子注入和 Eval-Harness 对接。
参考 EchoMem 的分层：
- L0 BackendStorage（原始 CRUD）
- L2a VectorStoreAdapter（ANN 搜索）
- L2b GraphStoreAdapter（图存储）

我们的通用层只定义 **L3（原语 Store 接口）** 和 **L5（MemoryStore 聚合）**，
L0-L2 由具体 backend 实现自行组织。
EntityResolver 和 EmbeddingProvider 都是 L2 级注入依赖。

### 10.8 Clowder 适配映射

| Clowder 数据类型 | 映射到 | 字段映射要点 |
|-----------------|--------|-------------|
| EvidenceItem（30+ 字段） | **TextBlock** | `anchor→id`; `kind/status→kind/status`; `worldId/sceneId/authority/activation/collectionId→metadata` |
| Passage | **TextBlock**（parentId 层级） | `docAnchor→parentId`; `passageId→id`; `position→position`; `speaker→metadata.speaker` |
| EntityRecord + aliases | **EntityResolver**（基础设施层） | 不再是数据原语；EntityRegistry → EntityResolver 实现 |
| EntityMention | **EntityResolver 内部** | 提及索引由 EntityResolver 内部管理 |
| Edge | **RelationEdge** | `fromAnchor→fromId`; `toAnchor→toId`; `relation→relation`; `fromCollectionId/toCollectionId/edgeSensitivity→metadata` |
| EventMemory | **Timeline** | `threadId→timelineId`; `type→type`; `summary→content`; `cognitiveTransition/relatedHarness→metadata` |
| SummarySegment | **Timeline**（模型可表达，但 §2 决定留在宿主） | `threadId→timelineId`; `type='summary'`; `summary→content`; `level/topicKey/topicLabel→metadata`。注：§2 决定 Thread 摘要留在宿主（绑定 thread 生命周期）。此映射仅证明三原语模型的表达力足够，不是 Phase 1 的提取范围 |
| Marker（采集队列） | *(不映射)* | 采集管道是宿主内部概念 |
| RecallEvent（遥测） | *(不映射)* | 可观测性数据由宿主独立管理 |
| AnchorRecallMetrics | *(不映射)* | 消费加权排名是宿主层优化 |
| CollectionManifest | **namespace 配置** | `collection.id → namespace` |

适配层代码结构（概念示意）：

```typescript
// ── Clowder MemoryServiceAdapter ──
class ClowderMemoryAdapter implements MemoryStore {
  readonly blocks: ClowderTextBlockAdapter;   // 包装 IEvidenceStore
  readonly edges: ClowderEdgeAdapter;          // 包装 GraphStore
  readonly timelines: ClowderTimelineAdapter;  // 包装 EventMemoryStore

  // 基础设施注入：EntityRegistry → EntityResolver
  private entityResolver: ClowderEntityResolver;  // 包装 EntityRegistry

  // IEvidenceStore 的 SearchOptions → TextSearchOptions 映射
  // namespace 从 CollectionManifest 注入（构造时确定），不从 item 取
  // threadId 标准化为 thread-${threadId}（与 IndexBuilder 写入约定一致）
  private mapSearchOptions(clowderOpts: SearchOptions): TextSearchOptions {
    return {
      mode: clowderOpts.mode,
      namespace: this.namespace,
      kind: clowderOpts.kind,
      status: clowderOpts.status,
      keywords: clowderOpts.keywords,
      dateFrom: clowderOpts.dateFrom,
      dateTo: clowderOpts.dateTo,
      parentId: clowderOpts.threadId
        ? `thread-${clowderOpts.threadId}`
        : undefined,
      depth: clowderOpts.depth === 'raw' ? 'withChildren' : 'block',
      contextWindow: clowderOpts.contextWindow,
      explain: clowderOpts.explain,
      extra: {
        scope: clowderOpts.scope,
        worldId: clowderOpts.worldId,
        sceneId: clowderOpts.sceneId,
        includeBackstop: clowderOpts.includeBackstop,
      },
    };
  }
}
```

### 10.9 EchoMem 映射（参考对照）

| EchoMem 数据类型 | 映射到 | 映射要点 |
|-----------------|--------|---------|
| AtomicMemory（NL 内容） | **TextBlock** | `atom_id→id`; `statement→content`; `atom_type→kind`; `confidence→source.confidence` |
| AtomicMemory（SPO 三元组） | **RelationEdge** + **EntityResolver** | `subject/object→EntityResolver 种子`; `predicate→RelationEdge.link()` |
| AtomRelation | **RelationEdge** | `rel_type→relation`; `confidence→weight` |
| Episode | **TextBlock** + **Timeline** | `summary→TextBlock.put()`; `key_events→Timeline.append()` |
| EpisodeEvent | **Timeline** | `event_type→type`; `description→content` |
| GraphNode | *(派生)* | `backing_ref→TextBlock.id`；图拓扑通过 RelationEdge 表达 |
| GraphEdge（三层权重） | **RelationEdge** | `weight→weight`（折叠单值）; 三层分解→`metadata.weightFactors` |
| ContextItem | **TextSearchResult** | 通用检索结果类型 — 形状一致 |

### 10.10 与 Eval-Harness MemoryPlugin 的映射

Memory-System-Eval-Harness 的 MemoryPlugin Protocol 定义了 9 个必需方法：

| MemoryPlugin 方法 | 通用层操作 | 说明 |
|-------------------|-----------|------|
| `add_memory(text, metadata)` | `blocks.put(...)` | 直接映射 |
| `retrieve(query, top_k)` | `blocks.search(query, { limit: top_k })` | 直接映射 |
| `update_memory(id, text)` | `blocks.put({ id, content: text })` | upsert 覆盖 |
| `delete_memory(id)` | `blocks.delete(id)` | 直接映射 |
| `get_memory(id)` | `blocks.get(id)` | 直接映射 |
| `add_entity(name, type)` | `entityResolver.seed([...])` | 通过 EntityResolver 管理接口注入种子 |
| `add_relation(from, to, rel)` | `edges.link(...)` | 直接映射 |
| `get_entities()` | `entityResolver.list()` | 通过 EntityResolver 管理接口列出已注册实体 |
| `get_relations()` | `edges.edges()` | 直接映射 |

**覆盖度**：
- 最小实现（textBlock=true）覆盖前 5 个（LoCoMo/LongMemEval 评测）
- 加 relationEdge 覆盖 add_relation / get_relations
- 加 EntityResolver 覆盖 add_entity / get_entities
- 三原语 + EntityResolver = 全部 9 个方法覆盖

### 10.11 分层总览

```
┌─────────────────────────────────────────────────────────────────┐
│               开源通用记忆服务（可独立发布）                      │
│                                                                  │
│  数据原语：TextBlock / RelationEdge / Timeline                  │
│  搜索模式：lexical / semantic / hybrid                          │
│  图遍历：neighbors / traverse                                   │
│  能力声明：StoreCapabilities（渐进实现）                         │
│  隔离：namespace                                                 │
│  扩展：metadata + extra（不透明逃生舱）                          │
│  基础设施：EmbeddingProvider + EntityResolver（可选）            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│           宿主适配层（Clowder / EchoMem / 其他）                 │
│                                                                  │
│  Clowder：                        EchoMem：                     │
│    IEvidenceStore → TextBlockStore   AtomicMemory → TextBlock   │
│    EntityRegistry → EntityResolver     + EntityResolver          │
│    GraphStore → RelationEdgeStore       + RelationEdge           │
│    EventMemoryStore → TimelineStore  Episode → TextBlock +      │
│    scope/worldId/sceneId → extra       Timeline                 │
│    消费 rerank / 治理 → 适配层       GraphEdge → RelationEdge   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│           Eval-Harness 评测桥接（可选）                          │
│                                                                  │
│  MemoryPlugin Protocol → MemoryStore + EntityResolver 的薄封装  │
│  REQUIRED_CAPABILITIES → StoreCapabilities 映射                 │
└─────────────────────────────────────────────────────────────────┘
```

### 10.12 §3 Service Contract v0 — 已完成三原语重写

§3 已使用三原语模型（TextBlock / RelationEdge / Timeline）重写，是本文档的权威契约定义。

以下为从旧领域模型迁移到三原语模型的变更记录：

| 旧类型 | 替换为 | 改动要点 |
|--------|--------|---------|
| ServiceDocument（18 字段） | **TextBlock**（15 字段） | 去掉领域字段，补 parentId/position/supersededBy/keywords |
| ServicePassage（6 字段） | **TextBlock**（parentId 模式） | 从独立类型变成 TextBlock 的子块用法 |
| ServiceEntity（6 字段） | **EntityResolver 种子** | 不再是数据原语，降级为基础设施层管理接口 |
| ServiceEdge（4 字段） | **RelationEdge**（6 字段） | 补 weight/namespace |
| ServiceSearchFilters（12 字段） | **TextSearchOptions**（15 字段） | scope→extra, threadId→parentId, 新增 depth/keywords |
| IIndexWriter（4 方法） | TextBlockStore + RelationEdgeStore | 从集中 writer 拆为各原语写方法 |
| 单一 GraphStore 接口 | RelationEdgeStore | neighbors/traverse 对应 |

**§3 是单一真相源**。§10 是设计推导过程文档，两者一致。

### 10.13 开源发布检查清单

- [x] **数据类型原语设计**（§10.1-§10.5 三种原语 + action 集 + EntityResolver 管理接口）
- [x] **共享 metadata 维度**（§10.2 CommonDimensions）
- [x] **Clowder 适配层映射**（§10.8 完整字段映射 + 示意代码）
- [x] **EchoMem 映射验证**（§10.9 双向对照）
- [x] **Eval-Harness 覆盖度验证**（§10.10 全 9 方法覆盖）
- [x] §3 Service Contract 按三原语模型重写（§10.12 变更记录）
- [ ] 参考实现：SQLite backend（从 SqliteEvidenceStore 提取）
- [ ] 最小可用示例（init → put → search → neighbors）
- [ ] NPM 包结构与发布配置
- [ ] 评测集成适配器（MemoryPlugin → MemoryStore 桥接）

---


## 11. EchoMem 协作方案 → 独立文档

> **四轮 review（codex / Fable / Sol + Fable×Sol 收敛）后，§11 已拆分为独立文档。**
>
> 详见 **[EchoMem 协作方案 — 三层架构设计](memory-component-abstraction.md)**。
>
> 拆分理由：本 ADR（§1-§10）聚焦**存储 SPI 设计**（三原语模型 + 通用记忆服务），
> 目标读者是存储后端实现者。EchoMem 协作是**跨领域协作设计**——需要领域 Provider Ports
> + 语言中立 Wire Contract + 路由决策表 + canonicalId + 可靠 ingestion + 删除 lineage，
> 这些概念正交于存储 SPI，不宜继续挤在同一文档。
>
> 新文档包含三层架构、路由决策表、canonicalId/IdentityScope、Wire Contract v0、
> 可靠 Ingestion 协议、删除与 Lineage、隐私边界、迁移拓扑、验收基线、
> 显式否决记录、以及四轮 review 的修正历史。

### 外部代码锚点索引（保留在本 ADR）

| 组件 | 仓库 | 路径 |
|------|------|------|
| EchoMem SessionService | EchoMem (develop) | `src/echomem/req_coordinator/interfaces/session_service.py` |
| EchoMem RetrievalService | EchoMem (develop) | `src/echomem/req_coordinator/interfaces/retrieval_service.py` |
| EchoMem ContextItemRsp | EchoMem (develop) | `src/echomem/memrouter/recall/interfaces/entities/retrieval.py` |
| EchoMem MCP 工具 | EchoMem (develop) | `src/echomem/entrypoints/mcp/tools.py` |
| EchoAgent Session Memory Engine | EchoAgent | `dev/backend/src/modules/session/session-memory-engine.service.ts` |
| EchoAgent Memory Query Tool | EchoAgent | `dev/backend/src/modules/session/tools/builtins/memory-query-via-engine.tool.ts` |
| 评测平台 MemoryPlugin 协议 | Memory-System-Eval-Harness | `memory/plugins/base.py:47` |
