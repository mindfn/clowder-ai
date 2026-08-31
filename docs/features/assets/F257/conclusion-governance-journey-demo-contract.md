# F257 Conclusion → Governance Journey Demo Contract

## 0. 一句话契约

- **Demo 名称**：Harness Ledger 治理闭环体验 Gate
- **demo_kind**：`journey_validation`
- **目标观众**：co-creator / operator
- **使用场景**：内部体验验收；必要时可确定性录屏复盘
- **观众复述句**：我看到 tracing 数据怎样经时间窗、指标与规则形成结论，系统怎样自动把结论变成治理候选，operator 怎样批准或带理由拒绝，并且两条路都回到下一评估回合。
- **希望观众接下来做**：按完整旅程给出“可用 / 需要调 / 不接受”的体验裁决。
- **主 claim**：代表性 operator 能看清 `数据/窗口/指标 → verdict → 自动 Candidate → 人类 approve/reject → 下一窗口`；approve 路径可中断恢复并验证 PatchTrial，reject 路径无干预且携带明确理由回到下一回合。
- **非目标**：不以演示数据证明生产调度、Redis 耐久性、真实用户流量效果或“拒绝理由已自动进入 evaluator”；这些分别由 PR #143 工程证据或显式后端触点续接。

## 1. 判题类型、交付车道与视觉真相

- **delivery_lane**：`internal_product_gate`
- **交付位置**：feature worktree 的当前 Web 产品；Browser Preview / 本机浏览器
- **visual_source_of_truth**：`LifelineChainView`、`ObjectiveEvaluationPanel`、`ApprovalDecisionCard`、`GenericApprovalRecommendation`、F056 semantic tokens；worktree `fix/f257-mainline-conclusion-writeback`
- **native_elements**：版本生命线、Objective 指标与结论、Approval Hub 决策卡、候选/试验 provenance、现有按钮与状态色语法
- **stylized_elements**：仅顶部的场景切换、播放/暂停、上一步/下一步与真相标签；它们不冒充生产控制面
- **dev_controls**：页面顶部独立虚线容器；可用“隐藏讲解控制”收起
- **truth_label**：常驻标注“功能原型 · 演示数据”；每一状态的 canonical contract 与真实测试锚点单列

- [x] 去掉 F 号、标题与开发控制后，画面仍由当前产品原生组件组成
- [x] 从真实产品组件和 token 开工，没有另造 SaaS 壳
- [x] Demo 控制与产品交互视觉分层，控制层可隐藏
- [x] 起始状态、目标结果与终态判据明确
- [x] 每个 handoff 有 canonical event / contract
- [x] 覆盖中断恢复与诚实失败路径
- [x] 不用总结卡代替状态迁移；演示状态与真实后端证据明确分层

## 2. 视角与主角

- **视角**：控制室 / operator
- **主角**：Harness Ledger 中的 Segment、ObjectiveJudgment、GovernanceCandidate 与 PatchTrial
- **受益者**：需要确认系统会发现、治理并验证重复偏差的 operator
- **操作者**：operator；系统自动完成 eval、candidate 创建与 re-eval
- **规约 owner**：版本化 Objective verdict rule；operator 只决定是否执行干预
- **裁判**：下一窗口的真实测量与 immutable trace hash，而不是“override 已写”本身

## 3. 信号路径

```text
Trace summary / structured counterexample
→ ObjectiveEvaluationRuntime commit
→ 明示 window + source refs + metric decisions + verdict
→ GovernanceWorker 自动解释 verdict 并创建 Candidate
→ operator 在 Approval Hub 批准或拒绝
→ approve: HookOverrideStore + PatchTrial / reject: Candidate approval note
→ 下一窗口 Objective evaluation
→ improved / inconclusive 的试验结论与 Candidate 终态
```

| 检查 | 答案 |
|---|---|
| 系统实际看得见什么？ | 版本化 Objective snapshot、window、MetricResult、trace source refs、Candidate 与 PatchTrial 状态 |
| 哪些信息它看不见？ | operator 未写入系统的私下判断；演示页不读取生产用户数据 |
| 是否存在只负责转发的 middle man？ | 无；post-commit hook 直接触发 GovernanceWorker，Approval Hub 投影 canonical Candidate |
| 反馈冲突时谁决定？ | operator 决定 approve/reject；Candidate CAS 决定并发终态归属 |
| 哪类信号必须拒绝或继续观察？ | evidence-only、证据不足、trace hash 未变化的 treatment sample 必须保持 inconclusive；operator 可带理由拒绝干预 |

## 4. 诚实边界

| 画面 / 数据 / 行为 | 概念编排 | 功能原型 | 真实证据 | 屏幕标注 |
|---|:---:|:---:|:---:|---|
| S13 / 3 个 counterexamples / hash | ✓ | | | 演示数据 |
| 上一步、下一步、自动播放、故障场景切换 | | ✓ | | 开发控制 |
| Lifecycle / Eval / Approval 原生组件 | | ✓ | | 功能原型 |
| Candidate 状态、resume-only、PatchTrial outcome | | ✓ | ✓ | 与 PR #143 E2E contract 同名 |
| reject note 写入 `Candidate.approval.note` | | | ✓ | 当前后端已持久化 |
| reject note 自动进入下一轮 evaluator | ✓ | ✓ | | 需要后端触点；不得标成已接通 |
| Redis CAS、production registrar、HTTP wiring | | | ✓ | 页面外续接测试/PR 证据，不在画面内伪造 |

统一角标：

> 本界面为功能原型，使用确定性演示数据；状态名、handoff 与恢复规则来自 PR #143 的真实契约，页面不连接生产数据。

### 本轮改动分层

- **纯展示 / 交互修正**：展开 evaluation evidence chain；标明 Candidate 由 worker 自动创建；只把 approve/reject 留给 operator；approve/reject 末尾都画回下一 tracing window。
- **已存在的后端触点**：reject route 接受 `note`，并以 exact-row CAS 持久化到 `Candidate.approval.note`；拒绝不会写 override 或创建 PatchTrial。
- **尚缺的后端触点**：下一次 Objective evaluation 尚不消费 `Candidate.approval.note`。Demo 把它显示为“下一轮评估上下文”的目标体验，并常驻标注“需要后端触点”，不能作为 production 接通证据。

## 5. 灵魂画面

- **无旁白截图也能表达的变化**：左侧 evidence chain 明示 `window → source refs → counter-zero → count=3 → retire-candidate`；生命线的 governance 端出现由 worker 自动创建、只等待 approve/reject 的原生审批卡。
- **画面左/前**：时间窗、snapshot、数据锚点、指标规则、measurement 与结论。
- **画面右/后**：同一 Candidate 的 operator 决策；失败场景显示 `resume-only`，拒绝场景显示理由并回到下一 tracing window。
- **观众看到后应说**：评估不是一句标签，governance 也不是用户手动启动；系统自动把有依据的结论交到人的审批边界，并把决定带入下一回合。
- **这一帧需要保留的真实细节**：Candidate ID、Objective/segment provenance、建议动作、baseline trace hash、operator authority。

## 6. Journey ledger

| # | actor | 起始状态 | 用户动作 / 系统信号 | canonical event / contract | surface | 下一状态 | 失败 / 恢复 | 验证证据 |
|---:|---|---|---|---|---|---|---|---|
| 0 | Harness | tracing | 第 3 个结构化反例进入窗口 | `TraceAnnotationCommitted` | Lifeline | eval ready | 证据不足时继续 tracing | trigger provenance |
| 1 | Eval runtime | eval ready | 按 window/source/metric/rule 原子提交 Objective judgment | `ObjectiveJudgmentCommitted(retire-candidate)` | Eval evidence chain | governance dispatch | rule 缺失时 inconclusive | snapshot + metricDecisions + verdictDecision |
| 2 | Governance worker | judgment committed | **系统自动**幂等创建候选 | `GovernanceCandidateOpened(proposed)` | Lifeline + Approval card | operator decision | 重放不得重复 Candidate；用户无需触发 governance | candidate ID + transition owner |
| 3 | operator | proposed | 批准 override 试验 | `CandidateDecisionApproved` | Approval card | executing | 拒绝则 settled、无 override/trial | actor + note |
| 4 | override executor | executing | 写入 disable override | `OverrideApplied` | Recovery / Trial | approved + trial | 首次写失败保持 executing + resume-only；重试同一 Candidate | single override call |
| 5 | evaluation runtime | trial open | 首个 treatment window 结束 | `PatchTrialEvaluated(inconclusive)` | Trial evidence | pending | hash 未变不能假称改善 | beforeHash = afterHash |
| 6 | evaluation runtime | pending | disabled-state 新窗口提交 | `PatchTrialClosed(improved, solidify)` | Lifeline + Trial | Candidate closed | stale worker CAS miss，不能重开 terminal | beforeHash ≠ afterHash |
| 7A | tracing runtime | approved trial closed | 开启下一 observation window | `TraceAnnotationCommitted`（下一回合） | Lifeline + Tracing | round 2 tracing | 不沿用旧 verdict 冒充新评估 | activeStage=tracing |
| 3B | operator | proposed | 填写理由并拒绝干预 | `CandidateDecisionRejected` | Approval card | Candidate rejected | 无 override / 无 PatchTrial | `Candidate.approval.note` |
| 4B | tracing runtime | rejected settled | 开启下一 observation window | `TraceAnnotationCommitted`（下一回合） | Lifeline + Tracing | round 2 tracing | note→evaluator 当前未接通，必须显式标注 | persistence / bridge truth label |

### 诚实失败路径

`executing → override write throws → Candidate 仍 executing → Approval Hub 显示 resume-only → retry → exactly one override + exactly one PatchTrial`。页面不得把失败隐藏成 pending，也不得要求 operator 再批准一次。

### 诚实拒绝路径

`proposed → operator 填理由 → rejected → no override / no PatchTrial → 下一窗口 tracing`。理由真实写入 `Candidate.approval.note`；自动进入 evaluator 是目标契约，当前页面必须标“需要后端触点”。

### 可判定终态

approve：Candidate=`closed`、PatchTrial=`improved / solidify`、treatment measurement=`counter 0`、before/after trace hash 不同；reject：Candidate=`rejected`、无 override/trial、reason 非空。两者 Approval Hub pending 均为 0，并显式回到 round 2 tracing。

## 7. 控场与节奏

- [x] 播放 / 暂停
- [x] 上一幕 / 下一幕
- [x] 左右方向键
- [x] 空格暂停 / 继续
- [x] 暂停冻结时间轴
- [x] 可切换 happy / interrupted-override 场景
- [x] 可切换 reject-with-reason 场景
- [x] 可隐藏开发控制

## 8. 验证与证据续接

### 自动检查

- 场景顺序与 canonical event 单调；Candidate ID 全程不变。
- recovery 场景失败后 `decisionMode=resume-only`、trialCount=0；恢复后 overrideCount=1、trialCount=1。
- 第一次 treatment hash 未变只能 inconclusive；第二次 hash 改变后才 improved/closed。
- Evaluation scene 展开 snapshot、时间窗、数据源锚点、metric rule/measurement/decision 与最终 verdict。
- Candidate scene 标明 `governance-worker` 自动创建；operator 可点击动作仅 approve/reject，正常 approve 不出现第二次“继续执行”。
- reject reason 非空、Candidate rejected、无 override/trial；approve/reject 末幕都回到 round 2 tracing。
- reject reason 的 persistence=`candidate-approval-note`，evaluatorBridge=`prototype-only`；页面常驻显示后端缺口。
- 页面使用真实 Lifeline / Eval / Approval presentation components；真相标签常驻。
- 键盘与控场状态可确定重放。

### 真实证据续接

- PR #143 exact HEAD 的 mainline E2E、真实隔离 Redis CAS 测试、production wiring 测试与 cross-family review。
- Demo 支持“operator 是否看懂并能完成决定”的体验 claim；测试/PR 支持“后端实际按同一契约执行”的工程 claim。
- 仍未验证：合入 fork 后的真实运行数据 soak、长期行为改善与真实 operator 决策。

### 2026-08-31 验证记录（本轮体验反馈 delta）

- Journey model + page interaction：18/18；红测先证明 evidence chain、自动 governance、reject reason 与双分支回环缺失，再实现转绿。
- 相邻 Lifeline / Eval / Approval 回归：114/114（7 files）。
- Web TypeScript：`tsc --noEmit` 通过。
- Biome changed-file check 与 `git diff --check`：通过；新页面无 lint warning。
- Production Web build：通过；新路由静态产出为 `/showcase/f257-governance-journey`。
- Production Web HTTP：`200`，SSR 载荷包含 truth label、reject 场景入口与首个 canonical event。
- 专用 Browser skill 控制通道本次未暴露；未用 Playwright / Computer Use 替代，因此逐幕视觉检查与 operator 复述仍是体验 Gate 的待签字项。

## 9. 完成判据

代表性 operator 能从明确的 window/data/metric provenance 读到结论，理解 Candidate 是系统自动生成而非用户触发；能分别完成 approve 与带理由 reject，并看到两条路回到下一 tracing window；能解释 interruption 后为何是“继续”而不是“再次批准”，也能指出 reject note→evaluator 仍是显式后端触点。
