---
feature_ids: [F245]
topics: [harness-eval, eval-friction, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:friction
packet_id: 2026-07-18-eval-friction-c3-hold-ball-cancel-replay
source_snapshot: "snapshot:bundle/2026-07-18-eval-friction-c3-hold-ball-cancel-replay/snapshot"
---

# Live Verdict — 2026-07-18-eval-friction-c3-hold-ball-cancel-replay

- Verdict: `keep_observe`
- Phenomenon: Replay of the 2026-07-15T03:00Z to 2026-07-18T03:00Z window surfaced one medium-severity actionableCandidate, `user_report: hold_ball_cancel` (count 1, sensor form `reason`, one user-feedback channel), with no referenceOnly or tail clusters and no dropped channels. The preceding 72-hour window also contained one different medium user-feedback singleton, so volume was flat while this specific cluster had not recurred.
- Harness: F245/friction-rollup (friction rollup)
- Root cause: execution_gap: the member context shows a cat used hold_ball wakeWhen to run a 20-minute poll for a human GitHub-auth action or externally created PR, despite the existing contract reserving wakeWhen for local command completion and routing human or external waits elsewhere. The operator cancelled the hold and confirmed the feedback. (confidence medium)
- Owner ask: Keep this singleton linked to F167 hold-ball misuse without opening a repair thread from count 1. Compare it with the 2026-07-25 friction rollup; escalate only if hold_ball_cancel recurs, gains a second channel, becomes high severity, or source collection degrades.
- Re-eval: next eval at 2026-07-25T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-18-eval-friction-c3-hold-ball-cancel-replay/snapshot
- attribution:bundle/2026-07-18-eval-friction-c3-hold-ball-cancel-replay/FR-2026-07-25-b4e44a650f51
- metric:friction-rollup.cluster_count
- metric:friction-rollup.cluster_b4e44a650f51
- metric:friction-rollup.top_cluster_count
- metric:friction-rollup.tail_signal_count

Counterarguments:
- A direct operator-confirmed cancellation plus a clear hold_ball contract breach may justify an immediate fix even at count 1.
- The missing GitHub CLI authentication may be the primary environment_drift, making execution_gap an attribution to the workaround rather than the original blocker.
- Connector availability differs across agent runtimes, so the apparent one-off could expose a broader tool_gap that this single-channel report cannot measure.