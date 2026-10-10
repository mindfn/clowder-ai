# Reproducible commands (feature checkout)

All API commands use `pnpm --filter @cat-cafe/api exec bash scripts/with-test-home.sh`, with `node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=30000`.

Red: `--test-name-pattern='callback preserves different explicit|callback retry restores' test/callback-routes.test.js test/callback-routes-agent-key.test.js` before the production edits.

API final: test/callback-routes.test.js test/callback-routes-agent-key.test.js test/callback-message-identity.test.js test/callback-a2a-trigger.test.js test/cross-thread-action-successor.test.js test/action-successor-carrier-recovery.test.js test/action-successor-carrier-refresh-admission.test.js test/action-successor-carrier-refresh-recovery.test.js test/callback-f193-boundary.test.js test/callback-cross-post-fail-closed.test.js test/post-message-successor-e2e.test.js test/f247-cloud-return-append-winner.test.js test/callback-f177h-participant-check.test.js test/callbacks-f182-c.test.js test/callback-scope-helpers.test.js test/cross-thread-coordination-ingress.test.js test/message-store.test.js test/direct-action-carrier-recovery-e2e.test.js test/direct-action-carrier-refresh-e2e.test.js test/1398-reeval-carrier-atomic-admission.test.js

Redis: same wrapper, then `bash scripts/run-isolated-redis-tests.sh -- node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=60000 test/redis-message-store.test.js test/redis-message-delivery-atomicity.test.js`.

MCP: same HOME wrapper, then `node --test ../mcp-server/test/callback-tools.test.js ../mcp-server/test/callback-tools-agent-key.test.js ../mcp-server/test/callback-retry.test.js`.

Original reproducer: same HOME wrapper, then `node --test /tmp/astra-callback-distinct-client-id.test.mjs`.

Build: `pnpm --filter @cat-cafe/api exec tsc`; `pnpm --filter @cat-cafe/finance build`; `pnpm --filter @cat-cafe/mcp-server exec tsc`.
