---
feature_ids: [F117]
related_features: [F039, F173, F183, F264]
topics: [message, queue, delivery, lifecycle, context]
doc_kind: spec
created: 2026-03-14
tips_exempt: automatic owner-timeline and cat-delivery consistency hardening; no new user action or standalone capability to teach
---

# F117: Message Delivery Lifecycle — 消息投递生命周期真相源

> **Status**: done — Phase C implemented locally; cross-family review and worktree experience acceptance pending in PR #1398 | **Owner**: Ragdoll + Maine Coon | **Priority**: P1
> **community_issue**: [#20](https://github.com/zts212653/clowder-ai/issues/20)

## Why

operator 2026-03-14 实测发现：queue 模式发送消息后立即取消，该消息仍出现在聊天流、进入猫猫 prompt context。社区 issue #20 也报告了同样问题。

根因：当前架构下 queue send 在 enqueue 阶段就持久化 user message 并做乐观插入，但没有 delivery status 概念。History API 和 ContextAssembler 不区分 queued/delivered/canceled，导致未送达甚至已取消的消息污染聊天历史和猫猫上下文。

**2026-03-14 原始 invariant**：`undelivered user messages MUST NOT appear in timeline, history API, or prompt context.`

**2026-07-21 契约演进（F264）**：原句把“operator查看自己已持久化的消息”和“猫获得正文”混成一个
visibility 开关，已被 F264 的 per-target receipt 契约细分：

- durable queued user message 从 admission 起留在**operator的浏览器时间线**原位，并显示真实 Queue receipt；
- 同一消息在 exact delivery 前仍不得进入猫的 callback/thread-context/prompt/pending-mentions；
- canceled 消息同时从 live 时间线与 F5 history 消失；
- `deliveryStatus` 继续表示 cat delivery，不再兼任 owner timeline publication。

operator experience：
> "前端不应该显示你们真正没有收到的消息，对吧？"
> "当我发了一个正在队列的消息的时候，我的用户气泡这里先不显示，等到你们真的收到这个消息的那一刻，再在正确的地方插入这个气泡"

## 已确认的 Bug 现象（operator实测 2026-03-14）

### Bug 1: 队列消息提前显示气泡
- **复现**：猫猫正在回复中 → 用户发消息（自动进队列）→ 消息还在"排队中"面板 → 聊天流里气泡已经出现
- **期望**：队列面板显示即可，聊天气泡等到消息真正"送达"（dequeue 执行）时才插入
- **截图**：同一条消息同时出现在聊天气泡和排队面板（`1773488348921-03899885.png`）

### Bug 2: 取消后消息仍在气泡 + 仍进入猫猫上下文
- **复现**：用户在队列面板按 X 取消消息 → 气泡仍然留在聊天流 → 猫猫下次回复时 prompt context 里有这条已取消的消息
- **期望**：取消后气泡消失，猫猫永远不应该"看到"这条消息
- **实测证据**：operator发送 `嘿嘿大猫猫喵` → 取消 → 猫猫对话上下文中仍出现该消息

### Bug 3a: queued 用户 @mention 提前进入 pending-mentions（F117 scope）
- **复现**：用户发带 @gpt52 的消息 → 消息进入队列（排队中）→ `pending-mentions` 已包含该条目
- **期望**：queued/canceled 的用户 @mention 不应出现在 `pending-mentions`；delivered 后才进入
- **根因**：mention inbox 读取时只看 `msg.mentions`，不看 `deliveryStatus`

### Bug 3b: `cat_cafe_post_message` 的 @mention 路由异常（F117 out of scope）
- **复现**：猫猫用 `cat_cafe_post_message` 发带 `@gpt52` 的消息 → Maine Coon session 未收到
- **截图**：`1773488607773-f4b34f0a.png`
- **不属于 F117**：`post_message` 走 callback 路由（`callbacks.ts` → `messageStore.append` + `enqueueA2ATargets`），不经过前端 queue send，不依赖 delivery lifecycle
- **处置**：单开 callback @mention 路由 bug，F117 仅标记 `related`

### 根因链路（Maine Coon + Ragdoll调查确认）
1. `useSendMessage.ts:95-100` — 无条件乐观插入，不区分 queue/immediate
2. `messages.ts:249` — enqueue 阶段就持久化 user message，无 delivery status 标记
3. `messages.ts:700` — History API 不过滤 delivery status
4. `ContextAssembler.ts:99` — 不过滤 delivery status，未送达/已取消消息直接进 prompt
5. `queue.ts:99,249` — withdraw/clear 只删 queue entry，不处理已持久化的 message

## What

### Phase A: deliveryStatus 字段 + 后端收口

1. Message 模型新增 `deliveryStatus?: 'queued' | 'delivered' | 'canceled'`（老数据缺省 `delivered` 兼容）
2. enqueue 时 message 持久化带 `deliveryStatus: 'queued'`
3. MessageStore 默认读只返回 `delivered`（或无 deliveryStatus 的历史消息）；F264 后 owner-facing
   `GET /api/messages` 显式 opt-in durable queued user publication，cat cognition readers 不 opt-in
4. ContextAssembler 只组装 `delivered` 消息
5. Mention surfaces（`pending-mentions` 等）只返回 `delivered` 消息的 @mention
6. QueueProcessor dequeue 执行时：将 message 标为 `delivered`，扩展 `messages_delivered` 事件携带完整 user message payload
6. withdraw 单条：同步将 message 标 `canceled`，发 `message_deleted` 给前端
7. clear 队列：批量标 `canceled`，发批量 `message_deleted`

### Phase B: 前端适配

> 以下是 2026-03-14 的历史交付。F264 于 2026-07-21 仅 supersede “queued user bubble 何时对operator
> 可见”：显式 queue send 在 202 成功并拿到 durable message id 后插入；smart-default queued 保留并
> reconcile optimistic bubble。取消与 cat-context 隔离仍完全沿用 F117。

1. queue send 时**不做乐观插入**到主时间线（QueuePanel 仍通过 `queue_updated` 展示）
2. 收到扩展版 `messages_delivered` 事件时，将 user message 插入主时间线
3. 收到 `message_deleted` 时，从 store 中移除对应 message
4. F5 hydration 路径：history API 已过滤，无需额外处理

### Phase C: Dispatch 可视化唯一规范（normative，2026-08-31）

> **状态**：co-creator 已定稿；实现已在 PR #1398 的 feature worktree 完成，待跨家族 review 与体验验收。
>
> **权威边界**：本节是聊天前端 dispatch 可视化的唯一规范。F117 早期阶段、F173/F183、
> 架构审计或现有组件若与本节冲突，以本节为准；其他文档只能引用本节，不能再定义第二套
> UI 状态机。本节只投影已有生命周期事实，不新增 receipt ledger。

#### 一句话

**只表达两件事：谁正在处理或处理过这条消息，以及每条成员回复在回复哪条源消息。**

#### 统一领域模型

- 每条公开 History 消息都可以是 dispatch source，可被派给 `0..N` 个成员；发送者是 user、cat、
  IM connector、GitHub 通知或其他系统来源，都不改变渲染规则。
- 是否显示处理成员，只由这条消息是否存在可验证的 actual-target lifecycle 决定；没有 dispatch
  就自然没有头像，不按消息分类设例外。
- 前端只消费同一 domain snapshot：source 上的 `dispatchRefs`、其 `statusMessageId` 关联的 canonical
  response status，以及 response 上指回 source 的 `messageRef`。Queue custody、carrier、source owner、
  文本内容和旧 dock 都不能补猜这些事实。
- multi-target source 为每个成员独立投影状态；一个成员的终局不能覆盖、删除或代表 sibling。

#### 源消息头像：唯一三态

| canonical fact | 视觉状态 | 含义 |
|---|---|---|
| 没有 actual dispatch，或仅 `assigned` 尚未开始 | 无头像 | 没有成员正在处理 |
| `dispatched` + exact active run | 头像闪烁 | 该成员正在处理 |
| `settled` + linked terminal response | 头像静止保留 | 该成员本跳已经结束 |

- `completed / failed / canceled / interrupted` 在头像层都只是“结束”，统一为静止保留。
- 成功不显示 badge、勾号、额外文案或“已随本轮完成”。
- 失败或取消不在头像上新增符号；复用 canonical response 已有的轨迹/状态提示表达结果。
- 任一 canonical read 不完整或映射多义时，不显示未经证明的动态头像，也不退回旧 receipt、消息 kind、
  文本或 carrier 推断。

#### 回复与引用

- 任一作为 dispatch result 的公开成员 response 都必须携带 `messageRef`，精确引用触发它的 source；
  引用呈现为现有 `↩ @源作者: 源正文…` 语义。
- source 是否需要引用由 lineage 决定，不由 author kind 决定。root source 没有上游就不造引用；completed
  response 若继续 dispatch 给下一跳，它同时成为新的 source，并在自身气泡上承载下一跳头像。
- processing 阶段不创建空气泡、“运行中”占位或假 `Thinking...`。response 气泡只在已有正文/partial
  content，或 canonical execution 已到 terminal 时出现。
- 成功、失败、取消和中断都必须有一个可关联的 terminal response 气泡；不得另追加 system row、
  provider notice 或第二条状态消息表达同一结果。

#### 失败传播

- **成员唤起的 dispatch 失败**：结果按现有 A2A 逻辑自动报回 source 成员；source 消息上该成员头像转静止（失败终态）；source 成员随后重分发给其他成员、或放弃并上报一条普通消息给用户——两者都是普通 History 消息，走同一套头像+引用投影，不新增 UI。
- **origin 唤起的 dispatch 失败**（source 为 user/GitHub/IM connector 等无上游、无法报回的来源）：投影为 `delivery failure result` 的用户可见 system message "唤起 xxx 失败"；不伪造 response 气泡、不挂动态头像。
- 判据：**能报回 cat source 的 → 报回 + 普通消息；报不回的 origin → 才降级 system message。**

#### 重试与默认信息密度

- 只有 `failed` 的 terminal response 气泡提供重试入口；成功、取消、中断和 source 头像不提供重试。
- 默认界面不展示“普通执行”“查看本轮”“正文读取时间”“处理完成时间”、attempt aggregate 或独立
  “处理回执”区块。回复引用与头像三态已经完整覆盖用户需要理解的事实。

#### 必须删除的旧坐标

实现 Phase C 时必须删除，而不是继续修改：

- 独立 `MessageReceiptDock` / “处理回执”展示模型；
- `primary_trigger` suppression 与任何 user-vs-cat、kind/scope/channel 的 dispatch 渲染分叉；
- processing 空气泡、假 `Thinking...` 与只为承载状态而生成的 system/provider rows；
- 从旧 receipt、carrier、source owner、消息正文或当前成员身份补猜头像/终态的 fallback；
- 成功 badge、头像结果符号、时间戳、“普通执行”和“查看本轮”。

历史兼容只能在 READ 边界把旧记录规范化为同一 domain snapshot；不能在 React 渲染层保留第二条
legacy 路径。若规范化后仍没有唯一事实，就 fail closed，而不是添加分类分支或 fallback。

#### Phase C 不变量

1. **INV-C1 — 一条渲染路径**：user、cat、connector、GitHub/系统来源共用同一 projection；零分类例外。
2. **INV-C2 — 头像三态守恒**：无 actual dispatch/仅 assigned = 无；active = 闪；terminal = 静止保留。
3. **INV-C3 — exact lineage**：每个 dispatch-result response 必须引用 exact source；不得用当前 thread、
   当前成员或相邻消息猜引用。
4. **INV-C4 — 无空气泡**：processing 不产生 response placeholder；正文或 terminal 才能让气泡出现。
5. **INV-C5 — 单一终局**：一个成员一次 execution 只有一个原位 terminal response，不附加第二条状态消息。
6. **INV-C6 — 成功静默**：成功只有静止头像与正常回复；失败/取消只复用 terminal 轨迹提示，不加头像 badge。
7. **INV-C7 — 重试归失败气泡**：只有 failed response 气泡可重试。
8. **INV-C8 — 无展示 fallback**：legacy 只在 READ 边界规范化；渲染层不以 fallback 或 kind/scope 分支补事实。

### Phase D: 队列内核收敛（normative，2026-09-02）

> **权威决策**：[ADR-043 — 消息队列 = 独立持久化的有序工单账本](../decisions/043-queue-durable-single-ledger.md)
> **RFC 依据**：[A2A 消息投递、处理与交接生命周期架构](../architecture/message-delivery-handling-handoff-audit.md)（PR #1356）
>
> **本节是队列内核设计的单一真相源。** F039 / F122 / F175 / F047 中与本节冲突的描述以本节为准。

#### D.1 职责边界

```
message  = 内容 + 粗粒度投递态（deliveryStatus: queued | delivered | canceled，单调）
queue entry = 投递工单（单目标、持久、有序）
```

per-target 投递细节归**队列条目**，不再挂在 message 上；队列不再持有任何 message 已经拥有的事实。

#### D.2 根因（实读证据）

1. **队列不持久**：`private queues = new Map<...>()`（`InvocationQueue.ts:263`）。持久的那份是 `message.queueCustody`，被序列化成 JSON 塞进 message 的 Redis hash（`RedisMessageStore.ts:189`）。而 `QueuedMessageCustody` 本身带 `entryId / revision / status: 'queued'|'processing'|'terminal'` —— **它就是一个持久队列条目，只是存错了地方**。
2. **双写**：`QueueEntry` 上 13 个字段与 `queueCustody` 逐一镜像（`queuedSeenByCatIds ↔ seenByCatIds` 等）。这违反 RFC L1「其他 surface 只能引用或投影，不能复制并裁决同一事实」。
3. **规模**：队列子系统合计 ≈15,690 行，`QueueProcessor.ts` 单文件 7,004 行（项目硬上限 350 行的 20 倍）。其中绝大部分是维持上述两份一致的机器。

#### D.3 收敛决策（详见 ADR-043）

| # | 决策 |
|---|---|
| D1 | 队列条目按 thread 独立持久化；入队即持久化，重启直接反序列化 |
| D2 | message 只留 `deliveryStatus`；per-target 细节归队列条目 |
| D3 | fan-out 铺满所有入队来源（现仅用于 `from.kind === 'agent'`），`targetCats` 退化为单目标；13 个 `...ByCatId(s)` map 随之退化为标量 |
| D4 | 5 个 Lua 脚本保证原子：`enqueue` / `claim` / `commit` / `restore` / `claimPrefix` |
| D5 | Steer 三段式 → 两步；删 `exactSteerBatch`（见 F047「设计现状」） |
| D6 | freshness carrier 5 字段是载荷标记非状态机；删纯写不读的 `freshnessRequiredFrontierMessageId` |
| D7 | `owner` 改判别 union `{kind:'user'} \| {kind:'system'}`；`messageFrom(msg)` resolver 统一 `from` 读取，不做数据回填 |
| D8 | entry.id 复用来源持久 id，合并 `idempotencyKey` / `continuationKey` |

目标：`QueueEntry` 字段 **43 → 14–16**。收益主要不在字段数，而在镜像消失后死掉的 CAS / reconcile / rollback / startup 重建。

#### D.4 一并修正的实现偏离

- **§6.4 前缀批处理拼正文**：RFC §6.4 明写「一次 dispatch，**不合并消息**」，而 `QueueProcessor.ts:5391` 在做 `content = content + '\n' + be.content`。`mergedMessageIds` 删除的同时必须修正该实现——一次 dispatch 可取多条 entry，但每条消息的身份、正文与顺序保持独立。
- **裸 userId 伪用户污染**：`SYSTEM_USER_IDS = new Set(['scheduler','system'])`（`visibility.ts:13`）+ 25 处硬编码 `userId: 'system'`。约 109 处站点改走 `messageFrom` / `queueOwner` resolver。

#### D.5 不会简化的部分（诚实边界）

`prestartRetirement` 不消失。窗口是 `invocationRecordStore.create`（`QueueProcessor.ts:4873`）→ `invocationTracker.startAll`（`:5419`），中间 546 行异步（freshness 预检、前缀吸收、session 准入）。该「已 processing 但 tracker 尚无」的空档由 I/O 本身造成，进不了 Lua；它会从 Steer 专用退化为 fan-out 组的通用 `retiringGroupId`。

## Acceptance Criteria

### Phase A（后端 — deliveryStatus 真相源） ✅
- [x] AC-A1: Message 模型支持 `deliveryStatus` 字段，老数据兼容
- [x] AC-A2: enqueue 持久化 message 时 `deliveryStatus='queued'`
- [x] AC-A3: History API 默认排除 `queued` 和 `canceled` 消息
- [x] AC-A4: ContextAssembler 只组装 `delivered` 消息（含无 deliveryStatus 的历史兼容）
- [x] AC-A5: dequeue 执行时 message 标为 `delivered` + 扩展 `messages_delivered` 事件
- [x] AC-A6: withdraw 将 message 标 `canceled` + 发 `message_deleted`
- [x] AC-A7: clear 队列批量标 `canceled` + 发批量 `message_deleted`
- [x] AC-A8: 回归测试——queue send → cancel → history API 不返回、ContextAssembler 不组装
- [x] AC-A9: queue send 带 @mention 的消息 → delivered 前 `pending-mentions` 不返回；delivered 后才出现

### Phase B（前端适配） ✅
- [x] AC-B1: queue send 不做乐观插入到主聊天流
- [x] AC-B2: `messages_delivered` 事件触发 user bubble 插入主时间线
- [x] AC-B3: `message_deleted` 事件触发 store 移除
- [x] AC-B4: F5 刷新后 queued/canceled 消息不出现在聊天流
- [x] AC-B5: QueuePanel 功能不受影响（仍通过 `queue_updated` 正常展示）
- [x] AC-B6: queue send 多行消息（Shift+Enter）时不出现 optimistic bubble；delivered 后只出现一次

### F264 owner-timeline 演进（2026-07-21）

- [x] AC-B7: durable queued user message 从 Queue admission 起可由 owner-facing history/F5 水合，仍不被 cat callback/context 读取
- [x] AC-B8: explicit queue send 等 202 durable id 后插入；smart-default queued 不删除 optimistic bubble
- [x] AC-B9: terminal delivery 更新同一 bubble 的 receipt/deliveredAt 并保留 authoring-time 顺序，不复制正文
- [x] AC-B10: canceled 消息继续由 `message_deleted` 移除，owner history/F5 也不返回

### Phase C（Dispatch 可视化重建，2026-08-31）

- [x] AC-C1: user、cat、IM connector、GitHub/系统来源在同一 renderer 中只按 actual dispatch facts 投影头像
- [x] AC-C2: 无 actual dispatch/assigned、active、terminal 分别稳定呈现为无头像、闪烁头像、静止保留头像
- [x] AC-C3: 每个 dispatch-result response 都带 exact `messageRef`；completed response 可作为下一跳 source
- [x] AC-C4: processing 不创建空气泡、假 `Thinking...` 或状态 system row；terminal 只有一个原位 response 气泡
- [x] AC-C5: 成功不加 badge/文案；失败与取消复用 terminal 轨迹提示，头像不加结果符号
- [x] AC-C6: 只有 failed response 气泡提供重试；旧 dock、时间戳、“普通执行”“查看本轮”全部删除
- [x] AC-C7: React 渲染层没有 `primary_trigger`、author/kind/scope/channel 分叉或 legacy receipt fallback
- [x] AC-C8: F5 hydration 与 live socket 对同一 source/target lifecycle 产生相同头像、引用与 terminal 投影

## Scope Boundary

- **In scope**: undelivered user message 对 cat cognition (`callback / thread context / prompt / pending-mentions`) 的泄漏，以及 canceled message 对 owner timeline/history 的 resurfacing
- **Phase C in scope**: 所有公开 History source 的统一 dispatch 头像、response lineage、terminal 与 retry 投影
- **Out of scope but related**: `cat_cafe_post_message` callback 路由的 @mention 解析/路由异常（走 `callbacks.ts`，不经过 queue/delivery lifecycle）

## Dependencies

- **Evolved from**: F039（消息排队投递 — 三模式已完成，但缺 delivery lifecycle 概念）
- **Related**: F047（Queue Steer）、community issue [#20](https://github.com/zts212653/clowder-ai/issues/20)、PR [#25](https://github.com/zts212653/clowder-ai/pull/25)

Architecture cell: `dispatch` + `bubble-pipeline`
Map delta: none — F264 只把既有 message visibility 拆成 owner timeline 与 cat delivery 两个 typed read option，未改变 cell ownership。
Why: Queue custody 仍归 dispatch，时间线投影与 receipt 合并仍归 bubble-pipeline。

## Risk

| 风险 | 缓解 |
|------|------|
| 老数据无 deliveryStatus 字段，查询可能误伤 | 缺省按 `delivered` 兼容，过滤条件 `WHERE deliveryStatus IS NULL OR deliveryStatus='delivered'` |
| `messages_delivered` payload 变更影响现有消费者 | 扩展而非重构，新增 `userMessage` 字段，现有字段不变 |
| withdraw/clear 新增 `message_deleted` 事件可能与现有删除逻辑冲突 | 复用现有 `message_deleted` handler，确认幂等 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用显式 `deliveryStatus` 字段而非 `deliveredAt` | `deliveredAt` 老数据没有，过滤会误伤即时消息和历史消息（Maine Coon提出） | 2026-03-14 |
| KD-2 | 不 merge 社区 PR #25 作为 quick fix | 只修渲染层是脚手架不是终态，withdraw resurfacing 未闭合（P1铁律）| 2026-03-14 |
| KD-3 | 修完后走全量 sync 而非 hotfix | 有多个已完成 F 待同步，hotfix 增加后续同步难度（operator决定）| 2026-03-14 |
| KD-4 | Bug 3 拆分：queued @mention 泄漏 in scope / post_message callback 路由 out of scope | post_message 走 callback 路由不经 queue，硬塞进 F117 会混 scope（Maine Coon Design Gate 提出）| 2026-03-14 |
| KD-5 | owner timeline publication 与 cat delivery 分成两个 typed read option | F264 receipt 必须让operator持续看见原消息；复用全局 `isTimelinePublished` 会把未投递正文泄给猫 | 2026-07-21 |
| KD-6 | Phase C 以 actual dispatch facts 建立单一 UI projection，不按消息来源分类 | user/cat/connector/GitHub 通知都可能成为 source；分类例外会再次制造多套生命周期 | 2026-08-31 |
| KD-7 | 删除旧 dock/占位/fallback，而不是继续收敛到 dock | dock 自身表达了第二套 receipt 模型，且增加用户无需理解的时间、执行类型与跳转信息 | 2026-08-31 |
| KD-8 | 成功静默、终态头像统一静止；结果只由 canonical terminal response 表达 | 头像只回答“谁在处理/处理过”，不复制 outcome；失败重试归 failed bubble | 2026-08-31 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon review 后端 delivery lifecycle 改动）
- Phase B: 跨家族 review（Maine Coon review 前端适配）
- Phase C spec: co-creator 定稿；Ragdoll Opus 做内容一致性 review 后，实现才可开始
- Phase C implementation: Opus 按 INV-C1..C8 逐条 review，并额外审计新增 fallback 与 kind/scope 分支；
  co-creator worktree 体验验收仍是 fork/上游前硬门
