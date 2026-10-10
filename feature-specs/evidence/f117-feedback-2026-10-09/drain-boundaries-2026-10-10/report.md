# F117 common drain: target order and native-ACK isolation

Base: 413efba086264ad83193796cc41043db36b4baa9; its changes_requested verdict at thread_msr51149hym0i79f#0001791617291974-000101-b878f5f7 remains unchanged. Operator source106 reiterates durable send/admission -> signal drain -> intent/liveness/capability-driven dispatch, not source-specific scheduling.

## Findings closed in this candidate

P1: Automatic Append now checks the same held-target comparator barrier as fresh-turn admission, as well as the existing retry delay and Stop suppression. Explicit manual Append is unchanged. An older same-target explicit next_work/retry item blocks a later automatic input; another target can still advance.

P2: Automatic Append still waits for the exact durable claim, receiver/message admission, target retirement and projection before calling the client. An internal handoff callback then frees the thread drain, while the in-flight operation occupies only its target until native ACK or failure compensation finishes. The per-target slot prevents a subsequent automatic input or fresh turn from overtaking the operation, even after its Queue target has retired. Completion signals the same existing drain and releases the slot. This is an execution mutex, not another source router, message deduplication cache, fallback send path or availability gate. No persistent lifecycle/read enums changed. Ordinary HTTP input signals the drain without awaiting its operation and returns the existing durable admission receipt.

## Evidence

Local API tsc compilation (build) exit0. Existing independent owned counterexamples remain unchanged and are copied with their original red evidence here. Script SHA256 c1f30b898f45d2c7c29c818ec4289656c9da73cb285c9e69e37a68a9a1dc1607; original red log SHA256 e40a3b4a0a0c1fc660d970be7872316232e1125b827e34bb6ce66e2f479526bd. Re-run against the feature's rebuilt dist: original2/2 green. No network, runtime data, provider or replay.

Committed tests extend the real Queue/MessageStore/ActiveRun fixture: same-target next_work and retry barriers with another live target, pending A native ACK plus B progress while later A waits, A resuming on ACK, exactly-once asynchronous rejection compensation, and nonblocking HTTP while requestDrain remains unresolved. The first local focused run assumed requestDrain's returned owner included a dirty re-signal; it did not. The assertion was corrected to wait boundedly for actual B dispatch before releasing A, retaining the semantic condition rather than weakening it (focused/ focused-green). Original independent counterexamples were already green; no production fix followed this fixture correction.

Final 12 API files:233/233 (final); consistent compiled Live/persisted copies:35/35 (typed). The latter use exactly the src->dist import-only adaptation documented in ../common-queue-drain-2026-10-10/report.md; original TS suites remain unchanged. Separate compensation file run24/24; counts are overlapping and not summed into the final233. Original counterexample2/2 is separately counted.

Commands from packages/api: `bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test` with the same12 files as the prior common-drain report. Independent script: same command with /tmp/astra-413-drain-boundaries.test.mjs. Typed35: copies of 1398-live-queue-admission.test.ts/persisted-queue-delivery.test.ts with ../src/ import prefixes replaced by ../dist/, placed in test/.f117-drain-boundaries-{live,persisted}.test.ts; use wrapper node --import tsx --test --test-timeout=15000, then remove only owned copies. These are isolated fixtures, not actual provider, browser, operator experience or soak.

Existing413 candidate and its prepared fork overlay were not published. Review this exact successor before updating original1398/222; fork retains accepted221 plugin files, upstream excludes them. No runtime/config/data changes, no merge/restart, no new PR or tracking generation yet.
