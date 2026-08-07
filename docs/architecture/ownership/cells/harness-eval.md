---
cell_id: harness-eval
title: Harness Eval Control Plane
summary: Harness contract、runtime eval、verdict handoff、domain registry、Objective/Metric 规则、TraceAnnotation 投影、可重放评估与 harness ledger 生命周期。
canonical_features: [F192, F257]
code_anchors:
  - packages/api/src/infrastructure/harness-eval/f167-eval.ts
  - packages/api/src/infrastructure/harness-eval/attribution.ts
  - packages/api/src/infrastructure/harness-eval/eval-domain-registry.ts
  - packages/api/src/infrastructure/harness-eval/verdict-handoff.ts
  - packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts
  - packages/api/src/infrastructure/harness-eval/legacy-task-cleanup.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure.ts
  - packages/api/src/infrastructure/harness-eval/eval-a2a-adapter.ts
  - packages/api/src/infrastructure/harness-eval/eval-hub-read-model.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-signal-source.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-marker.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/cancel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/user-feedback-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/eval-domain-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-aggregator.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-clusterer.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-input.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-report.ts
  - packages/shared/src/types/friction-signal.ts
  - packages/api/src/routes/eval-hub.ts
  - packages/web/src/components/HubEvalTab.tsx
  - sop-definitions/development.yaml
  - sop-definitions/stubs/video-cocreation.yaml
  - sop-definitions/stubs/tech-article.yaml
  - sop-definitions/stubs/family-office.yaml
  - scripts/sop-definitions.mjs
  - scripts/lib/sop-definition-codegen.mjs
  - packages/shared/src/types/sop-definition.generated.ts
  - packages/api/src/infrastructure/harness-eval/GuardRejectionEventLog.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationIndexer.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/MetricResultStore.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/evaluation-catalog.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/evaluator-runner.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/SemanticSweepCoordinator.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/SemanticSweepJobStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/submit-semantic-sweep.ts
  - packages/api/src/infrastructure/harness-eval/guard-threshold-escalation.ts
  - packages/api/src/infrastructure/harness-eval/objective-registry.ts
  - packages/api/src/routes/callback-docs-routes.ts
  - packages/mcp-server/src/tools/list-objectives-tool.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.ts
  - packages/api/src/domains/prompt-hooks/InjectionTraceStore.ts
  - packages/api/src/routes/prompt-injection-overrides.ts
  - packages/api/src/routes/segment-lifeline.ts
  - packages/api/src/routes/segment-lifeline-chain.ts
  - packages/shared/src/types/segment-lifecycle.ts
  - packages/web/src/components/settings/SegmentLifelineModal.tsx
  - packages/web/src/components/settings/EvalStagePanel.tsx
  - packages/web/src/components/settings/VersionActions.tsx
doc_anchors:
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F245-friction-signal-eval.md
  - docs/features/F257-harness-ledger.md
  - feature-specs/2026-08-04-f257-objective-eval-redesign.md
  - docs/features/assets/F257/
  - docs/harness-feedback/objectives/registry.yaml
  - docs/harness-feedback/eval-domains/eval-harness-ledger.yaml
  - docs/harness-feedback/
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, eval-domain, reeval, harness-fit-digest, Eval Hub, SopDefinition, sop-definitions, predicate, friction, paw-feel, FrictionSignal, harness-ledger, TraceEpisode, TraceAnnotation, EvaluationSnapshot, MetricResult, EvaluationIndexer, SemanticSweep, segment-lifeline, ObjectiveRegistry, objective-registry, list_objectives, objectiveId, metricId]
cited_by:
  - F192 Phase E-pilot
  - F245 Phase A (paw-feel friction collector) + Phase B (cancel/user-feedback/eval-domain adapters + aggregator + clusterer + rollup input; domain registration + rollup sink land in Phase C)
  - F257 Phase A (invocation tracing + annotation) + Phase C (Objective/Metric evaluation) + Phase D (segment lifeline + governance operations)
  - F257 #3 (objective registry definition layer + list_objectives discovery; canonical objectiveId source for report_harness_signal)
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure. F257 owns the per-unit ledger lifecycle and the exact path from closed `TraceEpisode` through append-only `TraceAnnotation`, immutable `EvaluationSnapshot`, and append-only `MetricResult` to the segment-lifeline projection. An Objective is a static definition plus unit attachments and Metric rules; it has no lifecycle state machine.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Producing or validating Verdict Handoff Packets.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.
- Adding a structured rule, MCP marker, or asynchronous semantic classifier that annotates an exact F257 trace episode.
- Adding or changing Objective/Metric definitions, unit/clause attachments, trigger rules, or code/LLM/replay evaluators.
- Extending the segment lifeline read model or its governance operations.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.
- Keep raw invocation tracing independent from evaluation. Tracing records what happened from invocation start through terminal closure; it does not choose an Objective, Metric, or verdict.
- Producers only append the unified `TraceAnnotation` schema. `report_harness_signal` creates a pending marker for the authenticated invocation; terminal resolution binds it to the exact episode. Structured rules append the same shape. Unclassified episodes enter a bounded asynchronous semantic sweep.
- Keep `EvaluationIndexer` deterministic: validate the annotation coordinates against the registry/manifest, deduplicate by incident key, and project query indexes. It must not perform semantic judgment.
- Keep `EvaluationScheduler` semantic-free: freeze an immutable snapshot only when the Metric's declared threshold, minimum sample, or cadence is ready. Counterexample counters do not invent a denominator or rate.
- Run LLM semantic review in the eval-cat worker after the response path. Code, LLM, and replay evaluators consume frozen snapshots and append one idempotent `MetricResult`; only a persisted result advances completion watermarks.
- F257's objective registry and versioned unit manifest are the canonical static definition layer of this same control plane. Registry discovery, unit/clause attachment, Metric rule, trigger, and evaluator kind must agree or loading fails closed.
- Treat legacy `SegmentJudgment` and window-attributed violation rates as historical compatibility inputs only. New evaluation and Console read models must not consume them, and invalid derived local data is not migrated. Raw traces, messages, and threads remain intact.

## Do NOT Unify With

- Do not move canonical trace storage out of F153 into this cell.
- Do not make tracing responsible for evaluation semantics or run LLM classification on the invocation response path.
- Do not replace F188 Health Dashboard or F200 memory recall metrics here; consume them as domain inputs.
- Do not treat Eval Hub as a metrics dashboard. A surfaced item must have verdict, owner ask, and re-eval plan.
- Do not collapse the per-unit F257 lifecycle into the domain-level F192 registry; they have different identities and closure semantics.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `SopDefinition`, `sop-definitions`, `predicate`, `GuardRejectionEvent`, `TraceEpisode`, `TraceAnnotation`, `EvaluationSnapshot`, `MetricResult`, `SemanticSweep`, `segment-lifeline`, `objectiveId`, and `metricId` artifacts.
