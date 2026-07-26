---
feature_ids: [F192, F236]
topics: [harness-eval, eval-anchor-first, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:anchor-first
packet_id: 2026-07-26-anchor-first-low-volume-observe
source_snapshot: "snapshot:bundle/2026-07-26-anchor-first-low-volume-observe/snapshot"
---

# Live Verdict — 2026-07-26-anchor-first-low-volume-observe

- Verdict: `keep_observe`
- Phenomenon: The latest 24h window (2026-07-25 03:00 UTC to 2026-07-26 03:00 UTC) retained only two anchor-mode thread-context responses, one list-tasks response, two explicit full thread-context responses, and no get-message full drill in the runtime log sanity check. This is materially lower activity than the 2026-07-19 baseline and insufficient for a new sunset conclusion; no committed eval:task-outcome verdict exists, so blindness correlation remains unavailable rather than disproved.
- Harness: F236/anchor-telemetry-rollup (anchor-first preview/drill open-rate rollup)
- Owner ask: Keep anchor-first enabled on all preview tools without implementation change; collect another retained 24h window with broader preview/drill traffic and obtain a committed eval:task-outcome verdict before any blindness or sunset decision.
- Re-eval: Re-evaluate on the next weekly fire; escalate to fix if any tool has anchorTax=true or task-outcome supplies correlated blindness evidence, and require both signals plus per-tool identification before proposing sunset. at 2026-08-02T03:00:00.000Z

Sunset Signal Assessment:
- list-tasks: HEALTHY (openRate=0.0%, netBenefit=2886)
- thread-context: HEALTHY (openRate=0.0%, netBenefit=8956)

Open-Rate Detail:
- list-tasks: 0.0% open rate (0/71 items), charsSaved=2886, drillChars=0, netBenefit=2886
- thread-context: 0.0% open rate (0/14 items), charsSaved=8956, drillChars=0, netBenefit=8956
- Orphan drills: 0

Adoption Detail:
- explicitAnchorCalls=2; explicitFullCalls=2; uniqueCatsExplicitAnchor=1
- defaultAnchorCalls=0; defaultFullCalls=0
- legacyEquivalentAnchorCalls=1; legacyEquivalentFullCalls=0
- unknownModeCalls=0

Evidence:
- snapshot:bundle/2026-07-26-anchor-first-low-volume-observe/snapshot
- attribution:bundle/2026-07-26-anchor-first-low-volume-observe/AF-2026-07-26-list-tasks
- attribution:bundle/2026-07-26-anchor-first-low-volume-observe/AF-2026-07-26-thread-context
- metric:docs/harness-feedback/bundles/2026-07-26-anchor-first-low-volume-observe/raw/rollup.json#rollup.perTool
- metric:docs/harness-feedback/bundles/2026-07-26-anchor-first-low-volume-observe/raw/rollup.json#rollup.adoption
- metric:docs/harness-feedback/bundles/2026-07-26-anchor-first-low-volume-observe/raw/rollup.json#rollup.track1Snapshot
- docs/harness-feedback/bundles/2026-07-26-anchor-first-low-volume-observe/raw/rollup.json#selector

Counterarguments:
- The list-tasks response may cover many items, so the generator could classify that tool as adequately sampled despite only one response.
- Zero drills can mean previews were sufficient, but it can also mean cats did not act on or notice drill pointers.
- The lack of a task-outcome verdict is a measurement gap and must not be interpreted as affirmative evidence that anchor previews are harmless.
