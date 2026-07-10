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
- `getDb()` 逃逸面（13 个 caller）证明 IEvidenceStore 的抽象边界已经被实现细节穿透
- collection 的 `sensitivity` 是 per-collection 静态标签，而对话隐私是 per-thread/per-message 的

**迁移期薄桥**：projectStore 包装为 DocRetrievalProvider + LegacyConversationProvider，
后者持有本地 passage 数据直到 EchoMem ownership 切换完成。

### 2.3 Layer 3: Wire Contract

跨团队协议。语言中立，OpenAPI/JSON Schema 为真相源，生成 TS + Python bindings。

```typescript
/** Wire Contract v0 — SearchRequest */
interface WireSearchRequest {
  version: 'v0';              // 请求必带版本（单一真相源，不用 header）
  query: string;
  options?: {
    mode?: 'lexical' | 'semantic' | 'hybrid';
    limit?: number;
    dateFrom?: string;      // ISO8601
    dateTo?: string;        // ISO8601
    depth?: 'summary' | 'raw';
    contextWindow?: number;
    explain?: boolean;
    // threadId 删除：thread 过滤通过 identity.session 传递（单一真相源）
  };
  identity: IdentityScope;
  origin: RequestOrigin;
}
// 版本不兼容 → WireError { code: 'unsupported_version' }

/** Wire Contract v0 — SearchResponse */
interface WireSearchResponse {
  items: WireSearchItem[];
  meta: WireResponseMeta;
  // capabilities 不在每个 response 中附带（避免两个能力真相源漂移）
  // 能力快照仅由 capabilities endpoint / 握手返回
}

interface WireResponseMeta {
  degraded: boolean;
  degradeReason?: string;
  effectiveMode?: string;
  traceId?: string;
  servedBy?: string;        // 'primary' | 'fallback'（§10.1）
}

/** Wire Contract v0 — GetByCanonicalId */
interface WireGetRequest {
  canonicalId: string;       // §4 格式
  identity: IdentityScope;
  origin: RequestOrigin;
}

interface WireGetResponse {
  item: WireSearchItem | null;
  meta: WireResponseMeta;
}

/** Wire Contract v0 — Health */
interface WireHealthResponse {
  healthy: boolean;
  latencyMs?: number;
  message?: string;
}

/** Wire Contract v0 — Capabilities（唯一能力真相源，握手 / 按需获取） */
interface WireCapabilitiesResponse {
  capabilities: WireCapabilities;
  version: string;            // 'v0'
  supportedModes: Array<'lexical' | 'semantic' | 'hybrid'>;
  supportedDepths: Array<'summary' | 'raw'>;
  supportedFilters: Array<'dateRange' | 'contextWindow' | 'explain' | 'sessionScope'>;
  // 请求中的 filter 不在 supportedFilters 中 → WireError { code: 'not_supported' }
  // 不允许静默忽略不支持的 filter
}

/** Wire Contract v0 — Error envelope */
interface WireError {
  code: string;               // 'not_supported' | 'invalid_request' | 'internal' | ...
  message: string;
  requestId: string;
}

interface WireSearchItem {
  canonicalId: string;        // tenant-scoped 唯一（见 §4）
  content: string;
  title?: string;
  summary?: string;
  kind?: string;              // metadata，不编入 canonicalId
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
  session?: string;           // thread ID — 唯一 thread 过滤真相源（不再在 options 里重复）
}

interface RequestOrigin {
  source: string;             // 'clowder' | 'echomem'
  requestId: string;          // correlation ID（不是读请求幂等键）
  hopCount: number;           // 防环（>1 拒绝）
}

interface WireCapabilities {
  textSearch: boolean;
  semanticSearch: boolean;
  entityResolution: boolean;
  graph: boolean;
  browse: boolean;
  anchorLookup: boolean;      // getByCanonicalId 支持
}
```

**协议 Owner**：Clowder v0 canonical schema。EchoMem native API 是首个 adapter target。
若未来共同治理，必须显式迁移到共同 repo + 版本流程，不能靠口头稳定承诺。

**EchoAgent Session Memory Engine 定位**：
仅保留在 EchoAgent 边缘（EchoAgentAdapter），不进入 Clowder↔EchoMem 核心链路。
Clowder↔EchoMem 直接对话用 Wire Contract v0。

**已知 EchoMem 能力 Gap**（需与 EchoMem 团队对齐）：

| Wire 操作 | EchoMem develop 现状 | Gap |
|----------|---------------------|-----|
| `search` | `RetrievalService.retrieve` 可对接 | ✅ 可映射 |
| `getByCanonicalId` | `SessionService.get` 存在，但无 exact event lookup | ⚠️ anchorLookup 声明 false，或 EchoMem 需扩展 |
| `health` | 有 health endpoint | ✅ |
| `capabilities` | 无 capability probe | ⚠️ 需要 EchoMem 实现或 adapter 静态声明 |

> **Sol P2-1 修正**：EchoMem develop 的 SessionService 只有 open/get，没有 SessionService.search。
> 实际搜索是 HTTP client → RetrievalService.retrieve。Wire 操作表已修正。

---

## 3. 路由决策表

> **收敛结论**：用单一版本化路由表替换 `isProjectLocalScope` 特判。
> 不在 IEvidenceStore 上叠加特殊分支，而让 RetrievalCoordinator
> 持有按 domain 注册的 provider。

### 3.1 Phase 1 路由表（v1）

> **路由语义**（Sol P1-1 修正）：**dimension 选定 provider 集合（universe），scope 在集合内过滤**。
> 不使用 wildcard 叠表——每个 `(dimension, scope)` 组合有唯一确定的 provider 结果。
> `depth` 不参与路由，只影响返回形状（`summary` 返回摘要，`raw` 返回原文 + passages）。

**dimension 定义 provider universe**

| dimension | 可用 providers | Conv 参与 |
|-----------|---------------|-----------|
| `project` | Doc + Conv | ✅ project-local 知识含对话 |
| `global` | Global only | ❌ |
| `all` | Doc + Conv + Global | ✅ |
| `library` | CollectionManifest 扇出 | ❌ Conv 不是 collection |
| `collection` | 指定 collection IDs | ❌ Conv 不是 collection |
| `undefined` | Doc only | ❌ 保守默认 |

**scope 在 universe 内过滤**

| scope | 在 universe 内保留 | 说明 |
|-------|-------------------|------|
| `threads` | 仅 Conv（若 universe 不含 Conv → empty + degraded nudge） | 对话消息 |
| `sessions` | 仅 Doc（session digest 是 scanner 产物，归 Doc） | session digest |
| `docs` | Doc + Global（若 universe 含 Global） | 文档搜索 |
| `memory` | Doc + Global（若 universe 含 Global） | 记忆搜索 |
| `undefined` / `all` | universe 全部 providers | 不过滤 |

**完整路由矩阵**（dimension × scope → providers）

| dimension \ scope | `undefined`/`all` | `threads` | `sessions` | `docs` | `memory` |
|-------------------|-------------------|-----------|------------|--------|----------|
| `project` | Doc + Conv | Conv | Doc | Doc | Doc |
| `global` | Global | ⚠️ empty+nudge | Global | Global | Global |
| `all` | Doc+Conv+Global → RRF | Conv | Doc | Doc+Global | Doc+Global |
| `library` | CollManifest 扇出 | ⚠️ empty+nudge | CollManifest 扇出 | CollManifest 扇出 | CollManifest 扇出 |
| `collection` | 指定 IDs | ⚠️ empty+nudge | 指定 IDs | 指定 IDs | 指定 IDs |
| `undefined` | Doc | ⚠️ empty+nudge | Doc | Doc | Doc |

> **⚠️ empty+nudge**：dimension 的 provider universe 不含 Conv 时，scope=threads 返回空结果 +
> `meta: { degraded: true, degradeReason: 'scope_not_available_in_dimension' }`。
> 不静默路由到 Conv（否则 `dimension=global` 被偷换成 Conv 查询）。

**Conv provider Phase 绑定**

| Phase | Conv 实现 | 说明 |
|-------|----------|------|
| Phase 1-2 | LegacyConv (primary) | projectStore 包装的薄桥 |
| Phase 3+ | EchoMem (primary) + LegacyConv (fallback) | fallback 仅在 timeout/unhealthy/contract-error 触发 |

**Breaking changes vs 现有行为**

| 组合 | 现有行为 | 新行为 | 变更类型 |
|------|---------|--------|---------|
| `project + undefined` | projectStore 搜 docs+threads（单 store） | Doc+Conv（两个 provider 并发） | ⚠️ 行为保持，实现变 |
| `all + docs/memory` | project+global | Doc+Global | ✅ 兼容 |
| `global + threads` | 不走 isProjectLocalScope，搜 globalStore | empty+nudge | ⚠️ Breaking：显式报告不可用 |
| `undefined + threads` | 不到这里（dimension 总有值） | empty+nudge | ⚠️ 新增防护 |

> **sessions→Doc 而非 Conv**（Fable × Sol R1 修正）：`scope='sessions'` 在 store 层映射为
> `kind='session'`（SqliteEvidenceStore.ts:176-177），搜的是 **session digest 文档**——
> 这是 scanner/编译产物，按 source-based ownership 归 Doc domain。

### 3.2 设计约束

- **路由表是版本化 routing policy**：未来 ownership 迁移只改这一处真相源
- **dimension 先选 universe，scope 再过滤**：不使用 wildcard/tier 叠加——每个 `(dimension, scope)` 组合有唯一确定结果
- **scope 不兼容 universe 时报告而非偷路由**：`global + threads` → empty+nudge, 不静默切到 Conv
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

### 4.1 CanonicalId 设计

> **Sol P1-3 修正**：canonicalId 必须满足：
> 1. **tenant-scoped 唯一**：唯一性定义为 `(IdentityScope.tenant, canonicalId)` 元组，
>    tenant 不编入字符串（避免过长/泄露）
> 2. **稳定**：基于不可变 source/native ID，不含可变 metadata（kind 变化不改 ID）
> 3. **可路由**：domain 前缀决定 provider 分发
> 4. **可编码**：segment 内 `/`、`:`、unicode 需 percent-encoding（RFC 3986）

**Grammar（Phase 0 必须固定）**

```
canonicalId := domain ":" nativeId
domain      := "doc" | "conv" | "global"
nativeId    := segment ("/" segment)*
segment     := pchar*                   // RFC 3986 pchar，保留字符 percent-encode
```

```
示例：
  doc:F102                   → DocRetrieval（anchor = F102，不含 kind）
  doc:ADR-020                → DocRetrieval
  conv:thread_mp3iz…         → ConversationRetrieval
  conv:msg_abc123            → ConversationRetrieval
  global:methods/TDD         → GlobalRetrieval
```

> **kind 不编入 canonicalId**：kind 是可变 metadata（evidence_docs.kind 可以改），
> 编入 ID 会违反稳定性。kind 作为 WireSearchItem.kind metadata 传递。

### 4.2 与 Legacy Anchor 映射

| Legacy anchor 模式 | CanonicalId | Provider | 说明 |
|--------------------|-------------|----------|------|
| `F102` | `doc:F102` | Doc | anchor 原样保留为 nativeId |
| `ADR-020` | `doc:ADR-020` | Doc | 同上 |
| `thread-thread_xxx` | `conv:thread_xxx` | Conv | 去掉 `thread-` 前缀 |
| `session-xxx` | `doc:session-xxx` | Doc | anchor 原样 |
| `global:methods/xxx` | `global:methods/xxx` | Global | 保留原始路径 |

### 4.3 Conformance vectors（Phase 0 交付物）

> table-driven：每行写 legacy anchor、expected canonicalId、expected resolve 输出。
> 不使用模糊断言——strip prefix 意味着 roundtrip 不恒等（`thread-thread_abc` → `thread_abc`），
> 必须逐行验证。

```
// canonicalize: legacy anchor → canonicalId
| legacy anchor          | expected canonicalId       |
|------------------------|---------------------------|
| "F102"                 | "doc:F102"                |
| "ADR-020"              | "doc:ADR-020"             |
| "thread-thread_abc"    | "conv:thread_abc"         |
| "session-sess_123"     | "doc:session-sess_123"    |
| "global:methods/TDD"   | "global:methods/TDD"      |
| "has/slash"            | "doc:has%2Fslash"         |

// resolve: canonicalId → { domain, localId }
| canonicalId            | expected domain | expected localId  |
|------------------------|----------------|-------------------|
| "doc:F102"             | "doc"          | "F102"            |
| "conv:thread_abc"      | "conv"         | "thread_abc"      |
| "global:methods/TDD"   | "global"       | "methods/TDD"     |
| "doc:has%2Fslash"      | "doc"          | "has/slash"       |

// roundtrip: canonicalize then resolve
| legacy anchor          | resolve(canonicalize(a)).localId | 说明 |
|------------------------|---------------------------------|------|
| "F102"                 | "F102"                          | 恒等 |
| "thread-thread_abc"    | "thread_abc"                    | prefix stripped, not equal to legacy |
| "global:methods/TDD"   | "methods/TDD"                   | `global:` prefix stripped |
```

### 4.4 Anchor Namespace Registry

Layer 2 一等设施。实现完整 `AnchorRouter` 接口：`canonicalize`（legacy→canonical）+
`resolve`（canonical→provider+localId）+ `owns`（判断归属）。

> **domain 类型对齐**：grammar domain = `doc | conv | global`。
> Registry rule 和 provider map 均使用 grammar domain（`conv`），不是 `conversation`。

```typescript
// domain 类型与 grammar 一致
type CanonicalDomain = 'doc' | 'conv' | 'global';

class AnchorNamespaceRegistry implements AnchorRouter {
  private providers = new Map<CanonicalDomain, RetrievalProvider>();

  private rules: Array<{
    pattern: RegExp;
    domain: CanonicalDomain;
    stripPrefix: string;  // legacy anchor 去前缀
  }> = [
    { pattern: /^thread-/, domain: 'conv', stripPrefix: 'thread-' },
    { pattern: /^global:/, domain: 'global', stripPrefix: 'global:' },  // strip `global:` prefix
    // session-* stays in doc domain (session digests are scanner products)
    { pattern: /^session-/, domain: 'doc', stripPrefix: '' },
    // default: doc domain, no prefix strip
    { pattern: /.*/, domain: 'doc', stripPrefix: '' },
  ];

  // legacy anchor → canonicalId
  canonicalize(legacyAnchor: string): string {
    const rule = this.rules.find(r => r.pattern.test(legacyAnchor))!;
    const nativeId = legacyAnchor.replace(rule.stripPrefix, '');
    return `${rule.domain}:${encodeSegments(nativeId)}`;
  }

  // canonicalId → { provider, localId }
  resolve(canonicalId: string): { provider: RetrievalProvider; localId: string } | null {
    const colonIdx = canonicalId.indexOf(':');
    if (colonIdx < 0) return null;
    const domain = canonicalId.slice(0, colonIdx) as CanonicalDomain;
    const localId = decodeSegments(canonicalId.slice(colonIdx + 1));
    const provider = this.providers.get(domain);
    return provider ? { provider, localId } : null;
  }

  // canonicalId 归属判断
  owns(canonicalId: string): boolean {
    return this.resolve(canonicalId) !== null;
  }
}
```

### 4.5 Identity Scope（Phase 1 推荐）

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

| Wire 操作 | EchoMem native 端点 | 状态 | 说明 |
|----------|---------------------|------|------|
| `search` | HTTP → `RetrievalService.retrieve` | ✅ 可映射 | 对话搜索 |
| `getByCanonicalId` | `SessionService.get`（无 exact event lookup） | ⚠️ Gap | anchorLookup 初始声明 false |
| `health` | health endpoint | ✅ | 健康检查 |
| `capabilities` | 无 capability probe | ⚠️ Gap | adapter 静态声明或 EchoMem 需实现 |

> **不再使用 EchoAgent 的 Session Memory Engine 协议**（Sol P1 修正）。
> EchoMem develop 分支已有独立 SessionService / RetrievalService，
> 使用 tenant/user/agent/session 四层身份模型。
> 注意：SessionService 只有 open/get，不是搜索入口。搜索走 RetrievalService。

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
  canonicalId grammar + IdentityScope + Wire Contract v0 schema + IngestEvent v0 schema
  → 两侧 conformance test fixture 通过（SearchRequest/Response + IngestEvent + TombstoneEvent）
  → table-driven canonicalize/resolve conformance vectors 通过
    │
    ▼
Phase 1: 薄桥
  projectStore 拆为 DocRetrievalProvider + LegacyConversationProvider
  路由决策表替换 isProjectLocalScope
  AnchorNamespaceRegistry 上线
  本地 21,946 passage 继续由 LegacyConv 服务
    │
    ▼
Phase 2: Durable outbox + Backfill + Shadow 旁路
  2a. durable outbox 上线（增量消息实时推送到 EchoMem）
  2b. backfill 存量 passage 到 EchoMem（IndexBuilder 改推 + cursor 断点续传）
  2c. EchoMem ConversationRetrievalProvider 上线（shadow mode = 旁路观测）
      shadow 不进入 served result / 消费遥测 / RRF 融合
      → 旁路比较：same query → LegacyConv result vs EchoMem result → diff 报告
      → F200 Eval 基线对比（仅离线评测，不影响在线排序）
    │
    ▼
Phase 3: Read primary 切换
  路由表 Conv slot: primary=EchoMem, fallback=LegacyConv
  fallback 触发条件：timeout / unhealthy / contract-error（零命中不触发 fallback）
  meta 标明 degraded + servedBy=fallback
  验收门槛通过 → 进入 rollback window（定期 N 天）
    │
    ▼
Phase 4: Rollback window 到期
  明确决定后才清理 LegacyConv（降为 dormant，不是"下线"）
  dormant = 不主动写入/更新，但数据保留可回退
```

> **Sol P1-2 修正**：
> 1. Shadow 必须旁路比较，不能进入 served result——即便 canonicalId 相同不重复显示，
>    现有 RRF 会累加同 anchor 分数，改变用户可见排序并污染 F200。
> 2. Outbox 移到 Phase 2（不是 Phase 3）——否则 shadow 期间新增消息不进 EchoMem，
>    F200 对比必然拿 stale dataset。
> 3. LegacyConv 生命周期是 "primary → fallback → dormant"，不是 "primary → 下线"。
>    Dormant 意味着数据保留但不再主动更新，可随时回退到 fallback 角色。

### 10.1 路由 policy 角色

| 角色 | 语义 | 触发条件 |
|------|------|---------|
| `primary` | 正常服务路径 | 默认 |
| `fallback` | primary timeout/unhealthy/contract-error 时接管 | **零命中不触发 fallback**（空结果是合法返回） |
| `shadow[]` | 旁路观测，不进入 served result | 始终执行，结果只用于 diff 报告 |

> fallback 返回时 meta 必须标明 `degraded: true, servedBy: 'fallback'`。

### 10.2 回退成本

| 场景 | 回退行为 | 成本 |
|------|---------|------|
| EchoMem 不可达 | health()=false → Conv provider degraded → 对话搜索走 LegacyConv fallback | **零改动**（自动） |
| 决定不用 EchoMem | 路由表 Conv slot: primary=LegacyConv, shadow=[] | **1 行配置改动** |
| EchoMem 数据不可靠 | Phase 2 shadow diff 不达标 → 不进 Phase 3 | 设计保护 |
| Phase 3 后发现问题 | rollback window 内切回 LegacyConv=primary | dormant 数据可用 |

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
| 1 | ~~canonicalId 具体语法~~ | **已关闭**：§4.1 已固定 Phase 0 grammar（`domain ":" nativeId`，RFC 3986 encoding）+ conformance vectors。剩余：编码库选择（手写 vs URI 库） |
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

> **Fable × Sol 收敛 — 候选教训（待正式沉淀到 docs/public-lessons.md）**

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
