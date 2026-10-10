# F117: one Queue drain owns message progress

Operator source: 0001791616427782-000073-83b7d39d. Base: 4fbb6a2cb56dc965e69d3b912791c422bbb9d3e5.

The prior change connected a missed producer Append call but retained three ingress-owned orchestration paths. This successor removes the user/A2A Append loops and producer busy branch. All signal the existing Queue drain after durable admission; the drain chooses exact Append or fresh-turn admission. Message+Queue atomic admission, each source identity, explicit author intent, parent/owner/private/pinned/capability/Stop fences, deferred retries and receipts remain. There is no sender-kind branch or new send HTTP service. Source-specific envelope preparation remains at the ingress.

Production diff: 28 added, 60 deleted lines across three files. No change to the already approved short tips copy. No GitHub CI plugin change; no runtime/config/data write, replay, merge or restart.

## Verification

API compiled locally with `pnpm --dir packages/api exec tsc` (build-final, exit 0).

Initial new four-source drain cases red: dispatch count 0 instead of 1 on the prior implementation (red). First migrated run exposed old ingress-owned call/state expectations (first); those assertions moved to common progress and real Queue boundary tests, preserving semantics. Final ordinary regression: 12 files, 228/228 (final-green). Sources user/agent/external/system append to the original response, concurrent drains dispatch once, explicit next-work waits, mismatched parent records fallback without guidance, negative boundaries remain queued. Existing Queue fairness, retry, Stop, ingress, Queue API and receipt tests pass.

Two existing TS suites mix src runtime class imports with fixture dist classes. Raw node lacks TS resolution (regression); tsx resolves modules but class-identity admission fails and a Live race blocks (regression-green/live-probe), so that test-only run was terminated, not any runtime process. To exercise one consistent production build, owned copies replace only `../src/` import prefixes with `../dist/`; copies preserved here, assertions unchanged. Their first consistent run exposed a real await regression: Live companion verification must remain asynchronous to HTTP admission (live-consistent; three race timeouts). Fixed by signaling the same drain while preserving Live nonblocking admission. Final consistent compiled Live/persisted suites: 35/35 (typed-green). These are isolated memory/client fixtures, not provider or operator/soak acceptance. No changes to the two original TS files.

Run ordinary suites from packages/api through `bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test`: 1398-append-delivery-boundary, message-lifecycle-ingress, callback-a2a-trigger, queue-processor, queue-api, queue-retry-deferrals, queue-cancel-no-auto-resume, queue-failed-only-fairness, queue-integration, message-lifecycle-queue-order, 1398-append-read-observation, callback-a2a-postmsg (all .test.js).

For typed reproduction copy the two preserved tests back into packages/api/test under their original temporary names, then use `bash scripts/with-test-home.sh node --import tsx --test --test-timeout=15000 test/.f117-common-drain-live.test.ts test/.f117-common-drain-persisted.test.ts`. Remove only these owned copies afterward. Original suites: 1398-live-queue-admission.test.ts and persisted-queue-delivery.test.ts.

Logs document failed setup and intermediate production findings as well as final green; no failed attempt is presented as a successful run. The earlier green log accidentally named nonexistent QueueProcessor.test.js: its 44 tests are the three other files only; final-green explicitly uses queue-processor.test.js and supersedes it.
