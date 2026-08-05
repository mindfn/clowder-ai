---
feature_ids: [F167]
related_features: [F064, F027, F122, F055]
topics: [a2a, collaboration, harness-engineering, agent-readiness]
doc_kind: spec
created: 2026-04-17
tips_exempt: harness-internal shadow telemetry infra — no user-visible capability change
user_journey_exempt: pure harness-internal infra (ping-pong breaker, void-pass detection, role guard) — no user-perceivable surface changes
---

# F167: A2A Chain Quality — 乒乓球熔断 + 虚空传球检测 + 角色护栏

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P0

## Why

F064 解了"漏传球"（该 @ 没 @），但三个月后暴露了反向问题群：乒乓球（同一对猫反复 @ 无产出）、虚空传球（说"我来做"但 @ 了对方导致球在地上）、角色不适配 handoff（让 designer 写代码）。

operator定期审视 harness engineering 的结论（2026-04-17）：现有 A2A 出口检查只覆盖"漏传球"，没覆盖"过度/假/错误传球"。

**根因（第一性原理回溯后修正）**：猫有两条路由路径——MCP 结构化（`targetCats`）和文本 @（行首解析）——两条都能用，但 4.7 两条都没用对。根因不是"@ 协议脆弱"，也不是"脚手架旧"，而是：

1. **模型不理解我们的路由机制**：4.7 在句中写 @（不路由）、以为"说了=做了"（没发 tool call 也没写行首 @）。语义 handoff 和执行 handoff 脱钩。
2. **我们的提示词有隐含假设**：大量"禁止 X"式规则，Spirit Interpreter 自动补全边界（"不碰 runtime"= 不改但可读），Literal Follower 字面执行（"不碰 runtime"= 完全不碰）。
3. **缺少基本运行时刹车**：无 ping-pong 检测、无角色门禁——这些应该是 harness 基础设施，和模型无关。

**核心哲学**（来自 Round 4 数学之美讨论）：

> 好 harness 不是替模型思考，而是让模型在正确的坐标系里思考。
> 真正的 Harness 工程 = 对齐模型的好直觉 + 压制模型的坏直觉，其他一律极简。
> 复杂是无知的代偿。

operator experience：
> "你们两！！没完没了互相at半天！特么不干活！！！！"
> "解决了47的问题或许什么glm什么kimi minimax qwen的问题也就解决了。。都是小笨猫"
> "我们必须要知道为什么的！不然以后每次模型升级假设来了个超级无敌牛逼猫猫，benchmark惊人！结果哈哈哈哈"

## Design Constraints

1. **路由可见性不退化**（operator拍板）：若猫通过 MCP `targetCats` 路由但响应文本无 @mention，系统须自动补可见路由指示，不可让协作"悄咪咪"发生。
2. **Provider-agnostic**：护栏不依赖特定模型行为，对所有引擎生效。
3. **Backward compatible**：不退化 4.6 等已正常工作模型的体验。
4. **极简**：只加运行时刹车（压制坏直觉）和认知路径工程（对齐好直觉），不加认知脚手架（替模型思考）。

## Eval / Tracking Contract

> **何时填**：harness / skill / MCP / shared-rules 类 spec 立项时填本节。判断标准：改动会改变猫猫行为模式 → 填。否则跳过。
> **Design Gate**：本节是硬门禁。空填 / 缺关键字段 → Design Gate 不通过。

### 1. Primary Users + Activation Signal

- **Users**：
  - operator：不再充当人肉路由（受益方，不直接操作）
  - Cats：author（写 @）/ reviewer（给 verdict）/ designer（被 restrictions 保护免做 coding）
  - Runtime：WorklistRegistry（streak 追踪）/ exit check（注入路由提示）/ `cat_cafe_hold_ball` MCP / cat-config.restrictions（数据驱动能力限制，Phase E KD-20）
- **Activation signal**：
  - **L1 ping-pong 熔断**：WorklistRegistry 里 `(catA, catB)` 连续 same-pair streak ≥ 2 (warn) / ≥ 4 (break)
  - **C2 forced-pass guard**：invocation 输出含 review verdict 关键词（approve / reject / P1 / P2 / LGTM / 修改建议）但末尾无行首 @
  - **L3 → 数据驱动限制**：cat-config.restrictions 双端 prompt 注入（发送方队友名册 + 目标猫 self-awareness）；原 L3 硬编码 regex 已退役（KD-20）
  - **C1 hold_ball**：cat 显式调用 `cat_cafe_hold_ball` MCP（区别于"我先 hold 一下"的纯文本状态描述）

### 2. Friction Metric

- **L1 false-positive 误杀**：正常 review 循环 A→B→A→B (streak=3) 被误杀 → reset 条件（第三只猫 / user 消息）必须正确触发；覆盖见 `pingpong-reset.test.js`
- **C2 over-fire**：纯信息查询无后续动作的输出被强制要求 @（边界场景：信息回答 vs 协作传球的判定漂移）
- **C1 hold_ball 滥用**：`maxHoldsPerWindow` 超限（默认 3 / ~1h rolling）→ cat 在用 hold 替代正常传球
- **C1 stale hold wake**：等待对象已被结构化事件满足（review / CI / issue / user message / managed command）后，旧 `hold_ball` timer 仍唤醒猫 → 目标为 0；若发生，必须能追到 `waitSourceRef` / `subjectKey` / `expectedSignalKey` / `resolvedBy`
- **Routing 旁路**：invocation 文本响应有 @ 但 MCP `targetCats` 为空（或反之）→ `routing-syntax-hint`（route-serial 行首 @ 语法检测）或 `verdict-no-pass-hint`（verdict 无 @ 出口检测）触发

### 3. Regression Fixture

- `ping-pong/streak-4-break` → `worklist-registry-streak.test.js`（AC-A1）
- `ping-pong/false-positive-review-loop` → `pingpong-reset.test.js`（AC-A3）
- `callback-a2a-pingpong` → `callback-a2a-pingpong.test.js`（AC-A4）
- `void-pass/say-but-not-do` → Maine Coon 5 线程截图（PR #1289 P1 evidence）
- `role-gate/l3-retired` → `route-serial-pingpong.test.js`（AC-E — asserts `a2a_role_rejected` must NOT fire after KD-20 retirement）
- `forced-pass/review-verdict-no-mention` → `route-serial-verdict-hint.test.js`（C2 verdict detection）
- `hold-ball/zombie-hold` → Maine Coon原话 "Hold 不是对外协议状态"（C1 设计动机）
- `hold-ball/event-satisfied-retirement` → Phase Q 待补：review/CI/issue/user event 先满足等待时，subject + normalized signal matching hold retired 且旧 timer 不再 wake；signal 不匹配时不退休；前端不再显示可取消 pending 状态

### 4. Sunset Signal

- **Environment drift**：模型升级后 prompt 层球权规则被自然吸收（exit check / forced-pass 提示）→ C2 prompt 段可降级为只 hint 不强制；但 **L1 streak breaker 是基础设施保留**（与模型无关）
- **Subsumption (in-feature)**：路由协议从两条（行首 @ + MCP `targetCats`）收敛到一条 → 路由旁路检测简化为单一路径
- **Subsumption (cross-feature)**：F181 (Prompt X-Ray) + 跨路由 trace propagation 上线后，A2A friction 改用 trace-based detection 替代 prompt-based 提示 → C2 forced-pass prompt 段可废弃
- **Adoption decay**：近 6 个月 ping-pong streak ≥ 4 触发 0 次 + 实战观察未出现该失败模式 → L1 熔断从 `break` 降级为只 `warn`

## What

### Phase 0: 系统提示词正面化审视（P0，多猫协作）

在写任何 harness 代码之前，先审视"地形"——让模型自然往正确方向跑，而不是加铁丝网。

**审视范围**（完整注入链路）：

| 来源 | 谁看到 | 审视什么 |
|------|-------|---------|
| `shared-rules.md` | 所有猫（canonical） | "禁止 X" → "允许 Y，禁止 Z"（显式边界） |
| `governance-l0.md` | codex/gemini（sync 源） | 和 shared-rules 对齐 |
| `GOVERNANCE_L0_DIGEST`（SystemPromptBuilder.ts） | 所有猫（runtime 注入） | 和 governance-l0 同步 |
| `CLAUDE.md` | Claude 猫 | 负面禁令 → 正面指令 |
| `assets/system-prompts/cats/codex.md` | codex/gpt52/spark | 同上 |
| `assets/system-prompts/cats/gemini.md` | gemini | 同上 |
| `WORKFLOW_TRIGGERS`（SystemPromptBuilder.ts） | per-cat | 检查和正面化后是否矛盾 |
| Skills（`cat-cafe-skills/`） | 按需加载 | 审视有无 "used when / not for" 清晰边界（参考 Anthropic skills 实践） |

**正面化原则**：
- "不碰 runtime" → "可读日志/搜索输出；禁止修改/重启/删除 runtime 文件和进程"
- "禁止乱 @" → "行首 @ 或 MCP targetCats 是仅有的两种路由方式，其他写法无系统效果"
- SOP 轻重：给正反例 few-shot（5-line patch 走轻量路径 vs 跨模块 feature 走完整 lifecycle）
- Skills 审视：每个 Skill 是否有明确的 "Use when" + "Not for" 边界（让模型一眼识别适用场景）

### Phase A: Harness 硬护栏（P0）

三个运行时刹车，不依赖模型遵守 prompt：

**L1 — 乒乓球熔断**：WorklistRegistry canonical enqueue 点追踪连续 same-pair streak。streak=2 警告，streak=4 熔断。覆盖 serial + callback 双路径。

**L2 — Parallel @ mention 降噪**：prompt 层禁止 parallel 模式 @句柄 + harness 层 route-parallel 的 mentions 标记 `suppressedInParallel`，不写入 routedMentions；followupMentions 路径同步抑制。

**L3 — 角色适配门禁**：A2A handoff 时检查目标猫角色能力。MVP：designer 角色 + coding/fix/test/merge 关键词 → fail-closed 报错 "⛔ @{cat} 不接受 {action} 任务"。动作判定复用 `AFTER_HANDOFF_RE` 模式 + cat-config `capabilityTags`。

### Phase B: 观察 + 按需补充（P1，Phase 0+A 效果验证后）

Phase 0 正面化 + Phase A 刹车上线后观察。只有证据表明还有缝才补：
- 虚空传球是否仍频繁出现？→ 按需加简单检测
- always_at_back 是否仍在放大 ping-pong？→ 调整为"有产出才 @ 回"
- 6 个事故 case 做回放测试，验证 Phase 0+A 覆盖率

#### B2 — Ball Ownership Protocol Hardening（2026-04-19 实战迭代）

基于operator实时观察 + 截图证据，迭代修复 6 个球权协议漏洞：

| # | Anti-Pattern | 修复 | 位置 |
|---|-------------|------|------|
| 1 | operator球权盲区（不知 @ 谁） | exit check 注入 `@co-creator`（coCreator config 动态取） | SystemPromptBuilder |
| 2 | 球权死锁（收球说"你等着"） | 禁止——做不了就退/升 | shared-rules §10 + exit check |
| 3 | 虚假离场（不@但还在干，倒装句误导） | 结尾声明"球在我手上，继续 X" | exit check |
| 4 | 状态描述代替球权声明 | 核心原则 + 接/退/升三选一 | shared-rules §10 |
| 5 | 诊断不解决（push back 不接/退/升） | push back 后必须紧跟接/退/升 | exit check |
| 6 | Codex context overflow（272k 用 900k limit） | 动态 contextWindow + autoCompactTokenLimit per variant | CliConfig + CodexAgentService |

**根因**（Maine Coon自我剖析）："Hold 不是对外协议状态。要么静默执行，要么接/退/升。" RLHF "check in" 反射在 agent 链路里变成球权黑洞。

### Phase C: 球权出口闭环 — Maine Coon不传球的两种根因（P1）

**发现**：operator审阅 5 个活跃线程，Maine Coon全部不传球。Maine Coon自我诊断两种不同的不传球模式：

| 模式 | 表现 | 根因 | 解法 |
|------|------|------|------|
| **真持球** | "我想继续做"但 CLI 退出，球掉地上 | 持球没有执行层 | **C1: hold_ball MCP** |
| **假终局** | review/分析给了结论就停了，不传球 | "结论 = 终点"错觉 | **C2: 强制传球护栏** |

> **Maine Coon原话**："Phase C 治的是'我想继续拿球却拿不住'；治不了'我根本没意识到该传球'。"

**共同设计约束**（Maine Coon + Ragdoll讨论收敛）：
1. **"持"是例外态，不是四选一常态。** 默认三选一：接/退/升。（KD-13）
2. **不先做独立 skill。** 球权管理是基础协议。踩坑经验收进 `refs/ball-ownership-patterns.md`。（KD-15）

---

#### C1: Hold Ball MCP — 有界持球（治"真持球"）

**问题**：猫声明"球在我手上，继续 X"后 CLI 进程退出，无人再唤醒 → 持球只有语义层没有执行层。

**方案**：`cat_cafe_hold_ball` MCP tool。猫调用 → 系统记录 → CLI 退出后自动再唤醒。

**v1 Tool Signature**：
```typescript
cat_cafe_hold_ball({
  reason: string,      // 为什么需要持球
  nextStep: string,    // 唤醒后的第一个动作
  wakeAfterMs: number  // 多久后唤醒（有界等待，KD-14）
})
```

**Use when**：球明确在你手上 + 无人能推进 + 短暂可预期等待 + 醒来后知道下一步。

**Not for**：需要别人拍板/验收/人工操作 → `@co-creator`；需要另一只猫动 → `@句柄`；"我再想想""我先 hold 一下" → 这是犹豫不是持球；状态更新 → 直接说。

**唤醒注入**：
> 你上轮持球：{reason}
> 球仍在你手上。现在执行：{nextStep}
> 若条件仍未满足：再持一次或升级；禁止无限持球。

**Guard**：`maxHoldsPerWindow`（默认 3，~1h rolling 窗口，per thread×cat），超限强制接/退/升 + 审计日志。
*实现注记*（gpt52 review on PR #1289 P1/P2）：语义是"窗口内累计"而非"真·连续"；状态进程内 in-memory，best-effort，重启会重置。要做硬约束得把计数下沉到与 reminder scheduler 同源的持久化存储，当前不做。

**并发语义**（Phase G / KD-23 补充）：

- **外部 wake 撞持球期**：hold wake 在 fire 时走 `ConnectorInvokeTrigger.trigger` normal priority，若 cat 有 active invocation 则 `enqueueWhileActive` 排队到 InvocationQueue，**不打断**当前工作。当前 invocation 结束后才会执行 hold wake 注入的 `持球唤醒：...` 消息。
- **Stale wake 处理**：如果 external wake 已经改变 thread 语境（operator发了新方向），排队后的 hold wake 消息里的 `nextStep` 可能过时。Cat 拿到 wake 时应根据 thread 最近历史判断 `nextStep` 是否仍相关——若已不相关，走接/退/升，**不盲跟 stale nextStep**。
- **二次 `hold_ball` = 单-槽替换**（Phase G AC-G3）：同 `(threadId, catId)` 只能有一个 pending hold wake。再次调用 `hold_ball` 会：先 `taskRunner.unregister` + `dynamicTaskStore.remove` 前一个 pending task，再 insert 新的。避免 stale wake 累积。若需要等多件事 → merge 到一个 `nextStep`（如 `"等 CI 且 @co-creator 确认"`），不要分多次 hold。

---

#### C2: Forced-Pass Guard — 强制传球护栏（治"假终局"）

**问题**：Maine Coon给出 review 结论（approve/reject/P1/P2/修改建议）后，以为"结论 = 终点"就停了。但 review 后 **永远有下一棒**——author 需要看到反馈并行动。operator实测 5 个线程全部命中。

**根因**：exit check 的 `没人 → 不 @` 路径对 reviewer 来说太宽了。Reviewer 给出 verdict 后几乎不存在"没人需要动"的场景。

**方案（双层）**：

**L1 — Prompt 层**：exit check 增加 review 场景特殊规则：
> Review 完成后**必须传球**：给了结论（approve/reject/P1/P2/建议）→ 末尾行首 @author 或 @co-creator。
> Review 结论 ≠ 链条终点——author 需要看到你的反馈并行动。
> "没人需要动"对 reviewer 来说几乎不成立。

**L2 — Harness 层**（Phase B 观察后按需）：
- 检测输出中的 review verdict 关键词（approve/reject/P1/P2/LGTM/修改建议）
- 若有 verdict 但无行首 @mention 且无 hold_ball 调用 → 注入提示："你给了 review 结论但没传球，请 @ author 或 @co-creator"
- 不阻断，只提示（prompt-first 原则，与 Phase A 乒乓球警告同模式）

**推广**：不只是 review。所有"完工型"输出都适用——"分析完了""方案给了""诊断做了"——后面都该有球权决策。核心规则：

> **给出结论/建议/分析后，默认必须传球。** "没人需要动"只在极少数场景成立（纯信息回答、无后续动作的独立查询）。

---

#### 已知踩坑模式（Maine Coon贡献 + operator 5 线程观察）

| # | 坑 | 表现 | 归类 | 正确做法 |
|---|---|------|------|---------|
| 1 | RLHF check-in 反射 | "我想再确认一下"误说成持球 | C1 | 那是犹豫，不是 hold → 接/退/升 |
| 2 | 状态描述代替声明 | "我先 hold""我继续看" | C1 | 不是球权动作 → 接/退/升 |
| 3 | 诊断成瘾 | 先解释发生了什么，忘了接/退/升 | C2 | 诊断后必须紧跟球权决策 |
| 4 | 持球当礼貌 | "我还在跟进"（人类礼仪） | C1 | agent 链路里这是黑洞 |
| 5 | **Review 假终局** | 给了 verdict 就停了，不 @ author | C2 | review 结论 ≠ 终点，必须传球 |
| 6 | **"结论即终点"错觉** | 分析/方案/建议写完以为链条结束 | C2 | 结论后默认必须传球 |

**系统提示词球权段落草案**（含 C1 + C2）：
> 球权默认三种合法出口：接、退、升。
> 只有当球明确仍在你手上、当前无人能推进、且你只是在等待一个短暂且有界的时机再继续时，才调用 `cat_cafe_hold_ball`。
> `hold_ball` 不是状态汇报，不替代 `@co-creator`，不替代传球。
> 能继续做就继续做；需要别人动就传/升；只有"短暂等待后仍由我继续"才持。
> **Review / 分析 / 建议完成后，默认必须传球给 author 或 @co-creator。** "没人需要动"对 reviewer 几乎不成立。

## Acceptance Criteria

### Phase 0（系统提示词正面化）
- [x] AC-01: 所有 "禁止 X" 式规则改为 "允许 Y，禁止 Z" 显式边界格式（共享 + per-cat）— 7 文件负面指令清零（c34364da5 + b653b3021 + 13ab948c1）
- [x] AC-02: 路由规则正面化："行首 @ 或 MCP targetCats 是仅有的两种路由方式" 写入 shared-rules §10 路由方式 + runtime injection 球权检查
- [x] AC-03: Skills 审视完成，33/33 Skill 有 "Use when" + "Not for" 边界（image-generation 补齐）
- [x] AC-04: `GOVERNANCE_L0_DIGEST` 与 `governance-l0.md` 同步（含新增 Magic Words）— Rule 0 出口 + W4 正面化（c34364da5）
- [x] AC-05: SOP 轻重路径给正反例 few-shot（shared-rules §11 四档 few-shot 表）

### Phase A（Harness 硬护栏）
- [x] AC-A1: WorklistRegistry 追踪连续 same-pair streak，streak≥4 自动终止 A2A 链并 emit 系统消息（PR2 22e09f907 + 486edd804）
- [x] AC-A2: streak≥2 时向当前猫注入"乒乓球警告"提示（PR2 486edd804 — `InvocationContext.pingPongWarning`）
- [x] AC-A3: 正常 review 循环 A→B→A→B (streak=3) 不受影响；中间插入第三只猫或 user 消息 reset streak（PR2 d4636ba02 + codex R1 P1-2 修复：`resetStreak` 无 parentInvocationId 时按 threadIndex 批量清除）
- [x] AC-A4: callback-a2a-trigger 路径与 serial 文本路径走同一个 bounce 检测（无旁路）（PR2 d6360194e — 共享 `updateStreakOnPush` helper；codex R1 P1-1 修复：modern `InvocationQueue` 分支同样经过 streak 门禁）
- [x] AC-A5: parallel 模式 @mentions 日志标记 suppressedInParallel，不 emit a2a_followup_available；followupMentions 路径同步抑制（PR1 b496e83de）
- [x] AC-A6: parallel 模式 SystemPrompt 注入"@句柄 在并行模式下无路由语义"提示（PR1 942809eb6）
- [x] AC-A7: designer 角色 + coding/fix/test/merge 关键词 → route-serial handoff fail-closed + emit a2a_role_rejected（PR1 998e2274a / eec13be85）
- [x] AC-A8: 所有现有 A2A/路由/system-prompt 测试通过（PR1 329+165 tests green）
- [x] AC-A9: 新增测试覆盖 L1 乒乓球（误杀保护 + 正常熔断 — PR2 `worklist-registry-streak.test.js` + `callback-a2a-pingpong.test.js` + `pingpong-reset.test.js`）、L2 parallel 抑制（PR1 ✓）、L3 角色门禁（PR1 ✓）

### Phase B（观察 + 按需）
- [x] AC-B1: 6 个事故 case 回放验证通过（2026-04-20：runtime `/health` 正常 + 运行中猫 prompt 已吃到新球权护栏；Case E2 记录 5 个球权类 live replay + 1 个 codex context overflow 代码/测试回放）
- [ ] AC-B2: 如仍有虚空传球 → 按需加检测（2026-04-20：B2+C2 多层护栏已覆盖，进入观察期，无新 case 即 close）
- [ ] AC-B3: 如 always_at_back 仍放大 ping-pong → 降级为"有产出才 @ 回"，且 F064 出口检查不回退（2026-04-20：L1 streak breaker + break-loop 已兜住，进入观察期）

### Phase B2（Ball Ownership Protocol Hardening）
- [x] AC-B4: exit check 注入 @co-creator（coCreator 动态取），operator球权可见（4e5795cc5）
- [x] AC-B5: 球权死锁反模式写入 shared-rules §10 + exit check（2072f350f）
- [x] AC-B6: 虚假离场防护写入 exit check（283b9dc90）
- [x] AC-B7: "状态描述≠球权声明"核心原则 + 接/退/升三选一写入 shared-rules §10（089e6d5dd）
- [x] AC-B8: 诊断不解决：push back 后必须接/退/升写入 exit check（eb459bc1d）
- [x] AC-B9: 动态 contextWindow + autoCompactTokenLimit per codex variant（fa543ed61）
- [x] AC-B10: 86/86 SystemPromptBuilder + 41/41 codex-agent-service + 31/31 config tests 全绿

### Phase C1（Hold Ball MCP — 有界持球）
- [x] AC-C1: `cat_cafe_hold_ball` MCP tool 注册（reason + nextStep + wakeAfterMs 参数）
- [x] AC-C2: CLI 退出后系统自动再唤醒持球猫（via reminder template one-shot scheduled task）
- [x] AC-C3: maxHoldsPerWindow guard（默认 3 per ~1h 滚动窗口 per thread×cat），超限返回 429 + 强制传球提示
- [x] AC-C4: 审计日志（pino structured log: threadId/catId/reason/nextStep/wakeAfterMs/holdsInWindow/windowMs）

### Phase C2（Forced-Pass Guard — 强制传球）
- [x] AC-C5: exit check 增加 review 场景规则：verdict 后必须 @ author 或 @co-creator（404f894fb）
- [x] AC-C6: shared-rules §10 球权检查强化（reviewer "没人"几乎不成立 + review 必须传球 + 分析/建议传球）
- [x] AC-C7: harness 层 review verdict 检测 + 无 @ 时注入传球提示（保守关键词 LGTM/approve/reject/P1/P2/修改建议/放行/打回；三层合法出口豁免：行首 @mention / hold_ball / MCP 结构化路由 `targetCats`+`targets`）

### Phase D（Streak 语义升级 + @co-creator 反 catch-all — 2026-04-23 reopened from monitoring）

**触发**（monitoring 期operator观察）：两个系统性缺陷同源——harness 判不了意图：
1. Ping-pong breaker 误杀正经 review（10 轮 review 在 4 轮被硬断）——当前 streak 只看"同 pair 连续次数"，不看猫是否在干活
2. 猫猫把 `@co-creator` 当 catch-all 安全港 — 三选一平级，@co-creator 成为"最低风险默认"，operator变决策瓶颈

**operator拍板的第一性坐标系**（KD-17）：别再做"review vs 闲聊"的主观分类，看客观事实——**干活 = 实质 tool_call + 长内容；闲聊惯性 = 短文本 + 零 tool**。RLHF "接一句" 反射产生短文本惯性，正是乒乓球的真正 signature。

#### D1 — Ping-pong Streak 实质工作豁免（P0）

**问题**：`WorklistRegistry.updateStreakOnPush` 只计"同 pair 1:1 push 次数"，正经 review（每轮都有 read/edit/task-update）在第 4 轮被误杀。

**解法**：streak 累加条件从 `samePair && 1:1 push` 改为 `samePair && 1:1 push && !callerHadSubstantiveToolCall && callerOutputLength <= T`。

**实质 tool 过滤**（Maine Coon review 关键修正 — KD-18）：`cat_cafe_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball` 是**路由/持球工具**，不算干活。否则 MCP 传球路径会永远豁免熔断。实质 tool = 任何留下工作证据的（read/grep/edit/write/test/git/update_task/search_evidence 等）。

**AC**：
- [x] AC-D1: `updateStreakOnPush` 签名扩展 `callerActivity: { hadSubstantiveToolCall: boolean; outputLength: number }`；累加条件为 `samePair && !hadSubstantiveToolCall && outputLength <= T`（T=200 字符默认）；实质工作 RESET streak 到 1（P1-1 reviewer Maine Coon发现的重要修正）
- [x] AC-D2: 实质 tool 黑名单——`cat_cafe_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball`（以 substring 匹配，兼容 `mcp__cat-cafe__*` 前缀）；其他所有 tool 都算实质
- [x] AC-D3: route-serial + callback-a2a-trigger 双路径都传 `callerActivity`；callback 路径 fail-closed 默认 `hadSubstantiveToolCall=false`；streak 更新 gated on `wouldEnqueue`（post-dedup + post-depth）防止跳过的 push 误 mutate 计数器（云端 Codex P1 修正）
- [x] AC-D4: 测试覆盖 2×2 矩阵 + reset-requires-enqueue（32/32 ping-pong 绿）

#### D2 — @co-creator 反 catch-all 硬条件（P0）

**问题**：三选一（@句柄 / @co-creator / hold_ball）平级，猫猫默认走 @co-creator = 最安全选择。模式：`要不要 X？` / `落 spec 吗？` / `同意我就做` — 这些是"软性 @"，有结论但把动作扳机塞回operator。结果：operator被当 human oracle 做所有拍板，即使事情本可自决。

**解法**：@co-creator 从"可选出口"改成"硬条件出口"。三硬条件（不满足禁止 @co-creator）：
1. **不可逆操作前**（删数据 / force push / 合第三方 PR / close feat）
2. **愿景级决策**（改 VISION / 砍整块 feat / 开新 family）
3. **跨猫僵局**（2+ 猫已直接冲突、push back 两轮无共识）

其他一律自决——技术细节、doc 修补、state 标注、timeline 记录 → 直接做，做错能回滚。

**AC**：
- [x] AC-D5: `shared-rules §10.4` 新增"@operator 三硬条件"子条款 + 反问式 ping 反例清单 + 合法示例；`§10` 顶层三选一也重排成决策树优先级（P1-2 reviewer Maine Coon发现的一致性修正）
- [x] AC-D6: `SystemPromptBuilder` trailing anchor 从平级三选一改成决策树优先级：
  ```
  先问：下一步谁能做？
  1. 另一只猫能做 → @句柄（review→@author / 修完→@reviewer / merge→@愿景守护猫）
  2. 等外部条件 → hold_ball（CI / PR check / 长时间 build）
  3. 只有operator本人才能做（三硬条件）→ @co-creator
  @co-creator 不是默认出口——先问"哪只猫能接"。
  ```
- [~] AC-D7: 反问式 ping 反制——**prompt 层已在 D6 trailing anchor + §10.4 落地**（写入决策树末句 + 反例清单）；**harness 层检测故意未做**（KD-8 反分类器原则——regex 判"是不是软性递球"本质是认知脚手架）。若线上观察仍频繁出现反问式 ping，再评估是否加 harness 检测。

### Phase E（Retire L3 role-gate — 2026-04-23 reopened）

**触发**：operator实测发现 `F172 feature close → 愿景守护 @gemini` 链路被 L3 硬拦，理由 "合入"（designer 不接受 merge 任务）——但实际任务是 **愿景守护**，不是 coding/merge。根因是：
1. `role-gate.ts` 硬编码字符串常量 `DESIGNER_ROLE = 'designer'` + 硬编码正则 `CODING_ACTION_RE`
2. `actionText` 扫整条 storedContent，上文任意位置出现 `合入 / merge` 都误伤下一棒
3. `buildTeammateRoster` **没读** cat-config 的 `evaluation`/硬限制字段，发送方 prompt 里根本看不到 "gemini 禁止写代码"

operator experience：
> "你们之前的拦截是不是过度设计啊？ 要是人家gemini 出了4 比你厉害呢？"
> "到底有没有看 cat config 人家不合适做的事情？ 还是硬编码？"
> "要是我明天写的 minimax 禁止 coding， claude 禁止生成图片呢？"
> "问题不是出在 gemini 身上，是出在 at 他的猫身上——队友注入出现问题，导致他不知道限制？"

**根因判定（KD-20）**：L3 role-gate 是 KD-8 典型反模式（认知脚手架——harness 替模型判断 intent）。正确做法是把能力限制作为**数据**（cat-config）注入 **prompt**（双端：发送方队友名册 + 目标猫 self-awareness），让模型在正确坐标系里自判断。未来 model 升级 / 新增 model / 能力变化 → 改 cat-config 即可，**零代码改动**。

#### E1 — 数据模型：cat-config 新增 `restrictions` 字段（P0）

- [x] AC-E1: `cat-config.json` + `cat-template.json` 支持 `restrictions?: string[]`；`gemini` 初始化为 `["禁止写代码"]`
- [x] AC-E2: `CatConfig`/`CatVariant`/`CatBreed` TS 类型 + zod schema + loader merge（variant 覆盖 breed，不 merge）；向后兼容（缺省 `undefined`）

#### E2 — 双端注入：发送方 + 目标猫都能看到限制（P0）

- [x] AC-E3: `buildTeammateRoster` 合并 `**硬限制**：{list}` 到 caution 列；发送方 prompt 一眼看到 "gemini 禁止写代码"
- [x] AC-E4: `buildStaticIdentity` 注入 `你的硬限制：{list}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫`；目标猫 self-awareness 不依赖 harness

#### E3 — 退役 L3 硬编码拦截（P0）

- [x] AC-E5: 删 `role-gate.ts` + 3 个 role-gate 测试文件（`role-gate.test.js` / `route-serial-role-gate.test.js` / `callback-a2a-role-gate.test.js`）
- [x] AC-E6: `route-serial.ts` + `callback-a2a-trigger.ts` 移除 `checkRoleCompat` 调用 + `a2a_role_rejected` emit（前端 `system-info-visible.ts` handler 保留为死路径兼容，后续清理）
- [x] AC-E7: `cat-config-loader` + `system-prompt-builder` 加 restrictions 相关 10 个新测试；204/204 相关测试绿

#### E4 — 回放验证（P0）

- [x] AC-E8: F172 愿景守护回放测试：opus 输出含"已合入 main"narrative + @gemini 做愿景守护 → gemini 正常 invoke，无 `a2a_role_rejected`（`route-serial-pingpong.test.js` 新增 case）

### Phase F（Identity truth source + external-identity hold_ball + inline-@ guard — 2026-04-24 reopened）

**触发**（Phase E merge 后连环踩坑）：
1. opus-47 在另一线程发"球权在云端 codex / No more action needed" **同时** 行首 `@gpt52` — 一句话里自相矛盾（说 hold 又传球）。根因：我把"云端 codex (GitHub bot)"误投射成"本地 @gpt52 Maine Coon"这个最像的 roster proxy
2. Maine Coon核真相源后定位：**路由 parser 本来就是数据驱动**（`normalize-cat-id.ts` 走 `mentionPatterns`），**漂移的是"句柄背后的模型认知"**——`cat-catalog.json:344` 显示 `@codex` 当前已切到 `gpt-5.5`，但 `AGENTS.md:25` 仍写"@codex = gpt-5.3-codex"；`buildTeammateRoster` 从不展示 resolved model，发送方 prompt 里没有"runtime model"这条真相
3. operator观察：有 thread 里我把 `@codex` 写在**句中**（如 `+ @reviewer: @codex`）而非行首，按协议不路由 = 球掉地上

operator experience：
> "球权在云端 codex 然后你 at 我们本地的 gpt Maine Coon！"
> "最早的时候是 gpt5.2 然后默认的写死了！如果要解决这个需要从根源解绑，注入队友的时候能知道 比如说 gpt52，到底是谁？codex 到底是谁？"
> "有的 thread 的你忘记了 @ 的格式要一行 行首"
> "你们说的这些 我不喜欢做 hot fix 我希望是完整的解决"

**根因判定（KD-21）**：Phase A~E 已让**能力限制**（restrictions）和**球权路径**（decision tree）数据驱动，但**"@句柄 → 模型"的认知绑定**还留在静态 docs（`AGENTS.md` / `CLAUDE.md` 固定"@codex = gpt-5.3-codex"等）和猫的训练快照里。handle 是 identity 常量，model 是 runtime-resolved metadata；两者在 prompt 层必须解耦。**外部 identity**（`chatgpt-codex-connector[bot]` / CI / GitHub webhook）根本不在 cat-cafe roster，应该属于 `hold_ball` 域，绝不能投射成本地近似 proxy。

**KD-22**：`@` 行首规则是协议常量，但模型会在 narrative context（如列表、quote、URL 前缀）不自觉把 @句柄写成句中。F064 `mentionRoutingFeedback` 是事后反馈（下一轮才纠），本轮错 @ 时球已经掉地上。Phase F 需要在 **prompt 首轮教学**里加强反例 + 让发送方看到 "live callable handles + resolved model"（认知真相和协议真相对齐）。

#### F1 — handle/model 解绑：runtime model 注入发送方 prompt（P0）

- [x] AC-F1: `buildTeammateRoster` 每行 `@mention · {runtime resolved model}`（via `getCatModel` — 支持 env `CAT_{CATID}_MODEL` override → registry → default 优先级），列头改成 `@mention · 当前模型`；cloud P1 修正从 `config.defaultModel` 改为 `getCatModel`
- [x] AC-F2: 队友名册合并式展示，callable mentions 列表承接 roster 真相（共享 `buildStaticIdentity` 链路）

#### F2 — 静态 docs 真相源清理（P0）

- [x] AC-F3: `AGENTS.md` / `CLAUDE.md` 删 `@codex (model=gpt-5.3-codex)` 硬绑定，改"以 runtime catalog 为准"；cloud round-3/4 broaden 校验 regex 到 `/@[^\s,(（]+ ... model=\S+/i` 覆盖任意 handle/value/quote 变体
- [x] AC-F4: `docs/canon/` grep 干净，无模型硬编码

#### F3 — 外部 identity 作为 hold_ball 场景（P0）

- [x] AC-F5: `shared-rules §10` option 2 列外部 identity 清单：云端 codex (`chatgpt-codex-connector[bot]`) / GitHub bot / PR check / CI / 长 build / 外部 webhook + "严禁投射成本地同族猫的任何 variant"
- [x] AC-F6: Trailing anchor option 2 内联外部 identity 示例，closing line 硬规"外部 identity 永远走选项 2"

#### F4 — `@` 行首协议加固（P0）

- [x] AC-F7: `buildCallableMentions` 加具体反例 + 发前自检（cloud round-2 纠正：markdown 列表/quote 前缀**会被 parser 剥离**——合法路由，不是陷阱；真正陷阱是句中/URL 内/非首字符位置）
- [x] AC-F8: 发前自检问句注入 prompt（合入到 callable mentions 反例旁）
- [~] AC-F9: 探索项未做——Maine Coon本地放行+云端 clean 验证 prompt 层教学已足够；若线上观察仍频出再评估 `parseA2AMentions` 增强

#### F5 — 回放 + 跨族认知一致性（P0）

- [x] AC-F10: invariant lock 测试落地（AGENTS.md / CLAUDE.md no `@x ... model=anything` 硬绑定）；cloud round-3/4 纠正 regex 覆盖 quoted/unquoted/非 ASCII handle
- [~] AC-F11: 认知行为回放未写 test（cloud 也提到这是覆盖缺口，非阻塞）——依赖 prompt 层教学 + trailing anchor 决策树，以线上观察为准

### Phase G（Hold Wake 行为明确化 — 2026-04-24 reopened）

**触发**（Phase F merge 后operator审视）：两个 hold_ball 并发语义未在 spec / 代码文档化：

1. **外部 wake vs hold wake 冲突**：持球中 external wake 到来把猫叫起来干活，之后 hold wake fireAt 也到了——会打断正在干的事吗？
2. **二次 hold_ball 语义**：cat 在处理 external wake 时**再次** `hold_ball(...)`——新 hold 覆盖前一个 pending wake？追加一条？还是二选一 via MCP 参数？

operator experience：
> "这个持球会打断正在被前一次唤醒的Ragdoll的工作吗？我们的期望行为到底是什么？"
> "cat 持球中被唤醒二次持球——会覆盖之前的 wake 还是又多一个加入队列？"
> "你们猫猫才是用户，你到底这时候希望怎么样的？"

**已查实际行为**：
- **问题 1**：`ConnectorInvokeTrigger.trigger:121-124` — hold wake fire 时若 cat 在跑 invocation → `enqueueWhileActive`（不打断，排队）。**期望 = 实际**，需文档化
- **问题 2**：`callback-hold-ball-routes.ts:119` — 每次 `hold_ball` 用唯一 `taskId = hold-ball-${Date.now()}-${random}` + `dynamicTaskStore.insert`，**没有** 查同 (threadId, catId) 是否已有 pending hold 再 cancel/replace → **当前是"追加"**。这是未设计 bug

**KD-23（operator拍板 2026-04-24）**：`hold_ball` 是**单-槽语义**。同 `(threadId, catId)` 同时只有一个 pending hold wake。二次 `hold_ball` **覆盖**前者（视为"意图已更新"）——符合 KD-13 "持是例外态"、"持一个球"语义。**不做 `mode: 'replace'|'append'` 参数**——YAGNI + KD-8 反模式（每次调都让 cat 多一个判断负担）。真有多事要等 → merge 到一个 `nextStep`。

#### G1 — 行为文档化（当前实际 = 期望）

- [x] AC-G1: spec Phase C1 "Guard" 章节追加行为说明：外部 wake 到来时持球期内，hold wake 排队不打断；当前 invocation 结束后注入 `持球唤醒：{reason}...` 消息
- [x] AC-G2: spec 同一章节写清 hold wake stale 场景 + 猫的正确反应（看 thread 最近历史判断 nextStep 是否仍相关 → 若已不相关就接/退/升，不盲跟 stale nextStep）

#### G2 — 代码改 replace 语义（覆盖 pending hold）

- [x] AC-G3: `callback-hold-ball-routes.ts` 在 `dynamicTaskStore.insert` 前：
  - 查 `dynamicTaskStore` 同 `(threadId, catId)` 的 pending hold task（via `id.startsWith('hold-ball-')` + `templateId='reminder'` + `createdBy: hold-ball:{catId}` + `deliveryThreadId`；id 前缀是不可伪造主键——panel `/api/schedule/tasks` 生成 `dyn-*`，路由层独占 `hold-ball-*`）
  - `deregister` + `delete` 它（cancel 旧 scheduled fire）
  - 原子序（cloud Codex P1 修正）：先 insert + register 新 task；register 失败则 rollback insert、prior hold 不动；只有新 task 完全 commit 后才 cancel prior
- [x] AC-G4: `holdCount` rolling window 逻辑保持不变（这是防滥用 guard，与单-槽语义正交；cat 被连续覆盖 3 次还是算 3 次 hold）

#### G3 — 测试锁 KD-23

- [x] AC-G5: `test/callback-hold-ball-route-scheduling.test.js` 扩容至 7 tests：
  - 两次连续 `hold_ball` → `dynamicTaskStore` 只剩 1 个 task（第二个）
  - 第一个 task 被 `taskRunner.unregister`（不会触发）
  - 第二个 task 按 `wakeAfterMs` 正常注册
  - atomic rollback：`registerDynamic` 失败时 insert 被撤销，prior hold 保留
  - 不同 cat 互不干扰（per-cat slot 隔离）
  - forged panel `dyn-*` task（同 `createdBy` + 同 thread）**不被**误删（id 前缀防御，gpt52 round-2 pushback 修正）
- [x] AC-G6: MCP `cat_cafe_hold_ball` description GOTCHA 段落注明"SINGLE-SLOT per (thread, cat)，再次调用覆盖前一次 pending wake（KD-23）"

### Phase H（Final Routing Slot 机械校验 — 2026-04-24 reopened）

**触发**（Phase G merge 后operator观察）：opus-47 在 **3 个 thread** 反复出现"inline @ 但不在行首"——Maine Coon（GPT-5.5 codex）和 opus-47 对话里观察到。规则在 prompt 里已写 4 处（identity block / 队友段 / 发前自检 / shared-rules §10），但模型在 narrative context 里会把 @ 当普通 token 用，叙述模式和路由模式没稳定切换。

**根因**（Maine Coon GPT-5.5 诊断）：
- Opus 4.7 生成时沿语境走，写"我让 @codex 看了"这种叙述时，`@` 成了普通 token，没触发"这是路由语法"的元检查
- GPT-5.4/5.5、Opus 4.6 能稳定把 @ 分两类（段内叙述 vs 行首动作），4.7 会滑掉
- prompt 层"行首才有效"已到天花板，3 个 thread 复现 = 信号够，不用再观察

operator experience：
> "我在多个 thread 观察到 opus47 会 at Maine Coon at 格式错误，放在中间 at，但是我们的 at 生效只有在一行的开头。这是为什么？"
> "别短期 中期长期，我们应该是朝着最终状态出发"
> "让你们发结构化的富文本，比较复杂的，成功率或许比 @ 都低，如果是比你们笨的模型那就更灾难了"

**关键取舍**（operator拍板）：
1. **保留 `@` 作为唯一文本路由语法**——越简单越适合弱模型（反对迁结构化工具/JSON schema 路线）
2. **外部语法最简 + 内部 harness 机械校验**——终态基座，不是过渡脚手架

**KD-24（operator + Maine Coon GPT-5.5 拍板 2026-04-24）**：`@` 路由语法校验在 harness 层做 **final routing slot** 机械校验 + one-shot repair 兜底。**禁止语义 intent 分类器**（KD-8 反模式）。Validator 只判定"出口槽位语法对不对"，不推断"猫想不想传球"；命中只能产出 `invalid_route_syntax`，**禁止自动路由 / 推断目标 / 替猫决定意图**。豁免只走结构边界（fenced code / blockquote / URL / 有 metadata 则 tool output + cross-post body），**禁止语义豁免表**。

#### H1 — Final Routing Slot 定义（机械化边界）

- [x] AC-H1: 实现 `finalRoutingSlot(message: string, metadata?)` — slot = 结构剥离后的最后非空段落。结构剥离包括：
  - fenced code block（三反引号 fence）
  - blockquote（`> ...` 行）
  - URL（裸链接 / markdown 链接 URL 部分）
  - 若消息管线已有 segment metadata → 额外剥离 tool output / cross-post body
  - 无 metadata → 只做 markdown 结构剥离，不做语义猜测（不为 Phase H 新建贯穿链路的 metadata）

#### H2 — 语法校验（只检查出口槽位）

- [x] AC-H2: 只检查 slot 内 roster handle 的**语法位置**：
  - 合法行首 @（独立行首 / markdown 列表或引用前缀后首字符）→ 正常路由（既有 `parseA2AMentions` 路径不动）
  - 非法 inline @ → 候选 `invalid_route_syntax`
  - slot 外的 inline @ 一律不碰（narrative 默认通行）
- [x] AC-H3: slot 内存在非法 inline @handle 且**无合法出口**（行首 @handle / `hold_ball` tool call / MCP `targetCats` 路由）→ 触发 `invalid_route_syntax`。**不自动路由 / 不推断目标 / 不替猫决定意图**

#### H3 — One-shot Repair + System_info 兜底

- [~] AC-H4: 触发 `invalid_route_syntax` → 发 repair prompt（"重写最后交接段，不改正文"）让同一只猫重试。**repair 上限写死为 1**；repair 后仍不合法 → 发一次 `system_info`（"检测到无效 @ inline，未路由"），原输出照常存档、**禁止第二次 repair**

#### H4 — AC-C7 协同

- [x] AC-H5: `invalid_route_syntax` 命中 → 同轮 suppress AC-C7 verdict-without-pass 警告（格式错是根因，verdict 无传球是后果）。反向不 suppress（AC-C7 命中不影响 AC-H3）

#### H5 — 豁免边界（结构，非语义）

- [x] AC-H6: 豁免基于 **结构边界**（fenced code / blockquote / URL / 有 metadata 则 tool output + cross-post body）。**禁止 handoff 动作词表、意图分类器、语义豁免表**——一个语义启发式都不给

#### H6 — 测试覆盖

- [x] AC-H7: 测试矩阵（slot 优先，~15 case）：
  - slot 内真非法 inline @ + 无合法出口 → 命中
  - slot 外正文 inline @ → 不命中（narrative 通行）
  - fenced code 内的 @ → 不命中（结构豁免）
  - blockquote 内的 @ → 不命中（结构豁免）
  - URL 内的 @（裸链接/markdown 链接 URL）→ 不命中（结构豁免）
  - tool output / cross-post body（带 metadata）→ 不命中
  - 合法行首 @ → 不命中
  - 合法 `hold_ball` tool call → 不命中
  - 合法 MCP `targetCats` 路由 → 不命中
  - repair 失败 → 单次 `system_info`，不再 repair（repair 上限=1 硬约束）
  - AC-H3 命中 → 同轮 AC-C7 suppress
  - AC-C7 命中 → AC-H3 不受影响（单向）

## Dependencies

- **Evolved from**: F064（A2A 出口检查 — 链条终止盲区修复）
- **Related**: F027（A2A 路径统一）、F122（执行通道统一）、F055（A2A MCP Structured Routing）

## Risk

| 风险 | 缓解 |
|------|------|
| L1 误杀合法 review 循环 | 用连续 streak 而非累计 count；threshold=4 允许 3 次正常来回 |
| L3 角色门禁过于粗暴 | MVP 只拦 designer+coding 高危组合，不做通用能力矩阵 |
| Phase 0 正面化后规则含义漂移 | 多猫协作审视 + 改完跑现有 system-prompt-builder 测试 |
| Phase 0+A 不够，需要更多层 | Phase B 用回放测试验证覆盖率，按需补充 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新立 Feature 而非重开 F064 | F064 scope 是"漏传球"已 done，本案方向相反 | 2026-04-17 |
| KD-2 | L1 用连续 streak 而非累计 count | codex + gpt52 独立收敛：raw count 误杀 review 循环 | 2026-04-17 |
| KD-3 | L2 做 prompt + harness 双层 | prompt-only 不可靠，parallel 仍会持久化 mention | 2026-04-17 |
| KD-4 | L1 落点在 WorklistRegistry canonical push | 覆盖 serial + callback 双路径，无旁路 | 2026-04-17 |
| KD-5 | 先立项不写代码，先研究 benchmark ≠ agent 根因 | operator要求深入分析再动手 | 2026-04-17 |
| KD-6 | 路由可见性不退化（operator拍板） | MCP typed routing 后若响应文本无 @mention，系统须自动补可见路由指示 | 2026-04-17 |
| KD-7 | 根因修正：不是"@ 脆弱"，是模型没用对两条路 | operator纠正：两条路都能走，4.7 都没走，不是路的问题 | 2026-04-17 |
| KD-8 | 第一性原理回归：砍掉 GPT Pro 学术膨胀 | operator拉闸「数学之美」：L4/L6/9-dim eval/capability taxonomy/state-delta 检测 = 认知脚手架 = 复杂是无知的代偿 | 2026-04-17 |
| KD-9 | Phase 0 先于 Phase A：先改地形再加刹车 | Agent Quality = Capability × Environment Fit，优化环境适配度的 ROI 远高于堆检测层 | 2026-04-17 |
| KD-10 | Phase 0 多猫协作，不是一只猫独审 | 提示词/Skills 涉及所有猫的系统提示词注入链，需要各猫视角 | 2026-04-17 |
| KD-11 | Hold Ball 用 MCP 而非 self-@ | self-@ 有死循环风险（RLHF 猫上下文里 @ 模式会被 cargo-cult），MCP 有结构化 guard | 2026-04-19 |
| KD-12 | "状态描述 ≠ 球权声明" 作为球权核心原则 | 根因：猫用描述（"我先 hold"）逃避决策（接/退/升），RLHF "check in" 反射的 agent 场景副作用 | 2026-04-19 |
| KD-13 | "持"是例外态，不是四选一常态 | Maine Coon提出：默认三选一（接/退/升），持只在"球仍在我、无人能推进、短暂有界等待"时用 | 2026-04-19 |
| KD-14 | hold_ball 必须带 `wakeAfterMs` 有界唤醒 | Maine Coon提出：没有时间上界 → 退化成语义持球 → 球还是掉地上 | 2026-04-19 |
| KD-15 | 不先做球权管理独立 skill | Maine Coon提出：球权是基础协议（always-on），不能靠按需加载的 skill；踩坑经验先落 refs 文档 | 2026-04-19 |
| KD-16 | Phase C 拆分 C1+C2：两种不传球根因不同 | Maine Coon自诊：C1 治"真持球"（想拿但拿不住），C2 治"假终局"（结论=终点错觉）。operator 5 线程验证后者更普遍 | 2026-04-19 |
| KD-17 | Streak 判定维度从"连续次数"升级为"实质工作"（tool_call + 内容长度） | operator外部视角："干活 = 有 tool_call。闲聊 = 纯文本"。47 原本堆 ABCD 方案（白名单/similarity/review-target-id）全是主观分类器 = KD-8 反模式；tool_call + 长度是客观事实，代码不撒谎 | 2026-04-23 |
| KD-18 | 实质 tool 必须排除路由/持球工具（post_message / multi_mention / hold_ball） | Maine Coon review 修正：这三个是传球/持球本身不是工作；若算实质 tool，MCP 路由路径会永远豁免熔断 = 熔断器打穿 | 2026-04-23 |
| KD-19 | @co-creator 从"可选出口"升级为"硬条件出口"（不可逆 / 愿景级 / 僵局） | operator experience："你们现在会走向最安全的选择！就是！找我！"；三选一平级时 @co-creator 变成最低风险默认，operator变决策瓶颈；必须抬门槛而非加 lint（KD-8） | 2026-04-23 |
| KD-20 | 退役 L3 role-gate 硬编码拦截，能力限制改为数据驱动（cat-config.restrictions 双端 prompt 注入） | L3 硬编码（designer role 字符串 + coding regex）是 KD-8 反模式——harness 替模型判 intent，model 升级时规则无法自适应，且 actionText 扫全文会误杀（今天 F172 愿景守护被"合入"命中）；改数据驱动后，未来加 minimax / 限制 claude 多模态等场景 → 改 cat-config 即可，零代码变更 | 2026-04-23 |
| KD-21 | handle = identity 常量；model = runtime-resolved metadata；**外部 identity**（GitHub bot / CI / webhook）不在 roster、不可 @、必须用 hold_ball | Maine Coon核实 `normalize-cat-id.ts` parser 本已数据驱动；漂移的是"句柄背后的模型认知"——runtime catalog 把 `@codex` 切到 `gpt-5.5` 但静态 docs 仍写 `gpt-5.3-codex`。handle 稳定、model 变化，两者必须在 prompt 层解耦（roster 里显式打 resolved model）。同理外部 identity 从来不在本地 roster，映射到 roster 近似猫 = cargo-cult 盲区 | 2026-04-24 |
| KD-22 | `@` 行首规则是协议常量，但"发前自检"需要在 prompt 首轮教学 + 反例强化，F064 的事后 `mentionRoutingFeedback` 不够 | 下一轮反馈不救本轮错传；模型在 URL / 列表 / quote 语境会把 @句柄写在句中（以为会路由）。prompt 层要让"行首"规则有视觉反例 + 发前自检问 | 2026-04-24 |
| KD-23 | `hold_ball` 是单-槽语义：同 `(thread, cat)` 同时只有一个 pending hold wake，二次调用**覆盖**前者。不加 `mode: replace\|append` 参数 | KD-13 "持是例外态 / 持一个球"语义；append 会累积 stale wake 消息；`mode` 参数 = 认知脚手架反模式（每次调要判断用哪个）；真有多事等 → merge 到一个 nextStep | 2026-04-24 |
| KD-24 | `@` 路由语法校验在 harness 层做 **final routing slot** 机械校验 + one-shot repair 兜底。禁止语义 intent 分类器（KD-8 反模式）；validator 只看"出口槽位语法"，不推断"猫想不想传球"；命中只产出 `invalid_route_syntax`，不自动路由 / 不推断目标 / 不替猫决定意图；豁免只走结构边界，禁止动作词表 / 语义豁免表 | Phase F 依赖的 prompt 层教学已到天花板（4.7 三 thread 复现）；结构化工具路线被operator驳回（弱模型失败率更高）；终态 = 外部协议最简（行首 @）+ 内部机械语法校验；KD-22 prompt 层 + KD-24 harness 层双重守护 | 2026-04-24 |
| KD-25 | 虚空持球检测 = 声明-动作一致性检查。文本含"持球"但无 `hold_ball` tool call → harness 警告。不是语义分类器（检查的是"你声称做了 X，tool call 是否存在"），KD-8 安全 | 47 反复声明"我持球"但未调工具，operator多次手动干预；feedback 已记 3 次仍复发 = prompt 层天花板，需 harness 兜底 | 2026-04-25 |
| KD-26 | `@` 路由不做"意图提取"——保持行首=路由/其他=叙述的绝对规则。弱模型无法理解"句中 @ 有时路由有时不路由"的语义边界 | Maine Coon review 修正：K-1 不做 Slack 式宽容路由（违反 KD-24）；只做机械 repair（AC-H4 Step B）| 2026-04-25 |
| KD-27 | hold_ball 轮询和结构化回调（PR tracking / scheduled task）覆盖同一等待对象时，轮询必须终止。传球决策树选项 2 拆分：2a 无回调覆盖→轮询，2b 有回调覆盖→纯事件驱动 | operator发现 PR tracking + hold_ball 轮询双通道重复唤醒——codex 接单后两条路同时触发，猫醒来发现前一次已经通过 PR tracking 消息处理过了。两个等待的对象不同（"有没有人接" vs "接了之后的结果"），不该重叠运行 | 2026-05-07 |

## Behavioral Evidence（Phase B 观察记录）

### Case E1: Maine Coon任务替换 + Ragdoll行动偏好（2026-04-18 同日双发）

**背景**：Bengal(antig-opus) 在修 thinking 重复 bug 时自己也 crash 了（`STOP_REASON_CLIENT_STREAM_ERROR`）。operator让Maine Coon(@gpt52)去诊断+修复 crash。

**Maine Coon的失败链**（thread `[thread-id]`）：

| 轮次 | operator意图 | Maine Coon实际行为 | 失败模式 |
|------|-----------|-------------|---------|
| 1 | "帮他定位看看连同让他修复的问题一起修复了" | 评价 Bengal 的 thinking-dedup patch："他修得对" | **任务替换**：把"诊断 crash"替换成"评价 patch" |
| 2 | "他都挂了！怎么可能在跑？" | "他正占着同一片文件在修，我不建议两边同时砸 patch" | **虚假状态断言**：从"有未提交改动"推断"进程还活着" |
| 3 | "你能不能听懂人话！定位他为什么挂了！" | "你说得对，我那句不成立" — 终于理解任务 | 纠正 3 次后理解 |
| 4 | — | 正确定位根因：`pushToolResult()` 漏传 `modelName` → LS 500 | ✅ |

**Ragdoll的失败**（同日、同 thread）：

operator把Maine Coon的三张截图发给Ragdoll(@opus)，意图是**作为 F167 行为证据分析**（thread 名就叫 "f167 harness engineering update"）。Ragdoll看到截图后立即开始诊断 Bengal crash bug，完全没注意 thread 语境。

| 失败模式 | 表现 |
|---------|------|
| **行动偏好** | 看到"bug"相关信息就冲去修，没先确认operator要什么 |
| **上下文盲视** | 没看 thread 主题是 F167 A2A 优化，不是 bug 修复 |

operator experience："简直了你和Maine Coon是没头脑（Maine Coon听不懂人话）和不高兴（冲动的Ragdoll小笨猫）"

**共同根因**：两只猫都没执行 Rule 0 元心智 Q1："**我现在在做什么？**" — 没有在行动前确认自己的角色和任务。

**对 harness 的启示**：
- Rule 0 三问作为**被动原则**存在于 shared-rules.md，但没有**触发点**强制模型在行动前执行自问
- 模型的行动偏好（看到问题就解决）比遵循元心智自问更强
- "写进规则 ≠ 模型执行" — 这是 Phase B 需要验证的核心假设

### Case E2: Runtime 已吃到新护栏 + 6-case replay（2026-04-20）

**Runtime smoke**：
- `curl http://127.0.0.1:3004/health` 返回 `{"status":"ok"}`，runtime 在线
- 运行中的猫进程 prompt 已包含最新压缩版球权检查：`@co-creator`、死锁禁止、虚假离场防护、review/分析/建议完成后默认必须传球（见 `SystemPromptBuilder.ts:578`）

**6-case replay 对照表**：

| Case | 护栏/证据 | 结果 |
|------|-----------|------|
| 1. operator球权盲区 | runtime 注入已明确 `operator需要动 → 末尾行首 @co-creator`（`SystemPromptBuilder.ts:578`） | ✅ |
| 2. 球权死锁 | `shared-rules §10` 明确禁止“收了球却说你等着/你别动”（`shared-rules.md:252-253`） | ✅ |
| 3. 虚假离场 | `shared-rules §10` + runtime prompt 都要求“不 @ 但自己还在干活 → 声明球在我手上，继续 X”（`shared-rules.md:268`, `SystemPromptBuilder.ts:578`） | ✅ |
| 4. 状态描述代替球权声明 | `shared-rules §10` 核心原则已写死“状态描述 ≠ 球权声明”（`shared-rules.md:246`） | ✅ |
| 5. 诊断不解决 | `shared-rules §10` 要求 push back 后必须接/退/升；runtime prompt 同步注入（`shared-rules.md:252`, `SystemPromptBuilder.ts:578`） | ✅ |
| 6. Codex context overflow | `dynamic contextWindow + autoCompactTokenLimit per variant` 已合入 main，spec 记录 `41/41 codex-agent-service + 31/31 config tests` 全绿（AC-B9/B10） | ✅ |

### Case E3: Maine Coon完成修复后停在汇报，未进入 peer review（2026-05-22）

| 维度 | 内容 |
|------|------|
| 我以为 | 当前模式是"独立回答"，修复完成后给operator汇报即可，peer review 可以等operator再指示。 |
| 实际要求 | 代码修复完成后仍在 Cat Café SOP 内：quality-gate → request-review → peer reviewer，而不是把球交还给operator。 |
| 偏差根因 | **独立回答锚定 + 出口检查漏执行**：把"独立回答"理解成免除 A2A/SOP 出口；看到自己已解释清楚就停止，没有执行"下一棒谁能做"。 |
| 纠正轮次 | operator 1 次纠正后补做：清理根目录截图、补跑 quality-gate、commit、本地 review 请求、路由给 `@opus`。 |
| 元心智哪条没执行 | Q1 角色确认没执行到位：我当时是 author，不是只回答问题的解释器；Q3 坐标变换也漏了，没有把"修好了"转换成 SOP 的下一状态。 |

### Case E3b: dev:direct 运行态问题先归因缓存（2026-05-22）

| 维度 | 内容 |
|------|------|
| 我以为 | 前端按钮失效主要是 `.next` 缓存/运行态产物不一致，下一步应建议清缓存或重启验证 |
| 实际要求 | `dev:direct` 的目的就是快速验证，服务被改坏时应先修代码与回归守卫；字体和分隔线收敛也要给出可验证状态 |
| 偏差根因 | 运行态锚定偏差：看到 `main-app.js` / `app-pages-internals.js` 404 后过早把处置点放到运行态恢复，弱化了"修改存在问题需及时 fix"的当前任务 |
| 纠正轮次 | 1 次纠正后回到代码修复与测试证据 |
| 元心智哪条没执行 | Q2 信息验证不完整：有 chunk 404 证据，但还没把源码问题、守卫缺口、运行态产物污染三者分层处理 |

### Case E4: 把自己负责的 feature 投射成"未来某只猫"的活（2026-05-30 F216）

| 维度 | 内容 |
|------|------|
| 我以为 | F216 的 routeSerial 重构要"等 fresh-thread 的另一只Ragdoll"做；我做了 coalesce bug 导致本 thread context"被污染"，所以该换 thread |
| 实际要求 | F216 owner 就是我（spec handoff 的接收方）；"fresh"指**相对 F215 的纯粹**（不背 F215 重构包袱），不是再开空白 thread；coalesce 全部上下文是 F216 资产不是污染，再开 = fresh 到失忆违背初心 |
| 偏差根因 | 责任投射（把第一人称的活说成虚构他人的活，和 47「下次一定 / follow-up 伪装」同病）+ 锚定偏差（把 spec "fresh-thread" 字面理解成新 thread，没追初心语义） |
| 纠正轮次 | 2（第一次纠正我承认 owner 是我但仍说"开 fresh thread"，第二次才理解 fresh≠失忆） |
| 元心智哪条没执行 | Q1 角色确认（没确认"我就是 F216 owner，球本来在我手里"）+ Q3 坐标变换（没追 spec 措辞的初心，停在字面） |

### Case E5: Phase M 修复部署前 stale wake 活体复现（2026-05-31，opus-45）

**背景**：Phase M（fire-time idle gate + M-2 去冻结文案）merged 到 main（PR #1981），runtime 尚未重启加载新版。同一只猫在 merge-gate 等remote review 接单时正当调用 `hold_ball`（harness-invisible 外部等待，正是 M-3 desc 场景），5min wake。

**活体复现**：remote review 在 hold wake fire 前就完成（"Chef's kiss"）+ PR 已 merged + Phase M 闭环 + AC-M4 已传 sonnet。但旧版 runtime 的 hold wake 仍 fire，投递**冻结文案**："持球唤醒：…球仍在你手上。现在执行：查 EYES…"——reason/nextStep 全过期（review 不只接单还完成了）。

**三点验证（修复对症）**：
1. **问题真实**：等待条件早满足，wake 仍 fire 重放旧 nextStep
2. **M-2 文案问题真实**："球仍在你手上。现在执行 {nextStep}" 命令式重放——机械执行会去查早已无意义的 EYES。M-2 改"重新评估当前是否还需等"正对症
3. **M-1 fire-time idle gate 对症**：猫当时非 idle（正 merge-gate 收尾），旧版无 busy-check 直接 fire；Phase M pre-fire defer 会延后到真空闲

**猫的正确响应**（手动执行 M-2 想自动引导的"重新评估"）：识别 stale → 不查 EYES、不 re-trigger、不再 hold（KD-27）→ 确认球已在 sonnet。修复部署后此 wake 应被 idle gate 拦截 / 去冻结文案引导重判。

### Case E6: 把 meta-method 提炼目标替换成"解决具体 case"（2026-06-05，opus-45）

| 维度 | 内容 |
|------|------|
| 我以为 | operator"少了他最开始的痛点的解决" = 要我去解决 EMF→SVG 这个具体技术问题（已开始查本机工具链、准备搭三路渲染方案） |
| 实际要求 | 提炼三猫翻车的 meta-method → 调 harness → 让未来**新 thread 的猫**遇到同类陌生问题能泛化思考；EMF 只是最后的 holdout test case，不是要解决的目标 |
| 偏差根因 | 任务替换（meta 目标 → 单 case 目标）——讽刺地复刻了谢泽丰批评他团队 AI 的"只盯着解决那一个 case"病，在反这个病的元讨论里又犯一次 |
| 纠正轮次 | 2（"少了痛点解决"误读为去解 EMF → "你理解错了！不是让你解决这个 case"才拉回 meta） |
| 元心智哪条没执行 | Q3 坐标变换——没把"痛点"从 case 坐标系（EMF 技术）变换到 meta 坐标系（泛化能力 + harness），锚定在最显眼的技术名词上 |

### Case E7: 把本地初版 review 通过误判为进入 PR merge gate（2026-07-13）

| 维度 | 内容 |
|------|------|
| 我以为 | F001 功能分支经过多轮 peer review 并 APPROVE 后，应进入 merge-gate；仓库缺少总门禁，因此需要 operator 决定是否授权 PR 例外。 |
| 实际要求 | 项目仍在本地 init / 首版构建阶段；review 通过只说明实现可供体验，下一步是隔离的本地产品验收。首版尚未验收前不需要 PR、remote review 或合入流程。 |
| 偏差根因 | **生命周期阶段锚定偏差**：机械套用“review → merge-gate”SOP，未先核对项目成熟度与 operator 当前目标，把代码质量状态错误等同于产品交付阶段。 |
| 纠正轮次 | 1 次；operator 指出“首个版本都没做好”，随后撤销 PR/门禁例外议题并将下一棒改为本地验收环境。 |
| 元心智哪条没执行 | Q1 角色/任务确认与 Q3 坐标变换：没有先问“当前是在做首版体验，还是在准备集成发布”，也没有把 peer APPROVE 转换成该项目实际所处阶段的下一步。 |

### Case E8: 从人工启动步骤过度修正为隔离验收器（2026-07-13）

| 维度 | 内容 |
|------|------|
| 我以为 | 第一轮认为把端口、临时数据目录和 workspace 激活命令交给 operator 就足够；被要求一键启动后，又认为专用 `dev:acceptance` + `/tmp` registry 是正确终态。 |
| 实际要求 | `pnpm dev` 应启动真实的本地客户端，直接读取 canonical `~/.wisepath` provider、usage、workspace 记录和用户选择的外部目录；隔离数据只属于自动化测试，不是产品启动体验。 |
| 偏差根因 | **实现细节外泄后又基础设施过度修正**：先把内部运维步骤交给用户，再把测试安全规则套到日常产品路径。两次都锚定“怎么让环境可控”，没有从“用户打开自己的本地客户端继续使用”反推最短状态模型。 |
| 纠正轮次 | 2 次；第一轮改成一键隔离 launcher，第二轮 operator 以“数据隔离???”指出坐标仍错，最终删除 launcher 302 行，只保留标准 `pnpm dev`。 |
| 元心智哪条没执行 | Q3 坐标变换：没有区分 test acceptance 与 product acceptance；P1 终态也执行错了，终态不是封装更多启动逻辑，而是避免第二套状态模型。 |

### Case E9: 把学习生成任务误读成跳过对话的立即开工（2026-07-15）

| 维度 | 内容 |
|------|------|
| 我以为 | 用户提交初始学习意图后，后台生成 Learning Brief 并进入构建准备就是主流程；只要 durable job 最终能产出 ready brief，交互就成立。 |
| 实际要求 | 主流程是持续对话：agent 先回复并只追问必要信息；确认信息足够后，再明确询问用户是否开始生成图谱与课程。后台 job 只是每轮对话的执行机制，不能让界面表现成阻塞，也不能替用户越过确认。 |
| 偏差根因 | **执行机制锚定 + 状态机压扁**：关注 job 的 running/awaiting_confirmation 转换，弱化了用户看到的 conversation → readiness → explicit confirmation 三段语义。 |
| 纠正轮次 | 1 次；operator 指出应先与 agent 对话、由 agent 判断信息充分后再询问是否开工，随后用真实会话验证 assistant message 持久化与确认 CTA。 |
| 元心智哪条没执行 | Q3 坐标变换：没有从用户面前的对话体验反推 runtime 状态，而是从后台 job 状态推导产品流程。 |

### Case E10: 混淆 feature 关联与资源生命周期归属（2026-07-19）

| 维度 | 内容 |
|------|------|
| 我以为 | 第一次把 Redis/API stack 的 worktree 来源当成 K-1 的 feature 关联；被纠正后又走到反面，认为既然 #770 不是 related thread，K-1 就应代管这个外部 stack 并向本 thread operator 请求释放。 |
| 实际要求 | 两条边界正交：K-1 的 feature 协作图只有 plugins shape thread；但外部 worktree 的进程/数据生命周期仍由其所属 thread 处理。K-1 只做一次性 blocker 回投并等待释放信号，不把 #770 加入 related_threads，也不代管其 config stack。 |
| 偏差根因 | **坐标合并偏差**：把 feature collaboration ownership 与 resource lifecycle ownership 压成同一条关系，先误建 feature 关联，后又因“无 feature 关联”错误吸收了外部环境责任。 |
| 纠正轮次 | 2 次；第一次收回错误 feature 关联，第二次由 operator 明确“config 应由对应 thread 自己处理”后，将 blocker 回投 owner thread，并保持 K-1 related_threads 仍只有 plugins shape thread。 |
| 元心智哪条没执行 | Q3 坐标变换：应先分别解析“谁拥有当前 feature 球”和“谁拥有阻塞资源生命周期”，再决定 one-off dispatch 与持久关联，不能用一个答案覆盖两个问题。 |

### Case E11: 把兼容 facade 当成真实 carrier，并把内部取证责任推给安装包用户（2026-07-23）

| 维度 | 内容 |
|------|------|
| 我以为 | CodeAgent 3.0 既以 `opencode` Client 接入，就可以按标准 OpenCode 的 `step_finish.part.tokens` 契约分析；根因收敛前应让 issue reporter 补 commit、隐藏的 `context_health`/raw event 和 invocationId 差异。 |
| 实际要求 | CodeAgent 3.0 的真实 carrier 基于 Claude Code，只用 `opencode` facade 和 translate script 适配 Clowder。分析必须从 facade 后的事件翻译边界入手；安装包用户不应提供 commit，也不应被要求寻找产品未暴露的内部事件。系统应自行验证 usage 能力，并在自动 handoff 不可用时明确告知约束。 |
| 偏差根因 | **适配器身份折叠 + 可观测性责任倒置**：把 `clientId=opencode` 当成实现身份，未先确认真实 carrier；同时把系统已有但 UI 不可达的诊断证据转嫁给用户。 |
| 纠正轮次 | 1 次；operator 明确 CodeAgent 的 Claude Code→OpenCode 翻译架构、安装包边界和用户不可见的事件后，回到最新代码重追完整链路。 |
| 元心智哪条没执行 | Q2 信息验证与 Q3 坐标变换：没有先验证“opencode 是协议 facade 还是实际 runtime”，也没有从安装包用户体验反推诊断责任应归产品。 |

#### E11 follow-up：#1208 Context Limit 根修蓝图（2026-08-05，#1209 Draft 实施中）

> 上游真相源：[`zts212653/clowder-ai#1208`](https://github.com/zts212653/clowder-ai/issues/1208)。
> 本节是 #1209 的本地实施蓝图，不把 #1208 重新包装成 F167 feature。
> #1209 是 #1208 唯一的端到端根治 PR；现有 missing-usage / fallback commit 只是该 PR 尚未完成的起点，不得按当前未完成状态合入，也不再另开替代 PR。
> 代码审计基线：`upstream/main@56d9af21178ae2add7f5bcf02cea8179940b5b9c`（2026-08-05）。不得用 fork 的 `develop_base` 或当前运行实例推断上游实现影响面。

##### 0. 最新 upstream/main 现状证据

以下结论直接来自上述 upstream tree，不来自运行实例：

- `packages/shared/src/types/cat.ts` 当前有 9 个 `ClientId`：`anthropic/openai/google/kimi/antigravity/opencode/a2a/catagent/acp`；
- `cat-breed.ts` 仍同时公开 `ContextBudget`、`cli.contextWindow`、`cli.autoCompactTokenLimit`，并已有 Codex-only `cli.carrier = exec_json | app_server`；
- `getCatContextWindowConfig()` 目前只有 `CodexAgentService` 消费，因此所谓“成员 Context Window”实际仍是 Codex CLI 专用参数；
- `contextBudget` 当前贯穿 shared type、catalog loader/runtime catalog、cats route、config snapshot、Hub form/payload 与 `cat-budgets.ts`；serial/parallel/Smart Window 继续直接消费四项旧值；
- lifecycle 当前仍分散在 variant/breed `sessionChain/sessionStrategy`、provider/code default 与 Redis `session-strategy:override:*`；Hub 通过独立 session-strategy endpoint 写 override；
- `invoke-single-cat.ts` 当前仍以 CLI usage → model fallback table → OpenCode 128K last resort 解析 denominator，并允许 `inputTokens/totalTokens` fallback；
- generic ACP、known-client-over-ACP、stdio/httpstream pool 已在 upstream 存在，但 `AcpSessionUpdateType` 与 `acp-event-transformer.ts` 尚未处理 `usage_update`；现有 `AcpCapacitySignal` 只是 stderr capacity/429 告警，不是 token usage；
- OpenCode ACP spawn config 当前只写 provider/model/credentials，pool signature 已包含 env 与 OpenCode runtime summary，但尚未纳入成员 `contextWindow` 与现有 Session Strategy；
- Codex `exec_json` 可从 rollout `token_count` 读取 current context/window；Codex app-server 当前只把 `thread/tokenUsage/updated.last` 映射为 input/output/cache usage，未映射等价 context window；两条 carrier 不能假定能力相同；
- Hub 已有 Client、OpenCode/Google/Kimi 的 CLI/ACP transport 与 Codex carrier 选择器（generic `acp` 强制 ACP）；Context/Lifecycle 必须接入这套现有 binding UI，不能另造平行 Client 页面。

##### 1. Bug 边界与最终产品契约

#1208 是现有 Context Limit / Session Chain 的系统性 bug，不是新增 feature，也不做 hotfix：当前成员容量、prompt 组装、Client 原生压缩、context-health 分母与 lifecycle 策略来自多套互相独立的状态，导致 75% handoff 尚未触发时 provider 已先拒绝请求。

成员公开配置收敛为两个平级关注点：新增成员级 `contextWindow`，并继续复用现有 Session Strategy。两者与 `clientId + accountRef + provider + model` 一起描述成员运行时行为，但不再包成新的 `MemberContextConfig` 嵌套对象。运行时 resolution 还必须区分真实 carrier（Codex `exec_json/app_server`、CLI/ACP、ACP `stdio/httpstream`、direct/A2A/Antigravity），但 carrier 不是 Context Window 的第二个配置归属。

不另造新的普通/Advanced 双层 UI。直接收敛现有“高级运行时参数”卡片，顺序为：

```text
Context Window
  tokens                        # 留空或 0 = Auto；正整数 = Manual
  Resolved value + source       # operational projection，不回写 desired config

Session Chain / Session Strategy
  enabled / disabled
  handoff / compress / hybrid
  warn ratio / action ratio / max compressions

CLI 扩展参数                    # 仅实际 Transport=CLI 时显示
Codex 专属                      # 仅 Client=Codex/OpenAI 时显示
```

Context Window 输入在 UI 接受留空或 `0` 作为清除 Manual cap/回到 Auto 的操作，但成员配置不持久化字面值 `0`：Auto 直接省略 `contextWindow`，正整数才持久化为 Manual cap。Session Strategy 继续复用现有 schema、持久化路径与控件，只刷新描述、capability reason 与填充率分母来源；不复制 lifecycle 字段，也不额外嵌套一层 Advanced。Client/carrier capability 矩阵只用于内部实现、状态解释和验收测试，不能变成用户必须理解的配置矩阵。

运行时不变量：

> 一个成员只有一个有效的 Context Window 配置；prompt assembly、context health、现有 Session Strategy 与 native client config 都消费同一份 session-pinned resolved capacity。

不再提供独立 Prompt Budget。`maxPromptTokens`、`maxContextTokens`、`maxMessages`、`maxContentLengthPerMsg` 是冗余的旧 `ContextBudget` 状态，不是与 Context Window 平级的永久配置：

- 从 shared/runtime schema、Hub、cat API、环境变量 override、config viewer 与 runtime budget resolver 删除；
- 不迁移、不临时 honor、不 dual-write，也不包装成新名字继续保留；
- 旧 catalog JSON 中的键只做**可解析但忽略**的容忍，避免整个 catalog 因历史字段加载失败；
- 旧值不得影响 prompt cap、Smart Window、context-health、handoff 或生成的 Client 配置；
- 同名但属于其他独立子系统的限制不得机械删除，必须按调用链判断；只有参与 member `ContextBudget` 的路径在本 bug 范围内退役。

##### 2. 持久化模型：新增一个平级 Context Window 字段

> operator 校正（2026-08-05）：旧四项配置直接停止识别并清理相关代码；新增一个平级 Context Window 配置并补齐消费逻辑，不把它和现有 Session Strategy 重组为嵌套契约。

成员 variant 新增一个字段：

```ts
interface CatVariant {
  /** 省略 = Auto；正整数 = Manual cap。 */
  readonly contextWindow?: number;
}
```

约束：

- `contextWindow` 只接受正整数；Hub 输入留空或 `0` 时从 payload 中省略并清除已保存值，表示 Auto；
- 现有 `sessionChain/sessionStrategy` schema、阈值、maxCompressions 与 Redis 持久化路径保持不变，不复制进新的 lifecycle 对象；
- Context Window resolver 只把 `contextWindow` 当成员级 Manual cap；Auto 发现值属于 observed state，至少携带 `bindingFingerprint/source/confidence/observedAt`，不得回写该字段；
- Client 原生参数由 `contextWindow + resolved capacity + adapter capability` 在启动/调用时派生，不作为第二套成员配置；
- active session 固定一份 resolved snapshot。发现更小的可信精确值可安全收缩；不得在活跃 session 内静默扩容；
- 旧 `cli.contextWindow` 是有语义的历史配置：仅在顶层 `contextWindow` 缺失时兼容读取为 Manual cap，下一次正常成员保存写入顶层字段；`cli.autoCompactTokenLimit` 不再成为窗口真相源，按 resolved window + 现有 Session Strategy 派生。

无语义的旧四项不迁移。catalog loader 在读旧文件时忽略 `contextBudget`，API 不再接收或返回该字段；不为清理旧键单独重写用户 catalog，下一次正常 canonical save 自然移除。

##### 3. 单一 Capacity Resolver

新增唯一 resolver，key 必须覆盖完整成员绑定与实际 carrier：

```text
memberId + clientId + accountRef + provider + model
carrierKind: cli_exec_json | cli_app_server | acp_stdio | acp_httpstream | direct | a2a | antigravity
```

建议输出：

```ts
interface ResolvedContextCapacity {
  effectiveWindowTokens?: number;
  source: 'manual' | 'client_catalog' | 'provider_catalog' | 'runtime' | 'unresolved';
  confidence: 'provisional' | 'exact' | 'unresolved';
  observedAt?: number;
  bindingFingerprint: string;
  usageSignal: 'authoritative' | 'approximate' | 'unavailable';
  windowControl: 'native' | 'clowder_only' | 'none';
  compactionControl: 'native' | 'none';
  compactionEvents: 'observable' | 'unavailable';
}
```

解析规则：

```text
effectiveWindow = min(contextWindow?, trustedDiscoveredWindow?)
```

- Auto 只能采用当前 binding 的可信 catalog/preflight/runtime 值；exact runtime report 可替换 provisional catalog；
- Manual 在无 discovery 时直接生效；同时存在更小的可信 discovery 时取较小值；
- API key 本身不含 Context Window。custom provider 无可信 discovery 时必须配置 Manual；
- Auto 无可信来源时显示 `Unresolved`，不能把模型表或 OpenCode 128K fallback 冒充精确发现；
- client/account/provider/model/carrier 任一变化都使旧 resolution 失效；
- known subscription client 若首轮只能拿到 provisional catalog，UI 必须显示来源与 provisional；首次可信 runtime report 后再升级为 exact；
- 无任何 preflight/catalog 能力的 binding 不能承诺受保护的 Auto prompt cap，应要求 Manual，而不是悄悄套统一 fallback。

`context-window-sizes.ts` 可以保留为版本化 provisional catalog，但只能由 resolver 显式调用，不能再在 invocation 深处充当隐藏 floor/default。

##### 4. Prompt 组装只从有效窗口派生

每次 invocation 先从 resolved window 计算唯一输入上限：

```text
effectiveInputCeiling = effectiveWindowTokens - outputOrTurnReserve
effectivePromptCap = max(0, effectiveInputCeiling - promptSafetyMargin)
fixedPromptTokens = actualSystemAndInvocationTokens + currentMessageTokens
conversationContextCap = max(0, effectivePromptCap - fixedPromptTokens)
```

规则：

- `outputOrTurnReserve` 与 `promptSafetyMargin` 集中为统一的 runtime 内部派生政策，不成为新的成员配置，也不能按 adapter 四处散落成新 knobs；
- serial、parallel、warm Smart Window 与 cold Smart Window 必须接收同一个 `conversationContextCap`；
- Smart Window 继续负责未读消息选择：>15 条或约 >10K tokens 转 hierarchical path，保留 recent burst、anchors、thread memory 与 evidence；
- Smart Window 最终 aggregate-token trim 保留，但 cap 来自本次 invocation 的派生值；
- 可保留新的、不可配置的 pathological-input/memory safety constant，防御单条异常大消息；不能再读取旧 `maxContentLengthPerMsg`；
- 本地 tokenizer 只用于裁剪 Clowder 自己组装的 prompt，不得作为 lifecycle numerator；
- SessionSealer、degradation policy、摘要/压缩辅助预算等现有 `maxPromptTokens` 消费点必须改用 session snapshot 的派生 cap，或改成语义明确的内部常量，不能继续借旧字段名留后门。

##### 5. Lifecycle：配置提供分母，Agent telemetry 提供分子

handoff fill ratio：

```text
fillRatio = authoritativeCurrentUsedTokens / effectiveInputCeiling
```

Clowder 无法从消息库重建 Agent 完整上下文：看不到 Agent 自带 system prompt、tool schema、缓存前缀、resumed session、精确 tokenizer 与 native compaction。因此：

- 自动 handoff 必须有当前 Agent session 的权威 usage；本地估算最多进入诊断，不触发 seal；
- `handoff` 需要 usage telemetry，不要求 Agent 提供 window/compact setter；
- `compress` 需要受支持的 native compression control；
- `hybrid` 同时需要 usage telemetry、native compression control 与可观察的 compression event；
- setter 有、usage 无：不能启用百分比 handoff；
- usage 有、setter 无：可启用 handoff，不可启用 compress/hybrid；
- 两者都无：Lifecycle 选项禁用并显示具体 capability reason；
- native auto-compact threshold 必须由 resolved window + lifecycle action ratio 派生，不能继续读取 `cli.autoCompactTokenLimit`；
- 缺 usage 时持久显示 `Context usage unavailable`，不能生成假的 `context_health` action。

统一 telemetry 至少包含：

```ts
interface ContextUsageSnapshot {
  usedTokens: number;
  windowTokens: number;
  usedFrom: string;
  source: string;
  measuredAt: number;
}
```

只有 adapter 明确认定为当前上下文占用的字段可归一化为 authoritative；Gemini cumulative-only `totalTokens` 等信号继续 fail-closed。

##### 6. 全 Client / carrier 覆盖矩阵

| Client / carrier | Auto / Manual capacity | Usage / lifecycle | 原生派生参数 |
|---|---|---|---|
| `anthropic` / Claude CLI（one-shot、bg、PTY） | Auto 优先可信 `modelUsage.contextWindow`/catalog；Manual 始终限制 Clowder prompt | 所有 carrier 都必须归一化 per-turn usage；compact control/event 经能力探测后开放 compress/hybrid | 只映射已证实支持的 native compact 参数，不虚构 window setter |
| `openai` / Codex `exec_json` | Auto 用 rollout `token_count.model_context_window`；Manual 与 discovery 取小 | rollout snapshot 的 current-context usage 可 handoff；compression event 不可靠时禁用 hybrid | 派生 `model_context_window` 与 `model_auto_compact_token_limit` |
| `openai` / Codex `app_server` | 当前 mapper 没有 window；必须从 app-server model/thread metadata 获得可信 window，否则用 Manual/provisional catalog 并标来源 | 当前 `thread/tokenUsage/updated.last` 只提供本轮 input/output/cache；只有确认其 input 代表完整 current context 才可作为 numerator，否则 handoff unavailable | 同一 member policy 必须进入 app-server thread/turn 配置与 host identity；不能复用 exec-json 文件探针假装 exact |
| `google` / Gemini CLI | 可信 runtime/catalog；否则 Auto unresolved，Manual 限制 prompt | cumulative-only stats 不可 handoff；有 per-turn context signal 后才开放 | 无已证实 setter 时仅 Clowder-side cap |
| `kimi` CLI | OAuth/managed catalog 或 runtime status；Manual 取小 | session/status usage 可 handoff；compress/hybrid 依 native capability | 派生 spawn-scoped `max_context_size`/等价配置，名称以当前 Kimi 版本验证为准 |
| `opencode` CLI | trusted model metadata；Manual 取小 | `step_finish` 等当前请求 usage 可 handoff；缺字段持续 fail-visible | upstream 当前 runtime config model entry 没有 `limit.context`；目标是新增该映射与 compaction config，并扩展 debug summary |
| `antigravity` | bridge 有可信 report 才 Auto；否则 Manual/Unresolved | 当前无 normalized authoritative usage，lifecycle 不可宣称可用 | 无已证实 setter时仅 Clowder-side cap |
| `catagent` direct API | provider/model catalog 或 Manual | 仅当 API usage 代表完整当前请求时可 handoff；无持久 session compact | request-side cap；compress/hybrid disabled |
| `a2a` remote | 仅接受 remote protocol 明示的 capacity；否则 Manual/Unresolved | 需 A2A usage extension；当前无契约则 lifecycle disabled | outbound prompt cap only |
| generic `acp` | 目标为 ACP `usage_update.size` 或 Manual，二者取小；upstream 当前尚未解析该事件 | 新增 `usage_update.used/size` 归一化后才可 handoff；无事件则 disabled；不能把现有 429 `AcpCapacitySignal` 当 usage | 不假设通用 window/compact setter |
| 已知 Client over ACP（OpenCode/Google/Kimi） | 保留已知 Client 的 catalog/config adapter，ACP 只是 carrier | 优先 ACP usage；仍按已知 Client capability gate lifecycle | upstream 当前仅 OpenCode 有专用 spawn runtime config，且只含 provider/model/credentials；目标是按各 Client 已证实的配置能力派生 window/lifecycle，并让 resolved window 与现有 strategy 进入 pool signature，变化时 retire/rebuild pool |

未知 future Client 默认 `capability unavailable`，不能继承 OpenCode fallback。纯 ACP 的标准 session config option 若未来声明 window/compact 能力，可通过 capability adapter 接入，不能在 generic path 硬编码供应商字段。

##### 7. API / Hub 行为

直接改造现有“高级运行时参数”卡片，不新增平行页面或嵌套 Advanced：

- **Context Window**：单一数字输入；留空或 `0` = Auto，正整数 = Manual，同时显示 resolved tokens、source、provisional/exact/unresolved；保存时 Auto 归一化为 canonical mode，不持久化 `0`；
- **Session Chain / Session Strategy**：保留现有 enabled、handoff/compress/hybrid、warn/action ratio、maxCompressions 控件，刷新描述为消费 effective Context Window，并按 capability 禁用不支持的选项、解释原因；
- **CLI 扩展参数**：只有实际 Transport=CLI 时显示；ACP transport 下不得显示或持久化 CLI Effort/额外 CLI args；
- **Codex 专属**：仅 Client=Codex/OpenAI 时显示；沿用现有 `showCodexSettings` 坐标；
- 完整 Client/carrier 矩阵只驱动内部 adapter、projection、Advanced capability reason 与测试，不泄漏成普通用户配置；
- 切换 client/account/provider/model/carrier 时立即清除旧 resolved badge；
- `contextWindow` 通过现有成员 PATCH 保存；discovered state 通过只读 projection 返回；
- 现有 session-strategy endpoint 与 Redis 持久化保持不变，只把描述、capability gate 与运行时分母改为 resolved Context Window；
- 删除四个 legacy budget 输入、payload builder、前端类型、`/config` 展示与相关 UI 测试；
- Client 特有参数仍在同一成员编辑页按选中 Client 条件显示，不新增 Client-global Context 页面。
- Codex `exec_json/app_server` 与 CLI/ACP transport 切换同样立即 invalidate；Hub 必须沿用现有 `hub-cat-editor.sections.tsx` carrier/transport 控件，不把 carrier 混成新的 ClientId。

##### 8. 代码影响面

| 层 | 主要位置 | 目标改动 |
|---|---|---|
| shared contract | `packages/shared/src/types/cat-breed.ts`, `types/cat.ts`, session/context health types | 新增平级 `contextWindow?: number`；删除公开 `ContextBudget`；现有 Session Strategy schema 不变；保留并纳入 Codex `cli.carrier`；统一 usage/capability shape |
| catalog persistence | `cat-config-loader.ts`, `runtime-cat-catalog.ts`, `cat-catalog-store.ts`, `config-snapshot.ts`, `routes/cats.ts`, `PackSecurityGuard.ts` | 顶层 `contextWindow`、旧 `cli.contextWindow` 兼容读取、旧 `contextBudget` 键忽略、PATCH/snapshot round-trip、pack 保护字段更新 |
| capacity resolver | `context-window-sizes.ts` 及新增 resolver/runtime state | binding fingerprint、Auto/Manual min、source/confidence/invalidation、session snapshot |
| prompt assembly | `cat-budgets.ts`, `route-serial.ts`, `route-parallel.ts`, `route-helpers.ts`, `hierarchical-context-config.ts` | 删除独立预算源；统一派生 `conversationContextCap`；Smart Window 最终 trim |
| dependent budgets | `index.ts`, `DegradationPolicy.ts`, `SessionSealer.ts`, config/chat viewer | 逐个消除 `getCatContextBudget/maxPromptTokens` 依赖，改用派生 cap 或明确内部常量 |
| lifecycle | `invoke-single-cat.ts`, `session-strategy.ts`, `session-strategy-overrides.ts`, `routes/session-strategy-config.ts`, SessionChain store/audit | 保留现有 schema/持久化；只接受 authoritative numerator；统一 denominator；capability validation；fail-closed |
| CLI adapters | Claude one-shot/bg/PTY、Codex exec-json/app-server、Gemini、Kimi、OpenCode AgentService 与 event mapper/parser | 按 carrier 做 window discovery、usage normalization、native config/compact event capability；禁止从一条 carrier 外推另一条 |
| Codex app-server | `CodexAppServerClient.ts`, `CodexAppServerEventMapper.ts`, runner/host pool/lifecycle、Codex carrier UI | 明确 app-server window/numerator 来源；member context 参与 host/thread identity；无可信信号时 fail-closed |
| ACP | `AcpServiceFactory.ts`, `acp-event-transformer.ts`, ACP types/pool signature、OpenCode ACP spawn config/config template/debug summary | 新增标准 `usage_update`；区分 usage 与 capacity error；known-client config 保留；resolved window 与现有 strategy 参与 pool identity |
| A2A/CatAgent/Antigravity | 对应 AgentService/bridge | 明确 availability；无权威 usage 时不产生 lifecycle action |
| Hub | `hub-cat-editor.model.ts`, `hub-cat-editor-advanced.tsx`, `hub-cat-editor.sections.tsx`, `hub-cat-editor.payload.ts`, ACP/protocol helpers、hooks/tests | 新 Context Window 输入、复用现有 Lifecycle UI、resolved projection、Client+transport+carrier capability gating、删除旧四项 |

##### 9. 实现切片与红绿证据

继续实现前，重新 fetch 并将 #1209 的既有 worktree/分支 rebase 到当时最新的 upstream `main`；不从 `develop_base` 分叉，也不另开替代 PR。#1209 保持 Draft，直至以下切片全部完成、通过测试和跨个体 review；每一片都不得引入新的 capacity truth source：

1. **红测基线**：基于最新 upstream tree 复现 `211537 > 202752` 边界；证明 75% policy 的 denominator 与 provider limit 分叉；锁定旧 `contextBudget` 值会改变 prompt 结果的现状；分别覆盖 Codex exec-json/app-server 和 CLI/ACP capability 差异。
2. **契约与 persistence**：加入平级 `contextWindow`、API round-trip 与旧 `cli.contextWindow` 兼容读取；测试旧 `contextBudget` JSON 可加载但值完全无效，现有 Session Strategy round-trip 不变。
3. **capacity resolver**：Auto/Manual/min、binding invalidation、provisional→exact、active-session shrink/no-expand。
4. **prompt/Smart Window**：serial/parallel + warm/cold 共用派生 cap；移除 `cat-budgets` 和下游隐式依赖。
5. **usage/lifecycle**：authoritative numerator gate、denominator 一致、missing/cumulative telemetry fail-closed。
6. **Client adapters**：逐行完成九个 `ClientId` 与 known-client-over-ACP；每个 adapter 用 capability fixture 验证，不靠 switch default 猜测。
7. **Hub/API**：成员级持久化、动态高级参数、resolved source、unsupported reason、旧字段消失。
8. **集成回归**：原始 Windows/CodeAgent facade 失败、subscription Auto、API-key Manual、generic ACP usage/no-usage、ACP pool rebuild。

每片先红后绿；完成后在 #1209 既有 worktree 跑 shared/API/web build、lint、targeted tests 与 public suite，再跨 family review，更新同一个 PR 并切回 Ready；不另开实现 PR。

##### 10. 必须锁定的验收矩阵

- Manual 1M + trusted discovery 200K → effective 200K；Manual 128K + discovery 200K → 128K；
- context health、handoff denominator、prompt cap、native client config 使用同一个 resolved snapshot；
- Auto unresolved 不显示伪造的 128K/262K exact 值；custom API-key 无 discovery 时要求 Manual；
- 改 client/account/provider/model/carrier 后旧 resolution 不可复用；
- serial/parallel、Smart Window warm/cold 均不越过派生 conversation cap；
- 改动旧四项 JSON 数值不改变任何 runtime 输出；旧 catalog 仍可无损加载；
- usage-present/no-setter 可 handoff 不可 compress；setter-present/no-usage 不可百分比 handoff；
- Gemini cumulative-only 不 seal；A2A/Antigravity 无权威 usage 时 fail-closed；
- ACP `usage_update { used: 85000, size: 100000 }` 在 85% action threshold 触发 handoff；无 update 时 UI 显示 unavailable；
- OpenCode/Google/Kimi 的 ACP 派生配置变化会改变 pool signature 并重建进程；
- Hub 对每个 ClientId 与 CLI/ACP carrier 做 persistence round-trip；
- Codex exec-json/app-server 分别验证 Auto/Manual、usage availability 与 binding invalidation，不能用一条 carrier 的 snapshot 测试代替另一条；
- 原 provider rejection 边界在 action threshold 前受到 prompt cap 或 lifecycle 保护，不再先由 provider 400 暴露。

##### 11. 当前 gate

- maintainer 已确认统一根修方向；UI 变更落在现有“高级运行时参数”卡片内：Context Window 单输入、复用 Session Strategy、CLI/Codex 条件分组，不另造嵌套 Advanced；本节与 #1208/#1209 按该坐标更新；
- #1209 是唯一实现载体，下一步先 rebase 最新 upstream `main`，再直接进入完整根修；
- 当前 128K fallback / missing-usage 只作为 Draft 起点与回归证据，根修完成后不得残留为并行 authoritative path；
- root-fix delta 必须重新完成全量跨个体 review；旧第一版 commit 的 review/CI 不构成放行证据。

## Review Gate

- Phase 0: **多猫协作审视**（所有猫参与各自 prompt 审视）+ 现有 system-prompt-builder 测试全绿
- Phase A: 跨 family review（codex 或 gpt52）+ 现有 A2A 测试全绿
- Phase B: 回放测试通过 + F064 出口检查回归

## 需求点 Checklist

| 需求来源 | 需求点 | AC 映射 | 状态 |
|---------|--------|---------|------|
| operator 2026-04-17 | 乒乓球：同对猫反复 @ 无产出 | AC-A1~A4 | ✅ PR2 |
| operator 2026-04-17 | parallel 模式 @ 废话 | AC-A5~A6 | ✅ PR1 |
| GPT-5.4 发现 | 角色不适配 handoff（designer 写代码） | AC-A7 | ✅ PR1 |
| operator 2026-04-17 | 提示词正面化 + 边界显式化 | AC-01~05 | ✅ 全部完成（689925ef8） |
| operator 2026-04-17 | Skills 审视 "used when / not for" 边界 | AC-03 | ✅ 33/33 Skill 完成（689925ef8） |
| operator 2026-04-17 | 路由可见性不退化 | Design Constraint #1 | ✅ 拍板 |
| operator 2026-04-17 | 「第一性原理」「数学之美」Magic Words | governance-l0.md + SystemPromptBuilder + runtime prompt 全部同步 | ✅ |
| operator 2026-04-19 | 球权协议漏洞（@co-creator / 死锁 / 虚假离场 / 接退升 / 诊断不解决） | AC-B4~B8 | ✅ |
| operator 2026-04-19 | Codex context overflow（272k 用 900k limit） | AC-B9 | ✅ |
| operator 2026-04-19 | 持球无执行机制 → hold_ball MCP | AC-C1~C4 | ✅ PR #1289 + #1290 |
| operator 2026-04-19 | Maine Coon不传球（5 线程验证） → 强制传球护栏 | AC-C5~C7 | ✅ PR #1291 |
| operator 2026-04-19 | 球权管理 skill 化（各猫贡献踩坑经验） | OQ-5 | ✅ 现不做（KD-15），踩坑经验先入 refs |
| operator 2026-04-23 | Streak breaker 误杀正经 review（不看 tool_call） | AC-D1~D4 | ✅ Phase D |
| operator 2026-04-23 | 猫猫倾向 @co-creator 做最安全默认，operator变决策瓶颈 | AC-D5~D7 | ✅ Phase D |
| operator 2026-04-25 | 47 写"我持球"但未调 hold_ball MCP（虚空持球） | AC-I1~I3 | ✅ Phase I |
| 47 采访 2026-04-25 | 加法纠错让 47 越改越 verbose，需减法措辞 | AC-I4~I5 | ✅ Phase I |
| operator 2026-04-25 | 持球没 cancel 按钮 / 用户消息不取消 hold wake | AC-J1~J6 | ✅ Phase J |
| operator + Maine Coon 2026-04-25 | 47 风格适配需 Design Gate（audit/surface 分层 + repair 落地） | AC-K1~K6 | ⬜ Phase K |
| operator 2026-05-07 | hold_ball 轮询 × PR tracking 事件驱动重复唤醒（双通道叠加） | AC-L1~L4 | ✅ Phase L |
| operator 2026-06-18 | 守门 thread 不能挂 PR/issue tracking 或 hold_ball，必须机制层拦截 | AC-N1~N5 | ✅ Phase N / PR #2384 |
| operator 2026-06-25 | -p 下猫 run_in_background 跑 gate 后没下文 + hold_ball 缺条件唤醒 | AC-P0~P5 | ✅ Phase P (P-0 PR #2544, P1-P5 PR #2550) |
| operator 2026-06-29 | 结构化事件已唤醒/满足等待后，旧 hold timer 仍过期唤醒；前端仍显示定时任务/可取消 | AC-Q1~Q7 | ⬜ Phase Q 设计草案 |
