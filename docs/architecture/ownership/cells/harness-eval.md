---
cell_id: harness-eval
title: Harness Eval Control Plane
summary: Harness contract、runtime eval、verdict handoff、domain registry、legacy scheduled-task migration、re-eval closure 与 harness ledger 生命周期。
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
  - packages/api/src/infrastructure/harness-eval/harness-ledger-snapshot-provider.ts
  - packages/api/src/infrastructure/harness-eval/segment-judgment-engine.ts
  - packages/api/src/infrastructure/harness-eval/guard-threshold-escalation.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.ts
  - packages/api/src/domains/prompt-hooks/InjectionTraceStore.ts
  - packages/api/src/domains/prompt-hooks/SegmentJudgmentCache.ts
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
  - docs/features/assets/F257/
  - docs/harness-feedback/eval-domains/eval-harness-ledger.yaml
  - docs/harness-feedback/
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, eval-domain, reeval, harness-fit-digest, Eval Hub, SopDefinition, sop-definitions, predicate, friction, paw-feel, FrictionSignal, harness-ledger, GuardRejectionEvent, SegmentJudgment, segment-lifeline, denominatorKind]
cited_by:
  - F192 Phase E-pilot
  - F245 Phase A (paw-feel friction collector) + Phase B (cancel/user-feedback/eval-domain adapters + aggregator + clusterer + rollup input; domain registration + rollup sink land in Phase C)
  - F257 Phase A (observation + snapshot) + Phase C (eval:harness-ledger + SegmentJudgment) + Phase D (segment lifeline + governance operations)
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure. F257 owns the per-unit ledger lifecycle, guard/trace judgment join, and segment-lifeline projection inside this cell.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Producing or validating Verdict Handoff Packets.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.
- Consuming guard rejection events, injection traces, or per-segment judgments for F257 lifecycle decisions.
- Extending the segment lifeline read model or its governance operations.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.
- Keep F257 observation and judgment joins on the frozen three-key window contract unless a later schema version explicitly upgrades correlation.
- Add new ledger evidence sources through the existing snapshot/judgment path instead of creating a second eval control plane.

## Do NOT Unify With

- Do not move canonical trace storage out of F153 into this cell.
- Do not replace F188 Health Dashboard or F200 memory recall metrics here; consume them as domain inputs.
- Do not treat Eval Hub as a metrics dashboard. A surfaced item must have verdict, owner ask, and re-eval plan.
- Do not collapse the per-unit F257 lifecycle into the domain-level F192 registry; they have different identities and closure semantics.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `SopDefinition`, `sop-definitions`, `predicate`, `GuardRejectionEvent`, `SegmentJudgment`, `segment-lifeline`, and `denominatorKind` artifacts.
