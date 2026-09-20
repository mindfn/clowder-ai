/**
 * F202 Train C1 — Host-driven outbound: thread activity reaches a subscribing plugin.
 *
 * THE SHAPE operator settled: the plugin declares which thread it wants and which of its own
 * methods to call; when the thread produces a message the Host finds the subscribers and calls
 * that method; whatever the plugin then does with it (relay to Feishu, or anything else) is
 * closed inside the plugin. Nothing here knows what an IM connector is.
 *
 * WHY THE DRIVER LIVES IN THE HOST. The durable half of this already exists and is already
 * published — subscribe/read/ack carry the cursor, the replay floor and the INV-9 stale signal.
 * Putting the consume loop in the Host means one implementation with one set of failure
 * semantics; asking every plugin author to write their own read/ack loop would mean N copies
 * and N ways to drop a message. So the driver is a Host-side consumer of the Host's own
 * published API, and the only surface this adds is the direction itself: calling a plugin.
 *
 * WHAT THE TESTS PIN. Delivery must be at-least-once against a failing plugin (case 2) — the
 * cursor may only advance on an accepted call, because a connector that was briefly down must
 * come back to its messages rather than discover a hole. And it must not redeliver what was
 * accepted (case 3), because a duplicate outbound is a duplicate message in someone's chat.
 *
 * STATUS when written: RED — `domains/messaging/subscription-delivery.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createMessagingDomain;
let createSubscriptionDelivery;
let MessageStore;

let messaging;
let delivery;
let calls;
/** Errors to inject into successive invoke() calls; one entry consumed per attempt. */
let invokeFailures;

const THREAD_ID = 'thread-1';
const USER_ID = 'user-1';
const PRODUCER = { pluginInstanceId: 'inst-producer' };
const SUBSCRIBER_A = 'inst-feishu';
const SUBSCRIBER_B = 'inst-front-desk';

beforeEach(async () => {
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ createSubscriptionDelivery } = await import('../dist/domains/messaging/subscription-delivery.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  calls = [];
  invokeFailures = [];
  messaging = createMessagingDomain({ messageStore: new MessageStore() });

  delivery = createSubscriptionDelivery({
    messaging,
    invoke: {
      async invoke(pluginInstanceId, method, params) {
        const failure = invokeFailures.shift();
        if (failure) throw new Error(failure);
        calls.push({ pluginInstanceId, method, params });
      },
    },
  });
});

async function subscribeHandle(pluginInstanceId) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId,
    threadId: THREAD_ID,
    userId: USER_ID,
    scope: { canSend: false, canSubscribe: true },
  });
  return handleId;
}

async function produce(text, idempotencyKey) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: PRODUCER.pluginInstanceId,
    threadId: THREAD_ID,
    userId: USER_ID,
    scope: { canSend: true, canSubscribe: false },
  });
  return messaging.send(PRODUCER, {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey,
    payload: {
      provenance: { epistemicStatus: 'user_intent' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
    },
  });
}

describe('F202 C1 — Host-driven subscription delivery', () => {
  test('case 1: a message on a subscribed thread calls the declared method once', async () => {
    await delivery.register({
      pluginInstanceId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
      method: 'outbound',
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    assert.equal(calls.length, 1, 'the subscriber must be called exactly once');
    assert.equal(calls[0].pluginInstanceId, SUBSCRIBER_A);
    assert.equal(calls[0].method, 'outbound', 'the Host must call the method the plugin declared');
  });

  test('case 2: a failing plugin does not lose the message — it is redelivered', async () => {
    await delivery.register({
      pluginInstanceId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
      method: 'outbound',
    });
    await produce('hello', 'k1');

    invokeFailures.push('plugin is down');
    await delivery.drain(THREAD_ID).catch(() => {});
    assert.equal(calls.length, 0, 'the failed attempt must not count as delivered');

    await delivery.drain(THREAD_ID);
    assert.equal(calls.length, 1, 'the same message must come back after the plugin recovers');
  });

  test('case 3: an accepted message is not redelivered', async () => {
    await delivery.register({
      pluginInstanceId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
      method: 'outbound',
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);
    await delivery.drain(THREAD_ID);

    assert.equal(calls.length, 1, 'a duplicate outbound would be a duplicate message in a chat');
  });

  test('case 4: every subscriber of the thread is called, and the Host knows no connector', async () => {
    await delivery.register({
      pluginInstanceId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
      method: 'outbound',
    });
    await delivery.register({
      pluginInstanceId: SUBSCRIBER_B,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_B),
      method: 'deliver',
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    const byInstance = new Map(calls.map((c) => [c.pluginInstanceId, c.method]));
    assert.equal(byInstance.get(SUBSCRIBER_A), 'outbound');
    assert.equal(byInstance.get(SUBSCRIBER_B), 'deliver', 'each plugin declares its own method name');
    assert.equal(calls.length, 2);
  });
});
