---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-07-19-harness-ledger-burst-coalescing-fix-c2
source_snapshot: "snapshot:bundle/2026-07-19-harness-ledger-burst-coalescing-fix-c2/snapshot"
---

# eval:harness-ledger Verdict — 2026-07-19-harness-ledger-burst-coalescing-fix-c2

- Verdict: `fix`
- Phenomenon: The current 168h window recorded 5 rejections (4 hold_ball and 1 A2A) versus 0 in the prior scheduled window; all four hold_ball anchors occurred within 7.044 seconds, while the A2A block was an isolated streak-4 termination. Both enforcement guards behaved correctly, but F257 counted the hold retry burst as four independent 3-per-7d escalation events and therefore overstated distinct incidents.
- Harness: F257/guard-threshold-escalation (Guard rejection event log and 3-per-7d threshold escalation)
- Owner ask: Keep the hold_ball and A2A enforcement thresholds unchanged. Change F257 escalation accounting to preserve rawEventCount but coalesce same-guard, same-thread, same-cat rapid retries into a distinct episode count used by the 3-per-7d threshold; carry episode and sample-anchor metadata into the committed bundle. Add regression coverage proving four hold_ball 429s in one 7-second episode remain rawEventCount=4 but episodeCount=1 and do not alone trigger the three-episode threshold, while three separated episodes still trigger; keep the isolated A2A streak-4 block independently attributable.
- Re-eval: next eval at 2026-07-26T03:00:01.238Z

Evidence:
- snapshot:bundle/2026-07-19-harness-ledger-burst-coalescing-fix-c2/snapshot
- attribution:bundle/2026-07-19-harness-ledger-burst-coalescing-fix-c2/harness-ledger-snapshot-2026-07-19-harness-ledger-burst-coalescing-fix-c2

**Window**: 7 days | **Events**: 5

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| http_rate_limit | 4 |
| route_decision_block | 1 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| hold_ball_rate_limit | 4 |
| a2a_block_pingpong | 1 |

## Notes

Observed 5 guard rejection events over 7 days across 2 event kind(s) and 2 guard(s).
