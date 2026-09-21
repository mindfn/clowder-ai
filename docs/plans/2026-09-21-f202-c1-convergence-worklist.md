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

> **分层别搞混，且别往 payload 里加字段**：`host.messaging.deliver` 的入参是**闭合**的
> （`deliveryId` / `threadHandle` / `envelope`，`additionalProperties:false`）。
> 插件声明的 `action.method` **不随线传输**——Host 调固定投递入口，
> **接收侧按自己已注册的 `message-subscription` 自行分发**。
> （我原文写"由参数携带"是错的，sol 在实现时查出并纠正。）
**验收**：`f202-c1-end-to-end-journey.test.js` 全绿且不再出现自造签名。

### C-2　~~把已声明但调不到的能力接上线~~ —— **取消（2026-09-21 从实际诉求收敛得出）**

### C-4 也一并取消。理由见下，这是从 7 个 connector 的**真实调用**数出来的，不是推测。

operator 第四次指出方向：

> 基于 sdk 来推导 host 的接口有且只有一种场景：sdk 已有能力不满足，且是**开发新插件**时。
> 我们现在做的是**插件迁移**——应该整理收敛这些插件需要调用/实现的接口，在 Host 收敛做完，然后清理代码。

照此把 7 个 connector 包实际用到的 Host 面全部数出来（`grep context.*` on `connector-*/src`）：

| 实际调用 | 次数 | 对应 Host 能力 | 状态 |
|---|---|---|---|
| `context.config.get` | 13 | `plugin.config.read` | ✅ 已发布可用 |
| `context.secrets.get` | 10 | `secret.read` | ✅ |
| `context.state.set/get` | 3 | `plugin.state.set/get` | ✅ |
| `context.messaging.send` | 2 | `messaging.send` | ✅ |
| `context.messaging.subscribe` | 2 | `message.event.subscribe` | ✅ |
| `context.connectors.deliver` | 5 | 由 `host.messaging.deliver` 取代 | ✅ C-1 已接通 |
| `context.logger` | 7 | SDK 本地日志函数表，不在 `Capability` / `WIRE_METHOD_NAMES` | 无需 Host 面 |
| ~~`context.open`~~ | 2 | **误报**：实为 `context.open_chat_type` / `open_chat_id`，飞书 webhook 载荷字段 | 非 Host 面 |

**七个包里没有任何 `thread.*` 调用。** 它们不列 thread、不读 thread、不建 thread——
会话落点靠激活时签发的地址（`relay-address-provisioning.ts`，`88f7f8c4c`），
群↔thread 映射靠 `plugin.state`（已有）。

**所以 C-2 / C-4 服务的是一个假想需求。** 我此前从 operator 的 5 步流程**推导**出"插件要取/建 thread"，
但那 5 步描述的是**未来插件可能的做法**，不是这 7 个包**现在的做法**。迁移的验收标准是这 7 个包能跑，
不是把所有可想象的能力补全。

> **这是今晚第四个同形状的错**：用推理代替对被描述物的清点。前三次是类型 vs schema、
> 子集 vs 全集、文件位置 vs 定义归属。这次是**假想流程 vs 实际调用**。

**结论修正：Host 侧接口**面**已完整（不缺任何方法），但**接线**还差一段。**

### C-6　激活接线（清点时发现，此前清单漏编号）

零件都造好了，但**没有任何生产调用点**：

```
createRelayAddressProvisioner  → 零调用者        （88f7f8c4c 建的，插件激活后拿不到地址）
SubscriptionDelivery.register  → 零生产调用点    （插件声明的 message-subscription 从未变成活订阅）
```

`module-plugin-runtime.ts` 自己也写着：加载做完了、激活没做。所以今天即使插件装上、跑起来：
**入站没有地址可发，出站没有订阅可投。**

**C-6 = 激活时做两件事**：① 为该 pluginInstance 签发地址（已有 provisioner）；
② 把它 manifest 里声明的 `message-subscription` 注册进投递驱动（已有 register）。
**不是新接口，是把已有零件接上。**

**次序**：C-6 → C-5（删除）。删在前面，等于删掉唯一在工作的那条路而新路还没通电。

### C-3　thread 归属 metadata（通用版）
`ThreadStore` 已有 `updateSystemKind` / `updateConnectorHubState`。
把连接器专属的 `ConnectorHubStateV1{connectorId, externalChatId}` **换成**通用归属记录
（哪个 pluginInstance 拥有这个 thread）。**一换一，不是新增。**
地址由归属推导 → 不需要逐 thread 授予。

### C-5　删除（C-2/C-4 取消后，这是 Host 侧仅剩的一项）
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
| **P-1+2** | **合并（Plugins 线 2026-09-21 修正，已复核）**：让契约**从 schema 生成**帧级闭合键集 + 错误码 → `contract-mirror.ts`(212) 整文件删 → `wire-dispatch.ts`(1,113) 改消费生成值并**挪进 `plugin-contract`** → Host 改从契约 import `classifyFrame`，反向依赖消失 | 见 §3.1 |
| P-3 | connector 专属栈作废：`connector-runtime.ts`、`ConnectorInboundMessage`、`ConnectorOutboundDelivery`、`requireConnectorOutboundDelivery`、`FeatureContext.connectors` | `host.messaging.deliver` 才是标准 |
| P-4 | 两个 `standalone-host` 收成一份，且**不公开导出** | 两份 Host 模拟必然漂移 |
| P-5 | `messaging-client.ts`(141) 零使用 —— 接上或删 | 零使用的公开面最坏 |
| P-6 | 7 个 connector：`connector` contribution → `message-subscription` + 实现自己的方法 | **不需要声明回声 filter**，Host 默认抑制 |

### 3.1 P-1+2 的前提更正（我原文写错了，Plugins 线纠正）

我原文写「`plugin-contract` 只导出类型、不导出运行时值」——**错的**。一手复核：

```
契约已导出运行时常量：ACCEPT_CLASSES / ALL_ERROR_CODES / APPLICATION_ERROR_CODES / ACK_* 边界 …
契约缺的是帧级闭合键集：RESPONSE_SUCCESS_KEYS / PARAMS_ALLOWED_KEYS / DELIVER_RESULT_KEYS → 零命中
```

`contract-mirror.ts` 手抄的 25 组全是**帧级闭合键集 + 错误码**，属于后一类。
它们**全都在 schema 里**（`messaging.schema.json` 有 42 处 `additionalProperties:false` + `properties`），
只是生成器没吐出来。

**~~必须从 schema 生成~~ —— 该句于 2026-09-21 由 Plugins 线更正，对少数成立、对多数不成立。**
逐个匹配 9 个 schema 文件后，25 组 mirror 常量分两类：

| 类 | 组数 | 真相源 | 正确做法 |
|---|---|---|---|
| **(a)** | 3（`SUBSCRIBE_INPUT_KEYS` / `ACK_INPUT_KEYS` / `DELIVER_RESULT_KEYS`）+ enum | schema | **从 schema 生成** |
| **(b)** | 13+（`REQUEST_ALLOWED_KEYS` / `RESPONSE_SUCCESS_KEYS` / `META_ALLOWED_KEYS` / `PING_INPUT_KEYS` / `CANDIDATE_HELLO_KEYS` …） | **契约包自己的 TS 接口**：`plugin-contract/src/wire/envelope.ts`（`CallMeta:43` `WireRequest:66` `WireSuccessResponse:108` `WireErrorResponse:329`）、`row-shapes.ts`（`PingInput:159` `DrainInput:202`） | **在接口旁导出运行时键集，用编译期断言与接口键集绑死**——不等则编译红 |

**不要为 (b) 去扩 schema**：那是更大的工程，而编译期绑定同样满足 LL-104「不是手写断言」的要求。
照原句做的实现者会发现 13 组无源可生，**大概率退回手抄——正好落回我们在治的病**。

> **同时撤回我提的"可能有重复"**：契约 `APPLICATION_ERROR_CODES` 是 JSON-RPC 数字码
> （`HANDSHAKE_REJECTED_CODE` / `DELIVERY_REJECTED_CODE` / …），mirror `MESSAGING_ERROR_CODES`
> 是语义分类（`VALIDATION` / `PERMISSION` / `NOT_FOUND` / …）。**不同的东西，不要合并。**

> **P-1+2 不是清理技术债，它是 LL-104 的唯一执行形式。** 同一天里两条独立车道
> （Core 与 Plugins）各自断言"插件声明的方法名由 deliver 参数携带"，而 schema 早就
> `additionalProperties:false`——两条不同的推理路径撞进同一个坑。**靠记住无效；
> 只有让 schema 的闭合约束生成进代码，违反才会在校验期就红。**


### 3.2 P-3 与 P-6 不冲突（分属两层，文档并排会让人卡住）

- `host.messaging.deliver` 是**传输层 wire 方法**：`plane:'host-to-plugin-delivery'`、
  `operation:'deliverOnMessage'`（`contract.generated.d.ts:848,875,1066,1072`）
- 插件声明的 `action.method` 是**应用层方法名**，`{type:'string', minLength:1}`，**无枚举约束**

> **更正（2026-09-21，sol 在 C-1 开工时查出，已一手复核）**：我此前写「`action.method`
> 由 `host.messaging.deliver` 的参数携带」——**错的，而且按它实现会撞死在校验上**。
> `M0CDeliverInput` 是**闭合**的：
> ```
> /$defs/M0CDeliverInput
>   properties : ['deliveryId', 'envelope', 'threadHandle']
>   required   : ['deliveryId', 'threadHandle', 'envelope']
>   additionalProperties: False        ← 塞不进第四个字段
> ```
> **`action.method` 不上线传输。** Host 只发这三个标准字段；
> **接收侧（SDK / 模块适配器）依据自己已注册的 `message-subscription` 自行分发**——
> 它本来就知道自己订阅了什么，不需要 Host 告诉它调哪个方法。

**所以"用标准 wire 方法"和"插件实现自己的方法"是两层、同时成立**，
但衔接点不是"多带一个字段"，而是**接收侧自己路由**。

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
