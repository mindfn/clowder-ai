---
feature_ids: [F257]
topics: [harness-ledger, objective, evaluation, tracing, metrics]
doc_kind: implementation-plan
created: 2026-08-04
---

# F257 Objective Evaluation Redesign Implementation Plan

**Feature:** F257 — `docs/features/F257-harness-ledger.md`
**Goal:** 把 Harness Ledger 从“按时间窗给段分摊 guard 事件并显示伪违规率”重构为“invocation 全程 tracing、统一 trace annotation、Objective 自有评估规则、阈值/周期异步评估、append-only 指标结果”的可解释闭环。
**Acceptance Criteria:** AC-1 tracing 从 invocation 已有起点持续采集并在 terminal 时以 `invocationId/inputMessageId/outputMessageId/traceTurnId` 精确闭合；AC-2 MCP 只写 pending marker，不直接制造评估结论；AC-3 MCP、结构化规则、周期语义分析写入同一种 append-only annotation；AC-4 count 指标无需分母，Unit 内所有相关指标的去重反例 episode 合计达到 readiness 阈值即可触发；AC-5 rate/semantic/replay 指标各自显式声明输入和规则；AC-6 Objective 只保存静态定义与段挂靠，不引入 Objective 状态机；AC-7 scheduler 仅依据规则 readiness/阈值/时间窗调度，LLM 语义分析完全异步且不阻塞主流程；AC-8 evaluation snapshot 可重放，MetricResult append-only 回写；AC-9 旧 `SegmentJudgment` 时间窗归因与 `SegmentJudgmentCache` 不再作为评估或 Console 真相源；AC-10 23 个 Objective 与 46 个段/条款 100% 有唯一可寻址挂靠；AC-11 Tracing Console 展示 Unit 级时间窗、累计 episode、合并去重后的明确反例和真实回放，Eval Console 只展示各指标的评估方式、规则与结果；AC-12 旧的不合适派生评估数据不迁移、不兼容、不参与新结果，且不删除原始 tracing、message、thread 或其他用户数据。
**Architecture cell:** harness-eval
**Map delta:** update required
**Map delta why:** `harness-eval` 的当前 ownership cell 仍把 `SegmentJudgment`/时间窗 join/`SegmentJudgmentCache` 列为核心产物；本次要改为 TraceEpisode/TraceAnnotation/EvaluationSnapshot/MetricResult，并明确 tracing 与 eval 的边界。
**Architecture:** 现有 HookPipeline tracing 继续在 invocation 前半段采集 prompt exposure；terminal seam 只追加不可变的 episode closure。三类判定来源统一写 trace annotation sidecar，EvaluationIndexer 只消费 annotations 并按 manifest 纯投影到 Objective/Metric；scheduler 冻结 snapshot 后选择 code/LLM/replay evaluator，最终写 append-only MetricResult。主请求路径不运行 LLM，也不等待 eval。
**Tech Stack:** TypeScript, Redis/ioredis, Node test runner, YAML registry/manifest, React/Next.js Console
**前端验证:** Yes — reviewer 必须用 Browser/Playwright 实测 Eval 指标卡、Tracing 回放剧场和段编辑器。

---

## 0. Straight-line finish line

终态 B：任何 invocation 都能形成一个可回放 TraceEpisode；如果 MCP 或结构化规则已识别归属，terminal 后直接得到统一 annotation；未归属 episode 由后台语义 sweep 分类；每个 Objective 的 manifest 决定指标输入与评估规则；Unit 级 readiness 汇总同一 Unit 所有指标的明确反例，满足反例阈值或 tracing 窗口容量后自动生成可重放 snapshot 并写入 MetricResult。

Console 的职责边界固定如下：

- Tracing 回答“何时足够评估这个 Unit”：显示窗口起始时间、窗口内累计 TraceEpisode 数、合并去重后的明确反例数与反例记录，以及原始 episode 回放。
- Eval 回答“每个指标如何评估、结果是什么”：显示 evaluator、ruleRef、最近结果及其证据窗口，不重复渲染按指标拆分的调度进度或“下次触发”。
- manifest 中的 per-metric trigger 仍是 scheduler 的内部契约；它不等于 Console 上面向 operator 的 Unit readiness，也不能把同一 episode 因多指标命中重复计数。

不做：

- 不在主回复路径调用 LLM。
- 不让 tracing 决定 Objective、Metric 或 verdict。
- 不把所有指标强制压成 `numerator / denominator`。
- 不保留旧 objective id、旧 SegmentJudgment 或旧派生数据的兼容层。
- 不删除/flush Redis、SQLite、thread、message、raw trace 等持久数据。
- 不把 verdict 重新写入 Git/PR；继续使用 local artifact store。

## 1. Terminal schema

```ts
type MetricKind = 'counter' | 'rate' | 'semantic' | 'replay';
type AnnotationSource = 'mcp-marker' | 'structured-rule' | 'semantic-sweep';

interface TraceEpisodeRef {
  traceTurnId: string;
  invocationId: string;
  threadId: string;
  catId: string;
  inputMessageId: string;
  outputMessageId: string;
}

interface TraceTerminalExtension extends TraceEpisodeRef {
  terminalAt: number;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  outputText?: string;
  toolCalls: Array<{ toolName: string; callId?: string; outcome: 'ok' | 'error' }>;
}

interface PendingTraceMarker {
  markerId: string;
  invocationId: string;
  ownerUserId: string;
  subjectCatId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  polarity: 'counterexample' | 'positive' | 'candidate';
  note?: string;
  createdAt: number;
}

interface TraceAnnotation {
  annotationId: string;
  episodeRef: TraceEpisodeRef;
  source: AnnotationSource;
  ruleId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: Array<{ unitType: 'segment'; unitId: string; clauseId?: string }>;
  polarity: 'counterexample' | 'positive' | 'irrelevant' | 'unscorable';
  confidence: number;
  incidentKey: string;
  evidenceRefs: string[];
  createdAt: number;
}

interface MetricDefinition {
  id: string;
  kind: MetricKind;
  evaluator: { kind: 'code' | 'llm' | 'replay'; ruleRef: string };
  trigger:
    | { kind: 'distinct-counterexamples'; threshold: number; lookbackMs?: number }
    | { kind: 'minimum-sample'; minimum: number; windowMs: number }
    | { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };
}

interface EvaluationSnapshot {
  snapshotId: string;
  objectiveId: string;
  metricId: string;
  ruleVersion: string;
  window: { start: number; end: number };
  episodeRefs: TraceEpisodeRef[];
  annotationIds: string[];
  createdAt: number;
}

interface MetricResult {
  resultId: string;
  snapshotId: string;
  objectiveId: string;
  metricId: string;
  kind: MetricKind;
  value:
    | { kind: 'counter'; count: number; threshold: number }
    | { kind: 'rate'; numerator: number; denominator: number; rate: number }
    | { kind: 'semantic'; labels: Record<string, number>; explanation: string }
    | { kind: 'replay'; passed: number; failed: number };
  evaluatedAt: number;
}
```

`EvaluationIndexer` 不是语义判断器。它只执行 manifest 中声明的确定性投影：`annotation.objectiveId + metricId + unitRefs` 校验注册关系，按 `incidentKey` 去重，维护查询索引/水位；没有 annotation 的 raw trace 进入 semantic sweep 候选索引，不被猜测归属。

## 2. Stateful object census

### 2.1 TraceEpisode closure

Lifecycle owner：invocation terminal seam。prompt trace producer 只能创建 open trace；terminal seam 只能一次性闭合或幂等重放同一 closure。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | prompt trace persisted | open | 写 summary/detail/replay exposure |
| open | terminal completed/failed/cancelled | closed | 写 terminal extension，注册 episode index |
| closed | identical terminal retry | closed | no-op |
| closed | conflicting terminal retry | closed | fail closed + anomaly log，不覆盖 |
| absent | terminal before trace persist | terminal-pending | 暂存 terminal extension |
| terminal-pending | late trace persist | closed | 原子绑定并删除 pending terminal |

旁路约束：generic trace delete 只用于明确 owner-scoped 单 turn 删除；annotation/result store 不随之自动级联删除，以保留审计引用并显示 `source_missing`。

不变量：

- INV-1 一个 `invocationId` 最多对应一个 canonical episode closure。
- INV-2 closure 的四个 join id 一旦写入不可修改。
- INV-3 terminal retry 不产生第二个 episode。
- INV-4 LLM/eval 错误不能改变 invocation terminal outcome。

### 2.2 PendingTraceMarker

Lifecycle owner：marker resolver（terminal seam 后异步执行）。MCP callback 只允许 create；不得直接 resolve、delete 或计数。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | authenticated MCP trigger | pending | append marker keyed by invocationId |
| pending | episode closes | resolved | 原子创建 TraceAnnotation 并标记 resolved |
| pending | same MCP retry | pending | incidentKey 幂等 no-op |
| pending | terminal exists before marker | resolved | 读取 closure 后立即解析 |
| pending | resolver crash after annotation append | resolved | annotation idempotency 后补 resolved marker |
| pending | retention audit finds no invocation | orphaned | 记录 diagnostic；不伪造 annotation |

不变量：

- INV-5 pending marker 本身永不计入 Metric。
- INV-6 marker 的 owner/subject 来自 server-trusted principal/invocation，不信任 body。
- INV-7 resolve 后 annotation 必须引用 exact episode，禁止时间窗猜测。

### 2.3 TraceAnnotation ledger

Lifecycle owner：TraceAnnotationStore。无 update/delete API；修正通过追加 `supersedesAnnotationId`（V1 可先只支持 append）。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| absent | append valid annotation | present | SETNX record + objective/metric/unclassified indexes |
| present | same annotation retry | present | no-op |
| present | same id different payload | present | fail closed |
| unclassified episode | semantic annotation append | classified | 从 unclassified 工作索引 ACK，raw trace 不改 |
| unclassified episode | irrelevant/unscorable append | terminal-classified | 避免每个周期重复送 LLM |

不变量：

- INV-8 三种 source 使用完全相同的 annotation schema。
- INV-9 annotation append 与 index 更新原子化；重复 `incidentKey` 不重复计数。
- INV-10 raw trace 内容不可被 annotation 回写或改写。

### 2.4 EvaluationSnapshot / MetricResult

Lifecycle owner：EvaluationScheduler 创建 snapshot，EvaluatorRunner 完成，MetricResultStore 追加结果。

| Current state | Event | Next state | Side effect |
|---|---|---|---|
| no snapshot | trigger not ready | no snapshot | 只更新 readiness 观测，不显示 blocked |
| no snapshot | trigger ready | queued | 原子冻结 snapshot + trigger watermark |
| queued | worker starts | running | claim lease |
| running | code/LLM/replay succeeds | completed | append MetricResult，commit watermark |
| running | evaluator fails | retryable | 保留 snapshot，释放/超时 lease |
| retryable | retry succeeds | completed | 同一 snapshot 只写一个 result |
| completed | scheduler repeats same range | completed | watermark 防重复 run |

不变量：

- INV-11 snapshot 一旦创建不可修改；重试读取同一输入。
- INV-12 count threshold 只数 distinct `incidentKey` episode，不数重复 annotation。
- INV-13 counter 结果不包含虚构 denominator/rate。
- INV-14 semantic worker 不在 invocation 主流程运行。
- INV-15 completed watermark 只在 result 持久化成功后推进。

### 2.5 Derived indexes/cursors

索引与 readiness 全部是可重建投影；不得成为第二真相源。EvaluationIndexer 使用 per-owner cursor，advance 必须与目标索引写入原子化；cursor 丢失可从 annotation ledger 重放。

## 3. Adversarial test matrix

| Scenario | Expected | Invariants |
|---|---|---|
| terminal 先于 prompt trace persist | 后到 trace 自动闭合 | INV-1..4 |
| terminal 双写且 payload 冲突 | 原 closure 保留，冲突可见 | INV-1..3 |
| MCP marker 重试 3 次 | 只产生一个 annotation | INV-5..9 |
| resolver 在 append 后 crash | 重启后补 resolved，不重复计数 | INV-7..9 |
| 两个结构规则同时命中同一 incident | 同 incidentKey 只计一次 | INV-9,12 |
| 3 个 distinct counterexample、阈值 3 | 恰好创建一个 snapshot | INV-11,12,15 |
| 10 个 trace 无 annotation | 只进入 async sweep，不阻塞回复 | INV-4,10,14 |
| LLM timeout/格式错误 | snapshot retryable，主 invocation 不受影响 | INV-4,11,14 |
| evaluator 写 result 后在 watermark 前 crash | retry 读到同 result 并补 watermark | INV-11,15 |
| trace 被 owner 删除后结果仍引用 | Console 显示 source_missing，不复活 trace | INV-10,11 |
| 旧 SegmentJudgment Redis 数据存在 | 新 read model 完全忽略 | AC-9, AC-12 |

## 4. Implementation tasks

### Task 1: Write contract tests for terminal trace correlation

**Files:**
- Modify: `packages/shared/src/types/injection-trace.ts`
- Modify: `packages/api/src/domains/prompt-hooks/InjectionTraceStore.ts`
- Test: `packages/api/test/injection-trace-store.test.js`
- Test: `packages/api/test/f257-trace-episode-correlation.test.js`

1. 写红测：trace first、terminal first、identical retry、conflicting retry、四 join id 完整。
2. 运行 `pnpm --dir packages/api build && node --test packages/api/test/f257-trace-episode-correlation.test.js`，确认缺少 API 失败。
3. 增加 `TraceTerminalExtension`、episode/pending-terminal keys 与 Lua 原子闭合。
4. 将 route serial/parallel/invocation terminal seam 写入 exact refs；不新增 LLM work。
5. 重跑测试，预期全绿；commit `feat(f257): close trace episodes at invocation terminal`。

### Task 2: Replace direct MCP observation with pending marker

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/resolve-pending-markers.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/deviation/report-harness-signal.ts`
- Modify: `packages/api/src/routes/callbacks.ts`
- Modify: `packages/mcp-server/src/tools/report-harness-signal-tool.ts`
- Test: `packages/api/test/report-harness-signal.test.js`
- Test: `packages/api/test/harness-eval/trace-annotation-store.test.js`

1. 写红测：MCP 返回 marker id；terminal 前 annotation count=0；terminal 后 exact resolve=1；principal spoof 被拒。
2. 跑 focused 测试确认旧 direct `ManualObservationEvent` 行为使测试失败。
3. 实现 marker/store/atomic resolver；工具文案改为“标记当前 invocation，terminal 后关联 tracing”。
4. 保留旧 DeviationEventLog 供其他消费者只读，但从此路径拆除；不迁移旧数据。
5. 运行 API + MCP focused 测试；commit `feat(f257): bind harness signals to trace episodes`。

### Task 3: Add structured and semantic annotation producers

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/structured-rule-tagger.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/semantic-sweep.ts`
- Create: `packages/api/src/infrastructure/harness-eval/trace-annotation/semantic-evaluator-packet.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts`
- Test: `packages/api/test/harness-eval/structured-rule-tagger.test.js`
- Test: `packages/api/test/harness-eval/semantic-sweep.test.js`

1. 写红测：结构规则和 MCP 写相同 schema；未归属 episode 入 sweep；irrelevant/unscorable 不重复分析。
2. 实现纯函数规则注册表，规则只能输出 annotation draft，不能改 raw trace。
3. 实现 owner-scoped unclassified index + cursor + snapshot packet；LLM 输出 strict schema，解析失败保持 retryable。
4. 通过现有 eval-domain worker 异步投递；禁止从 route/QueueProcessor await LLM。
5. 跑测试；commit `feat(f257): unify structured and semantic trace annotations`。

### Task 4: Canonize 23 Objectives, 46 unit attachments, and metric models

**Files:**
- Modify: `docs/harness-feedback/objectives/registry.yaml`
- Modify: `packages/api/src/infrastructure/harness-eval/objective-registry.ts`
- Create: `docs/harness-feedback/objectives/unit-evaluation-manifest.yaml`
- Create: `packages/api/src/infrastructure/harness-eval/unit-evaluation-manifest.ts`
- Test: `packages/api/test/f257-objective-registry.test.js`
- Test: `packages/api/test/harness-eval/unit-evaluation-manifest.test.js`

1. 写红测：23 个 slug 精确集合、46/46 段/条款覆盖、无孤儿/重复 clause、metric kind/trigger/evaluator 合法。
2. registry schema v2 增加 `evaluationModelId` 与 metric definitions；Objective 本身无 lifecycle state。
3. manifest 写入 46 段与 clauseId 映射，C1/L1/L2/L3/L4/L7/D16 按条款寻址。
4. 增加 hook asset anchor existence + uniqueness lint。
5. 跑 parser/lint 测试；commit `feat(f257): register objective metrics and unit attachments`。

### Task 5: Implement EvaluationIndexer and count-threshold scheduler

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationIndexer.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.ts`
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/MetricResultStore.ts`
- Test: `packages/api/test/harness-eval/evaluation-indexer.test.js`
- Test: `packages/api/test/harness-eval/evaluation-scheduler.test.js`

1. 写红测：unknown objective/metric fail closed；incident dedupe；threshold 1/3/5；rate 最小样本；cadence；watermark crash recovery。
2. Indexer 只验证并索引 annotation，不读 message 语义、不运行 LLM。
3. Scheduler 以 manifest trigger 计算 readiness；不 ready 返回 `collecting` 投影而非持久状态/blocked。
4. snapshot store 原子 claim；MetricResult append-only；counter value 无 denominator。
5. 跑 Redis-isolated focused tests；commit `feat(f257): schedule objective evaluations from annotations`。

### Task 6: Wire code/LLM/replay evaluators and retire SegmentJudgment from production truth

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/evaluation/evaluator-runner.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/manual-trigger/trigger-now.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/domain/eval-domain-daily.ts`
- Modify: `packages/api/src/index.ts`
- Disconnect legacy-only: `packages/api/src/infrastructure/harness-eval/segment-judgment-engine.ts`
- Disconnect legacy-only: `packages/api/src/domains/prompt-hooks/SegmentJudgmentCache.ts`
- Disconnect legacy-only: `packages/api/src/infrastructure/harness-eval/manual-trigger/trigger-now-judgments.ts`
- Replace tests: `packages/api/test/harness-eval/segment-judgment-engine.test.js`

1. 写红测：zero guard events 仍可 sweep/evaluate；code evaluator deterministic；LLM failure retryable；replay input frozen。
2. runner 按 metric `evaluator.kind` dispatch，未知 rule fail closed。
3. daily/N-day 任务先跑 semantic sweep/readiness，再创建 snapshot；manual trigger 复用同 pipeline。
4. 删除 SegmentJudgment 的 production wiring/cache/time-window attribution；legacy 模块只为旧 API/测试兼容保留，新 Console 和评估路径不实例化、不读取。legacy Redis keys 不读不迁移。
5. 跑 manual/daily/lifeline focused tests；commit `refactor(f257): replace segment judgments with metric results`。

### Task 7: Rebuild lifeline read model and Console

**Files:**
- Modify: `packages/api/src/routes/segment-lifeline.ts`
- Modify: `packages/api/src/routes/segment-lifeline-chain.ts`
- Modify: `packages/api/src/routes/segment-lifeline-replay.ts`
- Create: `packages/web/src/components/settings/ObjectiveEvaluationPanel.tsx`
- Create: `packages/web/src/components/settings/SegmentTraceTheater.tsx`
- Modify: `packages/web/src/components/settings/SegmentLifelineModal.tsx`
- Modify: `packages/web/src/components/settings/SegmentEditorModal.tsx`
- Test: `packages/api/test/segment-lifeline.test.js`
- Test: `packages/web/src/components/settings/__tests__/LifelineStageDetail-replay.test.tsx`

1. 写红测：Tracing 显示 Unit 级窗口起点、累计 episode、跨指标合并去重的明确反例及其记录；Eval 显示归属/模型/指标的 evaluator、ruleRef、时间和结果窗口，不显示按指标拆分的调度进度；trace replay 含 input/output/tool/segment scene。
2. 新 `segment-evaluation` read model join manifest + latest MetricResult + episode refs；新 Modal 不读 SegmentJudgmentCache，也不渲染 legacy `EvalStagePanel/LifelineStageDetail`。
3. tracing tab 改 Unit readiness + episode replay theater；仅 ID 降为可复制 provenance。
4. 编辑器对可写 text hook 直接编辑；移除模板来源/冗余预览；变量用 KV；readonly 保留明确原因。
5. Browser/Playwright 截图验证；commit `feat(f257): present objective metrics and trace replay`。

### Task 8: Update truth sources and purge only invalid derived fixtures

**Files:**
- Modify: `docs/features/F257-harness-ledger.md`
- Mark superseded: `docs/features/assets/F257/objective-driven-redesign-v1.md`
- Modify: `docs/architecture/ownership/cells/harness-eval.md`
- Modify: `packages/mcp-server/src/server-toolsets.ts`
- Modify relevant generated fixtures/tests only where they encode legacy judgment semantics.

1. 文档明确 tracing/eval 分工、23 objectives、metric kinds、threshold/cadence、异步 LLM、无 Objective 状态机。
2. 删除 repo 内旧派生 verdict fixture/测试期望（若存在）；不操作 Redis/SQLite/runtime data。
3. 跑 convention graph 重新索引，核对 MCP contract consumers。
4. commit `docs(f257): define annotation-driven objective evaluation`。

### Task 9: Verification and review

1. `pnpm --filter @cat-cafe/shared build`。
2. `pnpm --dir packages/api build`。
3. 运行所有新增/修改 focused tests；预期 0 fail。
4. 运行 F257 Redis isolated suite；预期 0 fail。
5. `pnpm biome check . --diagnostic-level=error` 与 `git diff --check`。
6. `pnpm --dir packages/api test:public`；预期 0 fail。
7. 生成 UI screenshots 和 exact SHA evidence。
8. 请求跨家族 fresh-context review；作者不得自审。

## 5. Technical decisions resolved during implementation

- invocation exact id 的现有来源若不贯穿 route，将在 invocation request object 上增加一个 server-generated id；不得以 timestamp proximity 代替。
- `outputText` 只在现有 message persistence policy 允许的范围引用/读取；优先存 outputMessageId，避免复制敏感/长文本。
- annotation correction V1 若无产品入口，仅保留 append-only + deterministic id；不为未提出的人工编辑造 UI。
- semantic sweep 的 budget/批次沿用 eval-domain scheduler，失败不升级为 Objective blocked。
- 旧 `SegmentJudgment` 源文件暂留给历史 API/回归测试，但 bootstrap、manual/daily eval、新 `segment-evaluation` read model 与新 Console 均不再消费它。这是“退出生产真相”，不是对旧派生数据做兼容迁移。

## 6. No operator value questions

本轮价值判断均已由 co-creator 明确：旧不合适数据可清理/忽略；tracing 与 eval 分离；MCP 是 trigger；语义分析异步；反例 count threshold 不强求分母。因此没有待升级的价值 OQ。
