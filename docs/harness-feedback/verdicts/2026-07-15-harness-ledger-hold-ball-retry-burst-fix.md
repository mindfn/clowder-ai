---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-07-15-harness-ledger-hold-ball-retry-burst-fix
source_snapshot: "snapshot:bundle/2026-07-15-harness-ledger-hold-ball-retry-burst-fix/snapshot"
---

# eval:harness-ledger Verdict — 2026-07-15-harness-ledger-hold-ball-retry-burst-fix

- Verdict: `fix`
- Phenomenon: The rolling 168h window increased from 0 to 3 guard rejections, all from hold_ball_rate_limit/http_rate_limit. The three metadata anchors occurred within 3,032 ms and exactly crossed the configured 3-events/7-day escalation threshold, showing a rapid rejection retry burst while route_decision_block remained at zero.
- Harness: F257/guard-rejection-log (Guard Rejection Event Log)
- Owner ask: Preserve the hold_ball limit and correlate event IDs bbd0f12f-9492-44ce-aac5-ed985db5f714, 330342fb-089e-4b6c-912f-b78a7bcc283e, and 1903710a-2fb3-4645-8f89-da57d15261ed to threadId/catId/invocation. Fix the agent, callback, or transport path that immediately resubmits after a 429, and add a regression proving the first rejection causes a pass-ball response without an automatic retry burst. If correlation proves three independent actors, document that counterevidence and retain the guard unchanged.
- Re-eval: next eval at 2026-07-22T10:24:19.352Z

Evidence:
- snapshot:bundle/2026-07-15-harness-ledger-hold-ball-retry-burst-fix/snapshot
- attribution:bundle/2026-07-15-harness-ledger-hold-ball-retry-burst-fix/f257-guard-hold_ball_rate_limit

**Window**: 7 days | **Events**: 3

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| http_rate_limit | 3 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| hold_ball_rate_limit | 3 |

## Notes

Observed 3 guard rejection events over 7 days across 1 event kind(s) and 1 guard(s).
