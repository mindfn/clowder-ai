---
feature_ids: [F257]
topics: [harness-eval, eval-harness-ledger, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:harness-ledger
packet_id: 2026-07-26-harness-ledger-wakewhen-quota-c5
source_snapshot: "snapshot:bundle/2026-07-26-harness-ledger-wakewhen-quota-c5/snapshot"
---

# eval:harness-ledger Verdict — 2026-07-26-harness-ledger-wakewhen-quota-c5

- Verdict: `fix`
- Phenomenon: The 168h window contained 91 raw guard events / 83 episodes: 79 dedup_active episodes were correctly excluded, while four exact hold_ball_rate_limit episodes remained eligible. Two were expected timer/cloud-wait boundaries, but two rejected legitimate wakeWhen command-custody attempts in one PR workflow; after the second rejection no persistent trigger remained and the operator had to revive the task about 2h19m later.
- Harness: F167/hold-ball-rate-limit (Mode-agnostic hold_ball rolling-window quota)
- Owner ask: Make the hold quota mode-aware: preserve the anti-loop cap for wakeAfterMs polling, but give wakeWhen a separately bounded policy aligned with its single active ManagedRunner and timeout. Add a red-to-green regression reproducing three accepted holds followed by a legitimate wakeWhen request and require command-completion wakeup or an explicit safe handoff rather than silent custody loss. Include hold mode in rejection telemetry/response so the next eval can compare timer versus command paths.
- Re-eval: next eval at 2026-08-02T03:00:00.009Z

Evidence:
- snapshot:bundle/2026-07-26-harness-ledger-wakewhen-quota-c5/snapshot
- attribution:bundle/2026-07-26-harness-ledger-wakewhen-quota-c5/f257-guard-a2a_route_decision_skip
- attribution:bundle/2026-07-26-harness-ledger-wakewhen-quota-c5/f257-guard-hold_ball_rate_limit

**Window**: 7 days | **Events**: 91

## Event Breakdown by Kind

| Kind | Count |
|------|-------|
| route_decision_skip | 87 |
| http_rate_limit | 4 |

## Event Breakdown by Guard

| Guard | Count |
|-------|-------|
| a2a_route_decision_skip | 87 |
| hold_ball_rate_limit | 4 |

## Notes

Observed 91 guard rejection events over 7 days across 2 event kind(s) and 2 guard(s).
