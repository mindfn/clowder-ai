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

## 2. Incident Corpus（operator 确认的误投，跨 6 个 thread）

扫描方法：全量消息正文匹配误投投诉语（`投递错|投错|误投|通知错了|跑这儿|错误投递|发错`），
取 `catId` 为空（= operator 本人）的命中，再与该 thread 前 45 分钟内**投递进来的** cross-post 关联。
共 47 条 operator 命中，其中明确的误投投诉 10 条，归并为 6 个独立事件。

| # | 时间 (UTC) | 源 thread | 实际落点 | 预期落点 | 触发消息 | operator 投诉 | 分型 |
|---|-----------|----------|---------|---------|---------|--------------|------|
| **I-1** | 2026-09-19 12:50:59 | `thread_mrkmxgdfqquounc9`<br>(MAIN K-1/F258) | `thread_msr51149hym0i79f`<br>(A2A Lifecycle 1398) | **不存在**（无可核验的 F167 owner thread） | `0001789822259945-001848-58dc2307`<br>by `cat-eqdvbcxw`, effect=`investigate`,<br>subject=`subject:f167:c1-custody-recall-deviation`,<br>targetCats=`["opus"]` | `0001789823649818-001882-b9fd95e2`<br>（+23 分钟） | **A. 调用方 target 选错（无解析路径，靠猜）** |
| **I-1b** | 2026-09-19 12:52:51 | `thread_msr51149hym0i79f` | `thread_mrkn6povq4zzgh45`<br>(C1-Plugins) | 源 thread `thread_mrkmxgdfqquounc9` | opus 被误投消息唤醒后的**再投递** | 未单独投诉（混入 I-1） | **D. 误投后的二次污染** |
| **I-2a** | 2026-07-27 07:28:58 | `thread_ms2kxwwny5z5fcom`<br>(echo core design) | `thread_eval_a2a`<br>(A2A Harness Eval) | F167 owner thread（同样不存在） | `0001785137338540-000817-6c44b56e`<br>effect=`fyi`, targetCats=`null`（仅行首 `@codex`） | `0001785137394610-000824-a7217225`<br>「你投递错了的」（+56 秒） | **A** |
| **I-2b** | 2026-07-27 07:29:21 | `thread_eval_a2a` | `thread_ms2kxwwny5z5fcom` | — | codex 被 I-2a 唤醒后立刻回投 `0001785137361768-000821-5cbfb470` | `0001785137437651-000825-e40851aa`<br>「@sol 你刚投递错了吧」 | **D** |
| **I-3** | 2026-07-19 22:06:00 | `thread_mrrucuwlotamwuom`<br>(F257 V2/Phase B) | `thread_mq6alvzotw9ryo8r`<br>(develop_base_dev) | `thread_mrdip0u5aw4ysi97`<br>(F257 工作线) | `0001784498760629-000387-b9ecea13`<br>「[平行实例通报]」targetCats=`["opus"]` | `0001784498996539-000006-696c7213`<br>「你的平行的通知错了啊 平行的是 thread_mrdip0u5aw4ysi97 这个啊」 | **B. 同 catId 平行实例定位错误** |
| **I-4** | 2026-07-19 14:27 | 多个执行 thread | `thread_mrkmxgdfqquounc9`<br>(MAIN) | 各自执行 thread | 窗口内 6 条投入 MAIN 的 cross-post | `0001784471269998-000257-9809e71a`<br>「我们thread当前应该有且只和 thread_mrkn6povq4zzgh45 有关联的」 | **C. 汇报目的地过载（非误投，是噪声）** |
| **I-5** | 2026-04-30 09:39 | — | `thread_moicgl47en8m98do` (develop) | 同 thread 操作 | — | `0001777541980958-004592-9e6c6222`<br>「@opus 你跑错位置了；这不是一个跨线程的操作」 | **E. 工具选择错误（该同 thread 却用了跨 thread）** |

**独立 thread 数：≥6**（`mrkmxgdfqquounc9` / `msr51149hym0i79f` / `mrkn6povq4zzgh45` /
`ms2kxwwny5z5fcom` / `eval_a2a` / `mrrucuwlotamwuom` / `mq6alvzotw9ryo8r` /
`mrdip0u5aw4ysi97` / `moicgl47en8m98do`）。时间跨度 2026-04-30 → 2026-09-19。
**这不是单次操作失误。**

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

#### R-2 · 没有任何内容侧特征能机械区分误投与合法跨 feature 协作（**证据，不是缺陷**）

在提"加个 guard"之前先量化了两个最自然的 fence，**两个都不可用**：

| 候选 fence | 合法跨投的基线 | 本 corpus 误投是否会被拦 |
|-----------|--------------|----------------------|
| 「发送方在目标 thread 没有历史发言」（cold-open） | 957 条 cross-post 中 **92.7% 是 warm**（发送方此前发过言），7.3% cold-open | I-1 是 **WARM**（sol 当时正在 A2A#1398 干活）；I-3 也是 **WARM**。**拦不住** |
| 「coordination.subjectRef 在目标 thread 未出现过」 | 带 subjectRef 的 134 条里 **51.5% 是 novel subject**（Core↔Plugins 正常开新 subject 就是这样） | I-1 会被拦，但误杀率 ~50%。**不可用** |

**结论：不要做内容启发式 guard。** 它既拦不住真误投，又会砸掉一半合法协作。
正确方向是**消除猜测**（给解析原语 + 给"不知道"的合法出口），不是**惩罚猜测**。

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

`[DIAG/ghost-thread] post-message: cross-thread detected` 在**每一次**合法跨线程投递时打印，
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
| R-2 | 不是缺陷，是**排除性证据**（否掉内容启发式 guard 这条路） | — | — |
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
| 1 | `shortThreadRef()` 提取到 `@cat-cafe/shared`，`ContextAssembler` 与 web `parse-direction` 共用 | R-3。前端已有正确实现，提取即单一真相源（P4） | ≤1 commit 回滚 |
| 2 | `context-assembler.test.js` 增加**真实形状 threadId** 的回归（两个不同来源必须产出不同 tag；必须等于前端短 ref） | 旧 fixture 形状不真实是这个 bug 活 6 个月的直接原因 | — |
| 3 | 恢复本 bug-report 到 skill 已引用的路径，写入**裁决而非假设** | R-6。skill 的规范性约束不能挂在悬空路径上 | 文档 |
| 4 | 修正 `cross-thread-sync/SKILL.md` 的"P2 OPEN 服务端 bug"断言为已证伪 + 保留真实的调用方风险提示 | R-6。错误断言在给猫提供错误归因出口 | 文档 |

**不在本 PR 范围**（明确列出，不留尾巴）：

- R-1 的解析原语与 `targetGrounding` 契约 → 契约变更，走 Decision Packet
- R-5 的误投标记/撤回能力 → 改 message 生命周期语义，走 Decision Packet
- R-4 的 briefing provenance 校验 → 独立 slice，需 briefing 组装面的 owner
- `cliSessionId` 跨 thread 孤例 → 单独跟踪
- 不改 F202 C1 / A2A #1398 / 任何生产数据

---

## 6. 验证方式

1. **R-3 回归**：`node --test packages/api/test/context-assembler.test.js`
   - RED（修复前）：两个真实形状 threadId 产出同一个 tag `thread_m`
   - GREEN（修复后）：产出 `mrkmxgdf` / `mu8dg6h7`，且等于前端 `parse-direction` 的短 ref
2. **证伪结论可复现**：`forensics/scan-cross-thread-routing.mjs`（**只读**，仅 SCAN/HMGET/GET，
   不写不删不设过期；`--redis` / `--prefix` 可指向任意实例）。2026-09-19 对运行实例实跑输出：

   ```
   corpus: 106759 messages, 2077 sessions, 958 cross-posts

   — §3.1 falsification —
     causal reply edges                         : 7760
     replies landing outside the trigger thread : 234
     ... of which UNDECLARED (ghost signature)  : 0   <- expect 0
     sessions with an A2A trigger               : 663
     ... wake bound to the wrong thread         : 0  <- expect 0
     continuityCapsule / session thread drift   : 0  <- expect 0
     cliSessionId shared across threads         : 1
     duplicate active sessions per (cat,thread) : 5

   — §3.2 R-2: the two candidate fences —
     sender had prior participation in target   : 888/958 (92.7% 不会被 cold-open fence 拦到)
     cross-posts carrying a subjectRef          : 135/958
     ... subject already present in target      : 66 (51.1% 会被 subject fence 误杀)
   ```

   （与 §3 正文的 7,755 / 957 等数字的个位差异是实例在调查期间仍在产生新消息，不影响任何裁决。）
3. **Corpus 可复现**：误投投诉的检索式与关联窗口（45 分钟）见 §2 首段。
4. **回归护栏**：`packages/api/test/cross-thread-misdelivery-attribution.test.js` 把"服务端忠实于
   调用方声明的 target"这条不变量钉成可执行断言——将来若真出现服务端改路由/错绑唤醒，
   它会直接变红，不必再做一次全量扫描才能重新立案。

---

## 7. 给 operator 的决策包（R-1 / R-5）

见 `decision-packet.md`（同目录）。
