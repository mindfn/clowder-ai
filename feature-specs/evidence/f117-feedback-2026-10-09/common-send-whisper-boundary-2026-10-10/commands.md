# Commands

Feature root: pnpm exec tsc -p packages/api/tsconfig.json (exit0).

Feature packages/api: bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=15000 --test-name-pattern='astra' /tmp/astra-c354-whisper-review.test.mjs
Original red: /tmp/sol-c354-whisper-red.log. Original unchanged green: /tmp/f117-whisper-original-green.log. Script archived verbatim as reviewer-original.test.mjs.gz.

API: preceding common-send-a2a-boundary packet's 18-file API command plus test/1398-append-delivery-boundary.test.js. Same with-test-home + setup-cat-registry wrapper, timeout60000. api-green.log = 364/364.
Focused: same wrapper node --test timeout30000 test/1398-send-target-replay.test.js test/1398-append-delivery-boundary.test.js = 81/81 (overlapping).
Live/persisted copies: preceding common-send-target-replay packet's four archived .f117-successor-* fixtures/command, unchanged = 40/40. Removed after byte-equality verification against archives.
Biome error check: InvocationQueue.ts, QueueProcessor.ts, 1398-send-target-replay.test.js, 1398-send-policy-redis.test.js, 1398-append-delivery-boundary.test.js (five paths in codeHashes). No unsafe fixes.
