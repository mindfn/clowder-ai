# F202 C1 — Host↔插件 接口全集与整改规格

**裁定日期**：2026-09-20　**裁定人**：operator　**效力**：覆盖 connector 专用机制的一切安排

## 0. 依赖方向（铁律，operator 原话）

> 我们不依赖 sdk 只有插件依赖 sdk；而且插件的 sdk 接口一定和我们 host 的兼容的；
> 因为我们是基于诉求和能力先定义和整改的 host 的接口；然后再去发的插件的 sdk

```
插件 ──→ SDK ──→ contract ←── Host
```
单向。**Host 永不 import SDK。**

今天的两处违反（均需整改）：
- `domains/plugin/external-runtime/stdio-broker-transport.ts:26` — Host import SDK 取传输帧
- connector 线形状只活在 SDK（`plugin-sdk/src/feature-context.ts:48`、`connector-runtime.ts:56`），contract 内 0 命中

## 1. 原则（operator 裁定）

> 我们不应该留下任何定制的专属接口和能力

IM connector 只是众多出入口之一。前台猫同样要发消息、同样要插件化。
**任何只为 connector 存在的接口都是错的**——否则每来一种出入口就定制一次。

## 2. 接口全集

### 2.1 方向 A：插件 → Host（已有，全部通用，保留）

`PluginToHostMethod`（contract.generated.d.ts:857）：
`messaging.send` / `messaging.appendElements` / `messaging.subscribe` / `messaging.read` /
`messaging.ack` / `messaging.snapshot`

`Capability`（:22）：`plugin.config.read` / `plugin.state.get` / `plugin.state.set` /
`secret.read` / `messaging.send` / `messaging.appendElements` / `onMessage` /
`message.event.subscribe` / `thread.listMetadata` / `thread.readContent` /
`memory.query|append|retrieve` / `schedule.register` / `events.publish` /
`windows.create` / `whisper.extend`

### 2.2 方向 B：Host → 插件（**完全不存在，本 PR 新建**）

contract 内**没有** `HostToPluginMethod` 类型；broker `BrokerConnection` 只有
`call(method: WireMethodName, input)`，方向是 plugin→Host（`host-broker/builtin-loopback.ts:11-18`）。

这是 operator 所说的"基础能力"：
> 我插件可以监听某个 thread 的回调消息注册 callback；
> 那我们正常成员或者 thread 这边产生消息的时候就往这个 callback 推送

### 裁定的机制（operator 2026-09-20，覆盖此前的 A/B 二选一）

> sdk 提供这个 outbound 接口；然后插件调用 host 注册声明需要订阅哪个 thread 的消息，
> 然后 thread 那边产生新消息后；发现有哪些插件有订阅；然后调用插件实现的这个 outbound 接口；
> 插件实现的这个 outbound 接口再按照自己的逻辑处理……那都是插件内部闭环的

**声明不需要新契约类型**——已存在且通用：
`MessageSubscriptionContribution { binding, filter?, action: CallbackAction }`（:189-195），
`CallbackAction = { method, params? }`（:130）。插件声明要 Host 调哪个方法，这已经是契约语言。

**投递的持久性放在 Host，不放进公共面**——复用已有机制，不新建：
`EventLogStore.append/readAfter/minSequence` + `CursorStore.get/advanceDelivered/advanceAck`
（`domains/messaging/stores/ports.ts:112,198`）。Host 驱动游标，调插件的方法，成功才推进；
插件抛错就不推进，下一轮重投。**插件作者只实现一个函数，不实现循环。**

> **为什么不是"只推一个信号、插件自己 read/ack"**（我此前的推荐，已撤回）：
> 那把同一个消费循环复制到每一个插件作者手里，N 份实现 N 种错法；
> 而循环放在 Host 只有一份。公共面反而更小——signal 方案还得额外冻一个信号方法。

### 泛化裁定（operator 2026-09-20 续）

> 公共面甚至不需要理解什么是插件；它只知道有 n 个实现了 outbound 的实现；然后现在有哪些需要调用的
>
> 我们自己的前端的消息其实也是这个 outbound 的一个实现而已

**已采纳**：投递驱动只认 **sink**（outbound 的一个实现），不认"插件"。
`OutboundSinkPort.deliver(subscriberId, method, params)`，driver 内无任何按订阅者类型的分支。
测试 case 5 用一个 `ui:live-view` 形态的 sink 钉死这一点。

**证据支持这条泛化**：Host 内 `broadcastToRoom(` 有 **112 处**调用点，事件名散成
`connector_message`(31) / `intent_mode` / `task_updated` / `heartbeat`……
前端出站今天不是一个实现，是 112 个散落推送点——与本 PR 在入站上治的是同一个病，长在读的一侧。
**收敛它属于 C2（operator 已明确把前端部分划给 C2），本 PR 只保证抽象能容纳它而不需改动。**

> **push back：注册不能省，过滤不能交给订阅者。**
> operator 提议"完全 SPI 就不用注册、插件自己过滤"。**注册不是手续，是授权边界**：
> `handles.ts:99-107 resolveForSubscribe` 逐条校验 handle 存活、绑定到该实例（INV-8）、
> `scope.canSubscribe`。若 Host 把每条消息发给所有 sink 再由对方自行过滤，
> **数据已经离开 Host 了**——每个插件都将看到它从未被授权的 thread 内容，包括 whisper。
> 过滤必须在 Host 侧，因为投递之后的过滤不是过滤。
> 次要理由：全量扇出的成本，以及每个 (sink, thread) 需要独立游标才能各自重投。

**载体实现**（同一套语义，不漂移）：
- 进程内模块载体：就是一次函数调用（TS 的 SPI 形态，`22eba9a45` 已能加载插件自有模块）
- stdio 外部载体：已有连接上的反向帧

> **止损线覆盖记录**：本车道原定"新增 public method/hook 即转 C2"。operator 已裁定方向 B
> 是基础能力且必须在本 PR 内完成，该止损线在此项上被显式覆盖，不适用。

## 3. 缺口清单（要补的，共 4 项）

| # | 缺口 | 取证 |
|---|---|---|
| **G1** | Host→插件调用方向不存在 | contract 无 `HostToPluginMethod`；`BrokerConnection` 仅 plugin→Host |
| **G1b** | 订阅投递驱动不存在 | 无代码按订阅游标调插件声明的方法 |
| **G2** | `message-subscription` 无功能消费者 | 全仓仅 `plugin-manager-projection.ts:91` 一处，是 UI 投影 |
| **G3** | 无 thread 创建能力 | Capability 只有 `thread.listMetadata` / `thread.readContent` |
| **G4** | 地址签发无路径 | `issueConnectorBindingHandle` 生产调用点 0 |

G1 是底座：**connector 专用设计的 `outboundMethod` 同样依赖它，也同样没实现**——
所以选通用面不会比专用口子更慢。

## 4. 删除清单

| 层 | 删除对象 |
|---|---|
| contract | `ConnectorContribution { inboundMethod, outboundMethod }` |
| SDK | `connectors.register/deliver`、`ConnectorInboundMessage`、`ConnectorOutboundDelivery`、`requireConnectorOutboundDelivery`、`FeatureHostAdapter.deliverConnectorMessage` |
| Host | `ConnectorRouter`(664)、`ConnectorCommandLayer`、`im-connectors/` 7 provider(8,180)、`im-connector-loader` 静态 import、`OutboundDeliveryHook` 的 connector 分支 |
| Host（本 PR 自建，降层） | `ConnectorIngress.admit()` 代发层——保留其地址解析部分 |

斜杠命令 / 群白名单 / 表情 ack / skip 原因随 provider 迁往插件仓，**Host 侧不重建**。

## 5. 一般化清单（不是删，是去掉 connector 味道）

`ConnectorBindingAddress { connectorId, externalChatId }`（contract :455）承载的是
**唤醒授权**——已认证外部入站里"人的 @"有效，而插件自己的声音无效（F288 v0 冻结的安全属性）。
这是安全属性，不是 IM 属性：前台猫转述访客的话需要同一个东西。
应泛化为通用的"已认证外部入站地址"。**beta 期改名是免费的，正式版后就不是**——
这正是 operator 引用的插件仓 issue 所警告的。

## 6. 执行顺序（operator 裁定的路线）

> 搞清楚后；然后开始干；然后删代码；然后等插件仓那边基于调整后的 sdk 把相关的插件改造完成，
> 然后发布后；我们就可以验收了

1. 本规格（搞清楚）——本文件
2. Host 侧补 G1–G4 + 一般化（干）
3. Host 侧删除清单（删代码）
4. plugins 仓按整改后的 Host 接口重发 SDK，改造 7 个包
5. 验收：插件可独立安装 / 卸载 / 使用，且 Host 内无任何 connector 专属代码
