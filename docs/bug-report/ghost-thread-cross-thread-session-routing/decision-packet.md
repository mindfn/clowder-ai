---
feature_ids: []
topics: [routing, cross-thread, decision-packet]
doc_kind: decision-packet
created: 2026-09-19
status: awaiting-operator
---

# Decision Packet — 跨线程投递的目标解析政策

> 给 operator 的**价值取舍题**，不是技术 A/B 题。
> 证据见同目录 `README.md`（6 个事件 / 9 条 thread / 2026-04-30 → 2026-09-19）。

---

## 已经不用你决定的部分

- 服务端 continuation 绑错 thread：**已证伪**（0/7755 因果边、0/663 session 绑定）。不需要修。
- 接收侧 provenance 被截成常量 `thread_m`：**已确认是 bug，已在同 PR 修**。不需要你决定。
- skill 里那条悬空的"P2 OPEN 服务端 bug"断言：**已修正**。不需要你决定。
- 「加个内容启发式 guard 拦掉不相关 target」：**已量化否掉**——两个最自然的 fence
  （发送方无历史发言 / subject 在目标 thread 未出现）对本 corpus 的误投**拦不住**，
  却会砸掉 7%~50% 的合法跨 feature 协作。我不建议做，也不打算做。

## 需要你决定的部分

真正的根因是：**`cross_post_message` 要求猫提供一个它结构上无法核验的坐标**。
猫要找的是「F167 的 owner thread」「我的平行实例」「跟本 thread 关联的 thread」——
都是**角色**，不是 id；系统既不提供解析原语，也不提供"我不知道 id"的合法出口。
于是猫只能猜一个最近见过的 threadId，猜错了没人发现，只有你发现。

这块要花代价，代价花在哪由你定。

---

### 取舍 1：猫投错了，应该拦、还是应该可回收？

| | **A. 事前拦（fail-closed）** | **B. 事后可回收（fail-loud）** | **C. 两者都要** |
|---|---|---|---|
| 做法 | 目标 thread 与本次 subject 无任何可核验关联时，`cross_post_message` 返回 400，要求补一个 typed `targetGrounding`（形状照抄已有的 `groundingEvidenceRef`），或改走 `propose_thread` | 投递照常，但增加：①「这条投递错了」的 typed 信号（你一键、猫也能自查）②误投消息在落点 thread 被降级为不唤醒的 quarantine ③发送方被反向唤醒纠正 | 先 B 后 A |
| 你得到什么 | 误投在发生前就被挡住 | 误投仍会发生，但**23 分钟 → 秒级**，且不产生二次污染链 | — |
| 你付出什么 | **合法的首次跨 feature 协作会被误拦**。R-2 的数据说 7.3% 的 cross-post 本来就是冷启动首次接触；这些会变成"先补 grounding 再发" | 误投照旧发生，你仍然是第一发现人（但只需点一下，不需要打字解释） | 工期最长 |
| 我的倾向 | ✋ 不建议单独做 A —— 没有可用判据，只能靠猫自陈 grounding，等于再写一条"规则"，而 F167 Case E1 已经证明「写进规则 ≠ 模型执行」 | ✅ **推荐先做 B** —— 它不依赖任何判据，只依赖"错了之后能不能收回来" | 可以，但 A 应该等 B 跑出真实数据再谈 |

**我的立场**：选 B。理由是 corpus 里 6 次误投的真实伤害不在"投错了"这一下，
而在**投错之后没人知道、错的那条 thread 的猫还继续基于错的语境做二次协调**（I-1b、I-2b 两次都这样）。
止住二次污染比阻止首次误投便宜得多，也不会伤害合法协作。

**B 里有一块几乎零争议、我特别想要的**：**回复方向的 target 可以由服务端推导，不用猫填。**
被 cross-post 唤醒时，源 thread 已经记在 `extra.crossPost.sourceThreadId` 里；
`replyTo` 又已经被服务端约束在目标 thread 内（`resolveVisibleReplyParent`）。
也就是说"回复源 thread"这个动作**完全不需要猫再打一次 threadId**。
corpus 里 6 次事件有 2 次（I-1b、I-2b）就是被唤醒的猫在回复方向上重新猜了一个 id 并猜错——
这一类可以直接消灭，不需要任何启发式判断。

---

### 取舍 2：要不要给「角色 → thread」建一个真相源？

I-4 里你亲口给出过正确不变量：**"我们 thread 当前应该有且只和 `thread_mrkn6povq4zzgh45` 有关联的"**。
这句话是对的、是稳定的、而且系统里**没有任何地方存它**。

核查：涉事的 6 条 thread，`cat-cafe:thread:*` 的 `metadata` / `labels` 字段**全部为空**。
`cat_cafe_get_thread_metadata` 这个能力存在，但实际上没人填。

| | **A. 不建** | **B. 轻量：thread 关联表** | **C. 重量：feature/subject → owner thread 注册表** |
|---|---|---|---|
| 做法 | 维持现状，靠猫每次 `feat_index` + 查证 | 每条 thread 声明它的关联 thread（你在 I-4 说的那句话直接落库），cross-post 到关联集合外时在消息上打**可见的 provenance 标记**（不拦） | F-号 / subject 有唯一 owner thread；`cross_post_message` 支持 `subjectRef` 直接解析 target，猫不再传 id |
| 你付出什么 | 继续当人肉路由器 | 每条新 thread 多一次声明（可由猫提议、你批） | 需要一套注册 + 争用 + 迁移语义；I-1/I-2a 的根源「F167 压根没有 owner thread」也需要一个"无 owner"的合法状态 |
| 收益 | 0 | 覆盖 I-4，部分覆盖 I-1 | 覆盖 I-1 / I-2a / I-3（平行实例可解析），根治 R-1 |
| 我的倾向 | ❌ | ✅ 值得做，成本低 | 想做，但**不建议现在做** —— 它需要先有 B 的数据说明"角色解析"到底多频繁 |

**我的立场**：B 现在做，C 记进 backlog 等数据。

---

### 取舍 3（小，但要你点头）：`[DIAG/ghost-thread]` 怎么处置

当前两条埋点在**每次**合法跨线程投递 / 每次轮询时打印，零判别力；
真正有判别力的两条（invocation 创建、session_init 绑定）从未合入 main。

- **A. 删掉**——证伪结论已经立住，留着是虚假安全感
- **B. 换成真检测**——保留标签，但只在"回复 thread ≠ 触发 thread 且无 crossPost 声明"时告警（= 我用来证伪的那条判据，可直接做成运行时断言）
- **C. 原样留着**

我倾向 **B**：它把一条噪音日志变成一条**会在原 bug 复活时真正响的**断言，成本是几行代码。
本 PR 没做，因为它属于新增运行时行为，等你点头。

---

## 我需要你回什么

三句话就够：

1. 取舍 1 选 **A / B / C**？（我推荐 B）
2. 取舍 2 选 **A / B / C**？（我推荐 B 现在做，C 进 backlog）
3. 取舍 3 选 **A / B / C**？（我推荐 B）

不回也可以——本 PR 里已完成的修复（provenance 截断 bug、bug-report 恢复、skill 断言修正）
不依赖这三个决定，可以独立合入。
