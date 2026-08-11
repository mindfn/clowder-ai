# Issue #1329 gate contract drift

## Bug diagnosis capsule

| Field | Evidence |
| --- | --- |
| Symptom | `pnpm gate` failed in the public API suite. One test omitted the new `effectiveStrategy` audit field; another expected a pre-invocation handoff seal from prior-turn usage. Under Node's default test isolation, the second assertion was obscured by `Unable to deserialize cloned data`. |
| Evidence | `invoke-single-cat-turn-execution.test.js:107` failed with an extra `effectiveStrategy`. Running `turn-custody-stop-gate-route.test.js` with `--test-isolation=none` exposed the hidden assertion at line 634: the remedial prompt did not contain `Session Continuity`. |
| Root cause | The tests retained pre-#1329 contracts. `invocation_created` now intentionally carries the invocation policy snapshot, and handoff without authoritative current-invocation usage is `unavailable` and must take no action. The deserialization error was a test-runner reporting failure while cloning the very large prompt assertion payload. |
| Diagnostic strategy | Reproduce each file alone, then disable test isolation to reveal the underlying assertion; compare both expectations with the accepted #1329 state/policy/capability contract. |
| Timeout strategy | If isolated execution did not expose the failure within 15 minutes, reduce the file to the failing subtest and inspect the child-process message payload. |
| Warning strategy | Stop if a proposed fix makes handoff consume persisted usage, removes `effectiveStrategy`, or rewrites the configured policy to satisfy the fixture. |
| User-visible correction | None. The fix preserves the accepted runtime behavior and updates regression fixtures to grade it accurately. |
| Acceptance | Both files pass together under normal isolation; the full `pnpm gate` passes on the exact review HEAD. |

## Report

1. **Reporter**: the repository `pnpm gate` public test suite on issue #1329's implementation branch.
2. **Reproduction**: run the two failing API tests under the normal public-test harness; run the stop-gate file with `--test-isolation=none` to expose its underlying assertion.
3. **Root cause**: two fixtures encoded superseded contracts. One treated the audit event as a closed object; the other treated prior-turn usage as sufficient handoff authority.
4. **Fix**: assert the complete `effectiveStrategy` audit snapshot. Preserve the capacity-seal prompt-rebuild scenario using an active hybrid revision with an observed policy-local compression count, which is valid pre-invocation proof.
5. **Verification**: the two files pass together (19 tests), followed by the exact-HEAD full gate.
