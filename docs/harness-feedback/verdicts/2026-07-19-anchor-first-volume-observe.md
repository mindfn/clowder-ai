---
feature_ids: [F192, F236]
topics: [harness-eval, eval-anchor-first, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:anchor-first
packet_id: 2026-07-19-anchor-first-volume-observe
source_snapshot: "snapshot:bundle/2026-07-19-anchor-first-volume-observe/snapshot"
---

# Live Verdict — 2026-07-19-anchor-first-volume-observe

- Verdict: `keep_observe`
- Phenomenon: For the latest 24h window (2026-07-18 03:00 UTC to 2026-07-19 03:00 UTC), runtime log sanity checks show materially broader anchor traffic than the prior empty snapshot: 20 anchor-mode thread-context responses (including one response surfacing 200 items), 13 list-tasks responses, one empty anchor-mode pending-mentions response, and 8 get-message full drills. Thread-context therefore cannot meet the >80% per-item anchor-tax threshold; no committed eval:task-outcome verdict exists, so blindness correlation remains unavailable rather than disproved.
- Harness: F236/anchor-telemetry-rollup (anchor-first preview/drill open-rate rollup)
- Owner ask: Keep anchor-first enabled on all preview tools without implementation change; obtain a committed eval:task-outcome verdict for blindness correlation and re-evaluate the exact per-tool rollup and adoption lens on the next weekly fire.
- Re-eval: Re-evaluate after another retained 24h window; escalate to fix only if any tool has anchorTax=true or task-outcome supplies blindness evidence, and require both signals before proposing a per-tool sunset. at 2026-07-26T03:00:00.000Z

Sunset Signal Assessment:
- thread-context: HEALTHY (openRate=0.9%, netBenefit=1204328)
- list-tasks: NET_NEGATIVE (openRate=2.9%, netBenefit=-427)
- pending-mentions: LOW_SAMPLE (openRate=0.0%, netBenefit=0)

Open-Rate Detail:
- thread-context: 0.9% open rate (6/704 items), charsSaved=1229441, drillChars=25113, netBenefit=1204328
- list-tasks: 2.9% open rate (1/34 items), charsSaved=1190, drillChars=1617, netBenefit=-427
- pending-mentions: 0.0% open rate (0/0 items), charsSaved=0, drillChars=0, netBenefit=0
- Orphan drills: 1

Adoption Detail:
- explicitAnchorCalls=18; explicitFullCalls=42; uniqueCatsExplicitAnchor=2
- defaultAnchorCalls=3; defaultFullCalls=0
- legacyEquivalentAnchorCalls=11; legacyEquivalentFullCalls=10
- unknownModeCalls=0

Evidence:
- snapshot:bundle/2026-07-19-anchor-first-volume-observe/snapshot
- attribution:bundle/2026-07-19-anchor-first-volume-observe/AF-2026-07-19-thread-context
- attribution:bundle/2026-07-19-anchor-first-volume-observe/AF-2026-07-19-list-tasks
- metric:docs/harness-feedback/bundles/2026-07-19-anchor-first-volume-observe/raw/rollup.json#rollup.perTool
- metric:docs/harness-feedback/bundles/2026-07-19-anchor-first-volume-observe/raw/rollup.json#rollup.adoption
- metric:docs/harness-feedback/bundles/2026-07-19-anchor-first-volume-observe/raw/rollup.json#rollup.track1Snapshot
- docs/harness-feedback/bundles/2026-07-19-anchor-first-volume-observe/raw/rollup.json#selector

Counterarguments:
- The exact in-memory rollup may attribute fewer drills to thread-context than log volume suggests, which would strengthen rather than weaken the keep-observe verdict.
- A higher number of full-mode calls could indicate cats are bypassing anchor defaults even when matched drill open-rate remains low.
- Without a task-outcome verdict, keep_observe reflects an evidence gap and must not be read as affirmative proof that previews never cause judgment errors.
