# CI batch admission isolation

Base: `7b78bfca096f4ffd27aadc47306a26ee0ed95d01`. Exact source: `thread_msr51149hym0i79f#0001791612959672-000403-f4fc8bc0` (Astra read-only diagnosis), continuing task300 / #1398. This is a notification-collection fix, not an A2A routing or Queue identity change.

## Root cause and change

GitHub returned #1398's exact HEAD and successful checks, but CI admission waited for every tracked PR's failure details before returning any work. An unrelated detail query could exhaust the shared 30-second admission deadline; no PR facts reached the collector. Astra observed 54 consecutive timed-out runs after GitHub had completed; the historical per-request blocker was not logged, so credential contention remains an inference, not a proven individual HTTP cause.

Batch admission now performs the GraphQL fact read and synchronous per-PR mapping only. Required-check narrowing and typed jobs/annotations enrichment move into each PR's existing scheduler work item. A detail timeout cancels only that PR; the scheduler records its failure and continues with siblings. Incomplete (>100 contexts) rollups remain unknown in the shared snapshot and use the existing exact single-PR reader within their own work item. Unknown reads may likewise be retried there; no missing/partial/cancelled result becomes pass. The standalone reader's classification remains unchanged.

Architecture cell: GitHub fact collection → existing per-PR scheduler execution → CiCdRouter/GitHubWaitLifecycleService → existing Message+Queue admission.
Map delta: diagnostic and exact-read work move from shared admission to per-PR execution; no persistent schema, generation writer, ownership or delivery boundary changes.
Why: an unrelated PR's diagnostic work must not prevent known successful facts from reaching their owner. Reuse existing per-item timeouts/cancellation rather than increase the global timeout or introduce a cache/re-registration scheme.

## Validation

- New batch regressions before the change: 5 passed, 2 failed (extra diagnostic calls in shared admission; a truncated sibling query aborted the whole batch). `red.log.gz` retains these real assertion failures.
- After the change: 8 related files, 11 suites, **87/87 passed**, zero skips. Coverage includes batch/single CI interpretation, required failure checks, typed diagnostics/quota pause, admission cancellation cleanup, CI router and generation lifecycle.
- Production scheduler pipeline fixture: a failed PR's diagnostic is cancelled by its item timeout; the later pass PR advances. A real in-memory TaskStore + GitHubWaitLifecycleService + CiCdRouter + MessageStore/InvocationQueue fixture persists pass, advances generation, admits one exact owner wake, and does not duplicate it on another tick. Only the existing scheduler timeout is shortened in the isolated test.
- The end-to-end fixture initially omitted the CI pending baseline (86/87); the preserved initial log documents that fixture error. Adding the same baseline as actual registration yields 87/87. It is separate from the two production regressions.
- Feature API TypeScript compilation passed; changed-file Biome error-level checks and diff-check passed. Existing complexity warnings are not represented as new failures.
- No real GitHub polling, provider, runtime configuration/data/process changes, Redis mutation, re-registration, restart or full-gate claim. Test I/O uses fixtures and the existing isolated test-home wrapper. Reviewer approval and new-HEAD CI remain separate publication steps.

## Limit

A genuinely slow failed PR may still reach its own 30-second execution timeout and retry on a later tick; it does not discard siblings. This change does not claim to shorten that PR's diagnostics or fix the separate scheduler error-log formatting issue. #220's previously verified 7b78 CI result remains valid for that source cut; any successor requires its own CI result.
