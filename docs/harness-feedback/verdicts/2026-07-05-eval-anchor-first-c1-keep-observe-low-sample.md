---
feature_ids: [F192, F236]
topics: [harness-eval, eval-anchor-first, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:anchor-first
packet_id: 2026-07-05-eval-anchor-first-c1-keep-observe-low-sample
source_snapshot: "snapshot:bundle/2026-07-05-eval-anchor-first-c1-keep-observe-low-sample/snapshot"
---

# Live Verdict — 2026-07-05-eval-anchor-first-c1-keep-observe-low-sample

- Verdict: `keep_observe`
- Phenomenon: In the latest 24h window from July 4, 2026 03:00 UTC to July 5, 2026 03:00 UTC, the current API process shows one explicit anchor `thread-context` preview covering 20 items, followed by four matched `get-message` drills and one earlier orphan drill. That sample still produced positive double-sided savings of 40,537 chars and no per-tool anchor-tax signal, but the whole window is concentrated in one session and one cat.
- Harness: F236/anchor-telemetry-rollup (anchor-first preview/drill open-rate rollup)
- Owner ask: Keep the weekly eval running, do not sunset anchor on any tool yet, and re-evaluate after a window with broader multi-tool or multi-cat usage or once `eval:task-outcome` has its first committed verdict.
- Re-eval: Re-evaluate on the next weekly fire and only close this low-sample concern once a later 24h window shows broader usage, or any tool produces Signal 1 and `eval:task-outcome` supplies real blindness evidence. at 2026-07-12T03:00:00.000Z

Sunset Signal Assessment:
- thread-context: HEALTHY (openRate=14.3%, netBenefit=45535)

Open-Rate Detail:
- thread-context: 14.3% open rate (4/28 items), charsSaved=49041, drillChars=3506, netBenefit=45535
- Orphan drills: 1

Adoption Detail:
- explicitAnchorCalls=1; explicitFullCalls=3; uniqueCatsExplicitAnchor=1
- defaultAnchorCalls=1; defaultFullCalls=0
- legacyEquivalentAnchorCalls=0; legacyEquivalentFullCalls=5
- unknownModeCalls=0

Evidence:
- snapshot:bundle/2026-07-05-eval-anchor-first-c1-keep-observe-low-sample/snapshot
- attribution:bundle/2026-07-05-eval-anchor-first-c1-keep-observe-low-sample/AF-2026-07-05-thread-context
- metric:anchor-telemetry-rollup/thread-context_previewed_items
- metric:anchor-telemetry-rollup/thread-context_drilled_unique_items
- metric:anchor-telemetry-rollup/thread-context_net_benefit
- metric:anchor-telemetry-rollup/orphan_drills
- metric:anchor-telemetry-rollup/adoption_explicit_anchor_calls
- metric:anchor-telemetry-rollup/adoption_legacy_equivalent_full_calls
- transcript:thread_mr6kh7kdoac6852d/codex/ae5eb979-7c81-475f-9e89-566bea8aaf59#event17
- transcript:thread_mr6kh7kdoac6852d/codex/ae5eb979-7c81-475f-9e89-566bea8aaf59#event12
- transcript:thread_mr6kh7kdoac6852d/codex/ae5eb979-7c81-475f-9e89-566bea8aaf59#event56

Counterarguments:
- Twenty previewed items is above the generator's low-sample item gate, so calling the window 'low sample' may be overly conservative if future windows look similar.
- The single-session concentration could also mean anchor-first is especially useful in deep review flows, so sparse usage alone is not a weakness.
- Because `eval:task-outcome` has no committed live verdict yet, the absence of Signal 2 evidence is partly a measurement gap rather than affirmative proof of safety.
