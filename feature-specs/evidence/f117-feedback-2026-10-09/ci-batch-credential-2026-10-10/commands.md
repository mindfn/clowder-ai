Feature checkout commands:

```
pnpm --dir packages/api exec tsc
pnpm exec biome check --write --diagnostic-level=error packages/api/src/infrastructure/email/CiCdCheckTaskSpec.ts packages/api/src/domains/plugin/github-schedule-factories.ts packages/api/src/index.ts packages/api/test/github-ci-credential-isolation.test.js
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/github-ci-credential-isolation.test.js packages/api/test/github-schedule-factories.test.js packages/api/test/ci-status-batch-fetcher.test.js packages/api/test/ci-status-fetcher.test.js packages/api/test/scheduler/cicd-check-spec.test.js packages/api/test/scheduler/github-poller-admission-liveness.test.js packages/api/test/github-ci-quota-liveness.test.js packages/api/test/github-ci-enrichment-liveness.test.js packages/api/test/cicd-router.test.js packages/api/test/f280-github-wait-lifecycle.test.js
```

Before correction, the credential file alone was run against d867 compiled dist. All subprocess results are owned fixtures. Actual index DI changes are two lines plus import removal; real startup is not run.
