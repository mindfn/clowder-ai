import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDurablePublicInvocationCurrent } from '../src/domains/plugin/carrier/public-invocation-currentness.ts';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

function fixture(status, withChild) {
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: 'source',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
    contributionId: 'native',
    actionMethods: ['native.reply'],
    targetCatId: 'astra',
    authorityRef: 'public:1',
    authorityRevision: 'revision:1',
  };
  const binding = { entryId: 'entry-1', userId: 'owner', threadId: 'thread', targetCatId: 'astra' };
  const message = {
    id: 'source',
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    content: 'external source',
    source: { connector: 'fixture' },
    deliveryStatus: 'queued',
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 } },
    queueCustody: makeQueuedMessageCustody({
      ownerUserId: 'owner',
      ownerAuthProvenance: 'unknown',
      intent: 'execute',
      status,
      allTargetCats: ['astra'],
      pendingTargetCats: ['astra'],
      pluginPublicInvocation: carrier,
      ...(status === 'processing' ? { processingStartedAt: 1001 } : {}),
      ...(withChild ? { awakenedInvocationIdByCatId: { astra: 'child-1' }, awakenedAtByCatId: { astra: 1001 } } : {}),
    }),
  };
  let entered = 0;
  return {
    entered: () => entered,
    check: (invocationId) =>
      assertDurablePublicInvocationCurrent(
        'instance',
        carrier,
        { ...binding, ...(invocationId === undefined ? {} : { invocationId }) },
        { signal: new AbortController().signal, assertCurrent: async () => {} },
        {
          ownerUserId: 'owner',
          messageStore: { getById: async () => structuredClone(message) },
          threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['astra'] }) },
        },
        async () => {
          entered++;
          return { current: true };
        },
      ),
  };
}

for (const [status, withChild] of [
  ['processing', true],
  ['processing', false],
  ['queued', true],
]) {
  test(`public phase rejects omitted child for ${status} custody with witness=${withChild}`, async () => {
    const f = fixture(status, withChild);
    await assert.rejects(() => f.check(), /Public invocation source or custody/);
    assert.equal(f.entered(), 0);
  });
}

test('public phase accepts queue preflight only before a child is bound', async () => {
  const f = fixture('queued', false);
  assert.equal(await f.check(), undefined);
  assert.equal(f.entered(), 1);
});

test('public phase accepts processing only for its exact child', async () => {
  const f = fixture('processing', true);
  assert.equal(await f.check('child-1'), undefined);
  await assert.rejects(() => f.check('child-2'));
  assert.equal(f.entered(), 1);
});
