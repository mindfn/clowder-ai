Commands executed in the feature checkout:

```
pnpm --dir packages/api exec tsc
pnpm exec biome check --write --diagnostic-level=error <three changed API files and two changed tests>
CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash packages/api/scripts/with-test-home.sh node --test packages/api/test/ci-status-batch-fetcher.test.js packages/api/test/ci-status-fetcher.test.js packages/api/test/scheduler/cicd-check-spec.test.js packages/api/test/scheduler/github-poller-admission-liveness.test.js packages/api/test/github-ci-quota-liveness.test.js packages/api/test/github-ci-enrichment-liveness.test.js packages/api/test/cicd-router.test.js packages/api/test/f280-github-wait-lifecycle.test.js
```

Before implementation, the batch file alone ran against the base compiled dist (5/7, two new failures). The later API build compiled changed sources in this same feature checkout. No runtime checkout was built or modified.
