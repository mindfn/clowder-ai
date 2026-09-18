# F308 Public CI Under 10 Minutes Implementation Plan

**Feature:** F308 — `docs/features/F308-full-sync-durable-fast-train.md`
**Goal:** Reduce the complete target-CI public-test critical path below 10 minutes without changing selection, coverage, or per-runner serial execution for stateful tests.
**Acceptance Criteria:** AC-D1–D6 remain fail-closed; the same selected files appear exactly once; stateful files execute one at a time inside isolated serial shards; local full-lane verification is green before any push; target CI demonstrates p50 ≤10m and p95 ≤12m.
**Architecture cell:** `action-plane`
**Map delta:** none
**Map delta why:** This extends F308's existing target-owned CI planner/runner contract and introduces no new runtime owner, store, or external writer.
**Architecture:** Replace the single 1,648-file serial queue with four deterministic serial shards. Each serial shard keeps the existing one-file-at-a-time runner behavior, while GitHub Actions supplies job-level VM isolation between shards; four existing pure shards remain unchanged. Exact-once aggregation and provenance validation expand to all eight lanes.
**Tech Stack:** Node.js 24, `node:test`, deterministic JSON plans/reports, GitHub Actions matrix, YAML contract checker.
**前端验证:** No — CI and test-runner behavior only.

---

## Finish line

One exact plan covers every selected public test exactly once across four `serial-N` and four `pure-N` lanes; all local lanes pass before push, and target CI reports a critical path below 10 minutes without globally raising Node test concurrency.

Not building: reduced test selection, hidden exclusions, `node --test` file concurrency, deletion of cross-provider contract coverage, or a timeout increase.

## Terminal schema

```js
{
  schemaVersion: 2,
  serialShards: [
    { id: 'serial-1', files: [...], estimatedDurationMs: 0 },
    // serial-2 ... serial-4
  ],
  pureShards: [
    { id: 'pure-1', files: [...], estimatedDurationMs: 0 },
    // pure-2 ... pure-4
  ],
  assignments: {
    'test/example.test.js': {
      lane: 'serial-1',
      ruleId: 'stateful-by-name',
      reason: '...',
      estimatedDurationMs: 1000
    }
  }
}
```

Invariant: each lane runner still invokes one test file at a time with `--test-concurrency=1`; concurrency exists only between isolated GitHub jobs.

### Task 1: Lock the multi-serial contract with RED tests

**Files:**
- Modify: `packages/api/test/public-test-shards.test.js`
- Modify: `packages/api/test/public-test-shard-runner.test.js`
- Modify: `packages/api/test/public-test-shard-summary.test.js`
- Modify: `.github/scripts/check-public-test-ci-contract.mjs`

1. Change fixture expectations from one `serial` lane to `serial-1…4`.
2. Assert deterministic balancing, exact-once assignment, and fail-closed rejection of missing/duplicate serial reports.
3. Assert the CI matrix contains exactly four serial and four pure lanes.
4. Run:
   `node --test packages/api/test/public-test-shards.test.js packages/api/test/public-test-shard-runner.test.js packages/api/test/public-test-shard-summary.test.js`
   Expected: FAIL because the planner and runner only understand `serial`.
5. Run: `node .github/scripts/check-public-test-ci-contract.mjs`
   Expected: FAIL because the workflow still has the five-lane matrix.

### Task 2: Implement deterministic serial sharding

**Files:**
- Modify: `packages/api/scripts/plan-public-test-shards.mjs`
- Modify: `packages/api/scripts/plan-public-test-shards-cli.mjs`
- Modify: `packages/api/scripts/run-public-test-shard.mjs`
- Modify: `packages/api/scripts/summarize-public-test-shards.mjs`

1. Add a four-shard serial planner using the same deterministic least-loaded assignment used by pure shards.
2. Bump the plan schema to version 2 and validate `serialShards` plus `pureShards` as one exact partition.
3. Preserve classification metadata and isolation reasons on every serial assignment.
4. Teach runner and summarizer to resolve all eight lane ids.
5. Report `serialCriticalPathMs`, `serialAggregateMs`, overall `criticalPathMs`, and total runner minutes.
6. Re-run Task 1 tests. Expected: PASS.

### Task 3: Run eight isolated CI lanes

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/scripts/check-public-test-ci-contract.mjs`

1. Replace `[serial, pure-1, pure-2, pure-3, pure-4]` with `[serial-1, serial-2, serial-3, serial-4, pure-1, pure-2, pure-3, pure-4]`.
2. Keep per-file `--test-concurrency=1`; do not add `max-parallel` or global Node concurrency.
3. Keep all required summary and `Test (Public)` gates fail-closed.
4. Run: `node .github/scripts/check-public-test-ci-contract.mjs`.
   Expected: PASS with eight exact lanes.

### Task 4: Update the F308 acceptance boundary

**Files:**
- Modify: `docs/features/F308-full-sync-durable-fast-train.md`

1. Record isolated serial sharding as the reviewed boundary that makes the original p50 ≤10m / p95 ≤12m target testable again.
2. Preserve the prohibition on coverage reduction and within-runner global concurrency.
3. Keep AC-D6 incomplete until three new same-selection target-CI artifacts exist.

### Task 5: Local complete verification before push

**Files:** No source changes.

1. Verify the shell environment does not expose runtime Redis: run all public-test commands with `env -u REDIS_URL` so behavior matches target CI and cannot touch persistent runtime data.
2. Build exactly as CI: shared → MCP server → API.
3. Generate one schema-v2 plan and verify its eight lanes contain the full selected set exactly once.
4. Run all eight lanes locally, sequentially, through `with-test-home.sh`; sequential local execution avoids pretending one macOS host has GitHub's VM isolation.
5. Aggregate all reports; require every selected file green and exactly once.
6. Run targeted tests and `pnpm check`. Any code/test failure returns to RED/GREEN before push.
7. Replay the latest target timing artifact through the new deterministic plan and require the estimated maximum lane below 8 minutes, leaving setup/build headroom for the 10-minute target.

### Task 6: Review, then push once

**Files:** All changed files above.

1. Run `pnpm biome format --write <changed files>` using the repository formatter.
2. Commit the locally complete change with Why and thread provenance.
3. Obtain non-author exact-HEAD review.
4. Only after local full verification and review, push the commit to PR #1482.
5. Collect target CI; do not merge. Three same-selection target runs are required only for the final design, not for intermediate edits.

## Follow-on audit, not a prerequisite for the safe split

- Audit 757 dynamic-import-only files for transitive isolation and move proven files into pure shards.
- Replace remaining real sleeps/timers in the long-tail files with deterministic clocks or deadlines.
- Merge tests only when production branches, inputs, assertions, and side effects are equivalent; the current scan found zero byte-identical test files, so no deletion is assumed.
