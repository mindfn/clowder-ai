---
feature: F257
title: F257 Harness Ledger — 完整方案 v1（从 operator 模型往下推；proposal，待逐节确认）
status: proposal — 未经 operator 确认前不得据此改代码
depends_on: terminal-contract-v1.md（TC-1~13）
author: 宪宪(cat-8zfu14fb) 2026-09-02
---

> operator 2026-09-02："方案我现在怀疑你们都没怎么想清楚……想把方案完整搞清楚了再去改。"
> 本文只做一件事：把 terminal-contract 的条款展开成**能直接照着实现、也能直接照着验收**的完整方案，并把现有组件逐个定性为 **删 / 降级 / 保留**。每节末尾的 ☐ 由 operator 勾选；有一节不对就改这一节，不重来。

## 1. 一个周期的完整走查（用 D1 / identity-truth 的真实数字）

| 步 | 发生什么 | 谁 | 数据 |
|---|---|---|---|
| 1 | tracing 持续入池。D1 属于 Objective `identity-truth`，该 Objective 的当前周期起点 = 上次评估周期终点 = **2026-08-24 15:54** | 系统（路由终态缝） | 线性池；无分组 |
| 2 | 每条 trace 落盘后 + 每小时兜底，checker 算该 Objective 的三路水位：周期内累计 **1436/200**、周期内去重反例 **0/1**、距上次评估 **9 天/7 天**——三路全部满足 | 系统 | 只读池 |
| 3 | 满足即**开启本周期评估**：写一条周期记录 `{objective, version:v1, cycleStart:08-24 15:54, cycleEnd:now, evalStatus:requested}`；**不复制任何 trace** | 系统 | 一条小记录（<1 KB） |
| 4 | 向固定评估 thread（`thread_eval_harness_ledger`）投一条 assignment：Objective、版本、时间窗、指标列表（每个指标的评估方式/规则）、**周期内反例清单（高置信度，先读）**、以及"按窗读池"的工具说明 | 系统 | 消息 ≤ 32 KB（反例给引用不给正文；正文按需用工具读） |
| 5 | 评估猫按窗读池（反例优先，其余按需翻），对每个指标给结论，**调工具回写**：`submit_cycle_evaluation{objective, cycleId, metrics:[{id, conclusion, evidenceRefs}], overall}` → 周期记录 `evalStatus:written` | 评估猫 | 回写即真相 |
| 6 | 回写成功 → **系统自动**向同一 thread 再投一条 governance assignment：附上第 5 步结论，要求三选一 **keep / rollback / evolve** + 理由 → 评估猫回写 `submit_cycle_governance{decision, reason}` | 系统 → 评估猫 | 同一 thread，同一猫 |
| 7a | decision = keep → 周期收束：`cycleClosedAt:now`；**下一周期起点 = 本周期终点**；回到步 1 | 系统 | — |
| 7b | decision = rollback / evolve → 生成**审批卡**（objective、当前版本、决策、理由、按钮：批准 / 驳回 / 跳过） | 系统 → operator | 卡 |
| 8 | operator 批准 → 执行版本动作（rollback = 激活上一版；evolve = 生成 v2 草案交编辑/直接激活由卡决定）；驳回 = 等同 keep；**跳过 = 周期起点不动**（可能数据不够）。三者之后都进入下一周期 | operator → 系统 | override 版本链 |
| 9 | v2 周期与 v1 完全同流程；v2 的 eval 只看 v2 时间窗；**不做 v1/v2 对比** | — | — |

未回写分支（步 5 或 6 超过 T=30 分钟没有回写）：系统投**一条**"你还没回写"的系统 message 重触发；再超过 T 仍无 → 周期记录 `evalStatus:stalled` + 告警到本 thread，**不再重试**，等人处理。

☐ 走查正确

## 2. 状态：每个 Objective 只有一条"当前周期记录"

```
CycleRecord {
  objectiveId, version,                 // version = override 版本链当前激活版本
  cycleStart, cycleEnd?,                // cycleEnd 在触发时写；周期收束后作为下一周期的 cycleStart
  evalStatus: idle|requested|retriggered|written|stalled,
  evaluation?: { metrics:[{id,conclusion,evidenceRefs}], overall, writtenAt, by },
  governance?: { decision: keep|rollback|evolve, reason, writtenAt },
  approval?:   { cardId, state: pending|approved|rejected|skipped, at },
  closedAt?
}
```
- 历史周期 append-only 存档（生命线按 version+cycle 展示）。
- **删除**：snapshot 内嵌 corpus、pending/claim/commit 三段 Lua、Unit job / cursor receipt 作为**门**的角色、drain fence、sweep 状态机（见 §8）。
- 保留：tracing 池、反例标记、override 版本链、Console 路由。

☐ 状态足够且不多余

## 3. 触发检查（checker）

- 触发点：每条 trace 落盘后（已有终态缝回调）+ 每小时 cron 兜底（覆盖"7 天"这一路）。
- 三路 anyOf 口径：`累计 = 池中 terminalAt ∈ [cycleStart, now) 且 summary.segments 含该 Objective 任一段且 status=observed 的 episode 数`；`反例 = 同窗内 polarity=counterexample 的去重 incidentKey 数`；`cadence = now − cycleStart ≥ 7d 且累计 ≥ 1`。
- 幂等：同一 Objective 若 `evalStatus ∈ {requested, retriggered}` 则不重复开启；CAS 写周期记录。
- 阈值来自 Objective 的评估模型定义（现有 registry），不在代码里硬编码。

☐ 触发口径正确

## 4. 评估 assignment 与回写工具

- assignment 固定结构（≤ 32 KB）：`{objective, version, window, metrics:[{id,label,evaluator,ruleRef}], counterexamples:[{invocationId, incidentKey, rationale?}] (引用), readPoolTool: "cat_cafe_read_cycle_traces(objective, cursor?)"}`。
- 读池工具按窗分页返回 episode 摘要（段状态、input/output 截断、工具调用首尾），评估猫自行决定翻多少；**不预先分类、不等任何 sweep**。
- 回写工具 `cat_cafe_submit_cycle_evaluation`：一个指标一条结论（结论类型沿用 judgment-schema-v2：count / rate-badness / semantic-label），整体 overall 三态 complete / partial / insufficient_evidence。
- insufficient_evidence = "数据不够" → 走 §1 步 8 的**跳过**语义：周期起点不动，直接进入下一周期检查。

☐ assignment/回写契约正确（评估猫 = 现 override 指定的 sol，☐ 维持 / ☐ 改）

## 5. Console

- **Tracing**：周期起点；两组：`周期内反例 n/阈值`、`周期内累计 m/200`；第三路 `距上次评估 d/7 天`；列表分别为反例记录、累计记录（可回放）。无"待分类"。
- **Eval**：每指标：评估方式、规则、本周期结论、证据引用；整体结论；evalStatus（requested/written/stalled 可见）。
- **Governance**：decision + 理由；审批卡状态；版本链 v1→v2…（谁、何时、为何）。

☐ 三面正确

## 6. 现有组件处置表

| 组件 | 处置 | 理由 |
|---|---|---|
| `EvaluationSnapshot.traceCorpus`（6 MB/个） | **删** | TC-4 |
| pending / claim / commit Lua、watermark 三件套 | **删**，由 CycleRecord CAS 取代 | 状态过多 |
| UnitSemanticEvaluationCoordinator + JobStore + cursor receipt | **降级**为 §4 读池工具的实现（分页 + 可选 digest 审计）；不再是门 | 保留可追溯，不阻塞 |
| Semantic Sweep（批量打标）+ drain fence + volume-sweep retry | **移出主路径，默认关闭**；若保留，只作为后台"反例发现器"，写入反例标记后即退出 | TC-13 |
| trigger-now `if (!semantic)` | **删** | TC-3/13 |
| F299 recorder `sourceRefs.max(64)` | 上游止血：assignment 引用 ≤ 64 或聚合为一个 source map | 与本方案无关但必须 |
| 路由/lifeline/evaluation/override 路由 | 保留 | Gate 1 已验 |
| judgment-schema-v2（KD-22） | 保留为结论类型 | — |

☐ 删留表同意

## 7. 迁移现有卡死状态（一次性，operator 批准后执行，不删 tracing）

- 4 个 Objective 的 pending snapshot（6 MB×4）、81 个 open sweep job、drain state（generation 1899）、18 个 unit job：**全部作为派生状态清除**；tracing 池、反例标记、已完成 judgment 不动。
- 清除后 checker 首次运行即按 §1 从各 Objective 现有 cycleStart（= 上次 completed-window-end）重新触发。

☐ 批准清理

## 8. 验收（= terminal-contract §4 F-1~6）+ 一次真实周期走通的截图链（步 2→8）

☐ 以此为完成定义

## 9. 待 operator 拍板的开放问题

1. 评估猫固定为谁？（当前 override = sol；建议专用评估猫或 opus，避免与开发者同一只）
2. evolve 的 v2 内容由谁写：评估猫直接给 v2 草案，还是只给"演进建议"由人改？
3. 审批卡"跳过"是否等同"驳回但起点不动"？（本文按是）
4. 是否保留 cursor receipt（审计出处）——不作为门，只作为可追溯；☐ 保留 / ☐ 不要
5. 周期起点对首个周期：首条 eligible trace 时间（现状）☐ 维持

---
确认方式：在 thread 回一句"§x 对 / §y 改成…"，或直接改本文件。全部 ☐ 勾完 → 解冻，按 §6 顺序实施：先删后建，不在旧状态机上加固。
