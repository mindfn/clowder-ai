import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let MessageStore;
let createMessagingDomain;
let messageStore;
let service;

const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  messageStore = new MessageStore();
  service = createMessagingDomain({ messageStore });
});

async function setupSubscription() {
  const { handleId } = await service.issueThreadHandle({
    pluginInstanceId: CTX.pluginInstanceId,
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true },
  });
  const { subscriptionId } = await service.subscribe(CTX, handleId);
  const receipts = [];
  for (const index of [1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    receipts.push(
      await service.send(CTX, {
        address: { kind: 'thread_handle', handle: handleId },
        idempotencyKey: `snapshot-page-${index}`,
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: `el-${index}`, kind: 'text', payload: { text: `message ${index}` } }],
        },
      }),
    );
  }
  return { handleId, receipts, subscriptionId };
}

describe('M0-C frozen snapshot paging', () => {
  test('pages a frozen projection and advances neither cursor until its final entitlement is acked', async () => {
    const { receipts, subscriptionId } = await setupSubscription();

    const first = await service.snapshotPage(CTX, { subscriptionId, maxItems: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].revision, 1);
    assert.equal(typeof first.nextPageToken, 'string');
    assert.equal(first.snapshotAckToken, null);

    await service.appendElements(CTX, {
      handle: receipts[1].messageHandle,
      operationId: 'after-snapshot-fence',
      baseRevision: 1,
      elements: [
        {
          elementId: 'el-after',
          kind: 'text',
          payload: { text: 'newer than frozen view' },
          derivedFromElementId: 'el-2',
        },
      ],
    });

    const beforeAck = await service.read(CTX, subscriptionId, { limit: 32 });
    assert.deepEqual(
      beforeAck.events.map((event) => event.sequence),
      [1, 2, 3],
      'snapshot traversal must not advance live cursors',
    );

    const final = await service.snapshotPage(CTX, {
      subscriptionId,
      maxItems: 1,
      pageToken: first.nextPageToken,
    });
    assert.equal(final.items.length, 1);
    assert.equal(final.items[0].messageId, receipts[1].messageId);
    assert.equal(final.items[0].revision, 1, 'later append cannot mutate the frozen page');
    assert.equal(final.nextPageToken, null);
    assert.equal(typeof final.snapshotAckToken, 'string');

    await service.ack(CTX, subscriptionId, final.snapshotAckToken);
    await service.ack(CTX, subscriptionId, final.snapshotAckToken);
    const afterAck = await service.read(CTX, subscriptionId, { limit: 32 });
    assert.deepEqual(
      afterAck.events.map((event) => event.sequence),
      [3],
      'snapshot entitlement advances to its frozen head exactly once',
    );
  });

  test('page tokens are subscription-local and stale views fail closed', async () => {
    const first = await setupSubscription();
    const second = await setupSubscription();
    const page = await service.snapshotPage(CTX, { subscriptionId: first.subscriptionId, maxItems: 1 });

    await assert.rejects(
      service.snapshotPage(CTX, {
        subscriptionId: second.subscriptionId,
        maxItems: 1,
        pageToken: page.nextPageToken,
      }),
      (error) => error?.code === 'PERMISSION',
    );

    const decoded = JSON.parse(Buffer.from(page.nextPageToken, 'base64url').toString('utf8'));
    const fabricated = Buffer.from(JSON.stringify({ ...decoded, o: 0 }), 'utf8').toString('base64url');
    await assert.rejects(
      service.snapshotPage(CTX, {
        subscriptionId: first.subscriptionId,
        maxItems: 1,
        pageToken: fabricated,
      }),
      (error) => error?.code === 'PERMISSION',
    );

    await service.snapshotPage(CTX, {
      subscriptionId: first.subscriptionId,
      maxItems: 1,
      pageToken: page.nextPageToken,
    });
    await assert.rejects(
      service.snapshotPage(CTX, {
        subscriptionId: first.subscriptionId,
        maxItems: 1,
        pageToken: page.nextPageToken,
      }),
      (error) => error?.code === 'PERMISSION',
    );
  });

  test('cannot fabricate the final snapshot ack before every page is consumed', async () => {
    const { subscriptionId } = await setupSubscription();
    const first = await service.snapshotPage(CTX, { subscriptionId, maxItems: 1 });
    const page = JSON.parse(Buffer.from(first.nextPageToken, 'base64url').toString('utf8'));
    const prematureAck = Buffer.from(
      JSON.stringify({ s: subscriptionId, q: 2, n: page.v, k: 'snapshot' }),
      'utf8',
    ).toString('base64url');

    await assert.rejects(service.ack(CTX, subscriptionId, prematureAck), (error) => error?.code === 'PERMISSION');
    const unread = await service.read(CTX, subscriptionId, { limit: 32 });
    assert.deepEqual(
      unread.events.map((event) => event.sequence),
      [1, 2],
    );
  });
});
