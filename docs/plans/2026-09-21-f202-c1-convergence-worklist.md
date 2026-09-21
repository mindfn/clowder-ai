---
feature_ids: [F202]
topics: [plugin-framework, train-c1, convergence, worklist]
doc_kind: plan
created: 2026-09-21
architecture-cell: plugin
---

# F202 C1 — 两仓收敛工作清单（可直接开工）

> 设计依据在 `2026-09-20-f202-c1-host-plugin-interface-contract.md`。本文只讲**改什么、什么顺序**。

## 0. 目标形态（operator 裁定，一句话）

```
Host 提供双向接口  →  SDK 包装这些接口  →  插件实现接口  →  Host 加载插件
```

单向依赖：`插件 → SDK → contract ← Host`。**Host 永不 import SDK。**

## 1. 已完成（不要重做）

| commit | 内容 |
|---|---|
| `708ad9cf8` | 所有作者的消息进同一条发布流（`publishing-message-store.ts`，包在 `IMessageStore.append` 唯一汇聚点） |
| `80787735b` `5cfc6ef0b` `e1dd2f590` | 订阅投递驱动 + sink 泛化 + **回声抑制默认开启**（`includeOwnMessages` 才 opt-in） |
| `88f7f8c4c` | 激活时签发"转述人类授权"地址（`relay-address-provisioning.ts`） |
| `3daaea609` | 以上接进 `runtime-composition.ts` 真实装配 |
| `42aa3c73a` | 删除做错侧的 `connector-ingress.ts` |

回归基线：**1287 tests / 1286 pass / 0 fail**。

## 2. Core 侧待办（sol 可直接开工，按序）

### C-1　出站改用已发布的标准方法 ⚠️ 先做
`domains/messaging/subscription-delivery.ts` 目前调我自造的
`HostInvocationPort.invoke(targetId, method, params)`。**撤掉它**，改用契约已有的：

```
host.messaging.deliver
  M0CDeliverInput  = { deliveryId, threadHandle: ThreadHandleAddress, envelope: MessageEnvelope }
  M0CDeliverResult = { deliveryId }
```
- 已在 `WIRE_METHOD_NAMES`，已发布
- `external-runtime/stdio-broker-transport.ts:44` 已声明调用
- `host-broker/control-plane.ts:376` 已读它的 grant

`builtin-runtime/module-host-invocation.ts` 保留为**进程内载体的实现**，但其对外形状要对齐上面这个签名，不要另立一套参数。
**验收**：`f202-c1-end-to-end-journey.test.js` 全绿且不再出现自造签名。

### C-2　把已声明但调不到的能力接上线
`thread.listMetadata` / `thread.readContent` 在已发布 `Capability` 里，但**既无 wire 方法也无作者面**。
接线（不是扩面）。同批可核对的还有 `memory.query|append|retrieve`、`whisper.extend`——
**C1 只接 `thread.*` 两个**，其余登记不做。

### C-3　thread 归属 metadata（通用版）
`ThreadStore` 已有 `updateSystemKind` / `updateConnectorHubState`。
把连接器专属的 `ConnectorHubStateV1{connectorId, externalChatId}` **换成**通用归属记录
（哪个 pluginInstance 拥有这个 thread）。**一换一，不是新增。**
地址由归属推导 → 不需要逐 thread 授予。

### C-4　"创建一个归属自己的 thread"（唯一真新增）
能力表里没有创建类，这是本轮唯一新增公共面。**必须写成通用形状**，
名字与参数中不出现 `connector` / `im`（前台猫按访客分线用同一个方法）。

### C-5　删除（必须排在 C-1…C-4 之后）
```
ConnectorRouter 664 · ConnectorCommandLayer 621 · connector-gateway-bootstrap 1,195
OutboundDeliveryHook 397 · StreamingOutboundHook 383 · ConnectorThreadBindingStore 71
InboundMessageDedup 27 · ConnectorMessageFormatter 108 · ConnectorPermissionStore 207
im-connector-loader 224 · im-connectors/ 8,180（7 provider）
合计 ~16,121 行，外部接点 10 个文件
```
**提前删会让 IM 里 @ 猫不再唤醒任何猫。**

> `connector-binding:*` 等 Redis 旧数据：删代码后无人读，但**不得由猫清理**——
> 那是 operator 的运行实例数据，清不清由他定。

## 3. Plugins 侧待办（该线自行排期，此处只列事实）

| # | 项 | 依据 |
|---|---|---|
| P-1 | `contract-mirror.ts`(212) 删除 —— 让 `plugin-contract` **导出运行时枚举值**（它本就由 JSON schema 生成） | 文件自述 DELETION TARGET |
| P-2 | `wire-dispatch.ts`(1,113) **挪进 `plugin-contract`** | Host 正 `import { classifyFrame } from '@clowder-ai/plugin-sdk'`（`stdio-broker-transport.ts:26`）= 反向依赖 |
| P-3 | connector 专属栈作废：`connector-runtime.ts`、`ConnectorInboundMessage`、`ConnectorOutboundDelivery`、`requireConnectorOutboundDelivery`、`FeatureContext.connectors` | `host.messaging.deliver` 才是标准 |
| P-4 | 两个 `standalone-host` 收成一份，且**不公开导出** | 两份 Host 模拟必然漂移 |
| P-5 | `messaging-client.ts`(141) 零使用 —— 接上或删 | 零使用的公开面最坏 |
| P-6 | 7 个 connector：`connector` contribution → `message-subscription` + 实现自己的方法 | **不需要声明回声 filter**，Host 默认抑制 |

## 4. 顺序（跨仓）

```
C-1 C-2 C-3 C-4（Core 接口就位）
      ↓
P-1…P-6（Plugins 按新接口切，一次性不分批）
      ↓
C-5（Core 删除 16,121 行）
      ↓
发布 SDK  →  worktree 独立安装  →  operator 验收
```

## 5. 根因（写在这里防止下一位重犯）

**17 个 Capability 可声明，7 个既无 wire 方法也无作者面**——能力表与可调用面从未对账。
每个人走到自己那块发现"要的东西不在"，就在旁边另造一个：
`ConnectorContribution.outboundMethod`、`HostInvocationPort`、`contract-mirror`、两个 standalone-host，
全是同一个病的不同表现。**改之前先通读整张方法表。**
