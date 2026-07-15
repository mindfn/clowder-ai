# F258: Plugin Messaging Domain（K-1 messaging 域收敛）

> F 号 tentative——若与并行分配冲突，maintainer review 时可重命名。

**Status:** DRAFT（shape review 阶段）
**Lineage:** F240（IM connector plugins）→ plugins v0 proposal
**真相源:** `zts212653/clowder-ai-plugins` main `189f25d` — `docs/proposals/plugin-system-principles-and-v0-design.md` §3.1；roadmap PR-2（K-1）
**Merge gate（五步回边）:** 本 PR shape-approved → C-1 契约包双签 merge → publish v0.1（registry 精确 version+digest 可解析）→ 本 PR pin v0.1 精确版本 + conformance 绿 → merge

## 一句话

内核提供 plugin-facing messaging 域：一个内容模型（MessagePayload），一个发送入口（`messaging.send(draft)`），两类可靠事件（`message.publish` / `message.elements.append`），幂等结算 ledger 与 durable ack cursor。

## 范围（§3.1 五件套）

1. **send 收敛**：`sendReply/sendRichMessage/sendMedia` 在插件契约面收敛为 `messaging.send(draft)`，返回宿主 receipt；同 idempotencyKey 重试返回同一 receipt。平台降级（卡片→纯文本等）仍归 connector adapter（不在本 PR）。
2. **canonical MessageEnvelope + ingress binding**：宿主接受 draft 后生成 canonical envelope（actor 宿主绑定、audience 宿主派生、`system` 仅宿主可产生、occurredAt UTC）。Draft 寻址只能用宿主签发的 `ThreadHandle`/`ConnectorBindingRef`——schema 层面不存在自报裸 threadId 的通道。
3. **事件流**：per-thread 单调 sequence；cursor = 每消费者（pluginInstanceId × subscription）durable ack；未 ack 至少一次投递 + 消费者凭 eventId 幂等；cursor 是 subscription-local opaque token；落后超出 retention 窗口 → stale 态走快照追平，不静默丢事件。
4. **appendElements**：原子增补；`derivedFromElementId` 指向稳定 elementId；不改写原文；不把 `inference` 升格为 `observation/user_intent`；`baseRevision` 并发冲突检测。
5. **幂等结算 ledger**：send 键 =(pluginInstanceId, idempotencyKey)、append 键 =(pluginInstanceId, messageId, operationId)；实例作用域，插件间互不干扰，重装实例不复用旧键空间。

## 明确非目标

- Broker/握手/transport（K-2）、SDK（P-1）、存量 connector 迁移（P-7）、事件输入面（K-3a）、windows（K-3b）、schedule/state（K-5）
- `OutboundDeliveryHook` / `ConnectorRouter` / 现有三 send 呼叫点零改动
- user/cat 消息全量进事件流（K-1 只发射本域操作事件；全量覆盖待 P-7 出站消费者出现）
- cursor token 密码学签名（v0 不透明性是契约约束；跨 subscription 拒绝由服务端校验保证）

## 架构

```
packages/api/src/domains/messaging/
├── contract/types.ts      # v0.1 契约 mirror（merge 前 pin 发布包替换）
├── contract/validate.ts   # fail-closed 校验 + bounds
├── envelope.ts            # StoredMessage ↔ MessageEnvelope 纯投影（零第二真相源）
├── handles.ts / ledger.ts / event-stream.ts / send-service.ts / append-service.ts
├── messaging-service.ts   # Facade —— K-2 Broker 的消费面
└── stores/                # memory + Redis 双实现（plugmsg:* keys）
```

**K-2 接缝**：本 PR 不在组合根实例化 domain——`createMessagingDomain({ messageStore, redis })` 就是 K-2 Host Broker 的装配点（roadmap 五步回边：K-1 merge → K-2 消费）。端到端行为由域测试全链覆盖（facade e2e：issue→send→subscribe→read→ack→append→snapshot）。

**关键设计决定**：
- **D-1** envelope = `StoredMessage` 纯投影；插件消息持久化在现有 `IMessageStore`（`extra.pluginMessage` additive 扩展），Hub UI 免费获得展示。
- **D-2** v0 subscription 绑定单 ThreadHandle；多 thread = 多 subscription——"不得以单一 sequence 跨 thread 推游标"由构造保证。
- **D-3** persist → emit → settle 顺序；事件 emit 以确定性 eventKey 去重（crash-retry 不双发）。
- **D-4** provenance.origin 宿主校验绑定：thread_handle 发送 origin 必为 self plugin；connector_binding 发送 origin.external 必须与 binding 记录一致；`host` origin 任何 draft 不可声明。
- **whisper 边界（fail-closed）**：v0 事件流与 snapshot 只投递 public 消息；whisper 是 send-only 能力（targets ⊆ handle grant 允许集）。消费者可观察到 sequence 跳号（受限事件），单调性不受影响。
- **mentions**：v0 插件消息不解析/不触发 @ 路由（唤醒能力归 K-3a wake route）。

## 不变量（全部有对应测试）

INV-1 幂等 receipt 恒等；INV-2 system audience 双层不可达；INV-3 per-thread sequence 严格单调；INV-4 未 ack 重投/已 ack 不重投；INV-5 cursor token subscription-local；INV-6 append 不改写原文；INV-7 epistemic 不洗白（非 inference 增补必须 derivedFrom 同状态源）；INV-8 handle 跨实例/revoked 拒绝；INV-9 落后窗口 → stale 不静默丢；INV-10 baseRevision 冲突零变更；INV-11 存量消息路径零回归；INV-12 append 幂等不重复追加。

## C-1 契约对齐点（candidate 期双向可调，publish 后以包为准）

epistemic 值集 `observation|user_intent|inference`；element kinds v0 `text|media_ref|rich_block`；bounds（32 elements / 64KB element / 256KB 总 / 16 whisper targets）；错误码 `VALIDATION|PERMISSION|NOT_FOUND|CONFLICT|RETRYABLE_INFLIGHT|STALE_CURSOR`；receipt/subscribe/read/ack/snapshot API 形状。

## Ownership map delta（建议）

新增 cell `plugin-messaging`（K-1 起草，maintainer 定夺）：plugin-facing messaging 契约面。现有 transport cell（F088）继续持有 connector 出入站与平台降级。
