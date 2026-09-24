import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';

import { createLifecycleDelivery, lifecycleIdFor } from '../dist/domains/messaging/lifecycle-delivery.js';
import { createSubscriptionDelivery } from '../dist/domains/messaging/subscription-delivery.js';

test('lifecycle events share the thread delivery queue and retain stable ids', async () => {
  const calls = [];
  let tail = Promise.resolve();
  const delivery = createLifecycleDelivery({
    subscribers: () => ['subscriber-1'],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => {
      const current = tail.then(operation);
      tail = current.catch(() => undefined);
      return current;
    },
    drain: async () => calls.push({ state: 'message' }),
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onStreamEnd('thread-1', '', 'invocation-1');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-1');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-1');
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-1');
  assert.deepEqual(
    calls.map((call) => call.state),
    ['started', 'catching_up', 'catching_up', 'blocked', 'message', 'settled'],
  );
  assert.equal(calls[1].deliveryId === calls[2].deliveryId, false);
  assert.equal(new Set(calls.filter((call) => call.lifecycleId).map((call) => call.lifecycleId)).size, 1);
  assert.equal(calls[0].threadId, 'thread-1');
  assert.ok(calls.filter((call) => call.lifecycleId).every((call) => call.threadId === 'thread-1'));
  assert.ok(
    calls
      .filter((call) => call.lifecycleId)
      .every((call) => validateMessagingRowInput('host.messaging.lifecycle', call).valid),
  );
  assert.equal(calls.at(-1).chainDone, true);
  assert.equal(calls.at(-1).outcome, 'failed');
});

test('blocked carries the presentation deep link and settles failed even when invocation status succeeded', async () => {
  const events = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => ['subscriber'],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      events.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({
      actor: { displayName: 'Cat', emoji: '🐱' },
      thread: { shortId: 'thread-1' },
      deepLinkUrl: 'https://example.test/thread/thread-1',
    }),
  });
  await delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-blocked');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-blocked');
  assert.equal(events[1].recoveryUrl, events[0].presentation.deepLinkUrl);
  assert.equal(events[2].outcome, 'failed');
});

test('unsupported subscribers are skipped; R1 rejection is audited once without retry', async () => {
  const attempts = [];
  const errors = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => ['unsupported', 'supported'],
    supportsAction: (subscriber) => subscriber === 'supported',
    invoke: async (subscriber, _method, input) => {
      attempts.push({ subscriber, input });
      throw Object.assign(new Error('out of order'), { code: 'LIFECYCLE_OUT_OF_ORDER' });
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
    onError: (fields) => errors.push(fields),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-2');
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-2');
  await delivery.notifyDeliveryBatchDone('thread-1', false, 'failed', 'invocation-2');
  assert.deepEqual(
    attempts.map(({ input }) => input.state),
    ['started', 'settled'],
  );
  assert.deepEqual(
    errors.map((error) => error.errorKind),
    ['LIFECYCLE_OUT_OF_ORDER', 'LIFECYCLE_OUT_OF_ORDER'],
  );
  assert.equal(attempts.at(-1).input.outcome, 'failed');
  assert.equal(attempts.at(-1).input.chainDone, false);
});

test('a stalled lifecycle action is bounded and audited once', async () => {
  const errors = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => ['stalled'],
    supportsAction: () => true,
    invoke: async () => new Promise(() => undefined),
    actionTimeoutMs: 5,
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
    onError: (fields) => errors.push(fields),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-stalled');
  assert.deepEqual(
    errors.map((error) => error.errorKind),
    ['TIMEOUT'],
  );
});

test('concurrent start and blocked keep started before blocked', async () => {
  const calls = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => ['subscriber'],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input.state);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } };
    },
  });
  await Promise.all([
    delivery.onStreamStart('thread-1', 'cat-1', 'invocation-3'),
    delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-3'),
  ]);
  assert.deepEqual(calls, ['started', 'blocked']);
  await assert.rejects(delivery.onClosureBlocked('another-thread', 'cat-1', 'needs_user', 'invocation-3'));
});

test('started reserves the thread tail before asynchronous presentation lookup', async () => {
  const calls = [];
  let releasePresentation;
  let tail = Promise.resolve();
  const enqueueThread = async (_threadId, operation) => {
    const current = tail.then(operation);
    tail = current.catch(() => undefined);
    return current;
  };
  const lifecycle = createLifecycleDelivery({
    subscribers: () => ['subscriber'],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input.state);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread,
    drain: async () => undefined,
    presentation: () =>
      new Promise((resolve) => {
        releasePresentation = resolve;
      }),
  });

  const started = lifecycle.onStreamStart('thread-1', 'cat-1', 'invocation-slow-presentation');
  const message = enqueueThread('thread-1', async () => {
    calls.push('message');
  });
  releasePresentation({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } });
  await Promise.all([started, message]);
  assert.deepEqual(calls, ['started', 'message']);
});

test('canceled_by_user maps to cancelled rather than completed', async () => {
  const events = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => ['subscriber'],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      events.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-cancelled');
  await delivery.notifyDeliveryBatchDone('thread-1', false, 'canceled_by_user', 'invocation-cancelled');
  assert.equal(events.at(-1).outcome, 'cancelled');
  assert.equal(events.at(-1).chainDone, false);
});

test('a published final envelope is delivered between lifecycle started and settled with its lifecycleId', async () => {
  const calls = [];
  let acked = false;
  const event = {
    type: 'message.publish',
    eventId: 'event-1',
    envelope: {
      messageId: 'message-1',
      threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' },
      payload: { provenance: { epistemicStatus: 'observation' }, elements: [] },
    },
  };
  const delivery = createSubscriptionDelivery({
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-1' }),
      read: async () =>
        acked ? { events: [], ackToken: null, stale: false } : { events: [event], ackToken: 'ack-1', stale: false },
      ack: async () => {
        acked = true;
      },
    },
    resolveInvocationId: async () => 'invocation-final',
    delivery: {
      invoke: async (_subscriber, method, input) => {
        calls.push({ method, input });
        return { deliveryId: input.deliveryId };
      },
      deliver: async () => {
        throw new Error('unexpected legacy delivery');
      },
    },
  });
  await delivery.register({
    subscriberId: 'subscriber',
    threadId: 'thread-1',
    handleId: 'handle-1',
    method: 'bridge.deliver',
  });
  const lifecycle = createLifecycleDelivery({
    subscribers: (threadId) => delivery.subscribersForThread(threadId),
    supportsAction: () => true,
    invoke: async (subscriber, method, input) => {
      calls.push({ subscriber, method, input });
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: (threadId, operation) => delivery.enqueueThread(threadId, operation),
    drain: (threadId) => delivery.drain(threadId),
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await lifecycle.onStreamStart('thread-1', 'cat-1', 'invocation-final');
  await lifecycle.onStreamEnd('thread-1', '', 'invocation-final');
  await lifecycle.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-final');
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['host.messaging.lifecycle', 'bridge.deliver', 'host.messaging.lifecycle'],
  );
  assert.deepEqual(
    calls.map(({ input }) => input.state ?? 'message'),
    ['started', 'message', 'settled'],
  );
  assert.equal(calls[1].input.lifecycleId, lifecycleIdFor('invocation-final'));
});

test('the frozen host.messaging.deliver row also receives the final message lifecycleId', async () => {
  const delivered = [];
  let acked = false;
  const delivery = createSubscriptionDelivery({
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-legacy' }),
      read: async () =>
        acked
          ? { events: [], ackToken: null, stale: false }
          : {
              events: [
                {
                  type: 'message.publish',
                  eventId: 'event-legacy',
                  envelope: {
                    messageId: 'message-legacy',
                    threadId: 'thread-1',
                    actor: { kind: 'cat', id: 'cat-1' },
                    payload: { elements: [] },
                  },
                },
              ],
              ackToken: 'ack-legacy',
              stale: false,
            },
      ack: async () => {
        acked = true;
      },
    },
    resolveInvocationId: async () => 'invocation-legacy',
    delivery: {
      deliver: async (_subscriber, input) => {
        delivered.push(input);
        return { deliveryId: input.deliveryId };
      },
    },
  });
  await delivery.register({ subscriberId: 'external', threadId: 'thread-1', handleId: 'handle-legacy' });
  await delivery.drain('thread-1');
  assert.equal(delivered[0].lifecycleId, lifecycleIdFor('invocation-legacy'));
});
