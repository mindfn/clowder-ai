---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-07-21-harness-ledger-dedup-active-false-escalation-c3
source_snapshot: "snapshot:bundle/2026-07-21-harness-ledger-dedup-active-false-escalation-c3/snapshot"
---

# eval:harness-ledger Verdict — 2026-07-21-harness-ledger-dedup-active-false-escalation-c3

- Verdict: `fix`
- Phenomenon: The scoped 168h snapshot contains three raw events and three distinct episodes for a2a_route_decision_skip, all from the same opus-to-sol review thread and all dedup_active while the target was already processing or queued; the handoffs succeeded, yet the third healthy duplicate suppression triggered the 3-per-7d rejection escalation. The prior window is not trend-comparable because V2 introduced this producer and owner scoping.
- Harness: F257/route-decision-skip-escalation (Reason-aware A2A route-decision skip escalation)
- Owner ask: Keep raw route-decision skip telemetry, but add explicit escalation eligibility keyed by guard and normalized reason/outcome: record dedup_active while excluding it from the 3-per-7d harmful-rejection threshold; explicitly classify depth, aborted, and queue_pending. Persist skipReason/normalizedReason breakdown and sourceThreadId in committed bundle/provenance. Add regressions proving three distinct dedup_active episodes more than 60 seconds apart do not escalate, three eligible harmful skip episodes still do, and hold_ball/pingpong behavior is unchanged.
- Re-eval: next eval at 2026-07-26T03:00:01.238Z

Evidence:
- snapshot:bundle/2026-07-21-harness-ledger-dedup-active-false-escalation-c3/snapshot
- attribution:bundle/2026-07-21-harness-ledger-dedup-active-false-escalation-c3/f257-guard-a2a_route_decision_skip

**Window**: 7 days | **Events**: 3

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| route_decision_skip | 3 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| a2a_route_decision_skip | 3 |

## Notes

Observed 3 guard rejection events over 7 days across 1 event kind(s) and 1 guard(s).
