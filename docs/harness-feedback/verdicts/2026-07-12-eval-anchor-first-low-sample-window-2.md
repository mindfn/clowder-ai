---
feature_ids: [F192, F236]
topics: [harness-eval, eval-anchor-first, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:anchor-first
packet_id: 2026-07-12-eval-anchor-first-low-sample-window-2
source_snapshot: "snapshot:bundle/2026-07-12-eval-anchor-first-low-sample-window-2/snapshot"
---

# Live Verdict — 2026-07-12-eval-anchor-first-low-sample-window-2

- Verdict: `keep_observe`
- Phenomenon: Past 24h anchor-first rollup contains no previewed items, so no per-tool open-rate or benefit signal can be established; all preview and drill metrics are below actionable sample thresholds.
- Harness: F236/anchor-telemetry-rollup (anchor-first preview/drill open-rate rollup)
- Owner ask: Keep observing. Re-run eval:anchor-first over the next 24h windows until at least one preview tool reaches >=10 previewed items, then reassess for anchor-tax or blindness.
- Re-eval: Re-evaluate on next eval run; escalate only if a tool has actionable signal and task-outcome trend indicates blindness risk. at 2026-07-19T03:10:00.000Z

Sunset Signal Assessment:

Open-Rate Detail:
- Orphan drills: 0

Adoption Detail:
- explicitAnchorCalls=0; explicitFullCalls=1; uniqueCatsExplicitAnchor=0
- defaultAnchorCalls=0; defaultFullCalls=0
- legacyEquivalentAnchorCalls=0; legacyEquivalentFullCalls=0
- unknownModeCalls=0

Evidence:
- snapshot:bundle/2026-07-12-eval-anchor-first-low-sample-window-2/snapshot
- attribution:bundle/2026-07-12-eval-anchor-first-low-sample-window-2/eval-F236-2026-07-12:no-finding
- metric:anchor.previewed_items
- metric:anchor.drill_chars
- metric:anchor.net_benefit
- metric:anchor.orphan_drills
- trace:anchor-first-low-signal

Counterarguments:
- No previews can also indicate healthy low usage.
- Some preview requests could be routed in other runtime processes not represented in this in-memory window.
