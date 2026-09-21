/**
 * F202 Train C1 — what a relaying package is handed when it activates.
 *
 * WHY THE HOST DOES THIS AND NOT THE SDK. A package speaking in its own voice never gains wake
 * power from its text — that is a frozen v0 security property, and it is the reason a package
 * cannot simply relay a human's "@opus" and expect a cat to answer. Waking on a relayed human's
 * words requires an address whose external identity the Host itself verified, and no SDK can
 * grant itself that. So the Host mints it, once, when the package activates.
 *
 * WHY IT ALSO REMOVES TWO STEPS FROM THE PACKAGE. The fallback thread is fixed and derived from
 * the package's own identity, which means the Host can settle it at activation instead of the
 * package discovering it is unbound, asking for its thread, creating one, and retrying. A package
 * that is handed its address has nothing left to bootstrap.
 *
 * WHAT MUST NOT HAPPEN: a second activation creating a second thread. The package's history would
 * silently split in two, and the user would find yesterday's conversation missing rather than
 * moved.
 *
 * STATUS when written: RED — `domains/messaging/relay-address-provisioning.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createRelayAddressProvisioner;
let createMessagingDomain;
let MessageStore;

let messaging;
let provisioner;
let createdThreads;
let recorded;

const INSTANCE = 'connector:feishu';
const USER = 'user-1';

beforeEach(async () => {
  ({ createRelayAddressProvisioner } = await import('../dist/domains/messaging/relay-address-provisioning.js'));
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  createdThreads = [];
  recorded = new Map();
  messaging = createMessagingDomain({ messageStore: new MessageStore() });

  let seq = 0;
  provisioner = createRelayAddressProvisioner({
    messaging,
    threads: {
      async create(userId, title) {
        seq += 1;
        const thread = { id: `thread-${seq}`, userId, title };
        createdThreads.push(thread);
        return thread;
      },
    },
    store: {
      async getSystemThreadId(instanceId) {
        return recorded.get(instanceId) ?? null;
      },
      async setSystemThreadId(instanceId, threadId) {
        recorded.set(instanceId, threadId);
      },
    },
    defaultUserId: USER,
  });
});

describe('F202 C1 — relay address provisioning at activation', () => {
  test('case 1: a first activation settles a thread and hands back an address', async () => {
    const address = await provisioner.provision({ pluginInstanceId: INSTANCE, sourceId: 'feishu' });

    assert.equal(createdThreads.length, 1, 'the package needs a thread to speak into');
    assert.equal(address.threadId, createdThreads[0].id);
    assert.ok(address.handleId, 'the package must be handed an address, not a raw thread id');
    assert.equal(recorded.get(INSTANCE), address.threadId, 'the choice must survive this process');
  });

  test('case 2: activating again reuses the same thread', async () => {
    const first = await provisioner.provision({ pluginInstanceId: INSTANCE, sourceId: 'feishu' });
    const second = await provisioner.provision({ pluginInstanceId: INSTANCE, sourceId: 'feishu' });

    assert.equal(second.threadId, first.threadId, "splitting a package's history in two loses it");
    assert.equal(createdThreads.length, 1, 'no second thread');
  });

  test('case 3: the address carries relayed-human authority, not the package voice', async () => {
    const address = await provisioner.provision({ pluginInstanceId: INSTANCE, sourceId: 'feishu' });

    // A thread_handle would stamp mentions: [] for every send; only this address kind lets the
    // Host derive a wake target from a relayed human's text.
    const resolved = await messaging.resolveForSendTest?.(INSTANCE, address.handleId);
    if (resolved) assert.equal(resolved.kind, 'connector_binding');

    // Observable without a test-only accessor: sending through it must be accepted as external.
    const receipt = await messaging.send(
      { pluginInstanceId: INSTANCE },
      {
        address: { kind: 'connector_binding', handle: address.handleId },
        idempotencyKey: 'om_1',
        payload: {
          provenance: {
            epistemicStatus: 'user_intent',
            origin: { kind: 'external', connectorId: 'feishu' },
          },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hi' } }],
        },
      },
    );
    assert.equal(receipt.threadId, address.threadId);
  });

  test('case 4: two different packages get two different threads', async () => {
    const feishu = await provisioner.provision({ pluginInstanceId: INSTANCE, sourceId: 'feishu' });
    const desk = await provisioner.provision({ pluginInstanceId: 'inst-front-desk', sourceId: 'front-desk' });

    assert.notEqual(desk.threadId, feishu.threadId, 'identity-derived means per package, not shared');
    assert.equal(createdThreads.length, 2);
  });
});
