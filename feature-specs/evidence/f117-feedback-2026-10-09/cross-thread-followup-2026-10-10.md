# F117 / #1398：跨线程唤醒与追加读取回执修复

本轮从 `984edb0da56872ee771441b0d2e9586eba5ce19b` 继续；中间候选 `6cc7181486066074e16306ad19bfd98cdddccd28` 已被独立复审退回，本报告按后续 operator 051/054 的最终方向更新。使用原 `fix/f117-append-receipt-feedback` worktree。报告记录作者自验；独立放行、发布、运行回流及 operator 体验另据实际回执记录。

## 原问题与授权

同一 thread `thread_msr51149hym0i79f` 的不可变来源：

> `0001791595491779-000002-465a7b95`：跨线程消息 `0001791556382333-000171-697b2d56` 应投递给 Astra，但没有触发。
> `0001791595815561-000007-7fd17750`：Codex app-server 能否确认消息进入模型，为什么只有投递于且不闪烁？
> `0001791596027888-000015-69592a04`：补充消息圆点应该是 source 主题色。
> `0001791596170928-000017-3a8debc4`：本回合超时不应标记成员全局不可用，更不应影响其他 thread；应记录失败并回调触发成员。

`0001791595926479-000011-ea1ae754` 追问 #215 未关闭；此前的冗余 PR 清理授权继续有效。原 `0001791553890412-000138-a1dca2eb` 授权修复、报告、更新 #1398 和 fork develop_base 增量 PR，由 operator 择时重启。

## 根因与改动

### 超时与跨线程漏唤醒

原通知的目标是 `thread_mrkn6povq4zzgh45` / `cat-xlbldqjc`，来源是另一 thread 中的同一成员。目标解析正确，并非同成员跨线程被误当成自发自收。

运行日志 `packages/api/data/logs/api/api.2026-10-09.1.log` 实核：14:31:08.772，另一个回合 `b16935bd-37b0-4aa4-b355-6adf5386f467` 的本地输出超时生成全局 `provider_timeout` 路由断言，有效至 14:36:08.772。14:33:02.333 原通知已持久化，14:33:02.355 进入 preflight，随后没有 Queue admission。日志没有逐字记录拒绝 verdict；结合当时有效的全局断言与代码的入队前过滤，判断该门禁造成漏唤醒，不能把日志顺序本身写成拒绝 verdict 原帧。源工具返回 `200/routed=[]`，未保留后续唤醒责任。14:33:40.112 成功投递已使全局信号恢复，原通知仍没有队列记录可重试。

最终修复删除普通投递与 F293 availability 的接线，而非降为提示。串行、并行、callback、完成回复、失败回流、投票及多目标通知直接以原请求目标进入既有消息生命周期；不查询可用性，不提前拒绝、跳过 Append、延后执行或展示拒绝提示。普通 invocation 也不注入动态 routing-context 提示，不从成功/失败/本地超时终态发布全局可用性断言。实际客户端成功或失败负责正常回显；失败只回流到精确前序，失败回报本身不反弹。

中间 6cc 曾保留 actual-send preflight 与路由延后；operator 051/054 明确反对此方案，本次将相关分支和两个失去消费者的 helper 删除，没有增加 advisory 替代层。Team/显式查询及历史 signal 存储保持独立；后台记忆机会调度仍使用其自身路由契约，不属于普通消息发送路径。没有修改运行配置或清理生产 signal。

保留的退避仅处理后端在持久接纳输入之前真实失败，防止丢消息与热循环，不依据预测的 provider 可用性。定向验证发现多目标消息接纳了一个成员后、另一个成员在接纳前失败的收尾缺口：Queue 重建剩余目标后，也需要进入既有失败退避；现按尚存的 queued 行决定，已接纳成员不会重跑。客户端已经接纳后的 provider 失败走失败回复，不把源消息退回 Queue。

这里的 callback token 核对只是将回调绑定到正确 invocation/member/thread，防止写错回复；不是发送来源或角色的权限门禁。本轮不新增这种门禁，也不改变精确 parent、来源身份、循环/深度或行动归属契约。运行环境实际 `CLI_TIMEOUT_MS=1800000`，本轮不修改这项 30 分钟无输出配置或本地终态行为。

原消息 171 已由后来的手动通知触发并进入上下文，本轮不重发，避免重复业务执行。

### Codex 原生读取回执

本机 Codex `0.161.0` 的原生协议支持 `turn/steer.clientUserMessageId` 和 `userMessage.clientId`。此前适配器已发送 UUID，却未接入 `onInputRead`，也未声明 `inputReadReceipt`，因此 console 只能静止显示投递于。

本回合真实 SDK archive 中 5 条追加输入都有 exact thread、turn、clientId 的 `item/completed` 消费事件；归档仅提取 ID 与时间，不复制用户正文或凭证。`native-consumption-metadata.json` 保留这一事实。

修复在每个 active run 内绑定 UUID 与既有回调：RPC 接纳仍只是 pending；只有匹配 thread、turn、clientId 的 native user-message completion 才写现有 `dispatchRefs.inputRead`。其他回合、未知 ID、其他 item 类型及 `item/started` 不会升级为 read；重复 completion 只记一次。回执持久化异步执行，不阻塞 provider 输出、Stop 或 terminal；关闭回合清理映射。没有新增 consume 字段或消息状态体系。

这里的读取表示该输入进入客户端为模型准备的上下文，不表示模型理解或执行了内容。依据是 [OpenAI 原生消费实现](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/session/mod.rs#L4861) 与 [pending-input 协议测试](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/tests/suite/pending_input.rs#L180)；[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 的 steer 接纳本身不替代读取证据。F117 原文已约定 client-ID 消费接线，本轮补齐当前适配器缺口。

### 圆点与 #215

`AppendedInputReceipts` 复用 `resolveMessageSender`，圆点和名称从同一个 source 身份取颜色；target 仅用于匹配投递/读取状态。用户、成员及 connector 的既有主题色规则共用，不另造颜色表。

#215 已按授权通过 canonical gh 关闭，provider 回读 `closedAt=2026-10-10T01:34:13Z`；对应 tracking/task 已结束并取消登记。保留分支、原审查和证据，不合入旧差异。先前保留 draft 后没有完成清理是遗漏，本轮已纠正。

## Ownership / 风险

Architecture cells：`dispatch`、`routing-context`、`transport`、`bubble-pipeline`。Map delta：更新 `docs/architecture/ownership/cells/routing-context.md`，登记普通消息的 availability 消费/提示/终态回写退役。没有改变 owner 或新增运行组件。

行为：普通消息不根据跨 thread 可用性阻止执行；实际失败回显并回流，接纳前后按既有持久事实区分。数据：新验证仅使用 owned Git/in-memory fixture，生产记录只读；未迁移、清理或重发历史数据。身份：callback token 精确运行归属保留，没有增设来源或角色发送许可。契约：使用既有 native client-ID 与 `inputRead`，不把接纳当消费。不可逆：代码未自行合入或部署；唯一外部清理是已授权的 #215 关闭，可重开且无分支删除。

## 中间候选验证与独立退回

`followup-2026-10-10/sha256.json` 记录归档原件和 gzip 的哈希；红日志保留，不覆盖此前验收证据。

- API 编译：`pnpm exec tsc -p packages/api/tsconfig.json`，exit 0。
- API 定向 10 文件：138/138，覆盖 callback admission、路由 preflight、Queue retry、超时失败、投票及并行失败回流；`f117-cross-thread-final-api.log.gz`。
- 原失败回流 seam：`node --import tsx --test packages/api/test/a2a-1577-failure-return-seam.test.mjs`，5/5。
- 原生 app-server transport：`node --test packages/api/test/codex-app-server-transport.test.js`，37/37。随后加强 native-started 处理屏障的两个定向案例再跑 2/2，分别报告，不累计。
- Web 两个定向文件：10/10，含 source 用户/成员/connector 色彩及 receipt 展示。
- Web 类型比较：candidate 与 exact base 984 的诊断一致，只有已有 `proposal-card-realtime-socket.integration.test.tsx:152` 的 boolean/null 错误；不能称 Web tsc 全绿。
- 15 个改动文件 Biome error-level 检查及 `git diff --check` 通过。
- 作者隔离浏览器 preview：本 feature 的当前组件、合成输入及内存 API，实际 URL `http://127.0.0.1:5173/`。圆点实色为发送者默认 cocoa `rgb(107, 84, 67)`，不是 target Opus 紫色；已投递/读取于 tooltip、点击和键盘展开、停止全部两精确运行及移动视口均正常，零 page error。`preview-result.json`、`source-color-preview.png` 和实际 check 脚本保留；页面不连接运行数据或真实 provider。

已先红后绿：Queue 丢目标、timeout 全局映射、native 消费缺回调和 target 色彩各有独立原红。首次无 TS loader 的 seam 命令失败属于 fixture 启动问题，使用 `--import tsx` 后 5/5；不能算生产缺陷。

本轮不重跑不变全量、不请求真实 provider、不改运行 checkout/config、不重启进程，也不宣称体验或 soak 完成。原报告中剩余内部准备延迟仍是未解决范围，本轮不得借读取回执修复声称毫秒级入队到执行已实现。

## 后继修正与验证

Opus 对精确 6cc 的 `changes_requested`：`local-review:0001791597781796-000056-7bbac02a:changes_requested`。其 API 独跑 186 条中 185 过，一条既有 `1398-failed-response-recovery` 用例仍期待“前序拒绝则不入队”。这是作者漏跑该测试留下的 P1；本次保留并改写为“任何旧可用性记录不能阻止精确前序回流”，同时保留 `isFailureReport` 不反弹。旧红日志归档，没有删用例或改成无断言。

后继作者验证使用同一 feature checkout：

- API 编译 exit 0：`remove-availability-build-final.log.gz`。
- API 12 个定向文件 **206/206**：`remove-availability-api-final.log.gz`。包含原 P1 文件、跨线程原 source 准入、普通串行/并行不查询 availability、真实错误事件失败终态、两条串行/并行失败回复 → 实际 MessageStore/Queue 事务 → 精确前序案例；客户端错误是受控 fixture，不冒充真实 provider 请求。
- 普通回复不注入/调用动态 availability 投影的两个反例：原实现 **0/2**，后继 **2/2**；`remove-availability-prompt-red.log.gz` 与 `remove-availability-prompt-green.log.gz`。
- 原失败回流事务 seam **5/5**：`remove-availability-seam-final.log.gz`，旧 preflight spy 零调用、不产生额外提示。
- 首次扩展运行 **204/205** 的原红保留为 `remove-availability-api-partial-red.log.gz`；唯一失败是多目标接纳前后端失败的剩余目标未退避，后继修正并在 206/206 中通过。不是 provider 真请求失败，也不是编译问题。
- 格式 error-level 和 `git diff --check` 在提交前复核。既有复杂度等 warning 不称全仓已治理。

6cc 已独立核实的 Codex 原生 UUID 消费回调、inputRead pending/read、旧 signal 持久化兼容、source 圆点色继续沿用，后继未修改这部分，不重跑不变的 Web/native 全量。Opus 原 API 红、seam 与 Web 独立日志另存为 `opus-6cc7-*.log.gz`；其其他 extended 测试 10 项 MCP dist 缺失属于环境加载失败，不写成代码失败或通过。

`remove-availability-first-red.log.gz` 保存最初转向时的试验：普通串行拒绝反例为有效原红；另一条 attempted advisory 政策反例属于随后被 operator 054 否定的方案，其测试已经恢复，不将它算入最终产品验证计数。所有旧原件及归档哈希保留。

## 独立复审交接

Review-Subject-Ref：`task:0001787725735853-000657-d43e332d`。
Accepted-Source-Ref：`docs/features/F117-message-delivery-lifecycle.md`。
Accepted-Revision：`d015c806d91839658788a32593735e3f4ff99254`。
Scope override：同一 thread 的 `0001791597613326-000051-04cd35ac`、`0001791597713607-000054-cd1b4b61` 与 `0001791597752751-000055-f3cb29c5`；最终要求删除普通发送 availability 层和提示，身份只绑定运行归属。

请非作者 local peer 只读精确后继，重点检查普通发送是否仍残留 availability 拒绝/延后/提示、实际失败回复与精确前序回流、接纳前后 Queue 重试边界，以及旧测试改写是否保留原失败回报不反弹。复验使用同一 feature checkout 的新编译 dist；不使用运行目录的产物或数据。放行后沿已授权的原 #1398 与 fork develop_base 增量交付，不自行 merge 或应用到运行实例。当前后继没有独立放行、发布或体验/soak 完成回执。

[砚砚/gpt-6.1-sol🐾]
