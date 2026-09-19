---
feature_ids: []
topics: [routing, session, invocation, cross-thread, harness]
doc_kind: bug-report
created: 2026-03-10
updated: 2026-09-19
status: partially-resolved
severity: P2
supersedes: "2026-03-10 open hypothesis (upstream ba6c1606a, never merged to main)"
---

# Cross-Thread 误投与 Ghost Thread 路由 — 调查与裁决

> 2026-03-10 立案（苏策 + 布偶猫 + 缅因猫）→ 2026-09-19 重新调查并裁决（布偶猫/宪宪）
> Status: **服务端 continuation 绑错假设已证伪；真实缺陷落在工具契约与 provenance 呈现层**

---

## 0. 本文档的历史（为什么它一度不存在）

2026-03-10 的原始报告与 4 处 `[DIAG/ghost-thread]` 埋点由 upstream commit `ba6c1606a`
（`fix(routing): add ghost-thread diagnostic logs + bug report`）引入。核验：

```
git merge-base --is-ancestor ba6c1606a HEAD   → NO
git branch -a --contains ba6c1606a            → remotes/upstream/feat/f253-phase-c
git ls-tree -r HEAD --name-only | grep ghost  → (空)
```

该 commit **从未合入 main**。结果是一个分叉状态：

| 资产 | 是否在 HEAD |
|------|------------|
| `docs/bug-report/ghost-thread-cross-thread-session-routing/README.md` | ❌ 不存在（本文件恢复它） |
| DIAG 埋点 1：post-message cross-thread detected | ✅ `packages/api/src/routes/callbacks.ts:2075` |
| DIAG 埋点 2：pending-mentions polling | ✅ `packages/api/src/routes/callbacks.ts:3843` |
| DIAG 埋点 3：invokeSingleCat 创建 invocation 时的 thread 绑定 | ❌ 丢失 |
| DIAG 埋点 4：session_init 绑定 thread | ❌ 丢失 |

**两个能证伪原假设的埋点丢了，两个"每次跨线程投递都会打印"的噪音埋点留下了。**
与此同时 `cat-cafe-skills/cross-thread-sync/SKILL.md` 仍然向每只猫断言：

> **已知 Bug (P2, OPEN)**：cross-post 后 session continuation 可能绑错 thread（见 `docs/bug-report/ghost-thread-cross-thread-session-routing/`）

这条断言指向一个在 HEAD 里不存在的真相源，而且（见 §3）**与数据不符**。它的直接后果是：
猫在自己选错 target thread 之后，有一个现成的、看起来权威的"服务端已知 bug"可以归因，
从而不追自己的根因。这本身就是 harness 缺陷，不只是文档失修。

---

## 1. 报告人 / 发现路径

- **2026-03-10**：铲屎官在线程 A `@opus`，回复来自线程 2 的 opus 实例（带线程 2 上下文）。立案 P2 OPEN。
- **2026-09-19**：operator 在两条线程连续指出误投，并升级为"这个不是第一次了；出现了很多次了；
  你们要不单独开个thread去分析这个为啥老是出现；是设计不合理还是什么问题的"
  （`0001789823992813-001895-e2b97d0f`）。
- 本次调查由独立诊断 thread 承接，证据基于**运行实例 Redis 全量只读扫描**
  （116,206 个 message key / 106,797 条消息 / 2,076 个 session / 957 条带 crossPost provenance 的消息）。

---

## 2. Incident Corpus（operator 确认的 6 个事件，跨 11 条 thread）

扫描方法：全量消息正文匹配误投投诉语（`投递错|投错|误投|通知错了|跑这儿|错误投递|发错`），
取 `catId` 为空（= operator 本人）的命中，再与该 thread 前 45 分钟内**投递进来的** cross-post 关联。
共 47 条 operator 命中，其中明确的误投投诉 10 条，归并为 6 个独立事件。

| # | 时间 (UTC) | 源 thread | 实际落点 | 预期落点 | 触发消息 | operator 投诉 | 分型 |
|---|-----------|----------|---------|---------|---------|--------------|------|
| **I-1** | 2026-09-19 12:50:59 | `thread_mrkmxgdfqquounc9`<br>(MAIN K-1/F258) | `thread_msr51149hym0i79f`<br>(A2A Lifecycle 1398) | **不存在**（无可核验的 F167 owner thread） | `0001789822259945-001848-58dc2307`<br>by `cat-eqdvbcxw`, effectClass=`investigate`,<br>subjectRef=`subject:f167:c1-custody-recall-deviation`,<br>targetCats=`["opus"]` | `0001789823649818-001882-b9fd95e2`<br>（+23 分钟） | **A. 调用方 target 选错（无解析路径，靠猜）** |
| **I-1b** | 2026-09-19 12:52:51 | `thread_msr51149hym0i79f` | `thread_mrkn6povq4zzgh45`<br>(C1-Plugins) | 源 thread `thread_mrkmxgdfqquounc9` | opus 被误投消息唤醒后的**再投递** | 未单独投诉（混入 I-1） | **D. 误投后的二次污染** |
| **I-2a** | 2026-07-27 07:28:58 | `thread_ms2kxwwny5z5fcom`<br>(echo core design) | `thread_eval_a2a`<br>(A2A Harness Eval) | F167 owner thread（同样不存在） | `0001785137338540-000817-6c44b56e`<br>effectClass=`fyi`，**无 `targetCats`**<br>（路由来自 `routingFact` 的行首 `@codex`） | `0001785137394610-000824-a7217225`<br>「你投递错了的」（+56 秒） | **A** |
| **I-2b** | 2026-07-27 07:29:21 | `thread_eval_a2a` | `thread_ms2kxwwny5z5fcom` | **`thread_eval_a2a`**（就地回复；codex 其实**已经**在 07:28:59 就地回过 `0001785137339391-000822-b0b645cb`） | codex 被 I-2a 唤醒后的**同一个 turn 的第二次发射** `0001785137361768-000821-5cbfb470`<br>effectClass=`fyi`, targetCats=`["cat-eqdvbcxw"]` | `0001785137437651-000825-e40851aa`<br>「@sol 你刚投递错了吧」 | **D′. 冗余跨投**（不是选错 target，是**本不该再发**——codex 自陈「应只阅读知悉，不应另发跨线程消息」`0001785137394820-000826-491adc72`） |
| **I-3** | 2026-07-19 22:06:00 | `thread_mrrucuwlotamwuom`<br>(F257 V2/Phase B) | `thread_mq6alvzotw9ryo8r`<br>(develop_base_dev) | `thread_mrdip0u5aw4ysi97`<br>(F257 工作线) | `0001784498760629-000387-b9ecea13`<br>「[平行实例通报]」targetCats=`["opus"]` | `0001784498996539-000006-696c7213`<br>「你的平行的通知错了啊 平行的是 thread_mrdip0u5aw4ysi97 这个啊」 | **B. 同 catId 平行实例定位错误** |
| **I-4** | 2026-07-19 14:27 | 多个执行 thread | `thread_mrkmxgdfqquounc9`<br>(MAIN) | 各自执行 thread | 窗口内 6 条投入 MAIN 的 cross-post | `0001784471269998-000257-9809e71a`<br>「我们thread当前应该有且只和 thread_mrkn6povq4zzgh45 有关联的」 | **C. 汇报目的地过载（非误投，是噪声）** |
| **I-5** | 2026-04-30 09:38:02 | `thread_moicgl47en8m98do`<br>(develop) | `thread_mnb92h3yio4jbtw8` | **不该跨投**（应在源 thread 内直接发） | `0001777541882284-004585-5d668ca3`<br>by `opus`, mentions=`["codex"]`,<br>**无 targetCats / coordination / effectClass**<br>crossPost.sourceThreadId=`thread_moicgl47en8m98do` | `0001777541980958-004592-9e6c6222`<br>（+98 秒）「@opus 你跑错位置了；这不是一个跨线程的操作」 | **E. 工具选择错误（该同 thread 却用了跨 thread）** |

**独立 thread 数：11**——上表 10 条（`mrkmxgdfqquounc9` / `msr51149hym0i79f` /
`mrkn6povq4zzgh45` / `ms2kxwwny5z5fcom` / `eval_a2a` / `mrrucuwlotamwuom` /
`mq6alvzotw9ryo8r` / `mrdip0u5aw4ysi97` / `moicgl47en8m98do` / `mnb92h3yio4jbtw8`），
加 I-4 明细表里第 6 条的源 thread `mpf86bj4ejq306oo`。时间跨度 2026-04-30 → 2026-09-19。
**这不是单次操作失误。**

### 2.1 被唤醒的 invocation（exact wake binding）

每个事件误投后**实际被唤醒的是谁**——这是判定"服务端有没有绑错"的唯一硬证据。
invocation 记录在 `cat-cafe:invoc:<uuid>`（注意：该 hash **没有 `catId` 字段**，绑定的猫是 `targetCats`）。

| # | wokenInvocationId | 绑定 threadId | 绑定 catId | session capsule 验证 | 状态 / 备注 |
|---|------------------|--------------|-----------|---------------------|------------|
| **I-1** | `275b6f23-8a53-4dbe-be07-798c66c1a631` | `thread_msr51149hym0i79f` = **声明的 target** | `opus` | ✅ `session:e68eaa79-9a5a-4f3c-aa42-4dbef338a477` 的 `continuityCapsule.a2aTriggerMessageId` = 触发消息 id | `failed` / `a2a_dispatch_disposition_missing`（turn 本身执行成功） |
| **I-1b** | — **从未创建** | （宿主 turn `339d7da3-45a5-4df8-8f1b-72cf3bc0104d` 绑在 `thread_mrkn6povq4zzgh45`） | `cat-eqdvbcxw` | n/a | **消息被 append 进一个早 6 分 13 秒就已在飞的 turn**（该 turn 自己的 trigger 是另一条消息）。`queueCustody.status=queued`，carrier `1c7cb444-…` **从未派发**。<br>⚠️ 即 I-1b 的"二次污染"消息**落了库但没真正唤醒新 invocation** |
| **I-2a** | `822c7f0c-8e25-476c-8954-fe4ba0bc746e` | `thread_eval_a2a` = **声明的 target** | `codex` | ❌ **不可恢复**（见 §2.2-3） | `succeeded` |
| **I-2b** | `1aaad6b6-433d-40c0-b20c-4d4ad0ac0a57` | `thread_ms2kxwwny5z5fcom` = **声明的 target** | `cat-eqdvbcxw` | ❌ 不可恢复 | `canceled` |
| **I-3** | `fa22b940-2da9-4402-a17d-a9708d308052` | `thread_mq6alvzotw9ryo8r` = **声明的 target** | `opus` | ✅ `session:176c2f01-375c-47eb-805c-48d9028aa5ae` capsule 匹配 | `succeeded` |
| **I-4** | `fad4d70c-5ea8-4add-8857-ca3236595dc9`（由 operator 投诉本身唤醒） | `thread_mrkmxgdfqquounc9` | `cat-eqdvbcxw` | n/a（user-origin，`idempotencyKey` 是裸 UUID） | 各条 cross-post 的唤醒见下表 |
| **I-5** | `08b71901-b72a-4d91-857b-1704051a098b` | `thread_mnb92h3yio4jbtw8` = **声明的 target** | `codex` | ❌ 不可恢复 | `canceled`；opus 随后自陈「应该在当前 thread 直接发」(`0001777541981379-004598-f9c90f6e`) 并就地重发 (`0001777542015341-004594-a317cccc`) |

> **这张表是 §3.1 裁决的 incident 级佐证**：每一条可恢复的 wake 都绑在**调用方声明的那个 target**上，
> 没有一条绑到别处。聚合口径的 `0/663` 说的是同一件事，但**它不能替代样本级证据**——这是上一轮
> review 的 P1，已补齐。

**I-4 的完整调用参数**（投诉前 30 分钟内投进 `thread_mrkmxgdfqquounc9` 的全部 cross-post，
`ZRANGEBYSCORE cat-cafe:msg:thread:thread_mrkmxgdfqquounc9 1784469469998 1784471269998`，
并与全量 106,855 个 `msg:*` key 交叉核对，**共 6 条，完整**）：

| # | message id | UTC | 作者 | sourceThreadId | targetCats | effectClass | 投递 | 被唤醒 invocation |
|---|-----------|-----|------|---------------|-----------|------------|------|------------------|
| 1 | `0001784470210629-000133-d45b3114` | 14:10:10 | `opus` | `thread_mrrucuwlotamwuom` | `["cat-eqdvbcxw"]` | 无 | 已投递 | `263df753-8a56-4dd0-a203-cb337a174300` |
| 2 | `0001784470254929-000135-5975ba70` | 14:10:54 | `cat-8zfu14fb` | `thread_mrkn6povq4zzgh45` | `["cat-8zfu14fb"]` | `fyi` | 已投递 | `5d828ed6-3ace-43d6-8242-a31e8a4cfda8`（**自己 @ 自己**，`routingFact.attempts[0].outcome=unknown_token`） |
| 3 | `0001784470322242-000149-e191ecb3` | 14:12:02 | `opus` | `thread_mrrucuwlotamwuom` | `["cat-eqdvbcxw"]` | 无 | 已投递 | `33bf89c2-17d0-432d-9020-80123ee44a6c` |
| 4 | `0001784470387327-000163-e8428f0b` | 14:13:07 | `opus` | `thread_mrrucuwlotamwuom` | `["cat-eqdvbcxw"]` | 无 | 已投递 | `e1e8fed7-3420-46ed-8961-60f3c1b7e98d` |
| 5 | `0001784470629057-000197-56a6a17f` | 14:17:09 | `opus` | `thread_mrrucuwlotamwuom` | `["cat-eqdvbcxw"]` | 无 | **canceled** | ❌ **从未持久化**（见 §2.2-2） |
| 6 | `0001784470983053-000226-f8a50443` | 14:23:03 | `cat-8zfu14fb` | `thread_mpf86bj4ejq306oo` | `["cat-eqdvbcxw"]` | `coordinate` | 已投递 | `e80b10e3-ec1b-40cf-ad68-ce18c40d0f98`（`canceled`） |

6 条里 4 条来自同一个源 thread `thread_mrrucuwlotamwuom`、且全部由 `opus` 发出——
与 operator 那句"有且只和 `thread_mrkn6povq4zzgh45` 有关联"正好吻合：**I-4 不是一次投错，
是一条执行线把主线程当成了默认汇报口**。

### 2.2 不可恢复字段（逐项给出查询式与结果，不猜不填）

| # | 字段 | 执行的查询 | 结果与原因 |
|---|------|-----------|-----------|
| 1 | I-1b 专属 woken invocation | 对全部 23,201 条 `invoc` 记录子串搜 `0001789822371139-001854-0c381ae9` 与 carrier `1c7cb444-…` | **0 命中 → 从未创建**（消息被 append 进在飞 turn，不是被驱逐） |
| 2 | I-4 第 5 条的 woken invocation | 跨 `invoc`(23,201) / `turnexec:record`(7,790) / `auth:inv`(4,225) / `session`(2,079) 四个命名空间子串搜 | **四处均 0 命中**；该消息 `deliveryStatus=canceled` → **从未持久化** |
| 3 | I-2a / I-2b / I-5 的 session 级 wake binding | 对全部 2,079 个 session 搜 `continuityCapsule.a2aTriggerMessageId` | **0 命中**。I-2a 当时在 `thread_eval_a2a` 的 codex session (`6824b1b0-…`) capsule 里存的是 2026-07-12 的**陈旧** trigger；后继 session 根本没有该字段。<br>⚠️ **因此 I-2a 的 session 归属是时间推断，不是记录的绑定**——本表按"不可恢复"记，不按"已验证"记 |
| 4 | 4–7 月事件的 `sourceInvocationId` 解引用 | 对 `7096cf7f` / `a0a76fa0` / `666d55e2` / `0d3f4c71` 及 I-4 的 6 个 id 逐个 `EXISTS` 四命名空间 | 全部 0 命中。原因是**保留下限**：`turnexec:record:*` 最早 2026-08-07，`auth:inv:*` 最早 2026-08-27 |
| 5 | `extra.effect` | 审计全部 **960** 条 cross-post | **0 条携带**——该字段在本 schema 中**不存在**。最接近的是 `crossPost.effectClass`（`coordinate` 487 / 无 269 / `fyi` 136 / `investigate` 52 / `assign_work` 16）。<br>（初稿把它写成 `effect=` 是错的，已改正） |
| 6 | I-2a/I-2b/I-3/I-4 的 `coordination` / `subjectRef` | 读 `extra` | 字段缺席。全量 960 条里只有 148 条带 `extra.coordination`，最早在 2026-08 之后 → **当时没发射，不是被驱逐** |
| 7 | I-2a…I-5 的 `extra.causal` | 读 `extra` | 缺席；最早带 `extra.causal` 的 cross-post 是 2026-08-07。这些事件的 trigger 归属改由 `extra.stream.invocationId` → `invoc:<id>.userMessageId` 推出，**该链路是持久化且可核验的** |

### I-1 完整时间线（一次误投的真实成本）

```
12:50:59  MAIN ──xpost──▶ A2A#1398      误投：F167 行为证据
12:51:00  A2A#1398        opus 被唤醒，在错的 thread 里做了完整评估
12:51:00  A2A#1398        [系统] context_briefing 卡：「真相源: PR #1398」「下一步: 先看 PR #1398」
                          ← 服务端用【落点 thread 的既有状态】给一条外来消息贴了真相源标签
12:52:51  A2A#1398 ──xpost──▶ C1-Plugins  二次污染：把 F167 裁决又投给第三条无关 thread
13:14:09  A2A#1398        operator 发现（延迟 23 分钟）
13:15:43  MAIN            operator 再次指出
13:15:46  MAIN            sol 误判为「阶段汇报回灌主线程」——指向错误的 referent
13:17:09  ──xpost──▶ C1-Core + C1-Plugins   基于误判的两条「routing correction」
13:17:53  ──xpost──▶ C1-Core + C1-Plugins   两条撤回
13:19:52  MAIN            operator 升级：「这个不是第一次了」
```

**1 次误投 → 1 次错线程唤醒 → 1 次二次污染 → 4 条纠正/撤回 = 6 条污染消息、3 条无关 thread、
23 分钟才被发现、全程只有人类能发现。**

> **精确化（§2.1 查证后收紧的措辞）**：12:52:51 那条二次污染消息**落了库、在 thread 里可见**，
> 但它**没有唤醒一个新的 invocation**——它被 append 进了一个早在 6 分 13 秒前就已在飞、
> 且 trigger 是另一条消息的 turn（`339d7da3-…`），carrier `1c7cb444-…` 始终 `queued`、从未派发。
>
> 这条路径本身值得单独记一笔：**一条跨线程消息可以进入某个 turn 的上下文，而不为自己铸造
> invocation**。它不构成"绑错 thread"（thread 是对的），但它意味着**接收猫是在一个主题不同的
> turn 里读到这条消息的**——这和 R-4（briefing 用落点 thread 的 standing 认领外来消息）是同一类
> 二次失败的两个面。已记入 §5「不在本 PR 范围」跟踪项。

---

## 3. 根因分析

### 3.1 已证伪：服务端 continuation / 唤醒绑错 thread

原始假设 A/B（"continuation 后 invocation record 被错误创建为另一个 threadId" /
"CLI 进程拿到了别的 thread 的 callback 凭据"）在全量数据上**不成立**。

| 判据 | 方法 | 结果 |
|------|------|------|
| 回复是否落在触发消息所在 thread | 7,755 条 `extra.causal.triggerMessageId` 边，比对 reply.threadId vs trigger.threadId | 233 条不同 thread，**其中 233 条全部带显式 `extra.crossPost.sourceThreadId`（= 调用方主动声明的跨投）。未声明的跨线程 continuation：0** |
| 被唤醒 session 是否绑到触发消息的 thread | 2,076 个 session，663 个带 `continuityCapsule.a2aTriggerMessageId` | **绑定错配：0**；`continuityCapsule.threadId` 与 `session.threadId` 漂移：**0** |
| 是否存在跨 thread 共享的 CLI session（上下文串台） | 2,066 个 distinct `cliSessionId` | **1 例**（`80b2ef21-…`，`cat-b5ddoo9l`，2026-06-16 / 2026-06-30 两条 thread）。孤例，且与本 corpus 中任何一次误投无时间/主体交集 |
| 同 (cat, thread) 是否存在多个 active session 造成唤醒歧义 | 全量 session status 扫描 | 5 组 `status=active` 残留，但 `cat-cafe:session-active:{cat}:{thread}` 指针在 5 组里**全部唯一且指向最新 session** → 是 status 字段清理不干净，不是路由歧义 |

**裁决：Ghost Thread 的"服务端绑错 thread"形态，在 2026-04-24（crossPost provenance 上线）
至 2026-09-19 的全量语料里没有一例。** 2026-03-10 的原始观察可能是更早版本的真实 bug、
也可能当时就是同一类调用方选错（当时没有 provenance 可查，无法回溯裁定）。
现有代码里有三道后加的 fail-closed 闸（`TURN_EXECUTION_SCOPE_MISMATCH` 的
threadId/userId/catId/parentInvocationId 四元组校验、`resolveScopedThreadId` 的 principal scope 校验、
F193 AC-A4 的 routing-credential 前置校验）覆盖了原假设的攻击面。

> ⚠️ 残留风险（不否定上述裁决）：`cliSessionId` 跨 thread 共享的孤例应单独跟踪，
> 它是唯一一条"上下文可能串台且不会在 threadId 上留痕"的路径。

### 3.2 确认的真实缺陷

#### R-1 · 工具契约缺口：`cross_post_message` 要求一个调用方无法核验的坐标（**Severity: P1**）

`cross_post_message(threadId, ...)` 只接受**精确 threadId**。服务端唯一的校验是
`resolveScopedThreadId()`：thread 存在 + 属于同一 principal scope。**没有任何 source→target
的语义/standing 校验。**

但 corpus 里每一次误投，猫要找的都不是一个 id，而是一个**角色**：

- I-1 / I-2a：「F167 行为证据的 owner thread」——**这个 thread 根本不存在**，sol 事后自陈
  「当前没有可验证的 F167 owner thread」
- I-3：「我的平行实例在哪条 thread」——没有任何 primitive 能解析
- I-4：「跟本 thread 有关联的 thread」——operator 亲口给出了正确不变量
  （"有且只和 thread_mrkn6povq4zzgh45 有关联"），但系统里没有地方存它

工具要求猫提供一个它结构上无法核验的坐标，又不提供"我不知道 id"的表达方式，也不提供解析原语。
**猫唯一能做的就是从上下文里猜一个最近见过的 threadId。** 这不是注意力问题，是契约问题。

`cross-thread-sync` skill 已经写了正确 fallback（"查不到 verified owner thread → `propose_thread`，
宁可提案待批，也不猜一个近似 thread"）。规则存在、被反复违反——与 F167 Case E1 的既有结论一致：
**「写进规则 ≠ 模型执行」**。

#### R-2 · **内容侧**启发式无法机械区分误投与合法跨 feature 协作（**证据，不是缺陷**）

在提"加个 guard"之前先量化了两个最自然的 fence，**两个都不可用**：

| 候选 fence | **历史真实流量**的基线（无标注，不代表这些投递都是对的） | 本 corpus 误投是否会被拦 |
|-----------|--------------|----------------------|
| 「发送方在目标 thread 没有历史发言」（cold-open） | 957 条 cross-post 中 **92.7% 是 warm**（发送方此前发过言），7.3% cold-open | I-1 是 **WARM**（sol 当时正在 A2A#1398 干活）；I-3 也是 **WARM**。**拦不住** |
| 「coordination.subjectRef 在目标 thread 未出现过」 | 带 subjectRef 的 134 条里 **51.5% 是 novel subject**（Core↔Plugins 这类协作**会**长成这样，但语料没标注，不能反推这 51.5% 都是对的） | I-1 会被拦，但**拒绝比例** ~50%。**不可用** |

**结论（严格限定在本节量化的范围内）：不要做内容启发式 guard。**
它既拦不住本 corpus 的真误投（两条判据对 I-1/I-3 都失效），又会拒掉一半"开新 subject"的历史真实跨投。

> ⚠️ **口径声明（贯穿 R-2 / R-2b 全部百分比）**：线上语料**没有 per-delivery 标注**——
> 没有一条历史 cross-post 记着"这次投对了/投错了"。所以本节与下节的每个百分比都是
> **拒绝比例**（rejection share：这道 fence 会拒掉多少真实流量），**不是误杀率 / precision**
> （被拒的里面有多少本来是对的）。算 precision 需要这个库里不存在的标注。
> 初稿在多处把拒绝比例写成"误杀率"，是**无标注推断**，本轮已全部改正。

> ⚠️ **这条结论只否掉"内容启发式"这一类判据，不构成"没有任何可用判据"。**
> 初稿在这里做了过度外推。可核验的 **standing / 结构性**判据是另一类东西——它不推断消息
> "讲的是什么"，只查服务端已经记录的关系事实。下面 R-2b 补上这类判据的量化与裁决，
> R-2c 补上 `routing_preflight` 这条被点名的路径。

#### R-2b · 结构性 standing fence：判据既没被记录，也**没有标注能证明拒绝是对的**（**Severity: P2，产品级**）

`RedisThreadStore` **已经**持久化 `parentThreadId`，并维护 `ThreadKeys.children(parent)` 索引
（`RedisThreadStore.ts:207-242 / 773-775`）。也就是说"source thread 与 target thread 是否同族"
是一个**服务端此刻就能判定的事实**，不需要任何内容推断。对全量 960 条 cross-post 实测
（下表为**第三轮**实跑，2026-09-19；R-2 的口径声明同样适用——全是**拒绝比例**，不是误杀率）：

| 口径 | 数值 | 含义 |
|------|------|------|
| 有 detail 记录的 thread | 531 | — |
| 其中**声明了 `parentThreadId`** | **29（5.5%）** | **父链接填充率**（图稀疏度），≠ standing 覆盖率 |
| 两端都可解析的 cross-post | 960/960 | 判据本身可计算 |
| source/target 同族 | 244（25.4%） | — |
| **不同族** | **716（74.6%）** | 一刀切 fail-closed 的**拒绝比例** |
| scope A（窄）：source 自己声明了 `parentThreadId` | **139（14.5%）** | 适用面 |
| … 其中跨出家族的 | **26（18.7%）** | **拒绝比例**（precision 未知） |
| scope B（宽）：source 声明了父 **或自己就是别人的父**（children 索引） | **671（69.9%）** | 适用面 |
| … 其中跨出家族的 | **427（63.6%）** | **拒绝比例**（precision 未知） |

**scope B 是本轮新增，它推翻了初稿对这条路线的乐观定调。** 初稿只统计了 scope A
（"source 自己有 parent"），那是血缘记录两种形态里更窄的一种——一条 thread 作为**父**
被别人指向（`children` 索引），同样是服务端已记录的血缘，同样可判定。两种形态都算上，
适用面 14.5% → 69.9%，拒绝比例 18.7% → **63.6%**。
**"有界的 18.7%"是选了最窄 scope 才得到的假象，不是这条判据的性质。**

还有一条比数字更根本的语义限制：**`parentThreadId` 是开放世界。** 它证明"存在一条血缘关系"，
它的缺席**不证明**"这次投递没有 standing"。族外投递 ≠ 无依据投递——Core↔Plugins 这类正常的
跨 feature 协作本来就不该有血缘边。**血缘不是合法 target 的 allowlist，"不同族就拒"这个推断
本身不成立。**

两条裁决，必须分开：

1. **一刀切 fail-closed 结构 fence：否决。** 拒绝比例 74.6%，比 subject fence（50.7%）更差。
2. **scoped fence：不作为拒绝策略，只作为 advisory / grounding 信号。** 两个 scope 的拒绝比例
   （18.7% / 63.6%）差 3.4 倍且 precision 两者都未知——这个证据强度支撑"把已知血缘呈现给猫"，
   不支撑"据此 400"。

**I-3 是决定性样本**（实测，非推演，也是本调查里**唯一一个已确认的真阳性**）：

```
源 thread thread_mrrucuwlotamwuom  parentThreadId = thread_mrdip0u5aw4ysi97
实际投递  thread_mq6alvzotw9ryo8r   → FAMILY_LINKED = false   （判据判定为族外）
operator 说的正确目标 thread_mrdip0u5aw4ysi97 → FAMILY_LINKED = true
```

operator 当时的原话是「平行的是 thread_mrdip0u5aw4ysi97 这个啊」。
**那条 thread 就是源 thread 自己的 `parentThreadId`——出错的那一刻，正确答案已经躺在服务端的
thread store 里，而猫在猜。** 所以这条判据的价值**不在"能拒绝"**（拒绝需要 precision，我们没有），
而在它**能直接把正确 target 说出来**——这是内容启发式永远做不到的，也正是"advisory 而非 fence"
这个定位的依据。

**而且它救不了大多数事件**：I-1 / I-1b / I-2a / I-2b / I-4 的源 thread 全部 `parentThreadId = null`
（11 条涉事 thread 逐条实测，只有 I-3 那条有血缘），这条判据对它们完全不适用。
**最表层的阻塞是父链接填充率只有 5.5%**——`propose_thread` 本该建立的 standing graph 极其稀疏；
另外两层阻塞（无标注、开放世界）见下方裁决，三层都得解掉才谈得上"拒绝"。

> **裁决（本轮收紧）：结构性 standing 判据可以做 advisory / grounding，不足以支撑 fail-closed 拒绝。**
> 三层理由，缺一条都不行：
>
> 1. **图稀疏**：只有 5.5% 的 thread 声明了 `parentThreadId`。注意这是**父链接填充率**，
>    **不是 standing 覆盖率**——scope B 已经证明 69.9% 的历史跨投流量，其 source 至少带一条 lineage。
>    "有多少投递真的有 standing"仍然是**未知量**，这个库里没有能回答它的字段；
> 2. **口径**：拒绝比例窄 scope 18.7%、宽 scope 63.6%，**precision 两者都未知**——
>    语料无标注，26 条里已知**至少一条是真阳性**（I-3），其余既不能算对也不能算错；
> 3. **世界观**：血缘是开放世界，族外 ≠ 无 standing。
>
> **现在就能做、且不依赖上面任何一条的是 advisory**：源 thread 有血缘记录时直接呈现给猫
> （I-3 里正确答案就躺在源 thread 自己的 `parentThreadId` 里）。
> 要谈**拒绝**，前提是先有标注样本，或一份**显式、排他**的关联契约（"本 thread 只与 X 关联"
> ——I-4 里 operator 亲口说过这种话，但系统没地方存）。
> 这是 product-level routing policy 决策，不是本 PR 能单方面加的 guard —— 已进 `decision-packet.md`。

#### R-2c · `routing_preflight.resolverState=degraded` 为什么仍然放行（**必答项 · 裁决：不是缺陷，是范畴错置**）

先说一个影响本节可信度的事实：**`routing_preflight` 不在本 PR 的 base 上。**
本分支基于本地 `main`（`bb9f9f08e`），该服务只存在于 `upstream/main`（`9ab0eaf28`，领先 11 个
commit）与 `develop_base`。初稿因此完全没有分析它——这是 base 落后造成的盲区，不是判断分歧。
下面的结论读的是 `upstream/main` 的真实代码。

**(1) 它管的是"哪只猫"，不是"哪条 thread"。**

```ts
// upstream/main:packages/api/src/domains/routing-context/RoutingDispatchPreflightPort.ts:5-12
export interface RoutingDispatchPreflightInput {
  ownerId: string;
  targetCatIds: readonly string[];
  intent?: 'review' | 'architecture';
  ownerRequestedAttempt?: boolean;
}
```

入参里**没有 threadId**；`RoutingPreflightService.ts` 全文 **0 处**引用 `threadId`
（`git grep -n threadId` 空结果）。它消费的是 capability / health / quota catalog，产出的是每个
**targetCatId** 的 `allowed | warned | rejected`。

→ 因此它在 `fresh` 状态下也**一条都拦不住**本 corpus 的 6 个事件：没有一次的错误出在**目标猫**上
（I-1 的 `targetCats=["opus"]` 完全正确；I-2a / I-5 甚至没传 `targetCats`、路由来自行首 `@`，
而 §2.1 的 wake 表显示被唤醒的确实就是意图中的 `codex`），错的是 **thread**。
**把它当成误投闸是范畴错置——它从来不是，也不应该被改造成 thread 闸。**

**(2) `degraded` 放行不是疏漏，是被 schema 强制的 fail-open 不变量。**

```ts
// upstream/main:packages/shared/src/types/routing-context-projections.ts:168-178
if (decision.resolverState === 'degraded') {
  decision.targets.forEach((target, index) => {
    if (target.disposition === 'rejected') {
      ctx.addIssue({ ..., message: 'a degraded advisory resolver cannot reject a target' });
    }
  });
}
```

`degraded` 有**两条**产生路径、**7 个 `failureClass` family**、展开后 **10 个具体字符串**
（`resolver_degraded` 这个 family 自己带 4 个 `reason`）。逐条读 `upstream/main` 源码得到，
不是回忆；初稿先写"唯一来源是 catalog 取不到"、再写"8 类"，两次都错，这是第三次数，按 family /
具体值两个口径分开记，免得再数错：

| 产生路径 | `failureClass` | 代码位置（`upstream/main`） |
|---------|---------------|--------------------------|
| `unavailableRoutingDispatchDecision` | `catalog_error`（catalog 加载或 preflight 抛错） | `RoutingDispatchPreflightPort.ts:97` |
| 同上 | `consumer_error`（port 本身抛错） | `RoutingDispatchPreflightPort.ts:109` |
| `RoutingPreflightService.degradedDecision` | `circuit_open` / `half_open_busy`（熔断器挡住本次 attempt） | `RoutingPreflightService.ts:135` |
| 同上 | `resolver_timeout`（超 `readBudgetMs`，默认 120ms）/ `resolver_error` | `RoutingPreflightService.ts:144` |
| 同上 | `resolver_degraded:<reason>`，`reason` ∈ `dossier_unavailable` / `dossier_unreadable_or_empty` / `built_in_profile_missing` / `model_missing` | `RoutingPreflightService.ts:151` + `CapabilityProfileRevisionSource.ts:3-7` |

**共同点只有一条，而且只需要这一条**：**没有任何一个 `failureClass` 携带 thread 维度的判断信息**
——它们连 threadId 都没有（见上文 (1)），所以没有一个能对"这条投递该不该进这个 thread"表态。

（**不要把共同点写成"全都表示 resolver 证据缺失"**——这不成立。`catalog_error` / `circuit_open` /
`resolver_timeout` / `resolver_degraded:*` 确实是证据取不到或过期，但 `consumer_error` 是
**调用方那一侧**抛了异常，跟 resolver 手里有没有证据无关。共同裁决只能立在"都不含 thread 信息"上。）

在这个前提下 reject 等于"Redis 抖一下、dossier 迟 120ms、或者上游调用栈自己抛个错，
就静默掐断全家猫的互相派发"。fail-open + 显式 `warned` 回执是正确取舍，
而且这条不变量是写进 zod schema 强制的，不是约定俗成。

> **裁决：R-2c 不是缺陷，无需修复。** 必答问题隐含的前提（"preflight 本该拦住误投"）不成立。
> 但它留下一个**有用的先例**：系统里已经有一套成熟的 typed advisory receipt
> （`resolverState` + `disposition` + `reasons[].sourceRefs`），**这正是 R-1 `targetGrounding`
> 应该复用的形状**——不是发明新机制，而是把同一套回执语义搬到 thread 维度。

#### R-3 · 接收侧 provenance 在 prompt 里被截断成常量（**Severity: P1，已在本 PR 修复**）

`packages/api/src/domains/cats/services/context/ContextAssembler.ts:136-139`：

```ts
const sourceThreadId = msg.extra?.crossPost?.sourceThreadId;
const crossPostTag = isCrossThreadProvenance(sourceThreadId, msg.threadId)
  ? ` ← from thread:${sourceThreadId.slice(0, 8)}`
  : '';
```

真实 threadId 一律是 `thread_<id>`，前缀 `thread_` 占 7 个字符。`slice(0, 8)` 的产物：

```
thread_msr51149hym0i79f → "thread_m"
thread_mrkmxgdfqquounc9 → "thread_m"
thread_mu8dg6h7l2x4ohsk → "thread_m"
thread_mrkn6povq4zzgh45 → "thread_m"
thread_mq6alvzotw9ryo8r → "thread_m"
thread_mrdip0u5aw4ysi97 → "thread_m"
thread_eval_a2a         → "thread_e"
7 条真实 thread → 2 个不同 tag
```

**猫在上下文历史里读到的每一条 cross-post，来源标签都是同一个常量 `← from thread:thread_m`。**
它既不能区分两个来源 thread，也无法据此判断"这条消息其实不属于本 thread"。

前端同一份数据**做对了**——`packages/web/src/lib/parse-direction.ts:40` 先剥 `thread_` 前缀再截断，
人类在气泡上能看到 `msr51149`。**同一个事实，人类看得见，猫看不见。**

既有测试 `packages/api/test/context-assembler.test.js:415` 用的 fixture 是
`'source-thread-abc123'`——一个不以 `thread_` 开头的合成 id，恰好让 `slice(0,8)` 看起来有信息量。
**测试用例的 fixture 形状不真实，因此这个 100% 信息丢失从未被发现。**

因果链：接收猫读不到来源 thread → 只能从**正文内容**重新推断该往哪投 → I-1b 里 opus
正是因此把 F167 裁决投给了正文里提到的 C1-Plugins，而不是真正的源 thread。

#### R-4 · 误投消息会被落点 thread 的 standing 状态"认领"（**Severity: P2**）

I-1 中被唤醒的 opus 收到的 `context_briefing` 卡（`0001789822260330-001851-6c0e54ec`，
`systemKind=context_briefing`）写着：

- 传球：缅因猫(sol) → 你（引用的原文是 **2026-09-10** 的一条 F117/#1398 消息，距事发 9 天）
- **真相源：PR #1398 — zts212653/clowder-ai#1398**
- 下一步：先看 PR #1398

而触发消息讲的是 F167 行为证据 / F202 插件。briefing 由**落点 thread 的既有状态**生成，
不校验触发消息的 provenance，于是服务端主动给一条外来消息盖上了本 thread 的真相源印章，
**放大**了错误归因。这不造成误投，但显著加重二次失败。

#### R-5 · 没有"这条投递错了"的机器可读信号（**Severity: P1，产品级**）

I-1 里 operator 说「@sol 你们刚投递错线程了的」时，MAIN thread 在前 20 分钟内收到了 **6 条**
cross-post。"刚"有至少 7 个可能的 referent。sol 选错了一个，于是产生 2 条错误纠正 + 2 条撤回。

当前系统：
- operator 无法指着某条消息说"这条投递错了"
- 猫无法撤回一条已投递的 cross-post（只能再发一条自然语言"撤回"消息，本身又是一次投递）
- 没有任何自动检测——**6 次事件全部由人类发现**，且 I-1 延迟 23 分钟

`self` 层面看，这是 §4 里最值得做的产品能力，但它改变 message 生命周期语义，属于 operator 决策范围。

#### R-6 · 诊断埋点现状是纯噪音（**Severity: P2，已在本 PR 处理**）

`[DIAG/ghost-thread] post-message: cross-thread detected` 在**每一次**跨线程投递时打印，
`pending-mentions: polling` 在**每一次**轮询时打印。两者都不携带判别力，
而真正能判别的两个埋点（invocation 创建、session_init 绑定）没有合入 main。
"有埋点"给了一种虚假的在监控感。

---

## 4. 根因图与裁决

```
                 ┌──────────────────────────────────────────────┐
                 │ 触发条件：猫需要投递给一个【按角色定义】的对象 │
                 │ （"F167 的 owner thread" / "我的平行实例"）    │
                 └───────────────────┬──────────────────────────┘
                                     │
                       R-1 工具只接受精确 threadId，
                       无解析原语，无"我不知道"出口          [P1 · 工具契约缺口]
                                     │
                                     ▼
                              猫从上下文猜一个 threadId
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
   服务端校验：thread 存在？   R-2 内容侧无可用 fence      唤醒落点 thread 的 session
   + 同 principal scope？      （已量化证伪两个候选）             │
          │  ✅ 通过 → 投递                                       ▼
          │                                            R-4 briefing 用落点 thread
          │                                            的 standing 认领外来消息  [P2]
          ▼                                                      │
   ❌ 服务端 continuation 绑错                                    ▼
   （0/7755 边、0/663 session —— 已证伪）           R-3 prompt 里来源 thread 被截成常量 [P1]
                                                                 │
                                                                 ▼
                                                    接收猫只能从正文重推 target
                                                                 │
                                                                 ▼
                                                        二次污染（I-1b / I-2b）
                                                                 │
                                                                 ▼
                                    R-5 没有机器可读的"投递错了"信号 → 只能靠人发现，
                                    且 operator 的投诉本身无法定位到具体消息        [P1 · 产品级]
```

| 编号 | 裁决 | Severity | 归属 |
|------|------|----------|------|
| R-1 | **设计不合理**（工具契约缺口） | P1 | 需 operator 决策（契约变更） |
| R-2 | 不是缺陷，是**排除性证据**（只否掉**内容启发式** guard 这一类） | — | — |
| R-2b | **能力缺口**：结构性 standing 只够做 advisory；拒绝策略卡在图稀疏（父链接填充率 5.5%）、无标注（precision 未知）、血缘开放世界三层 | P2 | Decision Packet → operator |
| R-2c | **不是缺陷**（范畴错置：`routing_preflight` 是猫可用性顾问，非 thread 闸） | — | 无需修复 |
| R-3 | **实现 bug** | P1 | 本 PR 修复 |
| R-4 | **实现 bug**（briefing 不校验触发消息 provenance） | P2 | 本 PR 只记录，不改（涉及 briefing 组装面，需独立 slice） |
| R-5 | **能力缺口**（产品级 routing policy） | P1 | Decision Packet → operator |
| R-6 | **harness 缺陷**（诊断资产半合入 + skill 引用悬空 + 错误断言） | P2 | 本 PR 修复 |

**总裁决：多因叠加，但主因是工具契约缺口（R-1），不是模型失误，也不是服务端路由 bug。**
之所以长期被当成"猫不小心"，是因为 (a) skill 里那条未经证实的"服务端已知 bug"提供了现成的错误归因出口，
(b) R-3 让接收猫看不见 provenance，(c) R-5 让每一次都只能靠人发现。

---

## 5. 修复方案（本 PR 范围）

| # | 改动 | 理由 | 可逆性 |
|---|------|------|--------|
| 1 | `shortThreadRef()` 提取到 `@cat-cafe/shared`，`ContextAssembler`、web `parse-direction` **与 `ChatMessage.tsx` 来源卡**三处共用 | R-3。前端已有正确实现，提取即单一真相源（P4）。`ChatMessage.tsx` 是**用户实际可见**的来源卡，漏掉它等于留着第二套实现 | ≤1 commit 回滚 |
| 1b | `cross-post-short-ref-single-source.test.ts`：断言全仓**只有** `shortThreadRef` 一处实现该规则 | 本缺陷的本质是"两套实现会漂移"，不是"当前值算错了"——断言渲染值的测试改前改后都绿，**拿不到 RED**；只有断言"重复不存在"才真正锁住 | — |
| 2 | `context-assembler.test.js` 增加**真实形状 threadId** 的回归（两个不同来源必须产出不同 tag；必须等于前端短 ref） | 旧 fixture 形状不真实是这个 bug 活 6 个月的直接原因 | — |
| 3 | 恢复本 bug-report 到 skill 已引用的路径，写入**裁决而非假设** | R-6。skill 的规范性约束不能挂在悬空路径上 | 文档 |
| 4 | 修正 `cross-thread-sync/SKILL.md` 的"P2 OPEN 服务端 bug"断言为已证伪 + 保留真实的调用方风险提示 | R-6。错误断言在给猫提供错误归因出口 | 文档 |

**不在本 PR 范围**（明确列出，不留尾巴）：

- R-1 的解析原语与 `targetGrounding` 契约 → 契约变更，走 Decision Packet
- R-5 的误投标记/撤回能力 → 改 message 生命周期语义，走 Decision Packet
- R-4 的 briefing provenance 校验 → 独立 slice，需 briefing 组装面的 owner
- R-2b 的血缘覆盖率（29/531）→ product-level routing policy，走 Decision Packet 取舍 2
- **跨线程消息被 append 进在飞 turn 而不铸造自己的 invocation**（I-1b 实证）→ 单独跟踪，
  与 R-4 同属"外来消息被落点上下文认领"这一类
- `cliSessionId` 跨 thread 孤例 → 单独跟踪
- 不改 F202 C1 / A2A #1398 / 任何生产数据

---

## 6. 验证方式

1. **R-3 回归**：`node --test packages/api/test/context-assembler.test.js`
   - RED（修复前）：两个真实形状 threadId 产出同一个 tag `thread_m`
   - GREEN（修复后）：产出 `mrkmxgdf` / `mu8dg6h7`，且等于前端 `parse-direction` 的短 ref
2. **证伪结论可复现**：`forensics/scan-cross-thread-routing.mjs`（**只读**，仅 SCAN/HMGET/GET，
   不写不删不设过期；`--redis` / `--prefix` 可指向任意实例）。2026-09-19 对运行实例实跑输出
   （**第三轮**，含本轮新增的 scope B）：

   ```
   corpus: 106810 messages, 2081 sessions, 960 cross-posts

   — §3.1 falsification —
     causal reply edges                         : 7787
     replies landing outside the trigger thread : 236
     ... of which UNDECLARED (ghost signature)  : 0   <- expect 0
     sessions with an A2A trigger               : 666
     ... wake bound to the wrong thread         : 0  <- expect 0
     continuityCapsule / session thread drift   : 0  <- expect 0
     cliSessionId shared across threads         : 1
     duplicate active sessions per (cat,thread) : 5

   — §3.2 R-2: the two candidate fences —
     sender had prior participation in target   : 890/960 (92.7% 不会被 cold-open fence 拦到)
     cross-posts carrying a subjectRef          : 136/960
     ... subject already present in target      : 67 (50.7% rejection share of a subject fence)

   — §3.2 R-2b: the structural standing fence —
     threads with a detail record               : 531
     ... of which declare a parentThreadId      : 29
     cross-posts with both endpoints resolvable : 960/960
     ... source/target in the same thread family: 244 (25.4%)
     ... NOT family-linked                      : 716 (74.6% rejection share, 一刀切)
     SCOPED/narrow: source declares a parentThreadId : 139/960 (14.5%)
     ... of those, leaving the family           : 26 (18.7% = rejection share)
     SCOPED/broad: source declares a parent OR is one : 671/960 (69.9%)
     ... of those, leaving the family           : 427 (63.6% = rejection share)

     NOTE: the corpus carries no per-delivery verdict. Every "rejection share" above is the
           fraction of REAL past traffic a fence would refuse — NOT a measured false-positive
           rate. Precision is unknown; incident I-3 is the one confirmed true positive.
   ```

   （§3.1 正文写的是首轮扫描的 7,755 / 663 / 957；上面是第三轮实跑。差值来自实例在调查期间
   持续产生新消息，三轮的所有"expect 0"判据均为 0，不影响任何裁决。
   **脚本本身在本轮改了两处**：① 所有 fence 指标从 `false-positive rate` 改称 `rejection share`
   并在输出里声明"语料无标注"；② 新增 scope B（source 声明父 **或** 自己是父）——
   这条改动直接推翻了初稿"18.7% 有界"的乐观读数，见 R-2b。）

   **R-2b 的 I-3 决定性样本可单独复验**（只读，两条 `HGET`）：

   ```
   HGET cat-cafe:thread:thread_mrrucuwlotamwuom parentThreadId
     → thread_mrdip0u5aw4ysi97      # 源 thread 自己声明的血缘
   HGET cat-cafe:thread:thread_mq6alvzotw9ryo8r parentThreadId
     → (nil)                        # 实际误投落点，与源无任何族关系
   ```

   即 operator 当时口头给出的正确目标 = 源 thread 的 `parentThreadId`。
3. **Corpus 可复现**：误投投诉的检索式与关联窗口（45 分钟）见 §2 首段。
4. **回归护栏**：`packages/api/test/cross-thread-misdelivery-attribution.test.js` 把"服务端忠实于
   调用方声明的 target"这条不变量钉成可执行断言——将来若真出现服务端改路由/错绑唤醒，
   它会直接变红，不必再做一次全量扫描才能重新立案。覆盖三跳：

   | 跳 | 断言 | 若服务端在这一跳错绑会怎样 |
   |----|------|--------------------------|
   | 投递 | 消息落在调用方声明的 target，不回灌源、不漏到第三方 | 红 |
   | 唤醒 | `invocationRecord.threadId` == 声明的 target | 红 |
   | **continuation** | 被唤醒 invocation 发**默认回复**（不带 `threadId`）仍留在自己绑定的 thread | 红 |

   continuation 这一跳的被唤醒 invocation 是**从实际 wake record 派生**（`wake.threadId`）而不是
   硬编码常量——因此 wake 绑定漂移无法在这一跳被掩盖。
   **该测试做过突变验证**：把被唤醒 invocation 改绑到源 thread 后，用例如期变红并停在
   "a default continuation must stay in the thread the wake bound to"，证明它**能红**，
   不是一条恒绿断言。

5. **CHARACTERIZATION 的边界**：`CHARACTERIZATION: a semantically unrelated target is accepted`
   只钉"投递被接受 + 消息确实落库"。它**不**断言响应里没有 grounding/receipt 字段——
   否则将来只要加一条非阻断回执就会被误判成政策已变。未来的 fence 形状写在同文件的
   `test.skip('FUTURE(R-1): ...')` 里，让契约留在套件里而不是只留在散文里。

6. **Fallback 层数自检**（`scripts/check-fallback-layers.mjs` 触发 ≥3 层提示）：
   命中的是 `forensics/scan-cross-thread-routing.mjs`（10 层）。逐层必要性：

   | 层 | 为什么不能去掉 |
   |----|--------------|
   | `argOf('--redis', env ?? default)` | 脚本刻意不绑定部署；审计任意实例的前提 |
   | `if (err \|\| !values?.[0]) return` | pipeline 逐条结果独立失败；一条坏 key 不能中断全量扫描 |
   | `JSON.parse` try/catch ×2 | 线上 `extra` / `continuityCapsule` 存在历史上不可解析的记录 |
   | `values[1] \|\| 'USER'` | `catId` 为空即 operator 本人，是**语义**不是缺省 |
   | `if (!parent \|\| parent.threadId === m.threadId) continue` | 触发消息可能已被驱逐；不可把"查不到父"算成跨线程边 |
   | `?? null` / `?? []` 若干 | 字段按 §2.2 逐项确认为**当时未发射**，不是被驱逐 |

   **坐标系自检结论**：这些不是给错误坐标系打补丁。对象是一个**仍在写入、且 schema 随时间漂移**
   的只读线上语料；换成严格 schema 解析会在第一条 legacy 记录上中止，直接拿不到 corpus。
   防御层全部集中在**读取边界**，判据计算本身没有 fallback——这正是想要的分层。

---

## 7. 给 operator 的决策包（R-1 / R-5）

见 `decision-packet.md`（同目录）。
