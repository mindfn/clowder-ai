import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runM0dJointAcceptance } from './plugin-m0d-joint-runner.js';

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
