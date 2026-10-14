import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

async function settleHistoricalSource(h, source, priorInvocationId = 'historical-source-child') {
  const entry = h.queue.list('thread-1', 'user-1').find((candidate) => candidate.messageId === source.id);
  assert.ok(entry);
  const seenAt = entry.createdAt + 10;
  assert.equal(h.queue.markProcessingById('thread-1', entry.id), true);
  assert.equal(
    h.queue.markQueuedAwakened('thread-1', 'user-1', entry.id, 'codex-sol', priorInvocationId, seenAt - 1),
    true,
  );
  h.queue.markProcessingSeen('thread-1', 'user-1', entry.id, ['codex-sol'], priorInvocationId, seenAt);
  const processing = h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id);
  await h.coordinator.persistEntry(processing);
  await h.coordinator.commitSuccessfulTargets(processing, ['codex-sol'], priorInvocationId, seenAt + 20, {
    'codex-sol': {
      invocationId: priorInvocationId,
      disposition: 'completed_with_turn',
      evidenceRef: { kind: 'turn_execution', invocationId: priorInvocationId },
      handledAt: seenAt + 20,
    },
  });
  assert.equal(h.queue.removeProcessedAcrossUsers('thread-1', entry.id)?.id, entry.id);
}

for (const read of ['window', 'targeted-window', 'drill']) {
  test(`ordinary ${read} read can settle the new source without replaying the primary`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    assert.equal((await h.complete()).status, 200);
    const source = await h.addSource('second request');
    const body = await h.get(
      read === 'window'
        ? '/api/callbacks/thread-context?responseMode=full'
        : read === 'targeted-window'
          ? `/api/callbacks/thread-context?messageId=${source.id}&before=0&after=0&responseMode=full`
          : `/api/callbacks/get-message?messageId=${source.id}&mode=full`,
    );
    assert.match(JSON.stringify(body), /second request/);
    assert.ok(
      h.messageStore
        .getById(source.id)
        .queueCustody.bodyExposures.some((e) => e.invocationId === h.identity.invocationId),
    );
    assert.deepEqual(
      body.a2aDispatchDisposition?.candidates.map((c) => c.sourceMessageId),
      [source.id],
    );
    const result = await h.complete(source.id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.sourceMessageId, source.id);
    assert.equal(result.body.outcome, 'applied');
    assert.deepEqual(h.messageStore.getById(source.id).queueCustody.handledByCatIds, ['codex-sol']);
    assert.equal((await h.complete(source.id)).body.outcome, 'replayed');
    await h.processor.onInvocationComplete('thread-1', 'codex-sol', 'failed', h.identity.invocationId, []);
    assert.deepEqual(h.messageStore.getById(source.id).queueCustody.failedByCatIds, []);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });
}

test('targeted full thread window exposes only its exact source, not returned neighbors', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const neighbor = await h.addSource('neighbor request');
  const target = await h.addSource('target request');

  const body = await h.get(`/api/callbacks/thread-context?messageId=${target.id}&before=3&after=3&responseMode=full`);
  assert.match(JSON.stringify(body), /neighbor request/);
  assert.match(JSON.stringify(body), /target request/);
  assert.equal(
    h.messageStore
      .getById(neighbor.id)
      .queueCustody.bodyExposures?.some((exposure) => exposure.invocationId === h.identity.invocationId) ?? false,
    false,
  );
  assert.equal(
    h.messageStore
      .getById(target.id)
      .queueCustody.bodyExposures.some((exposure) => exposure.invocationId === h.identity.invocationId),
    true,
  );
  assert.deepEqual(
    body.a2aDispatchDisposition?.candidates.map((candidate) => candidate.sourceMessageId),
    [target.id],
  );
  assert.equal((await h.complete(neighbor.id)).status, 412);
  assert.equal((await h.complete(target.id)).status, 200);
});

test('targeted preview does not create dispatch read authority', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const source = await h.addSource('preview-only request');

  const body = await h.get(`/api/callbacks/thread-context?messageId=${source.id}&before=0&after=0`);
  assert.equal(body.messages[0].content, undefined);
  assert.match(body.messages[0].preview, /preview-only request/);
  assert.equal(body.a2aDispatchDisposition, undefined);
  assert.equal(h.messageStore.getById(source.id).queueCustody.bodyExposures, undefined);
  assert.equal((await h.complete(source.id)).status, 412);
});

test('oversized targeted full window remains an anchor without dispatch read authority', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const source = await h.addSource(`oversized request ${'x'.repeat(30_000)}`);

  const body = await h.get(`/api/callbacks/thread-context?messageId=${source.id}&before=0&after=0&responseMode=full`);
  assert.equal(body.messages[0].oversized, true);
  assert.equal(body.messages[0].content, undefined);
  assert.equal(body.a2aDispatchDisposition, undefined);
  assert.equal(h.messageStore.getById(source.id).queueCustody.bodyExposures, undefined);
  assert.equal((await h.complete(source.id)).status, 412);
});

for (const read of ['targeted-window', 'drill'])
  test(`${read} full read reports no obligation for an already settled historical source`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    assert.equal((await h.complete()).status, 200);
    const source = await h.addSource('already settled historical request');
    await settleHistoricalSource(h, source);

    const settled = h.messageStore.getById(source.id);
    assert.equal(settled.deliveryStatus, 'delivered');
    assert.equal(settled.queueCustody.status, 'terminal');
    assert.equal(settled.queueCustody.targetOutcomeByCatId['codex-sol'].disposition, 'completed_with_turn');

    const body = await h.get(
      read === 'targeted-window'
        ? `/api/callbacks/thread-context?messageId=${source.id}&before=0&after=0&responseMode=full`
        : `/api/callbacks/get-message?messageId=${source.id}&mode=full`,
    );
    const returnedMessage =
      read === 'targeted-window' ? body.messages.find((message) => message.id === source.id) : body.message;
    assert.equal(returnedMessage.content, source.content);
    assert.deepEqual(body.a2aDispatchDisposition, {
      state: 'no_obligation',
      candidates: [],
      resolvedSources: [{ sourceMessageId: source.id, reason: 'already_terminal' }],
      instruction:
        'The requested exact dispatch source is already terminal, replaced, or withdrawn. Do not call cat_cafe_complete_a2a_dispatch for it; this result proves only that this source owes no further disposition.',
    });
  });

test('default exact window keeps pending candidates and reports the requested settled source', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const pending = await h.addSource('pending neighbor request');
  const pendingRead = await h.get(`/api/callbacks/get-message?messageId=${pending.id}&mode=full`);
  assert.deepEqual(
    pendingRead.a2aDispatchDisposition?.candidates.map((candidate) => candidate.sourceMessageId),
    [pending.id],
  );

  const settled = await h.addSource('settled exact request in a default window');
  await settleHistoricalSource(h, settled, 'settled-default-window-child');
  const body = await h.get(`/api/callbacks/thread-context?messageId=${settled.id}&responseMode=full`);

  assert.ok(body.messages.some((message) => message.id === pending.id));
  assert.ok(body.messages.some((message) => message.id === settled.id && message.content === settled.content));
  assert.equal(body.a2aDispatchDisposition?.state, 'pending');
  assert.deepEqual(
    body.a2aDispatchDisposition?.candidates.map((candidate) => candidate.sourceMessageId),
    [pending.id],
  );
  assert.deepEqual(body.a2aDispatchDisposition?.resolvedSources, [
    { sourceMessageId: settled.id, reason: 'already_terminal' },
  ]);
  assert.equal((await h.complete(settled.id)).status, 412);
});

test('default exact window keeps pending candidates when the requested source has no handoff ledger', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const pending = await h.addSource('pending neighbor survives unknown exact source');
  const pendingRead = await h.get(`/api/callbacks/get-message?messageId=${pending.id}&mode=full`);
  assert.deepEqual(
    pendingRead.a2aDispatchDisposition?.candidates.map((candidate) => candidate.sourceMessageId),
    [pending.id],
  );

  const unknown = h.messageStore.append({
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    content: 'legacy exact source without a handoff ledger event',
    mentions: ['codex-sol'],
    timestamp: Date.now(),
  });
  const body = await h.get(`/api/callbacks/thread-context?messageId=${unknown.id}&responseMode=full`);

  assert.ok(body.messages.some((message) => message.id === pending.id));
  assert.ok(body.messages.some((message) => message.id === unknown.id && message.content === unknown.content));
  assert.equal(body.a2aDispatchDisposition?.state, 'pending');
  assert.deepEqual(
    body.a2aDispatchDisposition?.candidates.map((candidate) => candidate.sourceMessageId),
    [pending.id],
  );
  assert.equal(body.a2aDispatchDisposition?.resolvedSources, undefined);
});

test('exact full read reports no obligation for a causally replaced source', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const source = await h.addSource('request replaced by a later handoff');
  const successor = h.messageStore.append({
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    content: 'handoff to the next owner',
    mentions: ['opus'],
    replyTo: source.id,
    timestamp: Date.now(),
  });
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: 'codex-sol',
      toCatId: 'opus',
      messageId: successor.id,
      at: successor.timestamp,
    }),
  );

  const body = await h.get(`/api/callbacks/get-message?messageId=${source.id}&mode=full`);
  assert.equal(body.message.content, source.content);
  assert.deepEqual(body.a2aDispatchDisposition?.resolvedSources, [
    { sourceMessageId: source.id, reason: 'source_replaced' },
  ]);
  assert.equal(body.a2aDispatchDisposition?.state, 'no_obligation');
});

test('exact full read reports no obligation for an author-withdrawn source', async (t) => {
  const h = await ordinaryDispatchFixture(t);
  assert.equal((await h.complete()).status, 200);
  const source = await h.addSource('request withdrawn before handling');
  const entry = h.queue.list('thread-1', 'user-1').find((candidate) => candidate.messageId === source.id);
  assert.ok(entry);
  assert.equal(await h.coordinator.withdrawEntry(entry), true);
  assert.equal(h.queue.markProcessingById('thread-1', entry.id), true);
  assert.equal(h.queue.removeProcessedAcrossUsers('thread-1', entry.id)?.id, entry.id);

  const body = await h.get(`/api/callbacks/get-message?messageId=${source.id}&mode=full`);
  assert.equal(body.message.content, source.content);
  assert.deepEqual(body.a2aDispatchDisposition?.resolvedSources, [
    { sourceMessageId: source.id, reason: 'source_withdrawn' },
  ]);
  assert.equal(body.a2aDispatchDisposition?.state, 'no_obligation');
});

for (const targetShape of ['primary', 'merged'])
  test(`ordinary ${targetShape} source in a merged carrier gains no exact-window authority`, async (t) => {
    const h = await ordinaryDispatchFixture(t);
    assert.equal((await h.complete()).status, 200);
    const primary = await h.addSource('primary merged source');
    const sibling = h.messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      content: 'merged alias source',
      mentions: ['codex-sol'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: sibling.id,
        at: sibling.timestamp,
      }),
    );
    const entry = h.queue.list('thread-1', 'user-1')[0];
    assert.equal(
      h.queue.coalesceContentIntoQueuedAgent('thread-1', 'user-1', entry.id, sibling.content, sibling.id),
      true,
    );
    h.messageStore.initializeQueueCustody(
      sibling.id,
      createInitialQueuedMessageCustody(h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id)),
    );
    const requested = targetShape === 'primary' ? primary : sibling;
    const body = await h.get(
      `/api/callbacks/thread-context?messageId=${requested.id}&before=0&after=0&responseMode=full`,
    );
    assert.ok(body.messages.some((message) => message.id === requested.id && message.content === requested.content));
    assert.equal(body.a2aDispatchDisposition, undefined);
    assert.equal(h.messageStore.getById(requested.id).queueCustody.bodyExposures, undefined);
    assert.equal((await h.complete(requested.id)).status, 412);
  });
