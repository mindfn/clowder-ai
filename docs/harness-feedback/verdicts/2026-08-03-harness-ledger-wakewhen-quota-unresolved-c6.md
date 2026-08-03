---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6
source_snapshot: "snapshot:bundle/2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6/snapshot"
---

# eval:harness-ledger Verdict — 2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6

- Verdict: `fix`
- Phenomenon: The 168h window contains 208 raw guard events / 189 episodes: all 181 dedup_active episodes remain correctly escalation-ineligible, while eight exact hold_ball_rate_limit episodes are eligible. The prior mode-aware fix remains undeployed; one newly entered episode again rejected a wakeWhen command-custody attempt, forcing Kimi to hand a 2.9 GB artifact download-and-verification job to another cat instead of retaining completion custody.
- Harness: F167/hold-ball-rate-limit (Mode-blind hold_ball rolling-window quota and C1 abuse metric)
- Owner ask: Implement the already-agreed mode-aware hold policy and update the F167 C1 metric contract. Apply the 3/~1h frequency gate only to wakeAfterMs polling; do not count or reject wakeWhen through that timer quota, leaving it bounded by the single active registry owner, timeout, and documented <=5s cancellation overlap. Add holdMode to the response and GuardRejection telemetry, retain separate command observability, and add red-to-green regressions proving that three accepted timer holds followed by wakeWhen still starts and completes, while a fourth timer hold remains 429 with useful retry metadata. Ensure any command-path rejection has an explicit safe handoff rather than a no-trigger state.
- Re-eval: next eval at 2026-08-10T03:13:31.123Z

Evidence:
- snapshot:bundle/2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6/snapshot
- attribution:bundle/2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6/f257-guard-a2a_route_decision_skip
- attribution:bundle/2026-08-03-harness-ledger-wakewhen-quota-unresolved-c6/f257-guard-hold_ball_rate_limit

**Window**: 7 days | **Events**: 208

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| route_decision_skip | 200 |
| http_rate_limit | 8 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| a2a_route_decision_skip | 200 |
| hold_ball_rate_limit | 8 |

## Notes

Observed 208 guard rejection events over 7 days across 2 event kind(s) and 2 guard(s).
