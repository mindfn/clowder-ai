import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

/**
 * A private input has no History member to carry its admission identity, so the Queue row is the
 * only thing standing between a stable producer key and a second execution. That row is removed on
 * purpose once its last target crosses into processing. The admission winner must outlive it.
 */
describe('#1398 private input idempotency', () => {
  const deliverOnce = (connector, threadId, userId) =>
    connector.delivery.deliverPrivate({
      ownerUserId: userId,
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
    });

  it('does not start the same work twice when a stable key is replayed after processing', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'private replay');
    const connector = connectorDeliveryHarness();

    const first = await deliverOnce(connector, thread.id, 'user-1');
    assert.equal(first.admitted, true);
    assert.equal(connector.progressed.length, 1, 'the first admission runs the work exactly once');

    // Cross the processing boundary: the durable row is retired by design.
    const claimed = await connector.queue.markProcessingDurable(thread.id, 'user-1', {
      entryId: first.entryId,
      targetCats: ['opus'],
    });
    assert.ok(claimed, 'the admitted entry must be claimable');
    const committed = await connector.queue.commitClaimedAdoptionDurable(
      thread.id,
      'user-1',
      first.entryId,
      'opus',
      'invocation-1',
      Date.now(),
    );
    assert.ok(committed, 'the claimed entry must cross into processing');
    assert.equal(
      await connector.queue.getDurableEntry(thread.id, first.entryId),
      null,
      'the Queue row is retired once its last target is processing',
    );

    // The producer replays the same stable key — a receipt-completion failure is allowed to do this.
    const replay = await deliverOnce(connector, thread.id, 'user-1');

    assert.equal(connector.progressed.length, 1, 'a replay after retirement must not start the work a second time');
    assert.equal(replay.admitted, true, 'the replay is reported as already admitted, not as a refusal');
  });

  const noticeFor = (threadId, userId) => ({
    from: { kind: 'system', service: 'scheduler' },
    userId,
    content: 'Scheduled eval triggered.',
    mentions: [],
    origin: 'callback',
    timestamp: Date.now(),
    threadId,
    source: { connector: 'scheduler', label: 'Scheduler' },
    idempotencyKey: 'eval-receipt-stable-key:notice',
  });

  it('never publishes a visible notice for work the Queue refused', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'refused admission');
    const connector = connectorDeliveryHarness();
    connector.queue.enqueueDurable = async () => ({ outcome: 'full' });

    const result = await connector.delivery.deliverVisibleWithPrivateInput({
      ownerUserId: 'user-1',
      threadId: thread.id,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      notice: noticeFor(thread.id, 'user-1'),
      sourceCategory: 'scheduled',
    });

    assert.equal(result.admitted, false, 'a refused admission is reported as refused');
    assert.equal(
      (await connector.messageStore.getByThread(thread.id)).length,
      0,
      'a refused admission must leave no visible notice behind',
    );
    assert.equal(connector.progressed.length, 0, 'no work may start');
  });

  it('publishes the visible notice at most once across a replayed stable key', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'replayed notice');
    const connector = connectorDeliveryHarness();
    const send = () =>
      connector.delivery.deliverVisibleWithPrivateInput({
        ownerUserId: 'user-1',
        threadId: thread.id,
        targetCatId: 'opus',
        idempotencyKey: 'eval-receipt-stable-key',
        content: 'run the scheduled eval',
        from: { kind: 'system', service: 'scheduler' },
        notice: noticeFor(thread.id, 'user-1'),
        sourceCategory: 'scheduled',
      });

    const first = await send();
    assert.equal(first.admitted, true);
    assert.ok(first.notice, 'the visible notice is published with its admitted work');
    assert.equal(connector.progressed.length, 1);

    const claimed = await connector.queue.markProcessingDurable(thread.id, 'user-1', {
      entryId: first.entryId,
      targetCats: ['opus'],
    });
    assert.ok(claimed);
    await connector.queue.commitClaimedAdoptionDurable(
      thread.id,
      'user-1',
      first.entryId,
      'opus',
      'invocation-1',
      Date.now(),
    );

    const replay = await send();
    assert.equal(replay.admitted, true, 'the replayed key is already-admitted work, not a refusal');
    assert.equal(connector.progressed.length, 1, 'the replay must not start the work again');
    assert.equal(
      (await connector.messageStore.getByThread(thread.id)).length,
      1,
      'the replay must not publish a second visible notice',
    );
  });
});
