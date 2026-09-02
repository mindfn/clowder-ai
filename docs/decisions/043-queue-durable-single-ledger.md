---
decision_id: ADR-043
related_features: [F117, F039, F047, F122, F175, F254, F264]
topics: [queue, delivery, lifecycle, persistence, architecture]
doc_kind: decision
created: 2026-09-02
---

# ADR-043: 消息队列 = 独立持久化的有序工单账本

> **Status**: accepted | **Decider**: co-creator | **Analysis**: 布偶猫(opus) | **Priority**: P1
> **Supersedes (设计层)**: F039 / F122 / F175 / F047 中关于队列状态与 Steer 预留的描述

## 背景

F117 对 A2A 消息投递做了完整重构。收尾阶段的实读审计发现：这个在 RFC 中被定义为「持久化的、有序的消息队列」的组件，实际实现是 **≈15,690 行**，其中 `QueueProcessor.ts` 单文件 **7,004 行**（项目硬上限 350 行的 20 倍）。

## 根因（实读证据）

### 1. 队列不持久，真相寄生在 message 上

```ts
private queues = new Map<string, QueueEntry[]>();   // InvocationQueue.ts:263 — 纯内存
```

持久的那一份是 `message.queueCustody`，被序列化成 JSON 塞进 message 的 Redis hash：

```lua
redis.call('HSET', KEYS[1], 'queueCustody', ARGV[1], 'queueCustodyRevision', ARGV[2])
-- RedisMessageStore.ts:189
```

而 `QueuedMessageCustody` 的形状本身就是一个队列条目：

```ts
interface QueuedMessageCustody {
  entryId: string;                                  // 队列条目 ID
  revision: number;                                 // 乐观并发版本
  status: 'queued' | 'processing' | 'terminal';     // 队列条目状态机
}
```

**结论：持久队列条目已经存在，只是存错了地方。**

### 2. 双写：13 个字段逐一镜像

| QueueEntry（内存） | message.queueCustody（持久） |
|---|---|
| `queuedNotifiedByCatIds` | `notifiedByCatIds` |
| `queuedAwakenedInvocationIdByCatId` | `awakenedInvocationIdByCatId` |
| `queuedSeenByCatIds` | `seenByCatIds` |
| `queuedSeenInvocationIdByCatId` | `seenInvocationIdByCatId` |
| `queuedBodyExposures` | `bodyExposures` |
| `queuedFailedByCatIds` | `failedByCatIds` |
| `queuedHandledByCatIds` | `handledByCatIds` |
| `allTargetCats` | `allTargetCats` |
| `steerRequestedByCatIds` | `steerRequestedByCatIds` |
| `steeredInvocationIdByCatId` | `steeredInvocationIdByCatId` |
| `authorIntentByCatId` | `authorIntentByCatId` |
| `queuedFailure*ByCatId` | `targetAttempts` |
| `queuedAttemptIdByCatId` | `targetAttempts` |

那 15,690 行里的绝大部分——CAS、`-3` lifecycle 冲突码、reconcile、rollback、`restoreDurableEntry`、startup reconciler——**都是维持这两份一致的机器**。

### 3. 正确形态已存在，但只用于一处

```ts
// QueuedMessageCustodyCoordinator.ts:929 — createFanoutQueueEntriesFromAdmission
return admission.targetCats.map((targetCatId) => ({
  targetCats: [targetCatId],   // 单元素
  ...
}));
```

一条消息 N 目标 → fan-out 成 N 条单目标条目。但 `if (from.kind !== 'agent') throw` —— **只用于 A2A 猫间消息**。用户/connector 消息仍走「一条 entry 挂 N 个 target」，那 13 个 `...ByCatId` 就是为老路径存在的。

## 决策

### D1 — 队列条目独立持久化

按 thread 建持久队列：入队即持久化，重启直接反序列化。**不再寄生在 message hash 上。**

### D2 — message 只留粗粒度投递态

`message.deliveryStatus: 'queued' | 'delivered' | 'canceled'`（F117 原定义，单调）。**per-target 细节全归队列条目。**

职责边界：**message = 内容；queue entry = 投递工单。**

### D3 — fan-out 铺满所有入队来源

`targetCats: string[]` → 单目标。13 个 `...ByCatId(s)` map **退化成条目自身标量**。

### D4 — 用 Lua 保证原子性

拆成两个 key 后，「消息入库」与「入队」需要原子。5 个 Lua 脚本：`enqueue` / `claim` / `commit` / `restore` / `claimPrefix`（§6.4 前缀批处理需原子多条 pop）。

### D5 — Steer：三段式 → 两步

| 原阶段 | 防什么 | 处置 |
|---|---|---|
| `reserveExactUserEntry` | 认领后起跑前不被 drain 抢走 | 语义留，实现换成 Lua 原子 claim |
| `beginExactSteerPreemption` | 跨 `await` 后重新校验世界没变 | **整段删**——纯旧架构补偿 |
| `activateExactSteerReservation` | 槽位真空出来前不许投递 | 语义留，pop 放在 cancel 成功后即隐含 |

```
Lua claim (queued → claimed)
  ↓
cancel 正在跑的 invocation   ← I/O，进不了 Lua
  ↓
成功 → Lua commit (claimed → processing)
失败 → Lua restore (claimed → queued，原位)
```

**不能压成一步**：`invocationTracker.cancel` 是 I/O。

`exactSteerBatch` **整个删除**——`QueueProcessor.ts:5382-5383` 证明 absorb 防护同时检查它与 `steerRequestedByCatIds`，而两者同时写，持久标记已足够。

Steer 只需在条目上留 2 个标量：`steerRequestedAt?: number`（UI「Steer 中」回执态）、`steeredInvocationId?: string`（替补 run 归属证据）。

### D6 — freshness carrier 是载荷标记，不是状态机

5 个字段写一次、起跑读一次即消费，**不进持久 custody**（custody 三文件 grep `freshness` 零命中），重启靠从 closure store 重新入队。归类同 `sourceCategory`。

`freshnessRequiredFrontierMessageId` **纯写不读，直接删**（全仓 5 处 src 命中：1 声明 + 1 类型 + 1 透传 + 2 写入，零读点）。

## 不会简化的部分（诚实边界）

`prestartRetirement` **不消失**。窗口是 `invocationRecordStore.create`（QueueProcessor.ts:4873）→ `invocationTracker.startAll`（:5419），中间 **546 行异步**（freshness 预检、前缀吸收、session 准入）。这个「已 processing 但 tracker 里还没有」的空档由 **I/O 本身**造成，不是内存队列造成的，进不了 Lua。

它会从 Steer 专用退化为 fan-out 组的通用 `retiringGroupId`。

## 顺带删除的死码

1. **`PREEMPT_PENDING_PRESTART` 分支不可达**：`preemptSteerTarget` 三个成功出口（queue.ts:442/451/472）全部 `deferred: false` → `:902` 与 `:1062` 的 `if (preemption.deferred)` 恒假。
2. **`freshnessRequiredFrontierMessageId`**：见 D6。

## 预期结果

- `QueueEntry` 字段 **43 → ~25**，13 个 by-cat map 退化为标量
- 删除模块：`QueuedMessageCustodyStartupReconciler` + `StartupQueueEntry` + `CarrierProjection`（436 行）、`queue-entry-settlement.ts`（49 行）、`convergeZombieQueue.ts`（87 行）、`exactSteerBatch` 预留 Map 与三段式 API
- `QueueProcessor` 中的同步/CAS/rollback/restore 大部分消失

## 迁移

**不需要**。co-creator 判定：不会在工作未处理完时同步代码重启，因此无存量队列数据兼容负担。

## 一致性代价

`deliveryStatus` 与队列条目状态分处两地，但 `deliveryStatus` 只有 3 态且**单调**（queued → delivered/canceled），出队时一次写回即可，不需要持续同步。

---

## 附录 A：设计评审修订（2026-09-02，co-creator 逐条 push back）

RFC 是「没看代码、不拘泥实现的理论目标」，因此不能照搬。以下为逐条评估结论。

### A.1 目标字段数：43 → 14–16（不是 RFC 的 11）

**RFC 漏掉的 3 条运行时约束（必须保留）**

| 字段 | 为什么 RFC 没看到 |
|---|---|
| `owner` | RFC 引入 `from` 治好了 author 一侧，但 grep `ownerUserId` / `owner principal` / `owner scope` 在 RFC 中**零命中**——它想的是「谁发的」，没想「这是谁的队列」 |
| `status` 的 `claimed` 态 | RFC 认为「仍在 Queue 就表示尚未 dispatch」，隐含出队即离开。但 Steer 必须先 `cancel` 正在跑的 invocation，**cancel 是 I/O 进不了 Lua**，失败必须原位回滚 → 需要可回滚的中间态 |
| `claimedAt` | 出队到起跑之间有 546 行异步（`QueueProcessor.ts:4873` → `:5419`）。无时间戳则无法回收 stale claim，进程崩溃后条目永久卡住 |

**RFC 建议但评估后不采纳的 2 条**

- **freshness 4 字段搬进 payload metadata**：RFC 原意是「不要扩张 `from` 或 lifecycle `kind`」。这 4 个是独立顶层字段，未扩张二者，不违反该条。而 `QueueProcessor.ts:4951/5163` 起跑时直接读取，搬家只换访问路径、读法不变——纯形式主义，收益 0、需改 payload schema。
- **删 `sourceCategory`**：RFC 反对的是「把 ci/review/a2a 当成与 user/Agent 并列的**身份类型**」。它当前不是 `from` 的一部分，只是独立来源标记，F175 用于视觉分组。RFC 反对的形态与现状不是一回事。

### A.2 `owner` 必须是判别 union，不是裸 id

co-creator 在评审中发现的 RFC 空缺。裸 `userId` 已被塞入伪用户命名空间：

```ts
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set(['scheduler', 'system']);  // visibility.ts:13
return SYSTEM_USER_IDS.has(msg.userId) && (msg.catId === 'system' || msg.catId === null);  // :23
```

加上 25 处硬编码 `userId: 'system'`。**这正是 `from` 判别 union 要治的病，只治了 author 一侧。**

```ts
type QueueOwner =
  | { kind: 'user'; userId: string }
  | { kind: 'system'; service: string }   // 复用 RFC `from` 已有的 system 变体形状
```

职责分离：`from` 回答「谁发的」，`owner` 回答「这条工单在谁的 scope」。两者正交，不得互相代替（否则违反 L1）。

收益：删除 `SYSTEM_USER_IDS` 集合与 `visibility.ts:23` 的字符串反推；消除「真实用户恰好叫 system」的命名空间碰撞。

### A.3 entry.id 复用来源持久 id，合并 `idempotencyKey` / `continuationKey`

现状：`id: randomUUID()`（`InvocationQueue.ts:449`）与来源持久 id 完全脱钩，因此另开 `idempotencyKey` 字段 + `:411-414` 线性扫描去重。

但 fan-out 路径**已经在做正确的事**：`id = fanoutQueueCarrierIdempotencyKey(message.id, targetCatId)`。

三种 kind 都有天然确定性 id：

| kind | 确定性 id | 现状 |
|---|---|---|
| `conversation_input` | `sourceRecordId` + targetCat | 未用 |
| `message_wake` | `hash(messageId, targetCat)` | **已在用** |
| `private_input` | 生产者持久 id（`action:{leaseId}:{gen}:{cat}`、closure/supplement id） | **已在用**，但塞进了 `idempotencyKey` |

**决策**：推广确定性 id 到所有来源，`idempotencyKey` 与 `continuationKey` 并入 `id`。去重从应用层线性扫描降级为存储层主键冲突。

### A.4 §6.4 前缀批处理拼正文违反 RFC（真 bug）

RFC §6.4 写「一次 dispatch，**不合并消息**」，而 `QueueProcessor.ts:5391` 在做 `content = content + '\n' + be.content`。`mergedMessageIds` 随之删除，但必须同时修正 §6.4 实现：一次 dispatch 可取多条 entry，但每条消息的身份、正文与顺序保持独立。

### A.5 裸 userId：本轮一次性改完（修订）

**初版结论「本轮只治内核内 188 个签名、内核外 734 个不动」已作废——分母用错了。**

`packages/api/src` 共 922 个 `userId: string` 签名，但其中绝大多数是**真实用户 id，本来就该是 string**，改成 union 反而引入错误。真实缺陷面只有伪用户污染那条路径：

| 缺陷面 | 数量 |
|---|---:|
| 硬编码 `userId: 'system' / 'scheduler'` 写入点 | 25 |
| `SYSTEM_USER_IDS` / `isSystemUserMessage` 消费点 | 56 |
| 裸 userId 与 `'system' / 'scheduler'` 比较 | 28 |
| **合计** | **≈ 109** |

109 处可以一次改完，本轮全部纳入。

**前置条件**：这些站点多数已是双分支形态——

```ts
msg.from ? msg.from.kind === 'system' : msg.userId === 'scheduler' && msg.catId === null
//         ↑ 新路径（首选）              ↑ legacy fallback
```

`from` 已是首选路径，裸比较只是 legacy 记录兜底。但 `MessageStore.ts:228` 为 `from?: MessageFrom`（可选），且全仓无通用回填（仅 `requireCanonicalMessageFrom` 会抛错，只用于 fanout）。因此直接删 legacy 分支会误判历史记录。

**方案（co-creator 提出，取代初版「回填 → 必填 → 删分支」三步）：单一 resolver，不动数据。**

```ts
fromRaw?: MessageFrom;           // 存储层裸字段，命名带 Raw 以示不应直接读
messageFrom(msg): MessageFrom;   // 唯一公开访问路径，返回必填 union
```

`messageFrom` 内部：有 `fromRaw` 直接返回；缺失则按 legacy 字段（`source` / `userId` / `catId` / `origin`）推导并封装。推导规则不是新发明——是把当前散落在 28 个比较点的逻辑抄进一处：

- `source?.connector` → `{ kind: 'external', connectorId }`
- `SYSTEM_USER_IDS.has(userId) && (catId === 'system' || catId === null)` → `{ kind: 'system', service }`（依据 `visibility.ts:23/50`、`:272` 的 `origin === 'briefing'`）
- `catId` 非空 → `{ kind: 'agent', catId }`
- 其余 → `{ kind: 'user', userId }`

109 处全部改为调用 `messageFrom`，`SYSTEM_USER_IDS` 与所有裸比较随之删除。同样形状套用于 owner：`queueOwner(entry): QueueOwner`。

**为何优于初版三步**：初版试图在**存储层**达成不变量（全量回写 message），本方案在**访问层**达成。类型强度相同（调用方拿到的永远是必填 union），但没有不可逆写操作的风险；存量数据自然老化，新写入均带 `fromRaw`，将来 fallback 分支自然成为死码，届时删除为零风险。

**关于门禁**：完成上述改造后不需要新增 lint gate。`from` 必填 + `owner: QueueOwner` 判别 union 之后，裸 userId 在**类型层面即不可表达**——错误形态不可写出，优于事后规则拦截。gate 是「改不干净」的补丁；本轮改干净就不需要补丁。
