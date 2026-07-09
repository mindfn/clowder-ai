---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-09-eval-a2a-stale-evidence-build
source_snapshot: "snapshot:bundle/2026-07-09-eval-a2a-stale-evidence-build/snapshot"
---

# Live Verdict — 2026-07-09-eval-a2a-stale-evidence-build

- Verdict: `build`
- Phenomenon: The latest committed eval:a2a evidence is still the 2026-06-17 raw snapshot behind the 2026-06-30 build verdict. Since then the codebase has added the requested counters and telemetry endpoints, but this checkout has no live snapshots/attributions sourceRefs, so the daily eval cannot publish a fresh runtime snapshot or verify grounding Phase O health.
- Harness: F167/f167-runtime-eval-telemetry (A2A runtime eval telemetry coverage)
- Owner ask: Build or restore the eval:a2a evidence producer so each daily run materializes fresh snapshots/*.yaml and attributions/*.yaml from current F167 telemetry, then publish a new snapshot that verifies the landed L1/C1/C2 counters, counter_window-backed denominators, and grounding-phase-o counters from live data.
- Re-eval: A new eval:a2a run publishes fresh sourceRefs generated after 2026-07-09 with counter_window.duration_hours >= 2, at least one non-no-data F167 component beyond route-serial, and grounding-phase-o reporting live check_total/verdict_total plus mismatch_sample_count or an explicit zero from current data. at 2026-07-10T03:00:00Z

Evidence:
- snapshot:bundle/2026-07-09-eval-a2a-stale-evidence-build/snapshot
- attribution:bundle/2026-07-09-eval-a2a-stale-evidence-build/AR-2026-06-17-001
- metric:rawEvidenceAgeDays
- metric:latestVerdictAgeDays
- metric:liveSourceRefPairs
- metric:codeTelemetryClosureSignals
- L1/streak_warn_count
- C1/hold_cancel_count
- C2/verdict_without_pass_count

Counterarguments:
- The missing live sourceRefs in this checkout could be an environment artifact rather than a product regression if another runtime already generated fresh YAMLs.
- Because code-level telemetry hooks now exist, the remaining gap may be operational runbook drift rather than missing implementation.
- If the daily eval intentionally depends on a manual evidence-prep step, this is a control-plane design gap rather than a telemetry bug.
