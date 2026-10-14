import assert from 'node:assert/strict';
import { createCatId, type QueueTargetOutcome } from '@cat-cafe/shared';
import type { IMessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

/** Same persistent CAS contract against memory and an isolated Redis store. */
export async function verifyPublicReplyCustody(store: IMessageStore) {
  const catId = createCatId('codex-sol');
  const source = {
    connector: 'collective',
    label: 'Collective',
    icon: '🌐',
    meta: {
      participation: {
        serviceInstanceId: 'svc_aaaaaaaa',
        collectiveId: 'col_aaaaaaaa',
        connectionId: 'con_aaaaaaaa',
        catId,
        eventId: 'evt_aaaaaaaa',
        participationRevision: 1,
        location: { channelId: 'general' },
        actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Fixture Human' },
      },
    },
  };
  for (const mismatch of ['message', 'event', 'accepted', 'cat', 'scope', 'owner', 'valid']) {
    const initial = makeQueuedMessageCustody({
      ownerUserId: 'fixture-owner',
      ownerAuthProvenance: 'unknown',
      executionScope: 'collective-participation',
      intent: 'execute',
      allTargetCats: [catId],
      pendingTargetCats: [catId],
      seenByCatIds: [catId],
      seenInvocationIdByCatId: { [catId]: 'child' },
      bodyExposures: [{ targetCatId: catId, invocationId: 'child', seenAt: 1100 }],
    });
    const message = await store.append({
      userId: 'fixture-owner',
      threadId: `fixture-${mismatch}`,
      catId: null,
      content: 'Public request',
      mentions: [catId],
      timestamp: 1000,
      source,
      deliveryStatus: 'queued',
      queueCustody: initial,
    });
    const outcome: QueueTargetOutcome = {
      invocationId: 'child',
      disposition: 'responded',
      evidenceRef: { kind: 'turn_execution', invocationId: 'child' },
      handledAt: 1200,
      consumption: {
        kind: 'collective_public_reply',
        sourceMessageId: mismatch === 'message' ? 'wrong' : message.id,
        sourceEventId: mismatch === 'event' ? 'evt_wrong' : 'evt_aaaaaaaa',
        acceptedEventId: mismatch === 'accepted' ? '' : 'evt_bbbbbbbb',
      },
    };
    const target = mismatch === 'cat' ? createCatId('codex-terra') : catId;
    const next = {
      ...initial,
      revision: 2,
      status: 'terminal' as const,
      pendingTargetCats: [],
      handledByCatIds: [catId],
      seenInvocationIdByCatId: {},
      updatedAt: 1200,
      targetOutcomeByCatId: { [target]: outcome },
      ...(mismatch === 'scope' ? { executionScope: 'collective-work' as const } : {}),
      ...(mismatch === 'owner' ? { ownerUserId: 'wrong-owner' } : {}),
    };
    const transition = async () =>
      store.transitionQueueCustody(message.id, { expectedRevision: 1, next, deliveredAt: 1200 });
    if (mismatch === 'valid') {
      assert.equal((await transition()).kind, 'updated');
      assert.deepEqual(
        (await store.getById(message.id))?.queueCustody?.targetOutcomeByCatId?.[catId]?.consumption,
        outcome.consumption,
      );
    } else {
      await assert.rejects(transition);
      assert.equal((await store.getById(message.id))?.queueCustody?.revision, 1, mismatch);
    }
  }
}
