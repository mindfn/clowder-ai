/**
 * F202 Train C1 — the half of the cutover that mints the address.
 *
 * WHAT THIS BINDS. The wake path this PR already landed (`ingress-wake.ts`, reached from
 * `send-service.ts` when `handle.kind === 'connector_binding'`) is unreachable in the running
 * process: `issueConnectorBindingHandle` has no production caller, so no `connector_binding`
 * handle exists and that branch never executes. `SendService.send()` addresses a handle whose
 * `threadId` is fixed at issuance — it never creates a thread and never writes a connector
 * binding. An IM first contact has neither.
 *
 * WHY THE BINDING IS LOAD-BEARING, NOT BOOKKEEPING. Outbound delivery is keyed on a different
 * store than messaging handles: `OutboundDeliveryHook.deliver()` reads
 * `bindingStore.getByThread(threadId)` and returns silently when it is empty
 * (OutboundDeliveryHook.ts:142-149). Today the only production writers of that store are
 * `ConnectorRouter.ts:419` and the command layer. So a provider that merely switched to the
 * public SDK would keep admitting inbound messages while every cat reply silently stopped
 * being delivered. Case 1 asserts the binding is discoverable BY THREAD for that reason.
 *
 * PORT DIRECTION. The inbound shape here is Host-owned and imports nothing from
 * `@clowder-ai/plugin-sdk`: the Host defines the port and the SDK wraps it. Its fields mirror
 * the connector contract (`externalConversationId`, `providerMessageId`, `sender`,
 * `conversation`) so the two sides stay checkable against one truth without the Host taking a
 * dependency on the author-facing package.
 *
 * STATUS when written: RED — `domains/messaging/connector-ingress.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createMessagingDomain;
let createConnectorIngress;
let MessageStore;

let messageStore;
let messaging;
let ingress;
let wakes;
let broadcasts;
/** Every `bind()` call, so a second inbound cannot quietly re-bind the same conversation. */
let binds;
let bindingsByExternal;
let bindingStore;
let createdThreads;

const CONNECTOR_ID = 'feishu';
const EXTERNAL_CONVERSATION_ID = 'oc_group_7781';
const DEFAULT_USER_ID = 'user-1';
const DEFAULT_CAT_ID = 'codex';

/** Mirrors ConnectorThreadBindingStore's production surface, including the outbound read. */
function makeBindingStore() {
  const byThread = new Map();
  bindingsByExternal = new Map();
  binds = [];
  return {
    async getByExternal(connectorId, externalChatId) {
      return bindingsByExternal.get(`${connectorId}:${externalChatId}`) ?? null;
    },
    async bind(connectorId, externalChatId, threadId, userId) {
      const binding = { connectorId, externalChatId, threadId, userId };
      binds.push(binding);
      bindingsByExternal.set(`${connectorId}:${externalChatId}`, binding);
      byThread.set(threadId, [...(byThread.get(threadId) ?? []), binding]);
      return binding;
    },
    /** The read OutboundDeliveryHook performs before delivering a cat reply. */
    async getByThread(threadId) {
      return byThread.get(threadId) ?? [];
    },
  };
}

beforeEach(async () => {
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ createConnectorIngress } = await import('../dist/domains/messaging/connector-ingress.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  wakes = [];
  broadcasts = [];
  createdThreads = [];
  bindingStore = makeBindingStore();
  let threadSeq = 0;

  messaging = createMessagingDomain({
    messageStore,
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        wakes.push({ threadId, catId, userId, message, messageId });
        return 'dispatched';
      },
    },
    socketManager: {
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
    },
    threadStore: {
      async getParticipantsWithActivity() {
        return [];
      },
    },
    getDefaultCatId: () => DEFAULT_CAT_ID,
    getMentionPatterns: () => new Map([['opus', ['@opus', '@宪宪']]]),
  });

  ingress = createConnectorIngress({
    messaging,
    bindings: bindingStore,
    threads: {
      async create(userId, title, projectPath) {
        threadSeq += 1;
        const thread = { id: `thread-${threadSeq}`, userId, title, projectPath };
        createdThreads.push(thread);
        return thread;
      },
    },
    defaultUserId: DEFAULT_USER_ID,
  });
});

function inbound(overrides = {}) {
  return {
    connectorId: CONNECTOR_ID,
    externalConversationId: EXTERNAL_CONVERSATION_ID,
    providerMessageId: 'om_msg_1',
    text: 'hello from the group',
    sender: { id: 'ou_alice', name: 'Alice' },
    conversation: { type: 'group', title: '产品群' },
    ...overrides,
  };
}

describe('F202 C1 — connector ingress admission (the handle-minting half)', () => {
  test('case 1: first contact creates the thread AND the binding outbound reads', async () => {
    const result = await ingress.admit(inbound());

    assert.ok(result.threadId, 'expected an admitted thread id');
    assert.equal(createdThreads.length, 1, 'first contact must create exactly one thread');

    const stored = await messageStore.getById(result.messageId);
    assert.ok(stored, 'the relayed text must be persisted as a Host message');
    assert.equal(stored.content, 'hello from the group');

    // D2: without this, every cat reply is dropped by OutboundDeliveryHook.
    const outboundBindings = await bindingStore.getByThread(result.threadId);
    assert.equal(outboundBindings.length, 1, 'outbound delivery must find a binding for this thread');
    assert.equal(outboundBindings[0].externalChatId, EXTERNAL_CONVERSATION_ID);
  });

  test('case 2: the Host-derived wake actually fires (the branch that is dead today)', async () => {
    const result = await ingress.admit(inbound());

    assert.equal(wakes.length, 1, 'authenticated ingress must wake exactly one cat');
    assert.equal(wakes[0].threadId, result.threadId);
    assert.equal(wakes[0].catId, DEFAULT_CAT_ID, 'no mention and no activity falls back to default');
    assert.equal(broadcasts.length, 1, 'the thread room must see the inbound bubble');
  });

  test('case 3: a second message reuses the thread and does not re-bind', async () => {
    const first = await ingress.admit(inbound());
    const second = await ingress.admit(inbound({ providerMessageId: 'om_msg_2', text: 'second' }));

    assert.equal(second.threadId, first.threadId, 'same conversation must stay on one thread');
    assert.equal(createdThreads.length, 1, 'no second thread');
    assert.equal(binds.length, 1, 'no second binding for the same conversation');
  });

  test('case 4: replaying one providerMessageId admits it once', async () => {
    const first = await ingress.admit(inbound());
    const replay = await ingress.admit(inbound());

    assert.equal(replay.messageId, first.messageId, 'a replay must converge on the same message');
    assert.equal(wakes.length, 1, 'a replay must not spend a second agent turn');
  });

  test('case 5: group conversation title reaches the created thread', async () => {
    await ingress.admit(inbound());
    assert.match(createdThreads[0].title, /产品群/, 'group title must not be dropped at admission');
  });
});
