---
feature_ids: [F117]
topics: [message-delivery, a2a, upstream, scope-closure]
doc_kind: implementation-plan
created: 2026-10-08
---

# #1398 投递语义与最终交付收口

## 授权、归属和终点

Operator source：`thread_msr51149hym0i79f#0001791431589436-000016-027ee9e2`。
这是原 task `0001791275498653-000300-2a121472` 的恢复与范围纠正，不另建任务。
sol 继续唯一源码写入，astra 负责来源审计、独立复验和交付协调。
本计划纠正实现和旧路线图对原 RFC 的偏离，包括读取阶段、F202 整体前置要求和逐批停等安排；不是 operator 新增或调整 A2A 目标，历史证据保留。

终点：同一个公开 #1398 包含合理、完整的 A2A 实现，与最新 public main 无冲突；
在 fork 同步该基线并接入同一候选后验证，再交 Landy review。公开最终合入由 maintainer 决定。
不自行重启运行实例，不删除持久数据，不绕 hooks，不以测试批次数代替终点。

冻结起点：public #1398 HEAD `fd4bd45d0857bddaf49dfbe6f41b6e2d160ef57e`；
最新 public main `3e70e1d6805be24672e8f841861f180d20b184c2`（本轮实时核查）。
唯一整合 checkout `/Users/lang/workspace/github-lab/cat-cafe-a2a-dev-1577`，
HEAD `db3fbbce7b9b98fe5d6b34c44016d03075fb6f17`，MERGE_HEAD 即上述 main，66 个 unmerged 路径。
CUT31 未复验改动与暂停清单保留，不能硬重置或覆盖。当前没有可发布的最终候选。

## 唯一产品和代码契约

1. 用户只需理解“排队 → 已投递给成员/处理中 → 成员结果”。投递失败与成员处理失败诚实呈现；不承诺模型已读。
2. Phase M 的 readState/readAt、handed input 列表、awaiting-read 投影/store/无操作队列行及消费确认驱动的延迟退休机制一并退役。不能只改文案，不能换名字保留第二条状态链。
3. Queue 只承载尚未投递的目标，保留 Steer/撤回等真实可执行操作。持久化投递证据与对应响应后退役精确目标；兄弟目标、幂等和崩溃恢复保护保留。成员后续失败由其响应表达，不能为等待模型读取把已投递消息重新留队。
4. 保留已经核定的单一 Message/Queue/History 责任边界和 Task/action 业务权限。普通读取、外层回合结束均不等于业务任务完成；不恢复旧 Message-custody writer/untyped 完成协议。
5. 不改用户持久数据；旧作者/account 结构沿 ADR-043 既定集中读取归一。废弃字段不再产生或参与决策；遇到真实存量读取失败才修具名边界，不新增通用兼容系统。
6. F202 插件独立交付。#1398 已有统一 connector 投递入口，只适配实际变化的消息投递/callback 通知接口；不将 registry、Settings、包制品和账号验收纳入 A2A 的合入前置条件。

## 行为提交分组

下列是提交主题，不要求为了凑数拆断可构建边界；相关回归随对应实现提交。临时日志和 fork 私有材料不进入公开 diff。

| 组 | 应交付的变化 | 关键验收 |
|---|---|---|
| 1 投递语义收敛 | 退役 Phase M 读取链，对齐 RFC，Queue/History 以投递为边界 | 排队可 Steer；投递后立即退出队列；成员未进入模型即失败仍有单一失败响应；无 awaiting-read 阶段 |
| 2 投递与响应可靠性 | 保留近两周草稿持久化、精确 child、超时/停止、重放/恢复与独立消息边界修复 | 无重复投递、无丢响应、无已投递目标复活；存活/未知 child、兄弟目标与重启路径 |
| 3 内容读取和预算 | 引用继续 messageId + 片段/评论，修正文与 contentBlocks 的查询呈现；只在真实上下文预算边界计数 | 引用可按 ID 追溯；长文本获取、检索/预览不被无必要全量同步计数拖住；必要预算正确 |
| 4 用户操作和失败呈现 | 收敛重复“回复失败”与 Diagnostics，保留必要前端稳定性和版本匹配修复 | 真实页面单一失败提示，诊断默认折叠；刷新/流式顺序/停止/Steer/转发状态正确 |
| 5 单入口整合及公开同步 | 剩余调用方统一到一套接口，独立结果通知走普通统一投递；解决当前 main 冲突，保存公开分支 Windows 修复 | API/Web/MCP fresh 构建和接口消费者通过，无旧第二 owner；公开来源清晰，#1398 无冲突 |

长文本专项先核调用图：ID 查询本身不需要 tokenize；真实上下文大小预算可以计数，但不能把同步全量编码扩到每次预览/读取。
#211 的加速实现是已有候选，不预设整包接纳；以调用必要性、精确性和实际性能证据选取，避免另建 token 子系统。
#213 的作品审查结果属于独立通知，不是 managed hold；来源分类若仍有必要须说明具体消费者，否则沿既有普通通知路径，不新建持球任务或完成协议。
#210–#214 每项记录“保留/已被覆盖/不适用”及精确文件依据，不能因存在 PR 就全量合入。

## 执行顺序和交付证据

1. sol 在上述唯一现场接回 CUT31，以本计划收敛生产实现、测试和 RFC；不继续旧的 F202 全量合流目标。常规文件和测试迁移自行推进，不逐文件等 astra 批准。
2. 对自动合并文件与冲突文件一起检查。完成候选后归并为上述行为提交，形成公开来源映射：原 #1398 + 适用 fork 修复 + latest main；排除 fork 私有治理、配置、数据和无关插件/桌宠改动。当前 fork merge 树不能直接推公开分支。
3. 在唯一候选工作树准备公开更新；如必须转换基线/分支，先保存完整原现场与未提交改动，明确新的唯一候选，重新构建验证。不同树的局部绿色不能拼成最终通过。不 force push、不丢原公开 Windows 修复；优先保留既有公开历史并添加有意义的后继提交。
4. 正常 hooks；fresh shared/finance/MCP/API/Web 构建、类型、相关完整回归和真实页面旅程。Redis/SQLite 使用自有隔离数据并保留。至少覆盖投递、追加、Steer、取消、失败、重启/刷新、引用长文本与普通回流通知。明确 provider 认证与真实调用未通过的部分，不能用 fixture 替代。
5. astra 对精确新 commit 做独立审查，修复发现后更新同一 #1398，并复查 GitHub head/base、CI 和无冲突状态；保留 Draft 至真实门禁满足。
6. fork 先在候选中验证 latest main + 同一 #1398 提交与 fork 自有改动的组合。按既定体验确认/合入门禁同步 develop_base，不 reset 掉 fork 功能，不直接改运行代码，不自行重启。向 operator 交付可验收坐标；按实际体验和 soak 证据再交 Landy 作最终上游审查。

结束条件必须含精确公开 commit、无冲突证明、公开与 fork 的消费映射、同候选构建/回归/页面结果和独立审查；
历史 220/827 等局部绿测、解决冲突数或来源可读取都不是结束条件。

## 工具记录

## 04:21 通知同类审计与后续范围纠正

Operator `0001791433289819-000025-740e3876` 要求核实作品审查通知合理性，清除统一 A2A 后仍残留的额外超时/失败通知。随后明确：引用和长文本不属于本次 A2A 范围，仅把已做、改动小且合理的修复一起完成；不得为每个场景叠加 if/else，应由机制满足统一规则，再用场景验证。若方案涉及新的产品/责任边界，先带具体取舍向 operator 确认。

因此上表第3组降为有限附带修复，不是新的 A2A 前置工程。没有必要的大幅 tokenizer/引用重构不纳入；已有小修仍需解释适用性并验证。

只读源码审计覆盖业务通知 producer、前端超时及诊断 writer、active/background/冷恢复消费者与既有测试。发现如下（尚未修复验证）：

| 项 | 实际证据 | 处置 |
|---|---|---|
| 作品页意见回送 | `ArtifactReviewReturnStore.record` 仅 applied human receipt + returnTarget + 明确提交/裁决/重开/修改操作创建 intent；`ArtifactReviewReturnDispatcher` 按 receiptRef 幂等走统一 delivery，原 Task 续办 | 这是人从作品页送意见给原成员，有明确业务意义；不等于猫每次审查结束额外通知，不是 managed hold。保留统一投递适配，不扩做 F309 体验；普通批注不制造回流 |
| **P2：客户端超时第二消息链** | `useAgentMessages.ts` 5min DONE_TIMEOUT → `invocation-timeout-reconciliation.ts` 的 `reconciliationNotice/upsertNotice` 构造 `invocation-status-*`；running/unknown 与成功/失败/取消都生成系统行；终态与 history/queue hydrate 继续驱动通知恢复；loading 测试固定断言额外 error row | 去掉额外消息与 notice 驱动恢复。丢 socket/重连需要查证时，刷新原响应和执行事实；未知不能伪造失败或停止，不丢真实结果 |
| **P2：CLI 分支仍重复失败卡片** | `TerminalDiagnosticsPanel` 只在 timeout 分支消费 responseOwnsFailure；CLI 分支直接调用始终渲染 `cli-diagnostics-banner` 的 `CliDiagnosticsPanel` | 不能再按 reasonCode 加隐藏分支。把失败结果与诊断详情的职责拆清，原响应只表达一次结果，诊断提供按需详情及有用建议 |
| 尚未投递的追加失败 | `QueueProcessor.compensateLifecycleAppendTargets` 按 source×target 幂等记录 delivery_failure | 这是未投递事实，不能当执行超时重复消息直接删；场景应证明每个失败投递只有一个结果，不能吞失败或串到别的成员 |
| 无响应的准入失败及后台 toast | active/background error writer 仅无 named response 时另写错误行；后台另有完成/失败 toast | 核查准入失败有唯一出口，后台提示不产生第二条 History/任务。不要为了“去重复”隐藏唯一失败证据 |

机制验收规则：同一次已接纳执行的结果归原 response；断线恢复刷新同一事实；诊断不成为另一结果；业务新输入按唯一 delivery 投递。用 active/background、F5、晚到 socket、未知查证、CLI/timeout、无 response 准入失败、通知重试/取消等场景验证这条规则，不按场景增加平行 writer。

审计已以 `0001791433393303-000028-44b1e70d` 投递给正在执行的 sol，沿原 task300 处理；astra 未改其源码。此表是具名静态发现，不声称全仓不存在其他重复通知或已通过运行验证。

本轮更新原 task300 为 doing 的请求被服务器 409 `ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED` 拒绝，
虽然请求不是终态操作。未伪造状态或重复建任务；本计划和原消息保存实际恢复授权，沿原 writer 链继续。

## 06:12 F286 公开来源边界核对

来源：sol `0001791439949904-000080-b50aa4f4`；只读核对回流 `0001791440231277-000088-c1626b78`。本节不批准尚未审查的生成基线，也不改变原 attestation。

- 原 attestation 绑定 `zts212653/cat-cafe` 的 `origin/main`，bootstrap 为 `265f7b998f7b8cae81d26d88db58351cf02b030d`。它不能证明公开 `clowder-ai` 或当前 fork 的祖先关系。
- 已落地公开处置：`5115761a67dd30a6a7af57a9bb4c07c4f5dd5762`（同步 PR #1297）新增 `scripts/check-sync-docs-runtime-assets.test.mjs` 的公开脚本剥离断言，明确移除根 `check:mcp-surface-governance` 和 MCP 的 `governance:*`，原因正是原仓 attestation 的历史不适用。该提交经 `git merge-base --is-ancestor` 核实为冻结 public main `3e70e1d6805be24672e8f841861f180d20b184c2` 的祖先，exit 0。
- `scripts/check-env-port-drift.test.mjs` 同样记录此公开边界；冻结 main 的 MCP package 与当前整合 package 均不暴露这些命令。因此手工调用原仓 CLI 的祖先拒绝，不应成为 #1398 新的私有历史前置工程。不得更改授权、digest 或伪造替代祖先。
- 生成 JSON 仍有实际测试消费者：`packages/mcp-server/test/opensource-ops-surface-regression.test.ts` 要求 `propose_thread` 描述与 registry 一致。不能删除此测试或盲选冲突一侧；应按公开产物用途核对快照与当前定义，保留历史来源与当前验证的区别。实际 MCP registry/schema/runtime 需在候选中自行验证。
- 原对象在扫描的 34 个本地 Git common database 中均不存在，包含非浅克隆；原仓 GitHub commit 查询被 403 rate limit 拒绝，不是 404，不能据此声称远端对象不存在。未查到新的具名迁移授权；结论依据是已有公开导出边界。

astra 未修改整合 checkout、未运行绕过检查的生成器。sol 继续唯一源码写入；本次来源核定不等于完整候选通过。

## 06:31 内部状态消息的同类审计

Operator `0001791441081560-000110-e3f79b33` 追问同类问题。astra 只读核对当前整合树的 producer、active/background 展示和恢复/持久化三路；下表是实际源码路径，不代表逐项运行复现或已修复。

| 发现 | 来源与影响 | 处置 |
|---|---|---|
| P2 provider 自动重连独立消息 | `CodexAgentService.buildCodexProviderRecoveryTransition` / `codex-event-transform` → `system-info.ts` → `projectProviderRecoveryMessage`，产生 `provider-recovery:*` 的正在重连、已恢复、重连失败行；warning suite 仍固定断言这行 | 自动恢复更新当前执行状态，成功不再留结果通知；最终失败由原 response 表达，attempt 保留诊断 |
| P2 transient_status 仍变成聊天行 | Codex 原生会话等待、ACP capacity、Antigravity 自动重试均声明 `transient_status`，`formatWarning` 却与 `user_action_required` 同样展示；后端只持久化后者 | 沿已有 presentation 分类收敛，瞬时进度进入执行状态；用户确需操作的警告保留唯一出口，不增加逐场景隐藏规则 |
| P2 自动会话接力/封存另发消息 | `invoke-single-cat` 三处 `session_seal_requested` → `formatSessionSealRequested`，输出自动接力/下次自动创建会话通知 | 保留 session/continuity 事实与诊断，取消独立聊天结果；不得只移除 `session_rollover_lifecycle` 落盘就宣称全清 |
| 失败去重仍依赖文本 | `persist-system-info-warnings.ts` 的 `duplicatesTerminalFailure` 用去前缀后的 substring 比较 | 按结果所属 response / 未接纳失败的责任边界处理，用措辞变化场景检验，不把文本相同当成唯一性机制 |

边界：未投递/待绑定的 cloud bridge 结果、治理初始化阻塞、没有 response 的准入失败确有用户动作或唯一失败事实，不能全部吞掉。后台完成 toast 是跨 thread 提醒，不等同另一条 History 消息。本轮不扩成重新设计全部通知。原 task300 唯一 writer 继续按同一机制及 active/background/F5/晚到事件/成功恢复/最终失败场景验证，astra 不改其 checkout。

### 原 RFC 既定约束：结果消息本身就是统一协议

Operator 随后重申既定设计：dispatch 目标成员的成功、失败、取消及内容由普通 message 承载，用户和其他成员读取同一份结果并按语义采取行动；失败结果通过既有 callback 与任务关系驱动后续分发。因此上述提示清单只是同根因证据，不应变成逐项 if/else 清理工程。这不是本轮新增目标。

统一终态要求是精确 dispatch 的结果 message 同时承载可见结果及回调依据；等待、自动重连、接力、补同步只更新执行状态/诊断，不制造第二条聊天结果。无正文、进入模型前失败、取消及崩溃恢复也要保有对应的可见结果。前文“无 response 的准入失败独立 error row”仅描述审计时实现，不能升格为终态例外；应核对统一 dispatch 入口建立结果身份的机制。发生在 dispatch 创建之前的请求拒绝仍是请求错误，不伪造已投递事实。

后续 callback/分发沿已有授权、任务关系及幂等边界消费结果 message；不得靠额外 system notice 驱动，也不引入无条件失败递归重派。以正常完成、未入模型失败、取消、重启恢复和 callback 重放验证同一机制。若现有契约无法满足，携具体设计取舍核定，不叠加兼容流程。

原文核验（operator 纠正来源 `0001791441454334-000128-0eec0c1a`）：以公开 #1398 冻结 HEAD `fd4bd45d0857bddaf49dfbe6f41b6e2d160ef57e` 中 `docs/architecture/message-delivery-handling-handoff-audit.md` 为依据，其最近提交 `f426fb7902837d95286ea98207ef39afb038106c` 日期为 2026-09-21，早于此次提醒。

- §1.2 第5/9条、§2 第4–6步：admission 先建立固定 response，成功/失败/取消原位终局，具体结果唯一由关联 response 表达。
- §1.3、§7.6：failed 的 exact `a2a_failure` wake 引用既有 failed response，是幂等控制边，不创建第二条结果或递归 fail-back。
- §2.5：取消保留原正文并在同一 bubble 表达原因，不追加第二条 system chat；§2 第5步与 A65：内部 compact/session rollover/continuation 不新增主生命周期对象。
- ADR-043 D2 同样明确失败传播直接引用原 failed response，不复制正文、不创建第二条失败通知。

因此本轮缺陷归因为原设计未贯彻、旧路径残留及整合审计遗漏；不得标记成 operator 改目标或新 feature。原 RFC §7.5 示例仍有“failed 不自动唤醒”的旧行，与同文 §1.3/§7.6 的 exact failed wake 冲突，需按明确既定失败传播契约机械校正文档，不据此重开产品设计。
