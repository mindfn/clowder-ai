---
feature_ids: [F245]
topics: [harness-eval, eval-friction, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:friction
packet_id: 2026-07-15-eval-friction-c3-private-memory-bypasses-harness-ledger
source_snapshot: "snapshot:bundle/2026-07-15-eval-friction-c3-private-memory-bypasses-harness-ledger/snapshot"
---

# Live Verdict — 2026-07-15-eval-friction-c3-private-memory-bypasses-harness-ledger

- Verdict: `fix`
- Phenomenon: The 2026-07-12T03:00Z to 2026-07-15T03:00Z window produced one medium-severity actionable user-feedback singleton in the F257 work thread: the user said the auto-harness was effectively unused because a correction was written only to Claude private memory instead of the Cat Cafe event and iteration system. Numeric volume remains flat versus baseline, but the sample directly exercises F257's documented write-only-memory failure mode and undermines the feature's primary user journey.
- Harness: F245/friction-rollup (friction rollup (Top-N + sensorForm))
- Root cause: The primary root cause is harness_misfit: F257 currently observes selected structural guard rejections but does not provide a completed, enforced correction/anomaly ingestion path for this workflow, so the agent fell back to provider-private auto-memory and incorrectly described that as an event-system write. This directly reproduces F257's own documented finding that memory feedback is write-only and outside the runtime critical path. (confidence high)
- Owner ask: Close the real correction-to-ledger path in the existing F257 thread. A co-creator correction or confirmed text_frustration event must enter a durable Cat Cafe anomaly or harness-ledger event store with a receipt/ledger id; self-evolution must use that path instead of treating Claude private memory as the system record; the event must be queryable by eval:harness-ledger and consumable by the planned F245 anomaly channel. Replay fi_mrk9vejf8x8ppl9x as the acceptance fixture and do not claim 'event recorded' without a durable receipt.
- Re-eval: next eval at 2026-07-18T03:00:00.000Z

Evidence:
- snapshot:bundle/2026-07-15-eval-friction-c3-private-memory-bypasses-harness-ledger/snapshot
- attribution:bundle/2026-07-15-eval-friction-c3-private-memory-bypasses-harness-ledger/FR-2026-07-15-73f7cc381631
- metric:friction-rollup.cluster_count
- metric:friction-rollup.total_signal_count
- metric:friction-rollup.user_feedback_signal_count
- metric:friction-rollup.actionable_candidate_count

Counterarguments:
- The cluster is still a single medium-severity reason-only signal with no cross-channel corroboration, so a fix verdict may overweight one strongly worded user message.
- F257 is explicitly in progress and already lists anomaly ingestion plus the F245 fifth adapter as future Phase B work, so this verdict may be restating planned scope rather than identifying a new defect.
- Private provider memory can remain a useful secondary behavioral cache; the defect is only that it was treated as the durable system record, not that such memory exists.
- Rule-only clustering is degraded and may not reliably distinguish a feature-level harness failure from a one-off agent execution mistake.