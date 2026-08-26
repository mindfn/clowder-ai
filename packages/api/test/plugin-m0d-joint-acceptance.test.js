import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { runM0dJointAcceptance } from './plugin-m0d-joint-runner.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const acceptanceCli = resolve(import.meta.dirname, '../scripts/m0d-joint-acceptance.mjs');

test('published M0 behavior catalog reports the real frozen Host execution boundary', async () => {
  const report = await runM0dJointAcceptance();
  assert.equal(report.catalog.catalogMatches, true);
  assert.equal(report.catalog.count, 18);
  assert.equal(report.counts['schema-incompatible-at-frozen-sha'], 3);
  assert.equal(report.counts['not-implemented-at-frozen-sha'], 6);
  assert.equal((report.counts.pass ?? 0) + (report.counts['canonical-mismatch'] ?? 0), 9);
  assert.equal(
    report.cases
      .filter((row) => row.transport !== 'host-admin')
      .every((row) => row.childPidObserved && row.sideEffectsPassed),
    true,
  );
  const snapshotRoundTrip = report.cases.find((row) => row.id === 'stale-cursor-snapshot-roundtrip');
  assert.equal(snapshotRoundTrip.observed.roundTrip.snapshot.snapshotAckToken, '<opaque>');
  assert.equal(snapshotRoundTrip.observed.result.ackToken, null);

  const canonicalFailures = report.cases
    .filter((row) => row.verdict === 'canonical-mismatch')
    .map((row) => ({ id: row.id, failures: row.failures, observed: row.observed }));
  assert.deepEqual(canonicalFailures, []);
});

test('joint acceptance CLI rejects provenance coordinates that are not durable commits', () => {
  const unrelatedSha = '0000000000000000000000000000000000000000';
  const result = spawnSync(
    process.execPath,
    [
      acceptanceCli,
      '--plugins-repository',
      repositoryRoot,
      '--plugins-sha',
      unrelatedSha,
      '--host-reviewed-sha',
      unrelatedSha,
      '--host-merge-sha',
      unrelatedSha,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1' },
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /--plugins-sha .* does not resolve to a commit/);
});
