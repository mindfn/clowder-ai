---
decision_id: ADR-043
related_features: [F117, F039, F047, F122, F175, F254, F264]
topics: [queue, delivery, lifecycle, persistence, architecture]
doc_kind: decision
created: 2026-09-02
---

# ADR-043: 消息队列 = 独立持久化的有序工单账本

> **Status**: implemented locally; acceptance follow-up under review | **Decider**: co-creator | **Analysis**: 布偶猫(opus) | **Implementation**: 缅因猫/砚砚 | **Priority**: P1
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

Message 另外持久化一个不可变的发布事实 `timelinePublishedAtAppend=true`：只由「用户
`conversation_input` Message + 完整 fan-out」原子写入。它不是 Queue 状态镜像，而是替代旧
`queueCustody` 存在性所兼任的时间线语义；后续 delivery 以它决定保留 authored time，还是在
`deliveredAt` 才进入时间线。

### D3 — fan-out 铺满所有入队来源

`targetCats: string[]` → 单目标。13 个 `...ByCatId(s)` map **退化成条目自身标量**。

### D4 — 用 Lua 保证原子性

拆成两个 key 后，「消息入库」与「入队」仍必须原子。队列自身由 5 个 Lua 转换保证：`enqueue` / `claim` / `commit` / `restore` / `claimPrefix`（§6.4 前缀批处理需原子多条 claim）。另外有 3 条跨记录原子路径：新 Message + fan-out、已有 connector Message + fan-out、terminal response + outbound fan-out。任一路径失败都不得留下 ghost Message 或半组 Queue rows。

Redis 的 `order` list 是 active 集合，terminal tombstone 只留在 `entries` hash 作为 receipt 真相；
容量判定只遍历 `order`，不扫描历史 tombstone。入队同时原子维护 `messageId → entryIds` hash
索引，History 分页和 socket receipt 投影按请求的 messageId 做 `HMGET`，复杂度只随 active
队列或当前页面增长，不随 thread 的终态历史增长。

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

Steer modal 的两个按钮表达作者意图，不表达一次易过期的 carrier capability snapshot：正常 Steer
选择 `next_work` 并在仍 active 时走上述 preemption；“不中断继续发送”选择 `continue_current`，admission
先尝试 exact Active Run Append，provider 不支持或 run 已结束时保留同一 Queue row，由普通 drain 启动。
因此任一可选择的 active target 都必须显示不中断选项，前端不得因 `canAppend` 投影缺失而隐藏作者意图。

### D6 — freshness carrier 是载荷标记，不是状态机

5 个字段写一次、起跑读一次即消费，**不进持久 custody**（custody 三文件 grep `freshness` 零命中），重启靠从 closure store 重新入队。归类同 `sourceCategory`。

`freshnessRequiredFrontierMessageId` **纯写不读，直接删**（全仓 5 处 src 命中：1 声明 + 1 类型 + 1 透传 + 2 写入，零读点）。

### D7 — terminal row 不复活；重做是新的用户意图

`handled / failed / interrupted / cancelled / withdrawn` 都是一次 Queue 工单的不可逆终态。历史上的
`WaitContinuationRetryPreflight` / `WaitContinuationRetryCommitter` 依赖 Message 内的
`queueCustody` 镜像，把失败 attempt 原位重新塞回 Queue；单账本切换后这条路径必须退役，否则
terminal tombstone 会重新变成可执行状态，并再次制造 Message/Queue 双写。

用户若要重做失败事项，应发送新的消息或执行明确的新动作，由生产者产生新的持久 source 与 Queue row；
旧 response、receipt 与 wait carrier 只保留原 attempt 的终态证据，不能充当 retry token。

### D8 — 完整正文读取是当前 child 对标量工单的接管

无 filter 的完整 thread-context 读取若要返回一个带持久 Message 的 same-target `conversation_input` queued
正文，服务端必须先验证 exact running `TurnExecution` 与同一个 `LifecycleActiveRun`，再把该
`sourceId × targetCatId` 标量行接管到现有 response：

1. claim exact row；
2. 在 live Active Run 预留 source/entry，并将 source Message 单调推进到 `delivered`；
3. 把 source message/entry 持久写入该 response lifecycle；
4. 在 row 上保留 exact `(targetCatId, childInvocationId, seenAt)` exposure，并终局为 `handled`。

History publication 失败时必须撤销 live 预留、restore claim；若后续 lifecycle CAS 因并发冲突失败，
Message 可以保持已发布但 row 恢复 queued。`active_run_missing` / `state_changed` / `lifecycle_conflict`
都是良性竞争：只从本次 payload 剔除尚未接管的 queued 正文并照常返回其余 History，不把整次读取变成
409。只有持久层不可用才返回 503。接管一旦持久化，后续失败不得把同一工单放回 Queue；无法写 terminal
receipt 时至少保持 `processing`，让 restart 终局为 interrupted。`queued_seen` 与 `queued_handled` 仍是不同
证据字段/指标，但在这条用户旅程中由同一 adoption path 提交，不再等待 invocation terminal success 推断 handled。

fan-out 的每个 target 是独立行：A 读取只终局 A，B 继续 queued；B 后续读取再终局 B。第一只猫接管后
Message 已进入成员可见 History，其他 target 的 Queue 责任仍由各自标量行独立追踪。无 Message 的行以及
带 `actionSuccessorFence` / `waitContinuationCarrier` / scheduled/freshness/continuation custody 的行保留 read→seen
语义，不由 History 读取终局；稀疏读取、跨 thread 读取、oversized anchor 或无法证明 exact active child
的请求都不得接管。

本决策取代 F254 D1.2 的旧“两阶段 seen，成功后 handled”实现约束；旧段落只保留为历史设计记录。

### D9 — 停止是对持久执行真相的权威终态化，投影不能反过来卡住它

> 来源：co-creator 2026-09-03 worktree 验收决策（thread `thread_msr51149hym0i79f`）。取代 F220 Phase 3「force-reset 逃生口」作为用户概念的地位。

用户只有两种状态（在运行 / 未运行）和一种动作（停止：单只猫 / 全部）。**停止的成功判据是投影进入「未运行」**；进程是否真的退出由服务端在后台保证。用户不需要区分「正常停」与「强制重置」，也不需要理解逃生舱。

1. **「在跑」的真相 = 持久行 + 活性见证**：TurnExecution `running` / 账本 `processing` 行是持久真相；tracker 槽位、`processingSlots`、session 锁只是内存缓存与活性见证，**单独不能构成 busy**。pre-start 预留只覆盖 `create → startAll` 的 I/O 窗口，不再以 75 分钟 TTL 钉住 busy。
2. **停止阶梯（服务端自动升级，用户不选机制）**：exact 活候选 → 现有取消链（abort / `terminateExact` / 释放本猫锁与槽位 / 写终态）；无活候选但目标仍投影为在跑 → 同一请求就地对账（退 pre-start 预留、running 记录置 canceled、释放孤儿锁与槽位、广播终态）并返回 `reconciled`；**对自己拥有的执行永不 409**。进程快照不完整（`ps` 失败 / owner manifest 目录损坏）时，服务端有界重试快照后仍不可用 → 走普通 dispatch terminal：该 exact execution 及其 response 行按 `failed`（reason `control_plane_unavailable`）终局，投影进入未运行，并沿 F117 Phase C「失败传播」回溯上游：源消息 dispatchRef settle 到该失败 response（`settleLifecycleResponseInputs`），猫来源按 A2A 自动报回 source 成员（由它重分发或上报），origin 来源呈现可见失败终态；pre-start 尚无 response 行时走 `delivery_failure`。重做只来自新的用户意图（INV-C7），系统不替用户重新拉起。只有持久层不可用（终态写不进去）才 503。**不做平台兼容分支**：Windows 没有 `ps`、子进程不可观测，同样落入这条 fail 分支收敛（快照不可用 = 无法确认 = failed 终局 + 失败传播）；本 ADR 唯一保留的兼容是旧 chat message 的 `from` 读取（A.5 `messageFrom`）。
3. **没有任何确认弹窗**：用户只关心运行态与终态，不需要理解「无法确认进程状态」。`ForceResetDialog` 退役；`/force-reset` 只作为服务端内部 thread 级对账实现，没有用户入口。终态行不复活（D7）保证迟到输出无法回写已终局的气泡；detached host 由 supervisor 收敛（F220 KD-8），有界。
4. **同一段对账三处复用**：启动（`StartupReconciler`）、投影读取（read-repair：running 记录 + 无 tracker + 进程快照 complete 且无 owner + 超出 pre-start 窗口 → 终态化；快照不 complete 时不动）、停止（第 2 条）。
5. **前端**：权威投影稳定即信；旧 socket busy 标记自愈，不再有「运行状态待确认」死角与基于卡死的强制重置入口。

历史根因：F220 Phase 2 报告（#972）已定性为「多 liveness SoT 无收敛点」；F194 读模型、TurnExecution 持久子真相与本 ADR 的账本已关闭进程内的绝大部分分叉，剩余只有基础设施故障（Redis / API 进程）一类，归 reconciler，不归用户。

## 不会简化的部分（诚实边界）

`prestartRetirement` **不消失**。窗口是 `invocationRecordStore.create`（QueueProcessor.ts:4873）→ `invocationTracker.startAll`（:5419），中间 **546 行异步**（freshness 预检、前缀吸收、session 准入）。这个「已 processing 但 tracker 里还没有」的空档由 **I/O 本身**造成，不是内存队列造成的，进不了 Lua。

它会从 Steer 专用退化为 fan-out 组的通用 `retiringGroupId`。

## 顺带删除的死码

1. **`PREEMPT_PENDING_PRESTART` 分支不可达**：`preemptSteerTarget` 三个成功出口（queue.ts:442/451/472）全部 `deferred: false` → `:902` 与 `:1062` 的 `if (preemption.deferred)` 恒假。
2. **`freshnessRequiredFrontierMessageId`**：见 D6。

## 预期结果

- 持久 `QueueLedgerEntry` 顶层约 **20 个字段**，变化大的执行参数和回执分别收进 `payload` / `execution` / `delivery`；13 个 by-cat map 全部退化为单目标条目的标量
- 删除模块：`QueuedMessageCustodyStartupReconciler` + `StartupQueueEntry` + `CarrierProjection`（436 行）、`queue-entry-settlement.ts`（49 行）、`convergeZombieQueue.ts`（87 行）、`exactSteerBatch` 预留 Map 与三段式 API，以及依赖 Message custody 复活 terminal attempt 的 Gate 5 retry bridge
- `QueueProcessor` 中的同步/CAS/rollback/restore 大部分消失

## 迁移

**不需要**。co-creator 判定：不会在工作未处理完时同步代码重启，因此无存量队列数据兼容负担。

## 一致性代价

`deliveryStatus` 与队列条目状态分处两地，但 `deliveryStatus` 只有 3 态且**单调**（queued → delivered/canceled），出队时一次写回即可，不需要持续同步。

---

## 附录 A：设计评审修订（2026-09-02，co-creator 逐条 push back）

RFC 是「没看代码、不拘泥实现的理论目标」，因此不能照搬。以下为逐条评估结论。

### A.1 字段数不是目标函数：43 个扁平/镜像字段 → 约 20 个顶层字段 + 3 个职责命名空间

实现后复核确认：RFC 的 11 字段是概念模型，不应被当作 TypeScript interface 的行数 KPI。`QueueLedgerEntry` 保留约 20 个顶层字段，并把载荷、运行参数和回执分别放入 `payload` / `execution` / `delivery`。真正必须消灭的是重复真相与 per-cat map，而不是为了数字把仍有运行语义的字段藏起来。

**RFC 漏掉的 3 条运行时约束（必须保留）**

| 字段 | 为什么 RFC 没看到 |
|---|---|
| `owner` | RFC 引入 `from` 治好了 author 一侧，但 grep `ownerUserId` / `owner principal` / `owner scope` 在 RFC 中**零命中**——它想的是「谁发的」，没想「这是谁的队列」 |
| `status` 的 `claimed` 态 | RFC 认为「仍在 Queue 就表示尚未 dispatch」，隐含出队即离开。但 Steer 必须先 `cancel` 正在跑的 invocation，**cancel 是 I/O 进不了 Lua**，失败必须原位回滚 → 需要可回滚的中间态 |
| `claimedAt` | 出队到起跑之间存在异步窗口；进程内的重复工作/活跃性判定用它识别 stale claim。当前不做进程内 sweep：重启恢复会无条件把遗留 `claimed` 行恢复为 `queued`，因此这是观测与 restart-only 恢复证据，不是后台回收租约 |

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

### A.3 entry.id 由来源持久 id 确定性派生，持久行不再保存 `idempotencyKey` / `continuationKey`

现状：`id: randomUUID()`（`InvocationQueue.ts:449`）与来源持久 id 完全脱钩，因此另开 `idempotencyKey` 字段 + `:411-414` 线性扫描去重。

但 fan-out 路径**已经在做正确的事**：`id = fanoutQueueCarrierIdempotencyKey(message.id, targetCatId)`。

三种 kind 都有天然确定性 id：

| kind | 确定性 id | 现状 |
|---|---|---|
| `conversation_input` | `sourceRecordId` + targetCat | 未用 |
| `message_wake` | `hash(messageId, targetCat)` | **已在用** |
| `private_input` | 生产者持久 id（`action:{leaseId}:{gen}:{cat}`、closure/supplement id） | **已在用**，但塞进了 `idempotencyKey` |

**决策**：推广确定性 id 到所有来源：`queueEntryId(sourceId, targetCatId)` 由来源持久 id 与标量 target 派生。`idempotencyKey` / `continuationKey` 仍可作为生产者命令输入来确定 `sourceId`，但不再进入持久 Queue row。去重从应用层线性扫描降级为存储层主键冲突。

### A.4 §6.4 前缀批处理拼正文违反 RFC（真 bug）

RFC §6.4 写「一次 dispatch，**不合并消息**」，而 `QueueProcessor.ts:5391` 在做 `content = content + '\n' + be.content`。`mergedMessageIds` 随之删除，但必须同时修正 §6.4 实现：一次 dispatch 可取多条 entry，但每条消息的身份、正文与顺序保持独立。

### A.5 author 身份统一由 resolver 读取；存储 owner userId 不冒充 author

**初版结论「本轮只治内核内 188 个签名、内核外 734 个不动」已作废——分母用错了。**

`packages/api/src` 共 922 个 `userId: string` 签名，但其中绝大多数是**真实用户 id，本来就该是 string**，改成 union 反而引入错误。真实缺陷面只有伪用户污染那条路径：

| 缺陷面 | 数量 |
|---|---:|
| 硬编码 `userId: 'system' / 'scheduler'` 写入点 | 25 |
| `SYSTEM_USER_IDS` / `isSystemUserMessage` 消费点 | 56 |
| 裸 userId 与 `'system' / 'scheduler'` 比较 | 28 |
| **合计** | **≈ 109** |

上述统计混合了两种不同语义：消息作者身份与存储 owner/tenant/thread ownership。后者本来就是 user id，不能机械替换成 `MessageFrom`。

**前置条件**：这些站点多数已是双分支形态——

```ts
msg.from ? msg.from.kind === 'system' : msg.userId === 'scheduler' && msg.catId === null
//         ↑ 新路径（首选）              ↑ legacy fallback
```

`from` 已是首选路径，裸比较只是 legacy 记录兜底。但 `MessageStore.ts:228` 为 `from?: MessageFrom`（可选），且全仓无通用回填（仅 `requireCanonicalMessageFrom` 会抛错，只用于 fanout）。因此直接删 legacy 分支会误判历史记录。

**方案（co-creator 提出，取代初版「回填 → 必填 → 删分支」三步）：单一 resolver，不动数据。**

```ts
from?: MessageFrom;              // 兼容旧 Redis row，读模型暂时可选
messageFrom(msg): MessageFrom;   // 作者身份的统一访问路径，返回必填 union
queueOwner(entry): QueueOwner;   // Queue scope 的统一访问路径
```

`messageFrom` 内部：有 `from` 直接返回；缺失则按 legacy 字段（`source` / `userId` / `catId` / `origin`）推导并封装。推导规则不是新发明——是把历史读取逻辑收进一处：

- `source?.connector` → `{ kind: 'external', connectorId }`
- `SYSTEM_USER_IDS.has(userId) && (catId === 'system' || catId === null)` → `{ kind: 'system', service }`（依据 `visibility.ts:23/50`、`:272` 的 `origin === 'briefing'`）
- `catId` 非空 → `{ kind: 'agent', catId }`
- 其余 → `{ kind: 'user', userId }`

新 Message 写入必须携带 `from`；author 判定统一调用 `messageFrom`。`SYSTEM_USER_IDS` 仅保留在 thread/tenant owner 的兼容边界，不再用于反推消息作者。同样形状套用于 Queue scope：持久行必须带 `owner` 判别 union，`queueOwner` 只为旧的进程内调用形状提供集中 fallback。

**为何优于初版三步**：初版试图在**存储层**达成不变量（全量回写 message），本方案在**访问层**达成。类型强度相同（调用方拿到的永远是必填 union），但没有不可逆写操作的风险；存量数据自然老化，新写入均带 `fromRaw`，将来 fallback 分支自然成为死码，届时删除为零风险。

**关于门禁**：不新增字符串扫描 gate。新写边界要求 `from`，持久 Queue row 要求 `owner: QueueOwner`，Redis hydrate 再做运行时 shape 校验；兼容只留在 resolver。存储 owner 的 `userId` 仍是合法且必要的，不应被 lint 误报。
