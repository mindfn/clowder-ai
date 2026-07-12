---
feature_ids: [F192, F236]
topics: [harness-eval, eval-anchor-first, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:anchor-first
packet_id: 2026-07-12-anchor-first-empty-post-restart-observe
source_snapshot: "snapshot:bundle/2026-07-12-anchor-first-empty-post-restart-observe/snapshot"
---

# Live Verdict — 2026-07-12-anchor-first-empty-post-restart-observe

- Verdict: `keep_observe`
- Phenomenon: The latest 24h in-memory anchor telemetry rollup has no preview responses after the API restarted four minutes into the window: no per-tool entries, no drills, and zero adoption activations. The sample is insufficient for sunset assessment; neither anchor-tax nor task-outcome-correlated blindness is established.
- Harness: F236/anchor-telemetry-rollup (anchor-first preview/drill open-rate rollup)
- Owner ask: Keep anchor-first enabled without implementation change; collect another 24h window with at least 10 previewed items per tool where possible and restore a queryable Track-1 cross-reference before making sunset or expansion decisions.
- Re-eval: Re-evaluate when the retained window has at least 10 previewed items for one or more anchor tools and a current eval:task-outcome verdict is available to test blindness correlation; otherwise retain keep_observe as insufficient-data. at 2026-07-19T03:00:00Z

Sunset Signal Assessment:

Open-Rate Detail:
- Orphan drills: 0

Adoption Detail:
- explicitAnchorCalls=0; explicitFullCalls=0; uniqueCatsExplicitAnchor=0
- defaultAnchorCalls=0; defaultFullCalls=0
- legacyEquivalentAnchorCalls=0; legacyEquivalentFullCalls=0
- unknownModeCalls=0

Evidence:
- snapshot:bundle/2026-07-12-anchor-first-empty-post-restart-observe/snapshot
- attribution:bundle/2026-07-12-anchor-first-empty-post-restart-observe/eval-F236-2026-07-12:no-finding
- metric:docs/harness-feedback/bundles/2026-07-12-anchor-first-empty-post-restart-observe/raw/rollup.json#track1Snapshot
- docs/harness-feedback/bundles/2026-07-12-anchor-first-empty-post-restart-observe/raw/rollup.json#selector

Counterarguments:
- A process restart erased any first-four-minute telemetry, so an empty retained rollup is not proof of zero wall-clock usage.
- The absence of a published eval:task-outcome verdict means no blindness evidence was found, not that blindness is impossible.
- Track-1 metrics were not exposed by the current Prometheus readout, limiting independent volume sanity checks.
