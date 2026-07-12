---
feature_ids: [F245]
topics: [harness-eval, eval-friction, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:friction
packet_id: 2026-07-12-eval-friction-c2-hold-ball-state-mismatch-singleton
source_snapshot: "snapshot:bundle/2026-07-12-eval-friction-c2-hold-ball-state-mismatch-singleton/snapshot"
---

# Live Verdict — 2026-07-12-eval-friction-c2-hold-ball-state-mismatch-singleton

- Verdict: `keep_observe`
- Phenomenon: The 2026-07-09T03:00Z to 2026-07-12T03:00Z every-3d window produced one medium-severity user-feedback singleton tied to cat_cafe_hold_ball: the user reported that no corresponding business or task was running. Signal volume, cluster count, severity, and one-channel diversity are flat versus the preceding 72h window, but the symptom is now specific enough to monitor as a possible hold-state lifecycle mismatch.
- Harness: F245/friction-rollup (friction rollup (Top-N + sensorForm))
- Root cause: The most plausible attribution is harness_misfit: cat_cafe_hold_ball exposed a held or recently cancelled state that the user could not reconcile with any visible business task, even though the trace contained a merge-gate managed command. A lifecycle or visibility mismatch between the hold card and the managed command is more likely than a missing task, but one reason-only singleton is insufficient for a firm diagnosis. (confidence low)
- Owner ask: Keep the every-3d rollup running and watch specifically for another hold_ball report where the user cannot identify a corresponding task. If it recurs, inspect hold creation, managed-command completion, cancellation, and card visibility as one lifecycle and escalate the cluster to a fix verdict against the hold/ball-custody owner.
- Re-eval: next eval at 2026-07-15T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-12-eval-friction-c2-hold-ball-state-mismatch-singleton/snapshot
- attribution:bundle/2026-07-12-eval-friction-c2-hold-ball-state-mismatch-singleton/FR-2026-07-12-99b38d3aded5
- metric:friction-rollup.cluster_count
- metric:friction-rollup.total_signal_count
- metric:friction-rollup.user_feedback_signal_count
- metric:friction-rollup.actionable_candidate_count

Counterarguments:
- Phase D classifies this singleton as an actionableCandidate, so deferring a repair thread could underreact to direct user feedback even at count one.
- The trace shows an actual merge-gate command, which may mean the harness state was correct and the problem was only presentation or user context loss.
- Rule-only clustering is degraded; a semantically similar hold lifecycle complaint may exist under different wording and therefore recurrence could be underestimated.