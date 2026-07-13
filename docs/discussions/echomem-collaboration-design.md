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

| 数据 | 归属 | 理由 |
|------|------|------|
| kind ∈ {feature, plan, decision, lesson, session, discussion, research, pack-knowledge} | DocProvider | scanner 产物，LLM 取书时 grep 原文件 |
| kind = thread + 全部 passages | ConversationProvider | 对话编译产物，内容直接在 passages 里 |
| 全部 edges | DocProvider | 文档间引用关系 |
| entities | 共享基础设施 | 两类都需要实体解析增强搜索 |

---

## 4. 目标架构

```
IKnowledgeResolver（前台不变）
    │
    ├── DocProvider: IEvidenceStore
    │   - 后端：SqliteEvidenceStore（不变）
    │   - 入库：IndexBuilder 扫描 repo
    │   - 数据：284 docs + 2,437 edges + entities
    │   - 取书：drill-down → grep 原文件
    │
    └── ConversationProvider: IEvidenceStore
        - 后端：今天 SqliteEvidenceStore，明天可换
        - 入库：session compiler / 消息事件
        - 数据：7 thread docs + 21,946 passages
        - 取书：passages 直接返回
```

### 4.1 路由规则（从现有代码提取）

`KnowledgeResolver` 已有的路由逻辑（`isProjectLocalScope()`，L240-242）：

```typescript
// 已有代码——几乎就是我们需要的拆分点
function isProjectLocalScope(options?: SearchOptions): boolean {
  return options?.scope === 'threads' || options?.scope === 'sessions';
}
```

组件化后：

| scope | 路由到 | 说明 |
|-------|--------|------|
| `threads` | ConversationProvider | 对话消息搜索 |
| `sessions` | DocProvider | session digest 是 scanner 产物（`kind=session`），归 Doc |
| `docs` / `memory` | DocProvider（+ globalStore if dimension allows） | 文档知识搜索 |
| `undefined` / `all` | 两个 Provider 都查 → RRF 融合 | 全域搜索 |

**这不是新设计——是把已有的 `isProjectLocalScope` 判断从硬编码变成 provider 注册。**

### 4.2 Provider 接口

不需要新接口——**`IEvidenceStore` 已经是正确的 Provider 接口**：

```typescript
// 已有接口，不需要改
interface IEvidenceStore {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
  searchWithMeta?(query: string, options?: SearchOptions): Promise<EvidenceSearchExecution>;
  upsert(items: EvidenceItem[]): Promise<void>;
  deleteByAnchor(anchor: string): Promise<void>;
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  health(): Promise<boolean>;
  initialize(): Promise<void>;
}
```

组件化的改动在 `KnowledgeResolver`，不在接口：

```typescript
// 改动前
constructor(deps: { projectStore: IEvidenceStore; globalStore?: IEvidenceStore; ... })

// 改动后
constructor(deps: {
  docStore: IEvidenceStore;         // 文档类（原 projectStore 的 doc 部分）
  conversationStore: IEvidenceStore; // 对话类（原 projectStore 的 thread/passage 部分）
  globalStore?: IEvidenceStore;
  ...
})
```

### 4.3 为什么不需要新抽象层

| 之前设计的 | 为什么不需要 |
|-----------|------------|
| `RetrievalProvider`（Layer 2 域接口） | `IEvidenceStore` 已经是正确的接口，加一层只增加复杂度 |
| `Wire Contract`（Layer 3 协议） | 本地应用不需要跨语言协议；如果未来用 EchoMem，那时再加 adapter |
| `RouteSlot`（primary/fallback/shadow） | 不同时跑两个后端，一个 provider 直接注册即可 |
| `CanonicalId`（跨后端统一 ID） | 单后端不需要 ID 翻译；换后端时做一次性数据迁移 |
| `ProviderFailure`（分类错误） | `IEvidenceStore.health()` 已经够用 |

---

## 5. 能力缺口（组件化前或过程中必须解决）

### 5.1 Sunset 能力缺失

co-creator 的能力清单里有"无效的记忆逐渐 sunset"。现有机制（status lifecycle / supersededBy / F163 contradicts）覆盖了**文档类**的下架，但**对话类的 sunset 是断的**：

**症状**：188 个孤儿 passage（doc 被 cleanup 删除，passage 永久堆积）

**根因**：`deleteByAnchor()` 只删 `evidence_docs`，不级联删 `evidence_passages`（全 codebase 无 `DELETE FROM evidence_passages`）。更深层：thread 记忆保留策略矛盾——doc 层有清理机制，passage 层没有。

**按图书馆模型**：下架是图书馆的内部职责，上层不该知道细节，但**两个书架都必须实现下架能力**。

| 书架 | 现有 sunset | 缺口 |
|------|-----------|------|
| DocProvider | status lifecycle + supersededBy + F163 | ✅ 基本完整 |
| ConversationProvider | 无 | ❌ 需要：passage 级联删除 + thread 记忆保留策略 |

组件化后，ConversationProvider 的 `IEvidenceStore` 实现必须保证 `deleteByAnchor()` 级联清理关联 passages。

### 5.2 媒体扩展点

co-creator 提到记忆数据可以有"文本、图之类的"。当前 `EvidenceItem` 是纯文本（title + summary + passages.content）。组件化不需要立刻实现多媒体，但 Provider 接口应预留扩展位：

- `EvidenceItem` 的 `passages` 条目可加 `mediaType?: string` + `mediaRef?: string`
- 具体实现延后到有实际需求时

---

## 6. 后端替换模式（按需）

当需要把 ConversationProvider 从 SQLite 换成 EchoMem 时：

```
步骤 1: 实现 EchoMemStore implements IEvidenceStore
         - search() → 调 EchoMem HTTP API 搜索
         - upsert() → 调 EchoMem API 写入
         - getByAnchor() → 调 EchoMem API 取
         - health() → 调 EchoMem health endpoint

步骤 2: 数据迁移
         - 从 SQLite 导出 thread docs + passages
         - 批量写入 EchoMem
         - 验证：相同 query 结果一致

步骤 3: 切换配置
         - KnowledgeResolver 的 conversationStore 指向 EchoMemStore
         - 完成
```

**没有 shadow 双跑、没有 fallback、没有渐进式切换。** 这是一个客户端应用——用户自己决定什么时候切换后端，切换后旧后端就不再使用。

---

## 7. 实施计划

### Phase 1: 拆分 projectStore（零行为变更）

1. `SqliteEvidenceStore` 加 kind 过滤：`docStore` 只返回 doc 类 kind，`conversationStore` 只返回 thread kind
2. `KnowledgeResolver` 构造函数改为 `docStore + conversationStore`，路由逻辑用 scope 判断
3. 行为兼容测试：拆分前后，相同 query 产出相同结果

**交付物**：现有测试全部通过，搜索结果 diff = 0

### Phase 2: Sunset 治理（与 Phase 1 并行或之后）

1. `deleteByAnchor()` 加级联删除 passages（修复 188 孤儿根因）
2. ConversationProvider 实现 sunset 策略（thread 记忆保留多久 / 怎么清理）
3. 两个 Provider 的 sunset 行为写入 `IEvidenceStore` 契约（deleteByAnchor 必须级联）

### Phase 3: 后端替换（按需）

如果决定用 EchoMem 或其他外部记忆服务：
1. 实现 adapter（implements `IEvidenceStore`）
2. 数据迁移
3. 配置切换

### 验收

| 阶段 | 验收条件 |
|------|---------|
| Phase 1 | 搜索结果 diff = 0（拆分前后行为完全一致） |
| Phase 2 | 孤儿 passage = 0；deleteByAnchor 级联测试通过 |
| Phase 3 | F200 Memory Recall Eval：换后端后召回率 ≥ 0.95 × 基线 |

---

## 8. 与 Parent ADR 的关系

Parent ADR（memory-service-componentization.md）定义了三原语模型（TextBlock / RelationEdge / Timeline）和完整的服务 SPI。那是面向**独立记忆服务**的设计——假设记忆组件是一个独立进程。

本文档是面向**客户端组件化**的设计——假设记忆组件还是在进程内，但后端可替换。两个设计互补：

- 如果未来需要把记忆拆成独立服务 → 用 Parent ADR 的三原语 SPI
- 如果只需要替换存储后端 → 用本文档的 Provider 拆分
- 两者可以结合：先按本文档拆分 Provider，再按 Parent ADR 把 Provider 提升为独立服务

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
| 6 | 新增 RetrievalProvider / RouteSlot 抽象层 | `IEvidenceStore` 已经是正确的 Provider 接口 |
| 7 | 消息队列级可靠性（outbox / at-least-once / exactly-once） | 索引可重建（缓存语义），hook + 定期 rebuild 补漏是合法方案 |

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

## 附录：scope × dimension 路由矩阵（测试基准）

> 降级为附录（Fable 建议）：不是协议交付物，是实现的测试基准。写 coordinator 单测时照抄。

| scope | 路由到 | 关键说明 |
|-------|--------|---------|
| `threads` | ConversationProvider | 对话消息 |
| `sessions` | DocProvider | session digest 是 scanner 产物（`kind=session`），归 Doc（source-based ownership） |
| `docs` / `memory` | DocProvider（+ globalStore） | 文档知识 |
| `undefined` / `all` | 两个 Provider 都查 → RRF 融合 | 全域搜索 |

> scope 与 provider universe 不匹配时（如 `global + threads`）：返回空结果 + `degraded: true`，**不偷路由**。

## 附录：被替换的前一版

前一版 "EchoMem 协作方案 — 三层架构设计"（1190 行，commit `f2bed3d62`）基于两个错误前提设计：

1. 把 Clowder AI 当 SaaS 服务（设计了隐私过滤、多租户分区）
2. 把组件化当多后端同时运行（设计了 shadow 双跑、fallback routing、渐进式迁移）

经过 co-creator 方向纠正后，以正确前提（客户端应用 + 按能力抽象）重写为本版。
前一版的 review 过程（codex/Fable/Sol 7 轮）中沉淀的教训（LL-090..093）仍然有效——它们是关于协议设计的通用教训，不依赖 SaaS 假设。
