# Bug 诊断胶囊：append 锁租约过期可导致 revision 事件乱序

| 栏位 | 内容 |
|------|------|
| **1. 现象** | `appendElements` 已持久化 revision N、但尚未发射事件时，如果 per-message 锁租约过期，后继 append 可持久化并先发射 revision N+1。事件 sequence 仍严格递增，但消费者会先看到高 revision、后看到低 revision。期望是已持久化 append 的事件按 revision 顺序进入 per-thread event log。 |
| **2. 证据** | `AppendService.applyLocked()` 先调用 `updatePluginMessage()`，随后 `buildReceipt()` 才调用 `events.append()`；`AppendLock` 是会过期的 best-effort TTL mutex。revision CAS 只能阻止旧写者覆盖新 revision，不能覆盖“写已成功、事件未发”的停顿窗口。复现通过在第一个 append 写入后阻塞其 `events.append()`，同时模拟租约到期让第二个 append 进入。 |
| **3. 问题假设或根因** | 根因已确认：message store 与 event log 之间没有原子事务或持久 outbox；锁租约是时间性互斥，不能跨任意进程停顿保证 persist → emit 的顺序。 |
| **4. 诊断策略** | 用真实 `MemoryEventLogStore` 和 `MessageStore`，只在测试边界阻塞首次 op-1 事件写入；让 op-2 在其间完成，检查 append event 的 operationId/revision 顺序。 |
| **5. 超时策略** | 若无法以单测稳定复现，则改用显式可控 event-log gate，不引入真实计时或等待 30 秒 TTL；若修复需要跨 Redis/MessageStore 分布式事务，则停止扩 scope，提交 reviewer 决策包。 |
| **6. 预警策略** | 若修复依赖延长 TTL、重复 ownership check 或 sleep，说明仍在用时间假设掩盖原子性缺口；若同一 operationId 产生不同 event payload，则必须回到持久化记录补齐重放信息。 |
| **7. 用户可见交互修正** | 插件消费者不会再在极端进程停顿/锁接管时先收到 revision N+1、后收到 revision N 的 append 事件。 |
| **8. 验收** | `lease takeover preserves append event order after the prior revision was persisted`：RED 时稳定得到 `op-2/rev3 → op-1/rev2`；修复后 append 定向测试 21/21、K-1 非 Redis 130/130、官方隔离 Redis 17/17 全绿。 |

[砚砚/GPT-5.6 Sol🐾]
