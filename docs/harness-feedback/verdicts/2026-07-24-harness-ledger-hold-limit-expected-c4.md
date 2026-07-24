---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-07-24-harness-ledger-hold-limit-expected-c4
source_snapshot: "snapshot:bundle/2026-07-24-harness-ledger-hold-limit-expected-c4/snapshot"
---

# eval:harness-ledger Verdict — 2026-07-24-harness-ledger-hold-limit-expected-c4

- Verdict: `keep_observe`
- Phenomenon: The owner-scoped 168h window contains 69 raw events across 62 episodes: all 66 route_decision_skip events (59 episodes) are dedup_active and correctly excluded from escalation, while three exact hold_ball_rate_limit episodes independently hit the designed fourth-hold boundary in three thread-by-cat workflows within about 50 minutes. The eligible episode count rose from zero in the prior window, but sampled callers transferred the ball after rejection and no retry burst recurred, so the guard is enforcing its F167 boundary rather than showing a proven misconfiguration.
- Harness: F167/hold-ball-rate-limit (Bounded hold_ball rolling-window forced-pass guard)
- Owner ask: Keep the current 3-per-hour per-thread-and-cat boundary and the reason-aware F257 eligibility taxonomy unchanged for this window. In the next 168h evaluation, sample every hold_ball 429 for wait mode, callback coverage, and exit destination; escalate to a mode-aware counter fix only if concentrated fourth-hold rejections recur, block required wakeWhen command custody, cause task loss, or repeatedly route ordinary waits to the operator.
- Re-eval: next eval at 2026-07-31T04:54:59.145Z

Evidence:
- snapshot:bundle/2026-07-24-harness-ledger-hold-limit-expected-c4/snapshot
- attribution:bundle/2026-07-24-harness-ledger-hold-limit-expected-c4/f257-guard-a2a_route_decision_skip
- attribution:bundle/2026-07-24-harness-ledger-hold-limit-expected-c4/f257-guard-hold_ball_rate_limit

**Window**: 7 days | **Events**: 69

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| route_decision_skip | 66 |
| http_rate_limit | 3 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| a2a_route_decision_skip | 66 |
| hold_ball_rate_limit | 3 |

## Notes

Observed 69 guard rejection events over 7 days across 2 event kind(s) and 2 guard(s).
