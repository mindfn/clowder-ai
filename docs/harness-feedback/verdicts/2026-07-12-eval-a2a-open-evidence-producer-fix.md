---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-12-eval-a2a-open-evidence-producer-fix
source_snapshot: "snapshot:bundle/2026-07-12-eval-a2a-open-evidence-producer-fix/snapshot"
---

# Live Verdict — 2026-07-12-eval-a2a-open-evidence-producer-fix

- Verdict: `fix`
- Phenomenon: The latest committed eval:a2a raw evidence is still the 2026-06-17 snapshot and no new snapshots/attributions were materialized for the 2026-07-12 run. PR #21 implements the missing evidence producer and currently has green CI, but it is still open, so the running/mainline eval path has not yet generated fresh sourceRefs or a post-fix runtime verdict.
- Harness: F167/f167-runtime-eval-telemetry (A2A runtime eval telemetry evidence production)
- Owner ask: Merge and deploy PR #21 (or land an equivalent change) so the daily eval:a2a run materializes fresh snapshots/*.yaml and attributions/*.yaml before invocation, then rerun eval:a2a to verify live L1/C1/C2 counters, counter_window-backed denominators, and grounding-phase-o telemetry.
- Re-eval: A post-merge eval:a2a run publishes a fresh sourceRefs pair generated after 2026-07-12, with counter_window.duration_hours >= 2, at least one non-no-data F167 component beyond route-serial, and grounding-phase-o reporting live check_total/verdict_total plus mismatch_sample_count or an explicit zero from current data. at 2026-07-13T03:00:00Z

Evidence:
- snapshot:bundle/2026-07-12-eval-a2a-open-evidence-producer-fix/snapshot
- attribution:bundle/2026-07-12-eval-a2a-open-evidence-producer-fix/AR-2026-06-17-001
- metric:rawEvidenceAgeDays
- metric:latestVerdictAgeDays
- metric:openObservabilityGapFindings
- metric:openEvidenceProducerPrs
- metric:openEvidenceProducerCiPassCount
- L1/streak_warn_count
- C1/hold_cancel_count
- C2/verdict_without_pass_count

Counterarguments:
- Because PR #21 is already authored, reviewed, and green in CI, this may be better described as merge/deploy lag than a product defect in the evidence producer itself.
- The lack of fresh YAML could still be environmental if the cron runtime differs from the checkout inspected here.
- If eval:a2a intentionally tolerates stale raw sourceRefs until a manual publish flow is used, the severity is lower than the packet suggests.
