---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build
source_snapshot: "snapshot:bundle/2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build/snapshot"
---

# Live Verdict — 2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build

- Verdict: `build`
- Phenomenon: The 2026-06-30 eval:a2a build verdict missed its 72h recovery condition: the latest raw F167 snapshot is still 2026-06-17 with a 0h window, no counter_window, no grounding-phase-o component, and six open observability-gap findings. Today's runtime confirms the gap remains live: telemetry health reports otelEnabled=false because TELEMETRY_HMAC_SALT is not configured, metrics/history/traces endpoints return 503, and grounding samples return 503.
- Harness: F167/f167-runtime-eval-telemetry (F167 runtime eval telemetry readiness)
- Owner ask: Restore eval:a2a runtime evidence ingestion: configure TELEMETRY_HMAC_SALT and OTel stores for the eval runtime, or make the scheduler fail closed before invoking eval:a2a when telemetry prerequisites are absent; then produce fresh daily F167 snapshot and attribution artifacts with counter_window and grounding-phase-o metrics.
- Re-eval: A post-2026-07-07 F167 raw snapshot exists with counter_window.duration_hours >= 2, L1/C1/C2 no longer all no-data, grounding-phase-o check/verdict/mismatch counters present, and the six 2026-06-17 observability-gap anchors closed or replaced by a prereq-missing skip message. at 2026-07-10T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build/snapshot
- attribution:bundle/2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build/AR-2026-06-17-001
- metric:rawEvidenceAgeDays
- metric:daysSinceLastVerdict
- metric:noDataComponentsLatestRaw
- metric:openObservabilityGapFindings
- metric:counterWindowPresent
- metric:groundingPhaseOComponentPresent
- metric:otelEnabled
- metric:telemetryEndpoint503Count
- metric:processUptimeHours
- docs/harness-feedback/snapshots/2026-06-17T03-00-00-229Z-F167-eval.yaml
- docs/harness-feedback/attributions/2026-06-17T03-00-00-229Z-F167-attribution.yaml
- telemetry:/api/telemetry/health:otelEnabled=false
- telemetry:/api/telemetry/metrics=503
- telemetry:/api/telemetry/metrics/history=503
- telemetry:/api/telemetry/traces=503
- telemetry:/api/telemetry/grounding-samples=503

Counterarguments:
- The latest committed bundle only contains the selected L1 raw finding because the a2a generator bundles the strongest raw attribution; the packet's metric and sample refs carry the broader re-eval context.
- A healthy /api/telemetry/health 200 could be mistaken for readiness, but its body explicitly reports otelEnabled=false and null trace/metrics stores.
- Grounding mismatch count cannot be interpreted as zero because grounding samples are unavailable; the correct signal is telemetry absence, not a healthy distribution.
