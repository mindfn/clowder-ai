---
feature_ids: [F245]
topics: [harness-eval, eval-friction, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:friction
packet_id: 2026-07-18-eval-friction-c2-hold-ball-cancel-singleton
source_snapshot: "snapshot:bundle/2026-07-18-eval-friction-c2-hold-ball-cancel-singleton/snapshot"
---

# Live Verdict — 2026-07-18-eval-friction-c2-hold-ball-cancel-singleton

- Verdict: `keep_observe`
- Phenomenon: The current 72-hour rollup surfaced one medium-severity actionableCandidate, `user_report: hold_ball_cancel` (count 1, sensor form `reason`, one user-feedback channel), with no referenceOnly or tail clusters and no dropped channels. The preceding 72-hour window also contained one medium user-feedback singleton but for a different symptom, so volume is flat while this specific cluster has not recurred.
- Harness: F245/friction-rollup (friction rollup)
- Root cause: execution_gap: the member context shows a cat used hold_ball wakeWhen to run a 20-minute poll for a human GitHub-auth action or externally created PR, despite the existing contract reserving wakeWhen for local command completion and routing human/external waits elsewhere. The operator then cancelled the hold and confirmed the feedback. (confidence medium)
- Owner ask: Keep this singleton linked to F167 hold-ball misuse but do not open a repair thread yet. Re-evaluate on 2026-07-21T03:00:00.000Z; if `hold_ball_cancel` recurs, gains a second channel, becomes high severity, or source collection degrades, open the repair thread and test whether semantic wait-target enforcement is warranted.
- Re-eval: next eval at 2026-07-21T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-18-eval-friction-c2-hold-ball-cancel-singleton/snapshot
- attribution:bundle/2026-07-18-eval-friction-c2-hold-ball-cancel-singleton/FR-2026-07-18-b4e44a650f51
- metric:friction-rollup.cluster_count
- metric:friction-rollup.cluster_b4e44a650f51
- metric:friction-rollup.top_cluster_count
- metric:friction-rollup.tail_signal_count

Counterarguments:
- A direct operator-confirmed cancellation plus a clear hold_ball contract breach may justify an immediate fix even at count 1.
- The missing GitHub CLI authentication may be the primary environment_drift, making execution_gap an attribution to the workaround rather than the original blocker.
- Connector availability differs across agent runtimes, so the apparent one-off could expose a broader tool_gap that this single-channel report cannot measure.