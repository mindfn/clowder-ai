---
title: "记忆能力抽象 — 组件化方案"
participants: [opus, fable, sol, codex, lang]
status: design-draft
created: 2026-06-30
updated: 2026-07-13
doc_kind: decision
decision_id: ADR-candidate-memory-abstraction
feature_ids: [F102]
topics: [memory, componentization, abstraction, provider]
related: ["memory-service-componentization.md"]
---

# 记忆能力抽象 — 组件化方案

> **Status**: design-draft（2026-07-13，基于方向纠正重写）
> **Issue**: [#1047](https://github.com/zts212653/clowder-ai/issues/1047)
> **Parent ADR**: [记忆服务组件化 — 三原语模型](memory-service-componentization.md)
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
| **下架** | 过期/失效的书下架 | `status: invalidated/archived` + `supersededBy` |
| **内部管理** | 图书馆自己处理 | 索引重建、向量嵌入、去重、矛盾检测、消费加权排序 |

**取书的两种模式**（`depth` 参数控制）：
- **文档类**：索引命中 → LLM 用 drill-down 工具 grep 原文件取全文（索引是摘要，原文在 repo）
- **对话类**：内容就在 passages 里，直接返回（对话消息本身就是内容，不需要回源）

上层不需要知道书架怎么组织、用的什么数据库、索引怎么建。**这就是组件化的目标**。

> **核心原则：索引可重建**。真相源始终是 docs/*.md + thread 消息历史（Parent ADR 最早的正确决策）。
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

**问题**：文档类和对话类混在同一个 `projectStore` 里。想单独替换对话类的后端（比如换成 EchoMem）→ 没法拆，因为它们共享同一个 `SqliteEvidenceStore` 实例。

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

图书馆只有一个前台。**一个 MemoryComponent 实例 = 一个馆**（project 馆、global 馆、每个 collection 各一个馆）。联邦搜索（跨馆 RRF 融合）在组件之上：

```
上层应用（search_evidence / list_recent / graph_resolve）
    │
    ▼
Federation Layer（跨馆 RRF 融合）← 现有 KnowledgeResolver 的跨 store 部分
    │
    ├── project 馆: MemoryComponent        ← 实例边界 = 替换边界 = 联邦单元
    │   │ remember — 入库
    │   │ recall   — 检索
    │   │ read     — 取书（inline content 或 resource reference）
    │   │ related  — 关系图查询（"这本书引用了谁/被谁引用"）
    │   │ invalidate — 下架（可逆）
    │   │ maintain — 内部管理（sunset 执行 / compaction / 向量重建）
    │   │ health
    │   │
    │   └── 当前实现：LocalMemoryComponent
    │       由 SqliteEvidenceStore + (NEW) SunsetManager 组合
    │       内部有 doc/conv 路由——实现细节，不是应用契约
    │
    ├── global 馆: MemoryComponent
    │
    └── collection_N 馆: MemoryComponent（LibraryCatalog entry）
```

**两个正交轴（Sol 的关键洞察）**：federation（哪些馆——宿主的事）× content type（馆内书籍分类——组件的事）。之前所有复杂度爆炸（RouteSlot、domain grammar、30 格矩阵、"Conv 不是 collection" 的反复辩论）根源都是把 conv 错当成一个新馆——它不是馆，是书的类型。

**rebuild 与 maintain 的分离**：rebuild = 宿主重放全量 ingest（扫描真相源 → 逐条 `remember()`），是宿主发起的操作；`maintain()` = 组件内部索引健康（compaction / 向量重建 / sunset 执行），是组件自治的操作。当前 IndexBuilder 混合了这两个语义（既做扫描又直写 SQL），正是 `getDb` 逃逸 13 处的根因——组件化后扫描归宿主，写入走 `remember()`。

### 4.2 能力契约

```typescript
interface MemoryComponent {
  // ── 应用层（上层直接使用）──
  remember(input: MemoryInput): Promise<MemoryRecord>;
  recall(query: MemoryQuery): Promise<MemorySearchResult>;
  read(key: MemoryKey): Promise<MemoryRecord | null>;
  related(key: MemoryKey, options?: RelationOptions): Promise<RelatedMemory[]>;

  // ── 系统层（系统事件触发）──
  invalidate(key: MemoryKey, reason: InvalidationReason): Promise<void>;
  recordFeedback(event: MemoryFeedback): Promise<void>;
  maintain(): Promise<MaintenanceReport>;

  // ── 运维层 ──
  health(): Promise<MemoryHealth>;
}
```

上层应用直接使用前四项（`related` 覆盖 `graph_resolve` 三入口之一，2,437 edges 在用——Fable 补充）；`invalidate` / `recordFeedback` 来自系统事件；`maintain` 由组件内部调度。

### 4.3 数据模型

```typescript
// 记忆的唯一标识——无路由含义，现有 anchor 直接作为 id
// namespace 降为实例配置或组件内部分区用途（不参与跨馆路由）
type MemoryKey = { namespace: string; id: string };

// 真相源引用（"索引可重建"的基础——知道从哪重建）
type SourceRef = { source: string; sourceId: string; revision?: string };

// 记忆内容——文本或资源引用（预留媒体扩展）
type MemoryContent =
  | { type: 'text'; text: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType: string; indexText?: string };

// 生命周期状态——默认持久化，sunset 是可逆检索过滤
type LifecycleState = 'active' | 'dormant' | 'superseded' | 'invalidated';
// 默认搜索只返回 active；旧记忆仍可 read/export
// 硬删除只响应用户或真相源删除事件（符合铁律"用户状态默认持久化"）
```

### 4.4 现有代码如何映射

| MemoryComponent 方法 | 现有实现 | 说明 |
|---------------------|---------|------|
| `remember` | IndexBuilder（docs 扫描入库）+ session compiler（conv） | 入库路径按内容类型不同——实现细节。**注意**：当前 IndexBuilder 混合扫描和直写，组件化后扫描归宿主、写入走 remember() |
| `recall` | KnowledgeResolver.resolve() + RRF fusion + 消费加权 | 已有联邦搜索。注意：跨馆 RRF 归 Federation Layer，单馆内搜索归组件 |
| `read` | IEvidenceStore.getByAnchor() + drill-down | doc=grep 原文 / conv=passages 直返（实现细节） |
| `related` | GraphResolver + edges（2,437 条） + resolveEntityAliases | 覆盖 graph_resolve 入口（Fable 补充） |
| `invalidate` | deleteByAnchor() + status/supersededBy | ⚠️ 部分实现——级联删除缺失（§5.1） |
| `recordFeedback` | F200 consumption tracking | 已有，但作为 store 副作用，不是显式能力 |
| `maintain` | 无统一实现 | ⚠️ 需新建 SunsetManager：sunset 执行 + compaction + 向量重建 |
| `health` | IEvidenceStore.health() | ✅ 已有 |

### 4.4b 现有 13 项能力 → MemoryComponent 穷举映射

> **Fable review 验收标准**：新契约必须映射全部 13 项现有能力。映射不上 = 契约有洞或能力该废。

| # | 现有能力（§2.1） | 映射到 | 覆盖度 |
|---|-----------------|--------|--------|
| 1 | 搜索（KnowledgeResolver.resolve） | `recall()` | ✅ 单馆内搜索 |
| 2 | 存储（SqliteEvidenceStore.upsert/get） | `remember()` + `read()` | ✅ |
| 3 | 扫描入库（IndexBuilder.rebuild） | 宿主逐条调 `remember()`（扫描归宿主，写入归组件） | ✅ 分离更清晰 |
| 4 | 向量嵌入（EmbeddingService） | `remember()` 内部触发 | ✅ 组件内部实现 |
| 5 | 关系图（GraphResolver + edges） | `related()` | ✅ 新增方法 |
| 6 | 实体识别（resolveEntityAliases） | `recall()` 内部增强 | ✅ 组件内部实现 |
| 7 | 标记物化（MarkerQueue → MaterializationService） | `remember()` 的一种 input 来源 | ✅ |
| 8 | 浏览最近（RecentBrowseResolver） | `recall()` + filter/sort 模式 | ✅ |
| 9 | 消费加权（F200） | `recordFeedback()` → `recall()` 排序 | ✅ |
| 10 | 矛盾检测（F163 contradicts） | `maintain()` 内部逻辑 | ✅ |
| 11 | 质量分层（provenance: authoritative/derived/soft_clue） | `remember()` input metadata | ✅ |
| 12 | Drill-down（depth 参数控制取全文） | `read()` 返回 inline/resource union | ✅ |
| 13 | 联邦搜索（跨 store RRF 融合） | **Federation Layer**（组件之上，正交能力） | ✅ 不在组件内 |

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
| `Wire Contract`（Layer 3 协议） | 删除 | 客户端应用不需要跨语言协议 |
| `RouteSlot`（primary/fallback/shadow） | 删除 | 不同时跑两个后端 |
| `CanonicalId` domain grammar（`doc:/conv:`） | **简化为 MemoryKey** | 无路由含义，现有 anchor 直接作为 id |
| `ProviderFailure`（分类错误） | 删除 | `health()` 已够用 |
| `isProjectLocalScope` scope 路由 | **保留为内部实现** | LocalMemoryComponent 内部仍需按 scope 分流搜索 |

---

## 5. 能力缺口（组件化前或过程中必须解决）

### 5.1 Sunset 能力缺失

co-creator 的能力清单里有"无效的记忆逐渐 sunset"。现有机制（status lifecycle / supersededBy / F163 contradicts）覆盖了**文档类**的下架，但**对话类的 sunset 是断的**：

**症状**：188 个孤儿 passage（doc 被 cleanup 删除，passage 永久堆积）

**根因**：`deleteByAnchor()` 只删 `evidence_docs`，不级联删 `evidence_passages`（全 codebase 无 `DELETE FROM evidence_passages`）。更深层：thread 记忆保留策略矛盾——doc 层有清理机制，passage 层没有。

**按图书馆模型**：下架是图书馆的内部职责，上层不该知道细节，但**两个书架都必须实现下架能力**。

| 内容类型 | 现有 sunset | 缺口 |
|---------|-----------|------|
| 文档类 | status lifecycle + supersededBy + F163 | ✅ 基本完整 |
| 对话类 | 无 | ❌ 需要：passage 级联删除 + thread 记忆保留策略 |

组件化后，`MemoryComponent.maintain()` 必须覆盖对话类记忆的 sunset。这是 `maintain()` 的核心实现内容之一。

**Sunset 信号→状态映射表**（Fable 补充——让 188 孤儿 passages 成为新契约的第一个验收用例）：

| 现有信号 | 状态转换 | 说明 |
|---------|---------|------|
| `supersededBy` 写入 | active → superseded | ✅ 已有 |
| F163 `contradicts[]` + `invalidAt` | active → invalidated | ✅ 已有 |
| 真相源删除（thread 删除 / 文件删除） | active → dormant（保留数据，默认不搜） | ❌ **当前硬删 doc + 漏删 passage**——孤儿根因 |
| F200 长期零消费（阈值待定） | active → dormant 候选（进 review queue，不自动） | ❌ 需实现 |

> 188 孤儿 passages 正是第三行信号没有接线的直接后果。doc 被 cleanup 硬删（过激）、passage 永久堆积（缺失），两边都错。正确答案是中间的 dormant：数据保留可 `read()`，默认不出现在 `recall()` 结果里。**这张表让孤儿问题从 bug 变成 `maintain()` 的第一个验收用例。**

### 5.2 媒体扩展点

co-creator 提到记忆数据可以有"文本、图之类的"。当前 `EvidenceItem` 是纯文本。§4.3 的 `MemoryContent` union（`text | resource`）已预留扩展位——图片等资源用 URI/blob reference + 可检索文本投影（`indexText`），核心接口不存二进制。具体实现延后到有实际需求时。

---

## 6. 后端替换模式（按需）

MemoryComponent 的替换有两种诚实定位（以 EchoMem 为例）：

### 6.1 完整组件替换

EchoMem 实现全部 MemoryComponent 契约 → 整体替换 LocalMemoryComponent：

```
步骤 1: 实现 EchoMemComponent implements MemoryComponent
         - remember/recall/read/invalidate/maintain/health 全部实现
         - 入库管道、生命周期管理、搜索语义 全部自治

步骤 2: 数据迁移（停机迁移——客户端应用重启即可）
         - 从 SQLite 导出全部数据（docs + passages + edges）
         - 批量导入新后端
         - 验证：相同 query 结果一致

步骤 3: 切换配置 → 完成
```

### 6.2 内部子模块

EchoMem 只处理部分能力（如对话记忆）→ 作为 LocalMemoryComponent 的内部 adapter，宿主不知道它的存在：

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

1. 定义 `MemoryComponent` 接口（remember/recall/read/invalidate/recordFeedback/maintain/health）
2. 实现 `LocalMemoryComponent`：组合现有 KnowledgeResolver + IndexBuilder + SqliteEvidenceStore
3. 上层 MCP 工具（search_evidence / list_recent / graph_resolve）改为调用 MemoryComponent
4. 行为兼容测试：重构前后，相同调用产出相同结果

**交付物**：现有测试全部通过，搜索结果 diff = 0，上层无感知

### Phase 2: Sunset 治理（与 Phase 1 并行或之后）

1. `deleteByAnchor()` 加级联删除 passages（修复 188 孤儿根因）
2. ConversationProvider 实现 sunset 策略（thread 记忆保留多久 / 怎么清理）
3. 两个 Provider 的 sunset 行为写入 `IEvidenceStore` 契约（deleteByAnchor 必须级联）

### Phase 3: 后端替换（按需）

如果决定用 EchoMem 或其他外部记忆服务（见 §6 两种模式）：
1. 选择替换模式：完整组件（§6.1）或内部子模块（§6.2）
2. 实现对应接口（MemoryComponent 或内部 adapter）
3. 数据迁移 + 配置切换

### 验收

| 阶段 | 验收条件 |
|------|---------|
| Phase 1 | 搜索结果 diff = 0（重构前后行为完全一致）；上层工具无感知 |
| Phase 2 | 孤儿 passage = 0；deleteByAnchor 级联测试通过 |
| Phase 3 | F200 Memory Recall Eval：换后端后召回率 ≥ 0.95 × 基线 |

---

## 8. 与 Parent ADR 的关系

Parent ADR（memory-service-componentization.md）定义了三原语模型（TextBlock / RelationEdge / Timeline）和完整的服务 SPI。那是面向**独立记忆服务**的设计——假设记忆组件是一个独立进程。

本文档是面向**客户端组件化**的设计——假设记忆组件还是在进程内，但后端可替换。两个设计互补：

- 如果未来需要把记忆拆成独立服务 → Parent ADR 的 SPI 是 MemoryComponent 的远程传输镜像
- 如果只需要替换存储后端 → 用本文档的 MemoryComponent 接口
- Storage SPI（IEvidenceStore）是具体实现内部细节，不是应用契约，也不是跨团队协议

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
| 9 | 宿主按内容类型路由到 DocProvider + ConversationProvider | 让宿主用 doc/conv 路由把两个半组件拼成一个"完整组件"——破坏可替换性。正确做法：宿主只看到一个 MemoryComponent，内容类型区分是组件内部实现（Sol pushback，本轮接受） |

### 从前一版降级的决策（内核保留，结论调整）

| # | 原否决 | 调整 |
|---|--------|------|
| 8 | "先 shadow 后补 ID" 被否决 | 改写：shadow 没了，但"统一 ID 映射先于数据迁移"仍是迁移前置条件 |

---

## 附录：关键源码锚点

| 组件 | 文件 | 说明 |
|------|------|------|
| 搜索路由 | `KnowledgeResolver.ts:240-242` | `isProjectLocalScope()` — 就是 provider 拆分点 |
| 存储接口 | `interfaces.ts:340-352` | `IEvidenceStore` — 即 Provider 接口 |
| 搜索选项 | `interfaces.ts:231-266` | `SearchOptions` — scope/dimension/depth |
| 数据类型 | `interfaces.ts:33-43` | `EVIDENCE_KINDS` — 9 种 kind |
| 向量嵌入 | `interfaces.ts:398+` | `EmbedConfig` |
| RRF 融合 | `KnowledgeResolver.ts:249-270` | 多源结果融合排序 |
| 孤儿根因 | `SqliteEvidenceStore.ts:1362-1367` | `deleteByAnchor` 不级联 |
| scope→kind 映射 | `SqliteEvidenceStore.ts:176-177` | `sessions → kind=session` |

## 附录：scope 内部路由矩阵（LocalMemoryComponent 实现参考）

> 降级为附录：这是 LocalMemoryComponent 的**内部实现**参考，不是 MemoryComponent 应用契约。应用只传 `MemoryQuery`，路由由组件内部处理。

| scope | 内部路由到 | 关键说明 |
|-------|----------|---------|
| `threads` | 对话类 store | 对话消息搜索 |
| `sessions` | 文档类 store | session digest 是 scanner 产物（`kind=session`），source-based ownership |
| `docs` / `memory` | 文档类 store（+ globalStore） | 文档知识 |
| `undefined` / `all` | 两类 store 都查 → RRF 融合 | 全域搜索 |

> scope 与 store universe 不匹配时：返回空结果 + `degraded: true`，**不偷路由**。

## 附录：被替换的前一版

前一版 "EchoMem 协作方案 — 三层架构设计"（1190 行，commit `f2bed3d62`）基于两个错误前提设计：

1. 把 Clowder AI 当 SaaS 服务（设计了隐私过滤、多租户分区）
2. 把组件化当多后端同时运行（设计了 shadow 双跑、fallback routing、渐进式迁移）

经过 co-creator 方向纠正后，以正确前提（客户端应用 + 按能力抽象）重写为本版。
前一版的 review 过程（codex/Fable/Sol 7 轮）中沉淀的教训（LL-090..093）仍然有效——它们是关于协议设计的通用教训，不依赖 SaaS 假设。
