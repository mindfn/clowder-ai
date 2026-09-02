---
feature_ids: [F047]
related_features: [F039]
topics: [queue, steer, ux, chat]
doc_kind: note
created: 2026-02-28
tips_exempt: existing Queue UI contract correction; no new cat-facing capability or workflow to teach
---

# F047: Queue Steer（取消当前轮并以同一消息立即重启）

> **Status**: done（2026-07-12 语义修订） | **Owner**: Maine Coon/Maine Coon（Codex）
> **Created**: 2026-02-28
> **Completed**: 2026-02-28
> **Priority**: P1

---

## Why

operator在 Codex 原生体验中使用 **Steer**：当消息在队列里等待时，点击 Steer 会让“那条排队消息”立刻进入猫的处理流程（而不是只能撤回/重排/再发一条）。

## What

- 在 QueuePanel 的 **queued** 条目上新增 **Steer** 按钮
- 点击后只有一个 Steer 动作：取消目标猫当前 invocation（如有），并以**同一条持久 Queue 消息**立即启动一次
- 普通重排继续由 drag/move API 独立提供，不再借用 Steer 名称

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] `queued` 条目显示 Steer（`processing` 不显示）
- [x] Steer 弹窗明确告知“取消当前轮并以同一消息立即重启”，且可取消操作
- [x] 有猫在跑时先 cancel，再以被 Steer 的 exact Queue entry 启动一次；空闲时直接启动同一 entry
- [x] `{ mode: "promote" }` 被 API 拒绝；重排只走独立 move/reorder 交互
- [x] Steer 不创建 supplement 或第二个 later carrier
- [x] 具备 API/Web 测试覆盖（至少：权限、409 processing、promote reject、默认 immediate）

## Implementation

### Backend

- Endpoint: `POST /api/threads/:threadId/queue/:entryId/steer`
- Body: 空 body 或 `{ "mode": "immediate" }`；其他 mode 返回 400
- Rules:
  - 404 if entry not found in current user scope
  - 409 if entry is `processing` (processing steer out-of-scope)
  - `immediate`: cancels active invocation (same user) and starts processing via QueueProcessor
- WS: immediate execution follows normal Queue processing updates; no `steer_promote` action exists

### Frontend

- `QueuePanel` queued entry row adds **Steer** button
- Modal offers one explicit action: 取消当前猫，并以同一条消息立即重启

### Reorder（F175 扩展）

F175 在 Steer 基础上扩展了用户可控编排能力：

- **Drag & Drop 排序**：QueuePanel 支持拖动排序（`@dnd-kit`），拖拽后通过 `PATCH /queue/reorder` 批量设置 position
- **Reorder API**：`PATCH /api/threads/:threadId/queue/reorder`，body: `{ expectedQueueRevision, orderedVisibleEntryIds }`（RFC #1356 §4.1 `ReorderVisibleEntriesCommand`）。前端提交同一 snapshot 下**完整的 visible row 顺序**；服务端校验 revision 与集合一致后原子写入 `position=0..n-1`，revision/集合/eligibility 任一变化即整批 typed conflict，不做 partial write
- **排序语义**：唯一 comparator 为 `position presence → position → priority(urgent before normal) → enqueuedAt → id`。隐藏 rows 不被客户端寻址，仍按自身 priority/FIFO 排序
- **Optimistic UI**：前端立即按 comparator 重排，失败时 rollback

## Key Decisions

- Steer 不改动消息内容，也不表示 promote / supplement；它只做 cancel + exact-message restart
- 排序是独立的 Queue 控制面，不属于 Steer
- `processing` 不提供 Steer：运行中纠偏属于更大能力（需要运行中注入/重路由），本 feature 不扩大范围

## 设计现状（2026-09-02 校准，见 ADR-043）

> **本节记录「文档 vs 实现」的偏离，不是新设计。**

本文档描述的 Steer 语义（cancel + 以同一 exact entry 重启、`processing` 是唯一拦截场景）**始终正确**。偏离发生在实现侧：`POST /queue/:entryId/steer` 长出了三段式预留
（`reserveExactUserEntry` → `beginExactSteerPreemption` → `activateExactSteerReservation`）与约 20 个拒绝分支，这些从未进入本文档。

按 [ADR-043](../decisions/043-queue-durable-single-ledger.md) 收敛后：

- **两步，不是三段**：Lua 原子 claim（`queued → claimed`）→ cancel 正在跑的 invocation（I/O，可能失败）→ 成功则 Lua commit（`claimed → processing`），失败则 Lua restore（`claimed → queued`，原位）。
  不能压成一步的唯一原因是 `invocationTracker.cancel` 是 I/O，进不了 Lua。
- **`exactSteerBatch` 删除**：它防的「F175 吸走相邻条目」在 `QueueProcessor.ts:5382-5383` 已与持久的 `steerRequestedByCatIds` 重复检查；原子 claim 后其余用途消失。
- **条目上只保留 2 个 Steer 标量**（fan-out 单目标后由 map 退化）：`steerRequestedAt`（UI「Steer 中」回执态）、`steeredInvocationId`（替补 run 归属证据）。

### 不变量：Steer 只有一个业务拦截场景

**用户点击 Steer 时，唯一应当拦截的业务场景是「该条目已出队、正在触发」→ 409 `ENTRY_PROCESSING`。**

其余拒绝只允许是通用 guard（401/403/404、schema 400）。当前实现的 `STEER_STATE_CHANGED` / `STEER_RESERVATION_LOST` / `STEER_RESERVATION_PERSIST_FAILED` / `QUEUE_BUSY` /
`INVOCATION_CANCEL_FAILED` / `PRESTART_STATE_CHANGED` / `PRESTART_TERMINALIZATION_FAILED` 均为三段式预留与前后端 target 判定不同源的产物，收敛后应全部消失或归并入 `ENTRY_PROCESSING`。

新增任何 Steer 拒绝分支前，必须先证明它不是上述两类产物。

### 已确认的死码

`PREEMPT_PENDING_PRESTART`（202）分支不可达：`preemptSteerTarget` 三个成功出口（`routes/queue.ts:442/451/472`）全部返回 `deferred: false`，故 `:902` 与 `:1062` 的 `if (preemption.deferred)` 恒假。「先预留、稍后投递」模式早已被收敛为同步。

## Risk / Blast Radius

- **状态机复杂度**：立即执行会触发 cancel → 需要确保 queue 不被错误 pause
- **并发/互斥**：需要保持 QueueProcessor mutex 语义，不允许同 thread 并发执行两条

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1 | Ragdoll/Opus-46 | 0 P1 / 1 P2 | 2026-02-28 |
| R2 | Ragdoll/Opus-46 | 0 P1 / 0 P2 ✅ | 2026-02-28 |
| Cloud | chatgpt-codex-connector | 0 P1 / 0 P2 ✅ | 2026-02-28 |

### 愿景交叉验证签收
| 猫猫 | 读了哪些原始文档 | 三个问题结论 | 签收 |
|------|------------------|-------------|------|

## Dependencies

- **Evolved from**: F039（消息排队投递 — 用户操作三模式）
