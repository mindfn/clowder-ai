Feature packages/api:

bash scripts/with-test-home.sh node --import ./test/helpers/setup-cat-registry.js --test --test-timeout=60000 test/a2a-parallel-fanout-custody.test.js test/approval-hub/dispatch-action-recovery.test.js test/multi-mention-b6-queue-dispatch.test.js test/callback-a2a-postmsg.test.js test/f088-gateway-integration.test.js test/f295-active-execution-projection.test.js test/f247-serial-cloud-source.test.js

bash scripts/with-test-home.sh node --import tsx --import ./test/helpers/setup-cat-registry.js --test --test-timeout=60000 test/a2a-1577-failure-return-seam.test.mjs

Original reds used the same isolated wrapper and node runner, selecting the corresponding two-file pairs or the unchanged source fixture. Local Node v24.15.0.

Feature root: pnpm exec biome check the five changed test files; git diff --check. CI job logs read with canonical guarded gh api repos/zts212653/clowder-ai/actions/jobs/{jobId}/logs. Initial gh run view --log declined while the run was in progress; job endpoint reads succeeded. No test or runtime network operation was substituted for CI.
