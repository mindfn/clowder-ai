---
title: "EchoMem 协作方案 — 三层架构设计"
participants: [opus, fable, sol, codex, lang]
status: design-draft
created: 2026-06-30
updated: 2026-07-10
doc_kind: decision
decision_id: ADR-candidate-echomem
feature_ids: [F102]
topics: [memory, echomem, collaboration, protocol, architecture]
related: ["memory-service-componentization.md"]
---

# EchoMem 协作方案 — 三层架构设计

> **Status**: design-draft（2026-07-10，四轮 review 后重构）
> **Deciders**: operator + Ragdoll(opus/fable) + Maine Coon(codex/sol)
> **Issue**: [#1047](https://github.com/zts212653/clowder-ai/issues/1047)
> **Parent ADR**: [记忆服务组件化 — 三原语模型](memory-service-componentization.md)
> **设计原则**：按擅长领域分工，不确定性用接口隔离，回退成本低
> **前序讨论**：EchoAgent 代码分析 + co-creator 分工方向确认（session #1）

## Review 历史

| 轮 | Reviewer | 关键修正 |
|----|----------|---------|
| 1 | codex | 三原语保留 / source-based ownership / 双向 adapter / EntityResolver local |
| 2 | Fable | ingestion 空白 / 孤儿根因 / 三入口 / getDb 逃逸面 / 隐私边界 / 验收判据 |
| 3 | Sol | 三层混用 / scope 硬路由 / CollectionManifest 不兼容 / 删除无 lineage |
| 4 | Fable × Sol 收敛 | sessions→Doc / canonicalId 硬前置 / wire owner / egress filter / 删除权威唯一 |

---

## 1. 背景

Clowder AI 的记忆系统（[ADR: 三原语模型](memory-service-componentization.md)）需要与 EchoMem
团队的对话记忆服务协作。核心分工：

- **DocMemory（我们）**：文档知识记忆 — feature/decision/plan/lesson 等从 repo 扫描出来的结构化知识
- **ConversationMemory（EchoMem）**：对话消息记忆 — thread 消息、episode 摘要、对话内关系
- **EventMemory / Timeline（我们）**：认知转变事件 — 不给 EchoMem

> **所有权按数据来源切，不按 SQLite `kind` 字段切**。
> scanner 产物 → DocMemory；对话事件流产物 → ConversationMemory。

---

## 2. 三层架构

> **Fable × Sol 收敛结论**：原方案把存储 SPI、领域检索 Provider、跨团队协议混成一层。
> 这导致 scope=threads 硬路由绕过 EchoMem、CollectionManifest 注册不上、
> EchoAgent 边缘适配器被当成核心协议等系统性问题。重构为三层。

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: Wire Contract（跨团队协议）                                │
│  ─────────────────────────────────────                              │
│  OpenAPI/JSON Schema 为真相源 → 生成 TS/Python bindings             │
│  Owner: Clowder（v0 canonical schema）                              │
│  SearchRequest/Execution + CapabilityDescriptor + IdentityScope    │
│  + canonicalId + degrade meta + origin/requestId/hopCount          │
│                                                                     │
│  EchoMemAdapter: native ↔ neutral 翻译                             │
│  EchoAgentAdapter: 边缘适配器（仅 EchoAgent 侧，不进核心链路）      │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Domain Provider Ports（宿主领域接口）                      │
│  ─────────────────────────────────────────                          │
│  读侧：                                                             │
│    RetrievalProvider.search(request): RetrievalExecution            │
│    AnchorRouter.resolve(canonicalId): provider + lookup             │
│    BrowseProvider.listRecent(request)          [optional]           │
│    GraphProvider.getRelated/traverse(request)  [optional]           │
│  写侧（独立端口）：                                                  │
│    ConversationIngestSink.append(events)                            │
│                                                                     │
│  RetrievalCoordinator：                                             │
│    routing table (dimension × scope × depth → provider calls)      │
│    RRF 融合 + 脱敏 + degrade meta                                  │
│    替换 isProjectLocalScope 特判                                    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: Storage SPI（存储原语）                                    │
│  ───────────────────────────────                                    │
│  TextBlock / RelationEdge / Timeline                                │
│  只描述可重建索引的 CRUD/查询                                        │
│  实现：SQLite（本地）/ 通用 Memory Service（远程）                   │
│  详见 parent ADR §10                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Layer 1: Storage SPI

见 [parent ADR §10](memory-service-componentization.md#10-通用记忆服务数据类型原语设计)。
三原语（TextBlock / RelationEdge / Timeline）+ MemoryStore + StoreCapabilities。

**重新定位**：三原语是存储服务的 SPI，不是跨团队协议。
`@clowder-ai/memory-protocol` 包（如果发布）面向的是**存储后端实现者**，
不是 EchoMem 这样的领域协作方。

### 2.2 Layer 2: Domain Provider Ports

宿主侧领域接口。每个 provider 声明 capability，RetrievalCoordinator 按路由表分发。

```typescript
/** 读侧：检索 */
interface RetrievalProvider {
  readonly domain: 'doc' | 'conversation' | 'global';
  search(request: SearchRequest): Promise<RetrievalExecution>;
  capabilities(): ProviderCapabilities;
  health(): Promise<boolean>;
}

/** 读侧：anchor 精确查找 */
interface AnchorRouter {
  resolve(canonicalId: string): { provider: RetrievalProvider; localId: string } | null;
  owns(canonicalId: string): boolean;
}

/** 读侧：最近浏览（optional） */
interface BrowseProvider {
  listRecent(request: BrowseRequest): Promise<BrowseExecution>;
}

/** 读侧：图遍历（optional） */
interface GraphProvider {
  getRelated(anchor: string, options?: GraphOptions): Promise<RelatedResult>;
  traverse(start: string, depth: number): Promise<TraversalResult>;
}

/** 写侧：对话 ingestion（独立端口） */
interface ConversationIngestSink {
  append(events: IngestEvent[]): Promise<IngestAck>;
}

interface ProviderCapabilities {
  search: boolean;
  browse: boolean;
  graph: boolean;
  anchorLookup: boolean;
  entityResolution: boolean;
  semanticSearch: boolean;
}
```

**为什么不复用 IEvidenceStore**：
- `IEvidenceStore` 混合了读写（`upsert` + `search`），而 ConversationMemory 的写侧语义（durable outbox）
  与文档 upsert 完全不同
- `getDb()` 逃逸面（14 个文件）证明 IEvidenceStore 的抽象边界已经被实现细节穿透
- collection 的 `sensitivity` 是 per-collection 静态标签，而对话隐私是 per-thread/per-message 的

**迁移期薄桥**：projectStore 包装为 DocRetrievalProvider + LegacyConversationProvider，
后者持有本地 passage 数据直到 EchoMem ownership 切换完成。

### 2.3 Layer 3: Wire Contract

跨团队协议。语言中立，OpenAPI/JSON Schema 为真相源，生成 TS + Python bindings。

```typescript
/** Wire Contract v0 — SearchRequest */
interface WireSearchRequest {
  query: string;
  options?: {
    mode?: 'lexical' | 'semantic' | 'hybrid';
    limit?: number;
    threadId?: string;
    dateFrom?: string;      // ISO8601
    dateTo?: string;        // ISO8601
    depth?: 'summary' | 'raw';
    contextWindow?: number;
    explain?: boolean;
  };
  identity: IdentityScope;
  origin: RequestOrigin;
}

/** Wire Contract v0 — SearchResponse */
interface WireSearchResponse {
  items: WireSearchItem[];
  meta: {
    degraded: boolean;
    degradeReason?: string;
    effectiveMode?: string;
    traceId?: string;
  };
  capabilities: WireCapabilities;
}

interface WireSearchItem {
  canonicalId: string;        // 全局唯一，可路由（见 §4）
  content: string;
  title?: string;
  summary?: string;
  kind?: string;
  speaker?: string;
  timestamp?: string;
  score?: number;
  provenance: WireProvenance;
  passages?: WirePassage[];   // depth=raw 时
}

interface WireProvenance {
  type: string;               // 'scanner' | 'conversation' | 'derived' | ...
  sourceUri?: string;
  sourceRevision?: string;    // 用于 lineage 追踪
  confidence?: number;
}

interface IdentityScope {
  tenant: string;             // Clowder instance/project
  user?: string;              // co-creator（按需隔离）
  agent: string;              // 'clowder-team'（Phase 1 team-shared）
  session?: string;           // thread ID（对话域）
}

interface RequestOrigin {
  source: string;             // 'clowder' | 'echomem'
  requestId: string;          // 幂等追踪
  hopCount: number;           // 防环（>1 拒绝）
}

interface WireCapabilities {
  textSearch: boolean;
  semanticSearch: boolean;
  entityResolution: boolean;
  graph: boolean;
  browse: boolean;
}
```

**协议 Owner**：Clowder v0 canonical schema。EchoMem native API 是首个 adapter target。
若未来共同治理，必须显式迁移到共同 repo + 版本流程，不能靠口头稳定承诺。

**EchoAgent Session Memory Engine 定位**：
仅保留在 EchoAgent 边缘（EchoAgentAdapter），不进入 Clowder↔EchoMem 核心链路。
Clowder↔EchoMem 直接对话用 Wire Contract v0。

---

## 3. 路由决策表

> **收敛结论**：用单一版本化路由表替换 `isProjectLocalScope` 特判。
> 不在 IEvidenceStore 上叠加特殊分支，而让 RetrievalCoordinator
> 持有按 domain 注册的 provider。

### 3.1 Phase 1 路由表（v1）

> **匹配语义**：规则按序匹配，**scope 特定规则优先于 dimension 规则**，第一命中生效。
> `depth` 不参与路由——它只影响请求返回形状（`summary` 返回摘要，`raw` 返回原文 + passages），
> 不改变 provider 选择。因此路由表是 **dimension × scope → provider** 的二维表。

**Tier 1: scope 特定规则（最高优先级，覆盖任何 dimension）**

| # | scope | Provider calls | 说明 | Phase 绑定 |
|---|-------|---------------|------|-----------|
| 1 | `threads` | **ConversationRetrieval** only | 对话消息 | P1-2: LegacyConv; P3+: EchoMem(primary) + LegacyConv(fallback) |
| 2 | `sessions` | **DocRetrieval** only | session digest 是 scanner 产物 | 全 Phase: Doc |
| 3 | `docs` | DocRetrieval only | 文档搜索 | 全 Phase: Doc |
| 4 | `memory` | DocRetrieval only | 记忆搜索 | 全 Phase: Doc |

**Tier 2: dimension 规则（scope 未指定或 scope=all 时生效）**

| # | dimension | Provider calls | 说明 |
|---|-----------|---------------|------|
| 5 | `project` | DocRetrieval only | 文档知识 |
| 6 | `global` | GlobalRetrieval only | 全局知识 |
| 7 | `all` | Doc + Conv + Global 并发 → RRF 融合 | 全域搜索 |
| 8 | `library` | 按 CollectionManifest 扇出（不含 Conv） | N-collection 联邦 |
| 9 | `collection` | 指定 collection IDs | 精确 collection |

**Fallback: scope 和 dimension 均未指定**

| # | 条件 | Provider calls | 说明 |
|---|------|---------------|------|
| 10 | `scope=undefined, dimension=undefined` | DocRetrieval only | 保守默认，兼容现有行为 |

> **sessions→Doc 而非 Conv**（Fable × Sol R1 修正）：`scope='sessions'` 在 store 层映射为
> `kind='session'`（SqliteEvidenceStore.ts:176-177），搜的是 **session digest 文档**——
> 这是 scanner/编译产物，按 source-based ownership 归 Doc domain。

### 3.2 设计约束

- **路由表是版本化 routing policy**：未来 ownership 迁移（如 session digest 改由 EchoMem 管理）只改这一处真相源
- **scope 优先于 dimension**：避免 `dimension=project, scope=threads` 这类组合产生矛盾——scope 是更强的意图信号
- **depth 不参与路由**：depth 只影响返回形状（summary vs raw + passages），不改变 provider 选择
- **Conversation 不走 CollectionManifest 体系**：
  - `CollectionKind` 只有 `project|world|domain|research|global`，无 `conversation`
  - collection `sensitivity` 是 per-collection 静态标签；对话隐私是 per-thread/per-message 的
  - EchoMem 不是 external collection，是 domain provider
- **EchoMem 不参与 `dimension=library/collection` 扇出**：它有独立的路由入口

---

## 4. CanonicalId 与 Identity Scope

> **Fable 最强反例确认**：canonicalId 未对齐前禁止开启双源窗口（shadow 双跑）——
> 否则 RRF 融合以 `item.anchor` 去重（KnowledgeResolver.ts:250-256），
> EchoMem 无兼容 anchor → 去重失败 → 同一消息双份进结果。

### 4.1 CanonicalId 格式

全局稳定、可路由、可映射 legacy anchor、可携带 source lineage。

```
格式（Phase 1）：<domain>:<type>/<id>
示例：
  doc:feature/F102           → DocRetrieval
  doc:decision/ADR-020       → DocRetrieval
  conv:thread/thread_mp3iz…  → ConversationRetrieval
  conv:message/msg_abc123    → ConversationRetrieval
  global:method/TDD          → GlobalRetrieval
```

### 4.2 与 Legacy Anchor 映射

| Legacy anchor 模式 | CanonicalId | Provider |
|--------------------|-------------|----------|
| `F102` / `ADR-020` | `doc:feature/F102` | Doc |
| `thread-thread_xxx` | `conv:thread/thread_xxx` | Conv |
| `session-xxx` | `doc:session/xxx` | Doc |
| `global:methods/xxx` | `global:method/xxx` | Global |

### 4.3 Anchor Namespace Registry

Layer 2 的一等设施。宿主拿到一个裸 anchor 必须知道问哪个 provider：

```typescript
class AnchorNamespaceRegistry implements AnchorRouter {
  private rules: Array<{
    pattern: RegExp;
    domain: 'doc' | 'conversation' | 'global';
    toCanonical: (legacyAnchor: string) => string;
  }> = [
    { pattern: /^thread-/, domain: 'conversation',
      toCanonical: a => `conv:thread/${a.replace('thread-', '')}` },
    { pattern: /^session-/, domain: 'doc',
      toCanonical: a => `doc:session/${a.replace('session-', '')}` },
    { pattern: /^global:/, domain: 'global',
      toCanonical: a => `global:${a.replace('global:', '')}` },
    // default: doc domain
    { pattern: /.*/, domain: 'doc',
      toCanonical: a => `doc:evidence/${a}` },
  ];
}
```

### 4.4 Identity Scope（Phase 1 推荐）

> **Fable × Sol 收敛 + operator 待确认**：Phase 1 推荐 team-shared。

| 字段 | Phase 1 值 | 说明 |
|------|-----------|------|
| `tenant` | Clowder instance ID / project slug | 实例级隔离 |
| `user` | co-creator ID（可选） | 按需隔离 |
| `agent` | `'clowder-team'` | **team-shared**：同一 thread 共享记忆，猫作为 speaker metadata |
| `session` | thread ID | 对话域按 thread 分 |

个体长期画像（per-cat namespace）另设，不在 Phase 1 范围。

---

## 5. 已有数据映射（实测数据）

> 以下数据来自 Clowder AI 实例的 `evidence.sqlite`（2026-06-30 快照）。

### 5.1 evidence_docs — 按数据来源归属

| kind | 数量 | 状态分布 | 数据来源 | 映射到 |
|------|------|---------|---------|--------|
| `feature` | 236 | active:221, done:13, in-progress:1, spec:1 | scanner 产物 | **DocMemory** |
| `plan` | 38 | active:37, draft:1 | scanner 产物 | **DocMemory** |
| `decision` | 10 | active:6, accepted:3, drifted:1 | scanner 产物 | **DocMemory** |
| `thread` | 7 | active:7 | IndexBuilder 编译对话 | **ConversationMemory** |
| `session` | 0 | — | scanner 产物 | DocMemory（session digest） |
| `lesson` | 0 | — | scanner 产物 | DocMemory |
| `discussion` | 0 | — | scanner 产物 | DocMemory |
| `research` | 0 | — | scanner 产物 | DocMemory |
| `pack-knowledge` | 0 | — | scanner 产物 | DocMemory |

**合计**：284 来自 scanner（→ DocMemory）+ 7 来自 IndexBuilder 对话编译（→ ConversationMemory）= 291 总文档。

### 5.2 evidence_passages — 100% 对话消息

| 指标 | 值 |
|------|-----|
| 总 passage 数 | 21,946 |
| 去重 doc_anchor 数 | 193（对应 193 个对话 thread） |
| doc_anchor 模式 | 100% `thread-*`（全部是对话消息） |
| 有对应 evidence_docs（kind=thread）的 | 5 个 |
| 孤儿 anchor（无对应 evidence_docs） | 188 个 |

> **孤儿根因是"删时不级联"**（Fable P1-B）：
> `deleteByAnchor()` 只删 `evidence_docs`，不级联删 `evidence_passages`
> （全 codebase 无 `DELETE FROM evidence_passages`）。
> 暴露更深的治理问题：历史 thread 记忆保留策略矛盾
> （doc 不保留 → 被 cleanup；passage 永久保留 → 无清理路径）。
> **必须先在我们治理层回答，再谈移交 EchoMem。**

### 5.3 edges — 100% 文档知识关系

| relation | 数量 |
|----------|------|
| `feature_ref` | 1,288 |
| `related_to` | 719 |
| `related` | 309 |
| `doc_link` | 113 |
| `wikilink` | 8 |
| **合计** | **2,437**（全部 doc-to-doc） |

所有 edge 归 DocMemory。ConversationMemory 若需对话内关系（SPO），在内部自建。

---

## 6. Wire Contract v0 详细设计

### 6.1 EchoMem 端点（Clowder 消费方）

EchoMemAdapter 做 EchoMem native API ↔ Wire Contract 翻译。

| Wire 操作 | EchoMem native 端点 | 说明 |
|----------|---------------------|------|
| `search` | `SessionService.search` / `RetrievalService.retrieve` | 对话搜索 |
| `getByCanonicalId` | `SessionService.getEvent` | anchor 精确查找 |
| `health` | health endpoint | 健康检查 |
| `capabilities` | probe / capability negotiation | 能力声明 |

> **不再使用 EchoAgent 的 Session Memory Engine 协议**（Sol P1 修正）。
> EchoMem develop 分支已有独立 SessionService / RetrievalService，
> 使用 tenant/user/agent/session 四层身份模型。

### 6.2 DocMemory 端点（EchoAgent 消费方）

EchoAgentMemoryEngineAdapter 保留在 EchoAgent 边缘，把 DocMemory
包装为 EchoAgent memory_query dialect。

> 这是边缘适配器，不是核心协议。Clowder↔EchoMem 核心链路用 Wire Contract v0。

### 6.3 防环与对称性

- 只保留**能力对称**：两侧互供 domain-pure endpoint
- **禁止 aggregate-to-aggregate**：Clowder 不调 EchoMem 的聚合端点，EchoMem 不调 Clowder 的聚合端点
- 每个请求带 `origin: { source, requestId, hopCount }`
- `hopCount > 1` → 拒绝（防环）

---

## 7. 可靠 Ingestion 协议

> **P1-A 前置设计缺口**（Fable P1-A + Sol P1 + 收敛锁定）：
> EchoAgent 的 `result` mode 是 session round 回调，Clowder 不是 EchoAgent，
> 没有 session round。当前没有任何机制把 Clowder 的 thread 消息灌进 EchoMem。

### 7.1 可验证语义（conformance-testable）

| # | 语义要求 | 说明 |
|---|---------|------|
| 1 | **Durable outbox** | 消息先写入本地 outbox，再异步投递 EchoMem。进程崩溃不丢事件 |
| 2 | **At-least-once delivery** | outbox 重试直到 ack。EchoMem 幂等消费 |
| 3 | **eventId + idempotencyKey** | 全局唯一事件 ID + 幂等键 |
| 4 | **sourceRevision** | 数据版本号，用于 lineage 追踪和 backfill |
| 5 | **Identity scope** | tenant / user / agent / session(thread) / message |
| 6 | **Thread 内有序** | 同一 thread 的消息保证有序投递。跨 thread 不要求 |
| 7 | **Backfill checkpoint/cursor** | 存量迁移支持断点续传 |
| 8 | **Ack / partial failure / retry ownership** | 部分失败重试由 Clowder outbox 负责，不由 EchoMem 主动拉取 |
| 9 | **Egress privacy filter** | 被标记为 private 的 thread / secret-scan 命中的消息**永不进入 outbox**。过滤在宿主侧，决策可审计。**前置依赖**：thread 隐私标记机制 + 消息级 secret-scan 均为需新建（见 §9） |
| 10 | **Tombstone 投递** | 删除事件作为特殊 event 进入 outbox，而非直接 DELETE 调用 |

### 7.2 IngestEvent v0 Schema

> **Fable P1-3**：TombstoneEvent（§8.2）有完整 interface，普通 IngestEvent 没有——
> 不对称导致 Phase 0 出口条件"conformance test fixture 通过"无法执行。

```typescript
interface IngestEvent {
  eventId: string;                  // 全局唯一（语义 #3）
  idempotencyKey: string;           // 幂等消费键（语义 #3）
  type: 'message';                  // 普通消息（vs TombstoneEvent.type='tombstone'）
  sourceRevision: string;           // 数据版本号（语义 #4，用于 backfill cursor + lineage）
  scope: IdentityScope;             // tenant/user/agent/session（语义 #5）
  canonicalId: string;              // 全局稳定 ID（§4）
  content: string;                  // 消息正文
  speaker: string;                  // 发言者（猫 ID / co-creator / system）
  timestamp: string;                // ISO8601（语义 #6 thread 内有序）
  position: number;                 // thread 内序号（语义 #6）
  metadata?: Record<string, unknown>; // 扩展字段（featureIds, toolCalls 等）
}
```

### 7.3 可选方案

| 方案 | 触发方 | 侵入性 | 推荐 |
|------|--------|--------|------|
| **A. 消息事件钩子 + outbox** | Clowder 消息处理管线 | 中 | ✅ **增量首选** |
| **B. IndexBuilder 改推** | rebuild 完成后批量推送 | 低 | ✅ **存量 backfill 首选** |
| C. EchoMem 主动拉取 | 定时轮询 | 低 | 实时性差 |
| D. 共享存储 | 直接读 SQLite | **高风险** | ❌ 违反隔离 |

> **最终方案 = A + B 组合**：A 负责增量消息实时推送（Phase 3+），B 负责存量 passage backfill（Phase 2）。
> 两者不是单选，而是覆盖不同阶段的互补机制。

### 7.4 前置问题

1. EchoMem 是否接受非 EchoAgent 事件源？（`result` mode payload schema 假设 round 结构）
2. 21,946 条存量 passage 如何 backfill？需要一次性迁移工具 + cursor
3. Clowder thread 消息 → EchoMem 的 schema 适配需要定义翻译层

---

## 8. 删除与 Lineage

> **Sol P1 + Fable 收敛加固**：EchoMem 从消息派生 atom / episode / graph，
> 删除源消息后派生记忆的清理无法靠 `Provenance {type, uri}` 判断。

### 8.1 删除权威唯一

**EchoMem 永不自主删除 / 过期 Clowder 数据**。只响应 tombstone。

| 权威 | 行为 |
|------|------|
| Clowder（唯一删除发起方） | 发送 tombstone event → outbox → EchoMem |
| EchoMem | 响应 tombstone：删除源消息 + 标记/删除派生记忆 |
| EchoMem 自主行为 | 允许不改变可检索逻辑状态的缓存/索引 compaction；不得自主 TTL/删除 |

### 8.2 Lineage 要求

```typescript
interface TombstoneEvent {
  eventId: string;
  type: 'tombstone';
  sourceCanonicalIds: string[];    // 被删除的源消息 canonicalId
  sourceRevision: string;          // 用于定位派生记忆
  scope: IdentityScope;
  reason: 'user_request' | 'thread_closed' | 'privacy_redaction';
  timestamp: string;
}
```

EchoMem 侧需要维护 `sourceEvent → derivedMemory` 的映射，
接收 tombstone 后级联处理派生 atom / episode / graph。

> retention 决策（历史 thread 记忆保多久）留在 Clowder 治理层。
> 孤儿 passage 问题（§5.2）是同一个未解决的治理空洞。

---

## 9. 隐私与部署边界（硬约束）

| 约束 | 要求 | 来源 |
|------|------|------|
| **部署位置** | EchoMem 必须 localhost / 同机部署。对话数据不出本机网络 | 铁律 #1 + W5 |
| **传输加密** | localhost 免 TLS；跨网络（未来）必须 mTLS | 安全基线 |
| **private thread** | 被标记为 private 的 thread 不推送到 EchoMem（§7.1 #9） | egress filter |
| **访问控制** | EchoMem endpoint 仅接受 Clowder 宿主连接（bind 127.0.0.1 + bearer token，参考 parent ADR §3.5） | 最小权限 |
| **数据保留** | EchoMem 侧保留策略不低于 Clowder 本地（当前无 TTL） | 铁律 #5 |
| **删除传播** | 用户删除对话 → Clowder 发 tombstone → EchoMem 级联删除（§8） | GDPR / 数据主权 |

### 9.1 前置依赖：隐私标记机制（需新建）

> **⚠️ 实然 vs 应然**（Fable P1-2 修正）：以下隐私过滤能力在当前系统中**均不存在**——
> ThreadSnapshot 没有 sensitivity 字段（仅 id/title/participants/threadMemory/lastActiveAt/featureIds），
> 消息级 secret-scan 仅存在于 marker 物化管道（`secretScanFingerprint`），不覆盖 outbox 场景。
> 今天的本地 passage 索引是无过滤全量索引。

| 需新建机制 | 说明 | 阻塞阶段 |
|-----------|------|---------|
| **Thread 隐私标记** | ThreadSnapshot 新增 `sensitivity: 'shared' \| 'private'` 字段 | Phase 3（outbox 上线前） |
| **消息级 secret-scan** | outbox 入口前扫描消息内容，命中 secret pattern → 拦截 | Phase 3 |
| **隐私标记默认值** | **价值决策**（见 §13 OQ#11）：默认 private（保守，EchoMem 初期只拿显式共享的 thread）vs 默认 shared（激进，全量进） | Phase 3 前 operator 拍板 |

> **"过滤在前、分区在后"论证链修正**：egress privacy filter（过滤层）是**待建机制**，
> 不能作为已有保障来论证 agentId 分区（分区层）的安全性。
> 两层都是设计目标，非既有防线。Decision Packet（§13 OQ#8 + OQ#11）必须如实声明。

---

## 10. 迁移拓扑

> **拓扑序锁死**（Fable 最强反例 + Sol 确认）：
> canonicalId 未对齐前禁止开启双源窗口。

```
Phase 0: 协议
  canonicalId 格式 + IdentityScope + Wire Contract v0 schema + IngestEvent v0 schema
  → 两侧 conformance test fixture 通过（SearchRequest/Response + IngestEvent + TombstoneEvent）
    │
    ▼
Phase 1: 薄桥
  projectStore 拆为 DocRetrievalProvider + LegacyConversationProvider
  路由决策表替换 isProjectLocalScope
  AnchorNamespaceRegistry 上线
  本地 21,946 passage 继续由 LegacyConv 服务
    │
    ▼
Phase 2: Shadow 双跑
  EchoMem ConversationRetrievalProvider 上线（shadow mode）
  LegacyConv + EchoMem 双源对比（RRF 融合用 canonicalId 去重 → 不会重复）
  backfill 存量 passage 到 EchoMem
  F200 Eval 基线对比
    │
    ▼
Phase 3: Ownership 切换
  threads scope 路由切到 EchoMem（LegacyConv 降为 fallback）
  ingestion outbox 上线（增量消息实时推送）
  验收门槛通过 → LegacyConv 下线
```

### 10.1 回退成本

| 场景 | 回退行为 | 成本 |
|------|---------|------|
| EchoMem 不可达 | health()=false → Conv provider degraded → 对话搜索走 LegacyConv fallback | **零改动** |
| 决定不用 EchoMem | 路由表 threads→LegacyConv | **1 行改动** |
| EchoMem 数据不可靠 | shadow 对比失败 → 不进 Phase 3 | 设计保护 |

---

## 11. 验收基线

**验收方案**：挂载 **F200 Memory Recall Eval**。

| 指标 | 基线来源 | 门槛 |
|------|---------|------|
| 对话召回率（recall@10） | 当前 passage_fts + passage_vectors | ≥ 0.95 × LegacyConv 基线值（相对门槛，非绝对 95%） |
| 搜索延迟 P95 | 当前 KnowledgeResolver 单 store | ≤ 2× 本地延迟 |
| 降级正确性 | EchoMem 不可达 → degraded=true | 100% |
| list_recent 完整性 | scope=threads 返回最近 N 个 thread | 不劣于本地（Phase 2+） |
| 去重正确性 | shadow 双跑期间无重复结果 | canonicalId 对齐 = 100% |

---

## 12. 显式否决记录

> **收敛三方（codex/Fable/Sol）明确否决的方向**（不是 OQ，是已关闭的决策）。

| # | 否决方向 | 理由 |
|---|---------|------|
| 1 | Conversation 伪装成 external collection + 新增 `conversation` kind | collection sensitivity 是 per-collection 静态标签，对话隐私是 per-thread/per-message；CollectionManifest 必填字段（root/scannerLevel/indexPolicy/reviewPolicy）对 EchoMem 无意义 |
| 2 | 三原语 MemoryStore 直接充当跨团队协议 | MemoryStore 是存储 SPI 面向后端实现者；跨领域协作需要领域接口（Layer 2）+ 语言中立协议（Layer 3） |
| 3 | EchoAgent Session Memory Engine 充当 Clowder↔EchoMem 核心协议 | Session Memory Engine 是 EchoAgent 边缘适配器（单 endpoint + mode 分流），不是中立跨宿主协议；EchoMem develop 已有独立 SessionService/RetrievalService |
| 4 | Aggregate-to-aggregate 双向调用 | 递归/重复风险；两侧只暴露 domain-pure endpoint + origin/hopCount 防环 |
| 5 | Hook-only（无 durable outbox）的 ingestion | 进程崩溃丢事件；无法保证 at-least-once delivery |
| 6 | 先 shadow 双跑、后补 canonicalId | RRF 以 anchor 去重，EchoMem 无兼容 anchor → 去重失败 → 重复结果污染 F200 |
| 7 | EchoMem native API 作为 wire truth（无共同治理 repo） | 协议 owner = 兼容义务承担者；外部团队"承诺稳定"不是可执行约束 |
| 8 | scope=threads/sessions 静态路由到 ConversationProvider | `sessions` 在 store 层映射为 `kind=session`（scanner 产物），归 Doc domain |

---

## 13. 开放问题

### 技术 OQ（不阻塞文档修正）

| # | 问题 | 当前立场 |
|---|------|---------|
| 1 | canonicalId 具体语法 | 本稿固定"全局稳定/可路由/可映射 legacy/可携带 lineage"；具体格式留实施 spec |
| 2 | routing table 完整矩阵 | 由 §3.1 列出，reviewer 复核 dimension/scope/depth 覆盖 |
| 3 | EchoMem `memory_query` response 格式对齐 | Wire Contract v0 定义结构化返回；EchoMemAdapter 翻译 |
| 4 | 孤儿 passage 治理方案 | 根因是 cleanup 不级联（§5.2）；治理策略先在宿主层回答 |
| 5 | 两侧 RRF 融合权重 | 默认等权，消费 rerank（F200）在融合后由宿主统一做 |
| 6 | list_recent recency 查询 | TextBlockStore 需新增 `orderBy` 语义或 BrowseProvider 独立实现 |
| 7 | adapter traversal stats 损失 | service-backed collection 丢失 F200 遍历信号，记为已知损失 |

### 价值 OQ（需 operator 确认，Decision Packet）

| # | 问题 | 推荐 | 替代 |
|---|------|------|------|
| 8 | EchoMem `agentId` 分区 | **team-shared**（同一 thread 共享记忆，猫作为 speaker）。注：与 OQ#11 是同一问题的两层——*什么进 EchoMem（过滤）× 进去后谁可见（分区）*，合成一个 Decision Packet | per-cat（隔离强但跨猫召回不一致，迁移成本高） |
| 9 | EchoMem 是否愿意接非 EchoAgent 事件源 | 与 EchoMem 团队对齐的第一议题 | — |
| 10 | 历史 thread 记忆保留策略 | 先在宿主治理层回答 | — |
| 11 | **Thread 隐私标记默认值** | **默认 private**（保守：EchoMem 初期只拿显式标记为 shared 的 thread，最小暴露面） | 默认 shared（激进：全量进 EchoMem，用 per-thread opt-out） |

---

## 附录：踩坑教训

> **Fable × Sol 收敛 → public-lessons**

1. **Host-specific adapter ≠ neutral protocol**：EchoAgent 的 Session Memory Engine 是 EchoAgent 对 EchoMem 的适配器，不是 EchoMem 对所有宿主的协议。把边缘适配器提升为核心协议 = 绑定到一个特定宿主的实现细节。
2. **两个正交抽象轴不能共用一个 Provider 名称**：storage backend（怎么存）和 domain provider（搜什么 + 怎么路由）是正交的。混用导致 `scope=threads` 硬路由到 project store 而 EchoMem 永远查不到。
3. **协议 canonicalId 是双源窗口的硬前置**：任何融合/去重都依赖 ID 对齐。先跑后补 = 污染数据 + 回滚成本指数增长。

---

## 附录：关键源码锚点

| 组件 | 文件 | 行号 |
|------|------|------|
| `isProjectLocalScope` 硬路由 | `KnowledgeResolver.ts` | 240-242, 154-156 |
| `CollectionKind` 无 conversation | `collection-types.ts` | 4 |
| `CollectionManifest` 必填字段 | `collection-types.ts` | 22-42 |
| `deleteByAnchor` 不级联 passage | `SqliteEvidenceStore.ts` | 1362-1367 |
| `RecentBrowseResolver` duck-typed getDb | `RecentBrowseResolver.ts` | 60, 109, 168 |
| `library.ts` duck-typed getDb | `library.ts` | 45, 90, 115, 243, 271, 572 |
| RRF 融合以 anchor 去重 | `KnowledgeResolver.ts` | 250-256 |
| EchoAgent Session Memory Engine | `session-memory-engine.service.ts` | 450, 481 |
| `scope='sessions'` → `kind='session'` | `SqliteEvidenceStore.ts` | 176-177 |

### 外部参考锚点

| 组件 | 仓库 | 路径 |
|------|------|------|
| EchoMem SessionService | EchoMem (develop) | `src/echomem/req_coordinator/interfaces/session_service.py` |
| EchoMem RetrievalService | EchoMem (develop) | `src/echomem/req_coordinator/interfaces/retrieval_service.py` |
| EchoMem ContextItemRsp | EchoMem (develop) | `src/echomem/memrouter/recall/interfaces/entities/retrieval.py` |
| EchoAgent Session Memory Engine | EchoAgent | `dev/backend/src/modules/session/session-memory-engine.service.ts` |
| EchoAgent Memory Query Tool | EchoAgent | `dev/backend/src/modules/session/tools/builtins/memory-query-via-engine.tool.ts` |
