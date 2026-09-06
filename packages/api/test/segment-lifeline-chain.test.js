/** F257 version-chain tests. Eval/governance truth lives in CycleRecord, not this chain. */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

function makeEvent(partial) {
  return {
    eventId: `evt-${partial.timestamp}-${partial.action}`,
    hookId: 'S1',
    workspaceId: 'default',
    source: 'operator',
    actorId: 'user1',
    ...partial,
  };
}

describe('buildVersionChain', () => {
  let buildVersionChain;
  let attributeGuardEventsToEpochs;

  before(async () => {
    const mod = await import('../dist/routes/segment-lifeline-chain.js');
    buildVersionChain = mod.buildVersionChain;
    attributeGuardEventsToEpochs = mod.attributeGuardEventsToEpochs;
  });

  test('manifest-only segment is one active idle epoch', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      currentContentVersion: null,
    });
    assert.deepEqual(
      chain.map(({ version, origin, isActive, status }) => ({ version, origin, isActive, status })),
      [{ version: 1, origin: 'manifest', isActive: true, status: 'idle' }],
    );
  });

  test('content-set, rollback and recreate preserve epochs and choose the live version', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000, epochVersion: 3 }),
      ],
      observations: [],
      currentContentVersion: 2,
    });
    assert.deepEqual(
      chain.map(({ version, parentVersion, isActive }) => ({ version, parentVersion, isActive })),
      [
        { version: 1, parentVersion: null, isActive: false },
        { version: 2, parentVersion: 1, isActive: false },
        { version: 3, parentVersion: 1, isActive: true },
      ],
    );
  });

  test('observations follow the activation timeline, including rollback', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [
        { timestamp: 500, version: null, fired: false, disabled: true },
        { timestamp: 1500, version: 1, fired: true, disabled: false },
        { timestamp: 2500, version: null, fired: true, disabled: false },
      ],
      currentContentVersion: null,
    });
    assert.deepEqual(chain[0].tracing, {
      observationCount: 2,
      firedCount: 1,
      disabledCount: 1,
      firstAt: 500,
      lastAt: 2500,
    });
    assert.deepEqual(chain[1].tracing, {
      observationCount: 1,
      firedCount: 1,
      disabledCount: 0,
      firstAt: 1500,
      lastAt: 1500,
    });
    assert.equal(chain[0].status, 'tracing');
  });

  test('disabled-only activity remains visible as tracing without an injection', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [
        { timestamp: 500, version: null, fired: false, disabled: true },
        { timestamp: 750, version: null, fired: false, disabled: true },
      ],
      currentContentVersion: null,
    });

    assert.equal(chain[0].status, 'tracing');
    assert.deepEqual(chain[0].tracing, {
      observationCount: 2,
      firedCount: 0,
      disabledCount: 2,
      firstAt: 500,
      lastAt: 750,
    });
  });

  test('same-ms transitions honor event order', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 3 }),
      ],
      observations: [{ timestamp: 2500, version: null, fired: false, disabled: false }],
      currentContentVersion: 2,
    });
    assert.equal(chain[2].isActive, true);
    assert.equal(chain[2].tracing?.observationCount, 1);
  });

  test('version-activate targets epochVersion before legacy contentVersion', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 3 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 2 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 3, contentVersion: 1 }),
      ],
      observations: [],
      currentContentVersion: 1,
    });
    assert.equal(chain.find(({ version }) => version === 3)?.isActive, true);
    assert.equal(chain.find(({ version }) => version === 2)?.isActive, false);
  });

  test('enable/disable attach governance event kinds to the active epoch', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'disable', timestamp: 2000 }),
        makeEvent({ action: 'enable', timestamp: 3000 }),
      ],
      observations: [],
      currentContentVersion: 1,
    });
    assert.deepEqual(
      chain[1].events.slice(0, 2).map(({ kind }) => kind),
      ['governance-reject', 'governance-approve'],
    );
  });

  test('guard evidence is attributed to the epoch active at event time', () => {
    const { chain, timeline } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 100, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 200 }),
      ],
      observations: [],
      currentContentVersion: null,
    });
    const metrics = attributeGuardEventsToEpochs(chain, timeline, [
      { timestamp: 50, guardId: 'g1' },
      { timestamp: 150, guardId: 'g1' },
      { timestamp: 250, guardId: 'g1' },
    ]);
    assert.deepEqual(metrics[1], [{ guardId: 'g1', count: 2 }]);
    assert.deepEqual(metrics[2], [{ guardId: 'g1', count: 1 }]);
  });
});
