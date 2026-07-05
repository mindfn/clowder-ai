---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-07-05-eval-a2a-telemetry-disabled-missing-salt-fix
source_snapshot: "snapshot:bundle/2026-07-05-eval-a2a-telemetry-disabled-missing-salt-fix/snapshot"
---

# Live Verdict — 2026-07-05-eval-a2a-telemetry-disabled-missing-salt-fix

- Verdict: `fix`
- Phenomenon: eval:a2a still has no usable F167 telemetry: the latest raw snapshot remains 2026-06-17 with a 0h window, no counter_window, and four no-data components, while today's production runtime still returns 503 for metrics, metrics history, traces, and grounding samples. The 2026-07-04 fix verdict PR #16 was merged, but its merge commit is no longer an ancestor of current main and the verdict file is absent from GitHub main, so the canonical evidence trail still needs the fix verdict.
- Harness: F167/runtime-telemetry-config (A2A runtime telemetry HMAC salt configuration)
- Owner ask: Set a non-empty TELEMETRY_HMAC_SALT for the running production API profile and restart the API, or explicitly authorize an open-source/self-hosted fallback salt policy. Separately, keep this fix verdict on the current main lineage so eval:a2a has a canonical owner-action trail. After restart, verify /api/telemetry/metrics, /metrics/history, /traces, and /grounding-samples no longer return 503, then wait until counter_window.duration_hours >= 2 before treating counter-derived rates as medium/high confidence.
- Re-eval: After TELEMETRY_HMAC_SALT is configured and the API is restarted, the next eval:a2a run emits a fresh F167 snapshot with counter_window.duration_hours >= 2, at least one non-no-data L1/C1/C2 component, grounding-phase-o telemetry available, no 503 telemetry endpoints for metrics/history/traces/grounding-samples, and the fix verdict remains present on current main. at 2026-07-06T03:00:00Z

Evidence:
- snapshot:bundle/2026-07-05-eval-a2a-telemetry-disabled-missing-salt-fix/snapshot
- attribution:bundle/2026-07-05-eval-a2a-telemetry-disabled-missing-salt-fix/AR-2026-06-17-001
- metric:rawEvidenceAgeDays
- metric:noDataComponents
- metric:openObservabilityGapFindings
- metric:runtimeTelemetryUnavailableEndpoints
- metric:telemetryHmacSaltConfigured
- metric:otelEnabled
- metric:traceStoreAvailable
- metric:metricsSnapshotStoreAvailable
- metric:groundingSamplesAvailable
- metric:processUptimeHours
- metric:evalA2aDailyRunsDeliveredLast7Days
- metric:previousFixVerdictMissingFromMain
- L1/streak_warn_count
- L1/streak_break_count
- C1/zombie_hold_count
- C1/hold_cancel_count
- C2/hint_emitted
- C2/verdict_without_pass_count
- telemetry:/api/telemetry/metrics=503
- telemetry:/api/telemetry/metrics/history=503
- telemetry:/api/telemetry/traces=503
- telemetry:/api/telemetry/grounding-samples=503
- telemetry:/api/telemetry/health:otelEnabled=false
- telemetry:/api/telemetry/health:disabledReason=HMAC salt validation failed
- config:TELEMETRY_HMAC_SALT=absent
- process:TELEMETRY_HMAC_SALT=absent
- process:NODE_ENV=production
- github:pr16=merged-but-not-current-main
- github:main:2026-07-04-fix-verdict=404
- code:packages/api/src/infrastructure/telemetry/hmac.ts:24
- code:packages/api/src/infrastructure/telemetry/init.ts:111

Counterarguments:
- The latest sanitized raw snapshot is still from 2026-06-17, so today's config diagnosis relies on live runtime endpoint and process/config checks as supplementary evidence on top of stale committed raw evidence.
- Because PR #16 was merged but is absent from current main, this packet partly repairs evidence lineage; if main is intentionally rebuilt from another source, the underlying single-truth-source policy needs owner clarification.
- Targeting lang in ownerAsk is intentional because the immediate corrective action is a secret/config/restart decision; if fallback salt is authorized, implementation should move through normal code review.
