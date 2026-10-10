# Commands

Feature worktree: /Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback.

Compile from feature root: `pnpm exec tsc -p packages/api/tsconfig.json` → tsc-green.log.

API from packages/api: `bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=60000 test/1398-send-target-replay.test.js test/1398-send-policy-redis.test.js test/1398-send-ingress-policy.test.js test/agent-router.test.js test/invocation-queue.test.js test/queue-message-admission.test.js test/queue-ledger.test.js test/queue-ledger-provenance-coercion.test.js test/1398-failed-response-recovery.test.js test/1398-wait-outbox-admission.test.js test/1398-wait-outbox-linearization.test.js test/1398-connector-delivery-composition.test.js test/1398-connector-sender-identity.test.js test/callback-a2a-postmsg.test.js test/cloud-delivery-retry.test.js test/callback-post-result.test.js test/queue-processor.test.js` → api-green.log.

Copies: decompress .f117-successor-*.gz into packages/api/test using archived originalPath names. From packages/api run `bash scripts/with-test-home.sh node --import tsx --import ./test/helpers/setup-cat-registry.js --test --test-timeout=15000 test/.f117-successor-persisted-queue-delivery.test.ts test/.f117-successor-1398-live-queue-admission.test.ts test/.f117-successor-1398-live-claim-races.test.ts test/.f117-successor-f317-live-admission.test.mjs` → copies-green.log. Runnable copies removed after verification; archives remain verbatim.

Reproducer: decompress adapted-reproducer.test.mjs.gz to /tmp/sol-send-successor-boundaries.test.mjs; packages/api `bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test /tmp/sol-send-successor-boundaries.test.mjs` → adapted-reproducer-green.log.

Initial logs record unavailable service rejection and default-target drift. Subsequent first-api includes a missing TS loader and two old assertions; first-typed mixed src/dist modules and was stopped after failures. corrected compiled-copy results are separate. Compiler source edits briefly overlapped two build logs; final compilation was serialized after both sessions ended (tsc-green.log), with no source changes afterward. Command-path typos were corrected and are not test evidence.
