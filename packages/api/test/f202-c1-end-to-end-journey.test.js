/**
 * F202 Train C1 — the whole journey, with no connector-specific code anywhere in it.
 *
 * An external message arrives and is admitted through the one canonical path; a cat is woken;
 * the cat's reply enters the same stream every author writes to; and the package that subscribed
 * gets its own declared method called with that reply. A front-desk package subscribing to the
 * same thread is the identical path — nothing here branches on what kind of subscriber it is.
 *
 * THE ECHO IS THE DANGEROUS CASE. The package that relayed the inbound message is also subscribed
 * to the thread it was relayed into. If the Host hands that message back, the package relays it
 * outward again, and a user's single "hi" becomes an endless conversation with itself on a real
 * platform. So a subscriber must not be delivered what it authored — declared through the filter
 * the subscription contribution already carries, so the rule stays generic rather than being a
 * connector special case.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let mods;
let stores;
let messageStore;
let messaging;
let ingress;
let delivery;
let loadedModules;
let wakes;
let outboundCalls;
let publishFailures;

const CONNECTOR = 'feishu';
const CONVERSATION = 'oc_group_1';
const RELAY_PACKAGE = 'connector:feishu';
const FRONT_DESK = 'inst-front-desk';
const DEFAULT_CAT = 'opus';

beforeEach(async () => {
  const [messagingService, factory, publishing, connectorIngress, subscriptionDelivery, moduleInvocation, storePort] =
    await Promise.all([
      import('../dist/domains/messaging/messaging-service.js'),
      import('../dist/domains/messaging/stores/factory.js'),
      import('../dist/domains/messaging/publishing-message-store.js'),
      import('../dist/domains/messaging/connector-ingress.js'),
      import('../dist/domains/messaging/subscription-delivery.js'),
      import('../dist/domains/plugin/builtin-runtime/module-host-invocation.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);
  mods = { messagingService, factory, publishing, connectorIngress, subscriptionDelivery, moduleInvocation };

  wakes = [];
  outboundCalls = [];
  publishFailures = [];
  loadedModules = new Map();
  stores = factory.createMessagingStores();

  // Every author's message lands on the stream subscribers read.
  messageStore = publishing.createPublishingMessageStore(new storePort.MessageStore(), {
    events: stores.events,
    onPublishFailure: (error, stored) => publishFailures.push({ error, stored }),
  });

  messaging = messagingService.createMessagingDomain({
    messageStore,
    stores,
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        wakes.push({ threadId, catId, message, messageId });
        return 'dispatched';
      },
    },
    threadStore: {
      async getParticipantsWithActivity() {
        return [];
      },
    },
    getDefaultCatId: () => DEFAULT_CAT,
    getMentionPatterns: () => new Map([[DEFAULT_CAT, ['@opus']]]),
  });

  const byExternal = new Map();
  let threadSeq = 0;
  ingress = connectorIngress.createConnectorIngress({
    messaging,
    bindings: {
      async getByExternal(connectorId, externalChatId) {
        return byExternal.get(`${connectorId}:${externalChatId}`) ?? null;
      },
      async bind(connectorId, externalChatId, threadId, userId) {
        const record = { connectorId, externalChatId, threadId, userId };
        byExternal.set(`${connectorId}:${externalChatId}`, record);
        return record;
      },
    },
    threads: {
      async create(userId, title) {
        threadSeq += 1;
        return { id: `thread-${threadSeq}`, userId, title };
      },
    },
    defaultUserId: 'user-1',
  });

  delivery = subscriptionDelivery.createSubscriptionDelivery({
    messaging,
    invocation: moduleInvocation.createModuleHostInvocation({
      runtime: { definedPlugin: (id) => loadedModules.get(id) },
    }),
  });
});

function loadPackage(instanceId, methodName) {
  loadedModules.set(instanceId, {
    async [methodName](params) {
      outboundCalls.push({ instanceId, method: methodName, envelope: params.event?.envelope });
    },
  });
}

async function subscribe(instanceId, threadId, method, filter) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: instanceId,
    threadId,
    userId: 'user-1',
    scope: { canSend: false, canSubscribe: true },
  });
  await delivery.register({
    subscriberId: instanceId,
    threadId,
    handleId,
    method,
    ...(filter === undefined ? {} : { filter }),
  });
}

async function catReplies(threadId, text) {
  await messageStore.append({ threadId, userId: 'user-1', catId: DEFAULT_CAT, content: text, timestamp: Date.now() });
}

describe('F202 C1 — external message in, cat reply out, nothing connector-specific', () => {
  test('case 1: the relayed message wakes a cat and the reply reaches the package', async () => {
    const admitted = await ingress.admit({
      connectorId: CONNECTOR,
      externalConversationId: CONVERSATION,
      providerMessageId: 'om_1',
      text: '@opus 看一下',
      conversation: { type: 'group', title: '产品群' },
    });

    assert.equal(wakes.length, 1, 'an authenticated external message must wake a cat');
    assert.equal(wakes[0].catId, DEFAULT_CAT);

    loadPackage(RELAY_PACKAGE, 'outbound');
    await subscribe(RELAY_PACKAGE, admitted.threadId, 'outbound', { excludeOwnMessages: true });

    await catReplies(admitted.threadId, '看完了');
    await delivery.drain(admitted.threadId);

    assert.equal(outboundCalls.length, 1, "the cat's reply must reach the relaying package");
    assert.equal(outboundCalls[0].method, 'outbound');
    assert.equal(outboundCalls[0].envelope.payload.elements[0].payload.text, '看完了');
    assert.deepEqual(publishFailures, []);
  });

  test('case 2: the relaying package is never handed back its own message', async () => {
    // Subscribing BEFORE the inbound arrives is the whole point: a subscription starts at the
    // current head, so registering afterwards would skip the message for the wrong reason and
    // prove nothing about the echo.
    loadPackage(RELAY_PACKAGE, 'outbound');
    const { handleId } = await messaging.issueThreadHandle({
      pluginInstanceId: RELAY_PACKAGE,
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: false, canSubscribe: true },
    });
    await delivery.register({
      subscriberId: RELAY_PACKAGE,
      threadId: 'thread-1',
      handleId,
      method: 'outbound',
      filter: { excludeOwnMessages: true },
    });

    const admitted = await ingress.admit({
      connectorId: CONNECTOR,
      externalConversationId: CONVERSATION,
      providerMessageId: 'om_1',
      text: 'hi',
    });
    assert.equal(admitted.threadId, 'thread-1', 'guard: the subscription must cover the created thread');

    await delivery.drain(admitted.threadId);
    assert.deepEqual(
      outboundCalls,
      [],
      'echoing the relayed message back would make one "hi" an endless loop on a real platform',
    );

    // And the filter must not swallow everything: the reply it exists to carry still arrives.
    await catReplies(admitted.threadId, '好的');
    await delivery.drain(admitted.threadId);
    assert.equal(outboundCalls.length, 1, 'excluding your own echo must not exclude the cat reply');
    assert.equal(outboundCalls[0].envelope.payload.elements[0].payload.text, '好的');
  });

  test('case 3: a second, unrelated subscriber gets the same reply', async () => {
    const admitted = await ingress.admit({
      connectorId: CONNECTOR,
      externalConversationId: CONVERSATION,
      providerMessageId: 'om_1',
      text: 'hi',
    });

    loadPackage(FRONT_DESK, 'deliver');
    await subscribe(FRONT_DESK, admitted.threadId, 'deliver', { excludeOwnMessages: true });

    await catReplies(admitted.threadId, '好的');
    await delivery.drain(admitted.threadId);

    const forFrontDesk = outboundCalls.filter((c) => c.instanceId === FRONT_DESK);
    assert.equal(forFrontDesk.length, 1, 'a front-desk package is the identical path');
    assert.equal(forFrontDesk[0].method, 'deliver');
  });
});
