/**
 * F202 Train C1 — shared fixture for the production-composition gate files.
 *
 * Extracted per fourth-round review P2; extended per fifth-round review P1 so the
 * binding/checkpoint gates run against a REAL installed instance that declares a connector
 * contribution, reached through an authenticated Broker connection rather than an internal
 * service method.
 *
 * The per-case source coordinates for every gap live in the plan
 * (docs/plans/2026-09-19-f202-train-c1-migration-plan.md §5.1), not in these headers.
 */
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/index.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import {
  EXTERNAL_PACKAGE_DIGEST,
  EXTERNAL_PLUGIN_ID,
  externalCandidate,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

export const CONNECTOR_ID = 'feishu';
export const SIBLING_CONNECTOR_ID = 'telegram';
export const CONNECTOR_IDENTITY_ID = 'feishu-identity';
export const CONNECTOR_SECRET_KEY = 'FEISHU_APP_SECRET';
export const CONNECTOR_SECRET_VALUE = 'synthetic-feishu-secret-4f2a';
export const EXTERNAL_CHAT_ID = 'oc-chat-9';
export const THREAD_ID = 'thread-1';
export const DEFAULT_CAT_ID = 'codex';

/**
 * Case 7 ONLY. A bare instance id with no installed package behind it is legitimate there
 * because that case isolates collaborator wiring and issues the handle internally on purpose.
 * Every authority/durability case must use installConnectorInstance() instead — fifth-round
 * review P1: a string that names no installed instance cannot prove a legitimate caller is
 * accepted, and lets a negative case pass for the wrong reason (instance simply absent).
 */
export const SYNTHETIC_INSTANCE = 'pi_external';

/**
 * A contract-valid manifest that DECLARES the feishu connector contribution.
 *
 * The four hand-written manifest rules (plugin-contract validation/manifest.js:99-145) make this
 * shape non-obvious: a connector contribution needs a paired `identity` contribution, both must
 * be owned by the SAME feature, and every top-level contribution must be feature-referenced.
 * SIBLING_CONNECTOR_ID is deliberately absent — that absence is what the forgery case measures.
 */
export function connectorManifest(overrides = {}) {
  return {
    pluginId: EXTERNAL_PLUGIN_ID,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'External Source',
    configuration: [{ key: CONNECTOR_SECRET_KEY, label: 'Feishu app secret', kind: 'secret', required: true }],
    contributions: [
      { type: 'identity', id: CONNECTOR_IDENTITY_ID, displayName: 'Feishu' },
      {
        type: 'connector',
        id: CONNECTOR_ID,
        identityRef: CONNECTOR_IDENTITY_ID,
        inboundMethod: 'connector.inbound',
        outboundMethod: 'connector.outbound',
      },
    ],
    features: [
      {
        id: 'im',
        name: 'IM',
        resources: [],
        contributions: [
          { type: 'connector', id: CONNECTOR_ID },
          { type: 'identity', id: CONNECTOR_IDENTITY_ID },
        ],
        capabilities: ['messaging.send', 'secret.read'],
      },
    ],
    runtime: { transport: 'stdio', entrypoint: 'dist/plugin.js' },
    ...overrides,
  };
}

/**
 * Installs the connector package into the composition's REAL inventory and returns the
 * Host-assigned instance id. Readiness is EARNED through HostPluginConfigurationService — never
 * hand-flipped — so a fail-closed implementation cannot be made green by manufacturing state.
 *
 * Activation is the one explicit transition: lifecycle.enable() spawns the stdio package and
 * blocks on the very handshake these cases are about to perform themselves, so enabling through
 * it would deadlock. Config readiness — the part an implementation could cheat — stays earned.
 */
export async function installConnectorInstance(composition, projectRoot, overrides = {}) {
  const manifest = overrides.manifest ?? connectorManifest();
  const installed = await composition.inventory.installPackage({
    manifest,
    computedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    expectedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    packagePluginId: EXTERNAL_PLUGIN_ID,
    effectiveGrants: overrides.effectiveGrants ?? ['messaging.send', 'secret.read'],
  });
  const configuration = new HostPluginConfigurationService({
    projectRoot,
    inventory: composition.inventoryStore,
  });
  const before = await composition.inventoryStore.snapshot();
  const record = before.instances.find((i) => i.pluginInstanceId === installed.pluginInstanceId);
  await configuration.configure(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId, {
    expectedRevision: record.lifecycleRevision,
    updates: [{ key: CONNECTOR_SECRET_KEY, value: CONNECTOR_SECRET_VALUE }],
  });
  await configuration.reconcile(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId);

  await composition.inventoryStore.transaction((transaction) => {
    const instance = transaction.instances.get(installed.pluginInstanceId);
    transaction.instances.put({ ...instance, activationState: 'enabled', runtimeState: 'stopped', updatedAt: 5_001 });
  });
  return installed.pluginInstanceId;
}

/**
 * Opens an AUTHENTICATED external Broker connection: the same three-stage path a migrated stdio
 * package uses (openExternalConnection → hello → ready). Calls made through the returned
 * connection go through HostBrokerControlPlane.call(), which enforces wire-registry membership,
 * handler registration, live lease, and grant possession before any Host code runs.
 */
export async function authenticatedConnection(composition, pluginInstanceId) {
  const connection = await composition.broker.openExternalConnection(pluginInstanceId);
  const binding = await connection.hello(externalCandidate());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  return connection;
}

/**
 * Builds the REAL production composition and offers it the Host collaborators an IM cutover
 * needs. `DormantPluginRuntimeCompositionOptions` declares none of them today, so they are
 * silently dropped — which is exactly what case 7 measures.
 *
 * `checkpointStore` is offered as an explicitly isolated durable checkpoint authority; the
 * composition has no such seam yet. Passing one keeps the restart cases from silently falling
 * back to projectRoot-as-persistence, which would pressure the implementation toward a
 * package-local/projectRoot file store instead of a Host-owned authority.
 */
export async function productionComposition(projectRoot, overrides = {}) {
  const { processes = new FakePluginProcessAdapter(), bindingStore, checkpointStore, packages } = overrides;
  const wakes = [];
  const broadcasts = [];
  const participants = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    processes,
    ...(bindingStore === undefined ? {} : { bindingStore }),
    ...(checkpointStore === undefined ? {} : { checkpointStore }),
    ...(packages === undefined ? {} : { packages }),
    now: () => 5_000,
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
        return participants;
      },
    },
    getDefaultCatId: () => DEFAULT_CAT_ID,
    getMentionPatterns: () => new Map([['opus', ['@opus', '@宪宪']]]),
  });
  return { runtime, wakes, broadcasts, participants, processes };
}

export function ingressDraft(handleId, text, idempotencyKey) {
  return {
    address: { kind: 'connector_binding', handle: handleId },
    idempotencyKey,
    sourceEventId: `${CONNECTOR_ID}-evt-${idempotencyKey}`,
    payload: {
      provenance: {
        epistemicStatus: 'user_intent',
        origin: {
          kind: 'external',
          connectorId: CONNECTOR_ID,
          sourceAddress: { connectorId: CONNECTOR_ID, chatId: EXTERNAL_CHAT_ID, messageId: 'ext-msg-7' },
        },
      },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
    },
  };
}

export async function waitForSpec(processes, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processes.specs.length === 0) {
    if (Date.now() >= deadline) throw new Error('external package was never spawned');
    await new Promise((done) => setTimeout(done, 5));
  }
  return processes.specs[0];
}
