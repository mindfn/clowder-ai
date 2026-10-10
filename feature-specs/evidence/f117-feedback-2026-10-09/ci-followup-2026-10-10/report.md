# F117 CI follow-up: ordinary delivery ignores legacy availability

Observed public head: `52cb79817066d458555d67d81e7132545434dd26`.
Failure source: [distributable-6 job](https://github.com/zts212653/clowder-ai/actions/runs/38017850925/job/114112452232), run `38017850925`.

The lane has one failing test in `routing-human-recovery.test.js`: its old journey expected a failed provider invocation to publish global unavailability, reject later cross-thread requests, and require an owner recovery attempt. The aggregate `Test (Public)` consequently failed. This test was omitted from the earlier targeted author and independent checks; their passing counts did not cover this journey.

The implementation already matches operator 017/051/054. Keep production code unchanged. Rewrite this existing journey to assert each requested thread executes, reports its real error, never queries legacy availability or publishes global member state, and never creates an availability rejection receipt. Seed one durable legacy signal to prove it stays readable without controlling ordinary sends. After provider recovery, only explicit new requests execute; failed work is not replayed. Other explicit recovery-service tests remain intact.

Local original test: 8/9, exit 1, same `allowed` versus `rejected` assertion as CI. Corrected test: 9/9, exit 0. Related three-file check: see `f117-ci-followup-related-green.log.gz` for the exact total and all named cases. Biome check and git diff check passed.

No production source, runtime config, persistent user data, running process, or workflow change. The earlier Opus approval remains bound to `709caf89`; it is not a verdict on this new test-only commit. Independent validation for this external CI correction is the fresh published-head CI. No merge or runtime restart is authorized by this record.

Architecture cell: routing-context ordinary-delivery consumer retirement.
Map delta: none; existing regression now asserts the retired consumer stays disconnected.
Why: preserve the operator-approved delivery contract instead of restoring a global suppression layer to satisfy an obsolete expectation.
