# Callback 来源身份：删除正文窗口过滤

续接原 task300 / A2A Lifecycle1398。接受来源为 operator231 `thread_msr51149hym0i79f#0001791607522054-000231-d1275eea`；精确新增 P1 来自 Astra237 `0001791607642722-000237-455b56e0`。基线 `6bec5551f92f6980300d22b33e0582d8a40d18a0` 的 D20 测试/注释修复已有独立批准，本增量另行审查。

## 根因与删除

普通 invocation / agent-key `post_message` 在入队之前，先扫描5秒内同文消息，再认领正文指纹；显式 clientMessageId 不在指纹中。不同ID同文的新消息被判重复。两条入口还在写入前认领短期 client ID，存储失败后该ID已被消耗，重试没有消息可恢复。四个新反例先跑，4/4失败：两入口新ID被吞、两入口落盘失败后重试被吞。

删除正文窗口扫描、指纹计算、原子正文认领及其缓存、Redis键生成器、消息库接口/实现和仅验证已退役接口的两条测试。普通发送不再调用 invocation/agent-key 的提前认领。没有新增缓存、TTL窗口、正文判别器或队列防重实现。

## 现有身份与事务

现有 MCP post/cross-post 发送器为一次调用生成 clientMessageId；HTTP重试和outbox保持原载荷。普通回调将此ID与已认证的发送者绑定，复用消息库的 user/thread/idempotencyKey 索引及 appendIdempotent；有接收成员时复用既有 Message+Queue 原子准入。不同ID同文独立持久化、各自唤醒；同ID重试返回原 messageId。失败发生在落盘前则不占ID。没有ID的直接HTTP请求按独立消息处理，既有MCP发送器无需改动。

空接收集合分支也复用 appendIdempotent，否则原子消息/队列分支之外会遗漏身份。恢复投递只使用已持久消息的正文、目标和 replyTo，不将重试载荷当新来源。身份同时适用于 invocation 和同一发送者的 agent-key 传输；不同发送者使用相同字符串ID互不覆盖。

精确云端回流、typed local-review 和 action-generation 的专用持久键与冲突校验保留，并优先使用原键。callback token、owner/thread/source/action围栏不变，未增加来源/角色发送许可。原短期认领API没有普通发送调用；原始鉴权后端旧状态读取和历史崩溃夹具保留，不清除存量键。无ID的历史消息不凭正文回填请求身份。

## 同类消费者和兼容

将旧同文合并断言改成新ID或无ID的独立消息/队列断言，保留 action lease/fence、coordination 和持久身份的语义检查。扫描方法仍被审查历史读取使用，因此更名为历史读取而保留该消费者。更新三处 stream+callback 合并的陈旧注释；历史 cliStdout/speechContent 的读取与渲染没有删除。

真实隔离Redis验证另暴露同文件既有 F317 夹具直接传旧 catId 输入：缺少 canonical MessageFrom。改用同文件既有 appendFixture 助手，原历史身份断言全部保留，未改生产F317行为。初跑63/64与修后64/64日志均保留。

## 验证与边界

- 20个API文件、23 suites、422/422；包括普通两入口、11个真实 MessageStore/InvocationQueue/Fastify.inject 身份场景、跨thread、action恢复、typed review、云回流、原子准入。
- 独立分配临时Redis实例：消息库及投递原子性64/64，0跳过；测试wrapper核对实例归属，未使用运行实例Redis。
- MCP发送/agent-key/传输重试3文件108/108；包含已有稳定clientMessageId重试/outbox断言。未改MCP生产源。
- 原Astra反例脚本未改，作者亲跑1/1转绿；不是把作者结果宣称为新增独立批准。
- Feature API、finance依赖及MCP tsc完成。最初MCP缺finance dist，编译现有依赖后成功；这是构建准备，不是候选行为失败。
- diff-check通过；退休正文扫描/指纹接口及上一轮跨消息target过滤标识在src/test无命中。保留的精确载荷比较只校验同一typed事实/action-generation的冲突，不扫描历史正文认定普通重复。

本增量Web仅注释，没有UI行为变更；没有重跑未变full gate/provider/browser/soak。当前运行实例仍未包含本增量，未修改配置/数据/运行代码，未merge/restart。原1398/220是唯一发布路径；需本增量独立批准和新head的实际CI，不能用旧head的批准/CI宣称220可合。
