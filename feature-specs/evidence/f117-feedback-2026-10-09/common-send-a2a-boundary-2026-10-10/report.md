# task300 A2A exact-target correction

Parent b1197d1361f8e690cd3880091c2c4abd7f24b11a / 608a2cfe832aa96ee1d9462657487d28e80a7fa9. Review baseline remains e8d668dc. The preceding target/replay packet is historical evidence; this supplement gives final source hashes and supersedes its A2A zero-target claim.

Operator292 corrected the boundary: A2A line-start mentions or explicit IDs already denote a delivery target. They are not ordinary prose/default conversation routing. The previous public-wake relaxation was an author scope error and is withdrawn.

- Common send treats the existing message_wake kind as an exact-recipient carrier, alongside existing typed/private authority. No new source-kind scheduling branch, state or fallback is added.
- Restore the existing nonempty message_wake admission contract at both Queue input and ledger factory; restore QueueProcessor's existing invalid-explicit-target settlement. Ordinary conversation fallback and durable no-available-target failure remain as reviewed against operator239/248/252.
- A real callback HTTP regression now verifies an invalid specified ID produces isError=true, routed=[], and the durable source messageId, with no default receiver/wake. Existing line-start vs inline callback cases remain in the same suite. This is immediate failure feedback to the sender, distinct from a provider failure response's exact predecessor wake.
- New common-send regression verifies an unavailable known A2A recipient remains opus even when codex is available, and a zero-target wake cannot be silently assigned by prose/default routing. This verifies admission identity, not an end-to-end unavailable-service response claim.
- Existing serial/parallel provider failure tests exercise the failed-response transaction and exact predecessor carrier without availability preflight. No new failure callback mechanism was built.

Final validation: 18 API files, 23 suites, 292/292; consistently compiled Live/persisted-delivery copies 40/40; adapted common-send reproducer 4/4; TypeScript exit0; formatting and diff check pass. Counts overlap; all are author evidence. Original/adapted scripts and import-only compiled copies remain in the preceding packet; copies were restored verbatim, rerun and removed. No true provider/runtime update/restart/remote CI/full gate/operator soak. No publication to #1398/#222 before independent review.
