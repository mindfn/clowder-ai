import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { CAPABILITY_TABLE } from '@clowder-ai/plugin-contract';
import { executeBehaviorCase } from '@clowder-ai/plugin-contract/conformance';

import { contractPermissionEntries, HostControlBehaviorAdapter } from './plugin-m0d-host-control-adapter.js';

const require = createRequire(import.meta.url);
const fixturePath = require.resolve('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function behaviorCase(id) {
  const found = fixture.cases.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing contract behavior case ${id}`);
  return structuredClone(found);
}

test('Host controls pass the signed L1 rejection, visible revocation, and complete matrix cases', async () => {
  for (const id of ['preset-l2-rejected', 'preset-visible-revocable', 'permission-matrix-complete']) {
    const contractCase = behaviorCase(id);
    const adapter = new HostControlBehaviorAdapter(contractCase);
    // eslint-disable-next-line no-await-in-loop
    const report = await executeBehaviorCase(contractCase, adapter);
    assert.deepEqual(report, { id, passed: true, failures: [] });
  }
});

test('permission entries are projected from every contract capability without a copied Core catalog', () => {
  assert.deepEqual(
    contractPermissionEntries(),
    Object.entries(CAPABILITY_TABLE).flatMap(([layer, capabilities]) =>
      capabilities.map((capability) => ({ capability, layer, firstPartyPreset: layer === 'L1' })),
    ),
  );
});

test('stale grant revision rejects revocation without overwriting the newer Host snapshot', async () => {
  const contractCase = behaviorCase('preset-visible-revocable');
  const adapter = new HostControlBehaviorAdapter(contractCase);
  await adapter.setup(contractCase.given);
  await adapter.store.transaction((transaction) => {
    const grant = transaction.grants.get(adapter.pluginInstanceId);
    transaction.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, updatedAt: 50 });
  });
  const before = await adapter.store.snapshot();

  assert.deepEqual(await adapter.execute(contractCase.when), { status: 'error', errorCode: 'PERMISSION' });
  assert.equal(adapter.rawHostErrorCode, 'STALE_GRANT_REVISION');
  assert.deepEqual(await adapter.store.snapshot(), before);
});

test('a retired instance rejects revocation without resurrecting inventory state', async () => {
  const contractCase = behaviorCase('preset-visible-revocable');
  const adapter = new HostControlBehaviorAdapter(contractCase);
  await adapter.setup(contractCase.given);
  await adapter.store.transaction((transaction) => {
    const instance = transaction.instances.get(adapter.pluginInstanceId);
    transaction.instances.put({
      ...instance,
      lifecycleState: 'retired',
      activationState: 'disabled',
      runtimeState: 'stopped',
      lifecycleRevision: instance.lifecycleRevision + 1,
      retiredAt: 60,
      updatedAt: 60,
    });
  });
  const before = await adapter.store.snapshot();

  assert.deepEqual(await adapter.execute(contractCase.when), { status: 'error', errorCode: 'PERMISSION' });
  assert.equal(adapter.rawHostErrorCode, 'STALE_INSTANCE');
  assert.deepEqual(await adapter.store.snapshot(), before);
});
