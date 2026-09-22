import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createMessagingDomain;
let createPluginMessagingSubscriptionSession;
let createSubscriptionDelivery;
let createMessagingStores;
let MessageStore;
let ThreadStore;
let MemoryConnectorThreadBindingStore;

const PLUGIN_ID = 'dev.clowder.subscription-fixture';
const INSTANCE_ID = 'instance-subscription-1';
const OWNER = 'owner-1';

beforeEach(async () => {
  ({ createMessagingDomain } = await import('../dist/domains/messaging/index.js'));
  ({ createPluginMessagingSubscriptionSession } = await import(
    '../dist/domains/plugin/host-surface/plugin-messaging-subscription-host.js'
  ));
  ({ createSubscriptionDelivery } = await import('../dist/domains/messaging/subscription-delivery.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  ({ MemoryConnectorThreadBindingStore } = await import(
    '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js'
  ));
});

function createFixture() {
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const bindings = new MemoryConnectorThreadBindingStore();
  const stores = createMessagingStores();
  const calls = [];
  let messaging;
  let delivery;
  const restart = () => {
    messaging = createMessagingDomain({ messageStore: messages, stores });
    delivery = createSubscriptionDelivery({
      messaging,
      delivery: {
        async deliver() {
          throw new Error('module subscriptions must use their declared action, not the frozen delivery row');
        },
        async invoke(instanceId, method, params) {
          calls.push({ instanceId, method, params });
        },
      },
    });
  };
  restart();
  const createSession = (effectiveGrants = ['message.event.subscribe']) =>
    createPluginMessagingSubscriptionSession({
      pluginId: PLUGIN_ID,
      pluginInstanceId: INSTANCE_ID,
      ownerUserId: OWNER,
      effectiveGrants,
      threadStore: threads,
      bindingStore: bindings,
      messaging,
      delivery,
    });
  return {
    calls,
    createSession,
    get delivery() {
      return delivery;
    },
    get messaging() {
      return messaging;
    },
    restart,
    bindings,
    threads,
  };
}

async function publish(messaging, threadId, text, producer = 'producer-1') {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: producer,
    threadId,
    userId: OWNER,
    scope: { canSend: true, canSubscribe: false },
  });
  return messaging.send(
    { pluginInstanceId: producer },
    {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: `${producer}:${text}`,
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: `${producer}:${text}`, kind: 'text', payload: { text } }],
      },
    },
  );
}

describe('F202 C1 — caller-bound Host messaging subscriptions', () => {
  test('delivers through the package-declared action without exposing a handle', async () => {
    const h = createFixture();
    const thread = await h.threads.create(OWNER, 'Subscribed');
    const session = h.createSession();

    await session.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
    await publish(h.messaging, thread.id, 'hello');
    await h.delivery.drain(thread.id);

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].instanceId, INSTANCE_ID);
    assert.equal(h.calls[0].method, 'fixture.outbound');
    assert.deepEqual(Object.keys(h.calls[0].params).sort(), ['deliveryId', 'envelope', 'threadId']);
    assert.equal(h.calls[0].params.threadId, thread.id);
    assert.equal(h.calls[0].params.envelope.payload.elements[0].payload.text, 'hello');
  });

  test('Host restart keeps the cursor, while owner disable drops the disabled-period backlog', async () => {
    const h = createFixture();
    const thread = await h.threads.create(OWNER, 'Lifecycle');

    const first = h.createSession();
    await first.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
    await publish(h.messaging, thread.id, 'before-restart');
    await h.delivery.drain(thread.id);
    await first.stop('host_shutdown');

    h.restart();
    await publish(h.messaging, thread.id, 'while-host-down');
    const restarted = h.createSession();
    await restarted.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
    await h.delivery.drain(thread.id);
    assert.deepEqual(
      h.calls.map((call) => call.params.envelope.payload.elements[0].payload.text),
      ['before-restart', 'while-host-down'],
      'Host restart must resume the durable cursor',
    );

    await restarted.stop('owner_disabled');
    await publish(h.messaging, thread.id, 'while-disabled');
    const reenabled = h.createSession();
    await reenabled.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
    await publish(h.messaging, thread.id, 'after-enable');
    await h.delivery.drain(thread.id);
    assert.deepEqual(
      h.calls.map((call) => call.params.envelope.payload.elements[0].payload.text),
      ['before-restart', 'while-host-down', 'after-enable'],
      'owner disable must restart at the current head instead of replaying disabled-period messages',
    );
  });

  test('own messages are suppressed unless the package explicitly opts in', async () => {
    const h = createFixture();
    const thread = await h.threads.create(OWNER, 'Echo');
    const session = h.createSession();
    await session.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });

    await publish(h.messaging, thread.id, 'no echo', INSTANCE_ID);
    await h.delivery.drain(thread.id);
    assert.deepEqual(h.calls, []);

    await session.host.subscribe({
      threadId: thread.id,
      method: 'fixture.outbound',
      includeOwnMessages: true,
    });
    await publish(h.messaging, thread.id, 'echo accepted', INSTANCE_ID);
    await h.delivery.drain(thread.id);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].params.envelope.payload.elements[0].payload.text, 'echo accepted');
  });

  test('subscription authority, shape and thread ownership fail closed', async () => {
    const h = createFixture();
    const ownThread = await h.threads.create(OWNER, 'Owned');
    const foreignThread = await h.threads.create('another-owner', 'Foreign');

    await assert.rejects(
      () => h.createSession([]).host.subscribe({ threadId: ownThread.id, method: 'fixture.outbound' }),
      (error) => error?.code === 'PERMISSION',
    );
    await assert.rejects(
      () => h.createSession().host.subscribe({ threadId: foreignThread.id, method: 'fixture.outbound' }),
      (error) => error?.code === 'PERMISSION',
    );
    await assert.rejects(
      () => h.createSession().host.subscribe({ threadId: ownThread.id, method: ' fixture.outbound' }),
      (error) => error?.code === 'VALIDATION',
    );
    await assert.rejects(
      () =>
        h
          .createSession()
          .host.subscribe({ threadId: ownThread.id, method: 'fixture.outbound', includeOwnMessages: 'true' }),
      (error) => error?.code === 'VALIDATION',
    );
  });

  test('a reinstalled plugin can subscribe to a legacy system-owned thread through its durable binding', async () => {
    const h = createFixture();
    const thread = await h.threads.ensureThread('legacy-plugin-thread', 'Legacy');
    await h.threads.updatePluginOwnership(thread.id, { v: 1, pluginInstanceId: 'instance-before-reinstall' });
    await h.bindings.bind(PLUGIN_ID, 'group-42', thread.id, OWNER);
    const session = h.createSession();

    await session.host.subscribe({ threadId: thread.id, method: 'fixture.outbound' });
    await publish(h.messaging, thread.id, 'after reinstall');
    await h.delivery.drain(thread.id);

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].params.threadId, thread.id);
  });
});
