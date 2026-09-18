# F308 Public CI Under 10 Minutes — Resource-Scope Plan

**Feature:** F308 — `docs/features/F308-full-sync-durable-fast-train.md`
**Goal:** Reduce the target-CI public-test lane/job critical path below 10 minutes without reducing coverage, increasing in-process test concurrency, or assuming that every stateful test shares one global resource.
**Acceptance:** All selected files execute exactly once. Tests with direct external-network or external-command markers remain in one global serial lane. Tests whose observed state is runner-local execute across five isolated VMs, one file at a time in each VM. Four existing pure shards remain unchanged. A measured critical path over 600,000 ms fails CI. AC-D6 remains open until three same-selection target artifacts establish p50/p95.

## Evidence and boundary

The accepted single-serial topology selects 2,176 files: 1,648 serial and 528 pure. Post-merge run `35342249618` measured a 25m42.409s serial critical path and a 27m41s serial job.

The current source audit finds 95 files with a direct network or external-command marker. Their total measured time in the same-selection summary is 145.946s. The remaining serial files have no direct shared-resource marker; their observed markers are Redis, ports, filesystem, process, worker, dynamic loading, or naming fallbacks. Public shard jobs receive no service credentials, use read-only repository permission, and do not persist checkout credentials, so those observed resources remain runner-local. Missing audits and unknown classifications still fail closed into the shared lane.

This plan therefore does not claim that all tests are pure. It distinguishes two actual execution scopes:

- `serial-shared`: direct external-network/external-command scope, missing audits, and unknown classifications. One global lane, fail-closed.
- `serial-local-1…5`: stateful tests with a current source-bound audit showing no shared-resource marker. Separate GitHub VMs provide isolation; files remain sequential inside each VM.
- `pure-1…4`: existing explicit pure classification and current negative audit.

Historical per-file replay of the exact 2,176-file selection predicts 145.946s for `serial-shared`. Four runner-local shards would leave only seconds of modeled job-level margin below 10 minutes; five reduce the slowest test shard to about 6m29s and the modeled complete job to about 8m42s. The prior unconstrained four-VM target run measured 6m40.639s test critical path and an 8m53s slowest complete lane job. These are forecasts/precedent, not completion evidence for the new topology.

## Machine contract

The schema-v2 plan contains:

```js
{
  sharedSerialLane: { id: 'serial-shared', files: [...] },
  serialShards: [
    { id: 'serial-local-1', files: [...] },
    // serial-local-2 ... serial-local-5
  ],
  pureShards: [
    { id: 'pure-1', files: [...] },
    // pure-2 ... pure-4
  ]
}
```

Required invariants:

1. selected = assigned = observed = unique, with no missing, duplicate, extra, or failed files;
2. any missing resource-scope audit defaults to `serial-shared`;
3. any direct `network` or external-command marker defaults to `serial-shared`;
4. a `serial-local-*` assignment must carry source-bound scope evidence with no shared-resource marker;
5. every lane runs files sequentially with `--test-concurrency=1`;
6. shard jobs have `contents: read`, `persist-credentials: false`, and no external-service credentials;
7. summary aggregation requires all ten reports and rejects critical path above 600,000 ms.

## TDD and verification

1. Unit tests lock external-network → shared, runner-local state → five local shards, missing audit → shared, and reject a forged network → local assignment.
2. Runner and summary tests lock all ten lanes, schema-v2 reports, exact coverage, provenance, and fail-closed timing.
3. The workflow contract checker locks the lane matrix, read-only/no-persisted-credentials boundary, exact execution environment, and 10-minute gate.
4. Generate the real plan and verify 2,176 assignments are unique; verify every shared assignment has a shared-resource marker or fail-closed reason and no local assignment has a shared-resource marker.
5. Build as CI and run all ten lanes locally in the feature worktree with runtime Redis absent.
6. Aggregate the reports locally, then run `pnpm check`.
7. Obtain non-author exact-HEAD review before opening the upstream PR. Open as Draft, register tracking immediately, and use target CI as the Linux timing authority. Do not merge; maintainer owns merge.

## Not in scope

- raising the 30-minute timeout;
- reducing test selection or deleting assertions;
- global Node test concurrency;
- claiming three-run p50/p95 from one sample;
- moving shared/unknown network scope into runner-local shards;
- merging same-title tests without proof that inputs, branches, side effects, and assertions are equivalent.
