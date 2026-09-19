/**
 * F202 Train C1 — Core cutover gate, part 2: production-composition activation prerequisites.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM f202-c1-im-cutover-wake-parity.test.js:
 * That file pins the WAKE SEMANTICS an authenticated `connector_binding` ingress must have,
 * and it does so at the `createMessagingDomain(...)` seam with hand-injected Host
 * collaborators. That isolation is deliberate and still correct — but on its own it is
 * satisfiable by an implementation that nothing in production ever composes. All four of
 * its RED cases could turn green while a real migrated IM package still cannot run:
 *
 *   1. PRODUCTION WIRING — `createDormantPluginRuntimeComposition` (runtime-composition.ts:213)
 *      builds the domain with `{ messageStore, redis }` only, and `MessagingDomainDeps`
 *      (messaging-service.ts:21-26) declares no wake/broadcast/thread collaborator at all.
 *      Injecting collaborators in a test proves nothing about the composition that ships.
 *   2. BINDING BOOTSTRAP — `issueConnectorBindingHandle` (handles.ts:60) has ZERO production
 *      callers; a repository-wide search finds only the forwarding service and tests. An
 *      external package that receives provider coordinates `(connectorId, externalChatId)`
 *      has no Host route to obtain the opaque handle `messaging.send` requires, and the
 *      contract exposes no `connector.*` wire method to ask for one.
 *   3. RESTART RECOVERY — after a Host restart the same package must still resolve
 *      `threadId -> externalChatId` for outbound delivery. Nothing persists that mapping
 *      on the plugin-facing path today.
 *   4. CONFIG/SECRET PROJECTION — `external-runtime/supervisor.ts:191-201` spawns a verified
 *      stdio package with exactly four protocol variables (CLOWDER_PLUGIN_ID,
 *      CLOWDER_PACKAGE_DIGEST, CLOWDER_CONTRACT_VERSION, CLOWDER_WIRE_VERSION). No
 *      manifest-declared config or secret reaches a migrated provider runtime — even though
 *      the builtin path already implements exactly this projection, grant-checked, in
 *      `BuiltinPluginContributionSupervisor.contributionEnvironment` (manager/
 *      builtin-contribution-supervisor.ts:558-585).
 *
 * So these are the Stage 3 substage-3a prerequisites expressed against the REAL composition.
 * Case numbering continues the wake-parity file: together the two files are one 10-case gate
 * (8 RED / 2 GREEN) on the C1 merge base (Core 9ab0eaf28).
 *
 * SEAM CHOICE (stated, not hidden): cases 8 and 9 bind the bootstrap/recovery route to the
 * composed `messaging` service, mirroring the wake-parity file's choice of the K-2 assembly
 * point. Internal placement stays free. Note that case 8's requirement — a Host route that
 * resolves-or-creates a binding for an authenticated caller — is the one C1 prerequisite
 * that may require a contract wire delta; the plan (§5 Stage 2a) classifies it explicitly as
 * a C1 boundary blocker awaiting maintainer sign-off rather than absorbing it silently.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import {
  EXTERNAL_PACKAGE_DIGEST,
  EXTERNAL_PLUGIN_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

const CONNECTOR_ID = 'feishu';
const EXTERNAL_CHAT_ID = 'oc-chat-9';
const THREAD_ID = 'thread-1';
const USER_ID = 'user-1';
const DEFAULT_CAT_ID = 'codex';

/**
 * Builds the REAL production composition and offers it the Host collaborators an IM cutover
 * needs. Today `DormantPluginRuntimeCompositionOptions` declares none of them, so they are
 * silently dropped — which is precisely what case 7 measures.
 */
async function productionComposition(projectRoot, processes = new FakePluginProcessAdapter()) {
  const wakes = [];
  const broadcasts = [];
  const participants = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    processes,
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

function ingressDraft(handleId, text, idempotencyKey) {
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

describe('F202 C1 Core cutover gate — production-composition activation prerequisites', () => {
  test('7/RED — the shipped composition wires Host wake and broadcast for authenticated ingress', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-prod-wiring-'));
    const { runtime, wakes, broadcasts, participants } = await productionComposition(projectRoot);
    participants.push({ catId: 'opus', lastMessageAt: 2_000, messageCount: 3 });

    // Internal issuance is used HERE ON PURPOSE: this case isolates collaborator wiring.
    // Bootstrap reachability is a different gap and is measured by case 8.
    const { handleId } = await runtime.messaging.issueConnectorBindingHandle({
      pluginInstanceId: 'pi_external',
      threadId: THREAD_ID,
      userId: USER_ID,
      scope: { canSend: true, canSubscribe: false },
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
    });

    await runtime.messaging.send({ pluginInstanceId: 'pi_external' }, ingressDraft(handleId, '@opus 看一下', 'prod-7'));

    assert.equal(
      wakes.length,
      1,
      'C1 blocker: createDormantPluginRuntimeComposition (runtime-composition.ts:213) composes the ' +
        'messaging domain with { messageStore, redis } only, and MessagingDomainDeps declares no ' +
        'invokeTrigger/socketManager/threadStore. A wake proven only with hand-injected collaborators ' +
        'does not exist in the process that ships.',
    );
    assert.equal(wakes[0]?.catId, 'opus', 'the shipped composition must derive the target Host-side');
    assert.equal(broadcasts.length, 1, 'the shipped composition must broadcast the ingress exactly once');

    await runtime.shutdown('test');
  });

  test('8/RED — a Host route resolves-or-creates a binding for an authenticated external package', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-bootstrap-'));
    const { runtime } = await productionComposition(projectRoot);

    const resolveBinding = runtime.messaging.resolveConnectorBinding;
    assert.equal(
      typeof resolveBinding,
      'function',
      'C1 blocker: issueConnectorBindingHandle (handles.ts:60) has no production caller and the ' +
        'plugin contract exposes no connector.* wire method, so a migrated connector that receives ' +
        '(connectorId, externalChatId) cannot obtain the opaque handle messaging.send demands. ' +
        'Encoding handles in package config/env is not an escape: it is multi-chat-incomplete and ' +
        'moves binding authority into untrusted package code.',
    );

    const first = await resolveBinding.call(runtime.messaging, {
      pluginInstanceId: 'pi_external',
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
      userId: USER_ID,
    });
    assert.ok(first?.handleId, 'the Host must return an opaque connector_binding handle');
    assert.ok(first?.threadId, 'the Host — not the package — owns the external-chat to thread mapping');

    const again = await resolveBinding.call(runtime.messaging, {
      pluginInstanceId: 'pi_external',
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
      userId: USER_ID,
    });
    assert.equal(again.threadId, first.threadId, 'resolve-or-create must be idempotent per external chat');

    const receipt = await runtime.messaging.send(
      { pluginInstanceId: 'pi_external' },
      ingressDraft(first.handleId, '@opus 用 Host 签发的 handle 发送', 'prod-8'),
    );
    assert.ok(receipt?.messageId, 'a Host-issued handle must be directly usable for ingress send');

    await runtime.shutdown('test');
  });

  test('9/RED — the binding survives a Host restart so outbound delivery can recover its chat', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-restart-'));
    const before = await productionComposition(projectRoot);
    const resolveBinding = before.runtime.messaging.resolveConnectorBinding;
    assert.equal(
      typeof resolveBinding,
      'function',
      'restart recovery cannot be asserted until the bootstrap route of case 8 exists',
    );
    const initial = await resolveBinding.call(before.runtime.messaging, {
      pluginInstanceId: 'pi_external',
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
      userId: USER_ID,
    });
    await before.runtime.shutdown('restart');

    // A fresh composition over the same project root is what a Host restart looks like.
    const after = await productionComposition(projectRoot);
    const recovered = await after.runtime.messaging.resolveConnectorBinding({
      pluginInstanceId: 'pi_external',
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
      userId: USER_ID,
    });

    assert.equal(
      recovered.threadId,
      initial.threadId,
      'after restart the same (connectorId, externalChatId) must resolve to the same thread, or a ' +
        'migrated multi-chat connector loses outbound addressing for every existing conversation.',
    );
    await after.runtime.shutdown('test');
  });

  test('10/RED — manifest-declared config/secret reaches the external stdio runtime', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-config-projection-'));
    await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
    await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');

    const base = externalManifest();
    const manifest = {
      ...base,
      // The package must REQUEST secret.read for the Host to be allowed to grant it; an
      // effective grant outside the manifest request is rejected at admission by design.
      features: base.features.map((feature) => ({
        ...feature,
        capabilities: [...feature.capabilities, 'secret.read'],
      })),
      configuration: [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
    };
    const packages = {
      async resolveInstalledPackage() {
        return {
          rootDir: projectRoot,
          manifest,
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    };
    const processes = new FakePluginProcessAdapter();
    const { runtime } = await productionComposition(projectRoot, processes);
    // The locator is composition-owned; swap it for the fixture package.
    const composed = createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
      processes,
      packages,
      now: () => 5_000,
    });
    await runtime.shutdown('unused');

    const installed = await composed.inventory.installPackage({
      manifest,
      computedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
      expectedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
      packagePluginId: EXTERNAL_PLUGIN_ID,
      effectiveGrants: ['events.publish', 'secret.read'],
      signalSchemas: {
        'schemas/external.signal.v1.schema.json': {
          type: 'object',
          properties: { payload: { type: 'object' }, source: { type: 'object' } },
          required: ['payload', 'source'],
        },
      },
    });
    await composed.inventoryStore.transaction((transaction) => {
      const instance = transaction.instances.get(installed.pluginInstanceId);
      transaction.instances.put({
        ...instance,
        // enable() is only valid from disabled/error + stopped/crashed with config ready.
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        updatedAt: 1_001,
      });
    });

    const current = await composed.inventoryStore.snapshot();
    const record = current.instances.find((i) => i.pluginInstanceId === installed.pluginInstanceId);
    // enable() only settles after the handshake, which the fixture process never completes.
    // The spawn spec — the subject of this case — is produced before that, so observe it
    // directly instead of waiting on a handshake this test does not model.
    const enabling = composed.lifecycle
      .enable(installed.pluginInstanceId, record.lifecycleRevision)
      .catch(() => undefined);
    const spec = await waitForSpec(processes);

    const projected = Object.keys(spec.env ?? {}).filter((key) => !key.startsWith('CLOWDER_'));
    assert.deepEqual(
      projected,
      ['FEISHU_APP_SECRET'],
      'C1 blocker: external-runtime/supervisor.ts:191-201 spawns a verified stdio package with only ' +
        'the four CLOWDER_* protocol variables, so a migrated IM provider receives none of its ' +
        'manifest-declared config/secrets. The builtin path already performs exactly this ' +
        'grant-checked projection (builtin-contribution-supervisor.ts:558-585); the stdio path — the ' +
        'one every migrated npm package uses — has no equivalent.',
    );

    await composed.shutdown('test');
    await enabling;
  });
});

async function waitForSpec(processes, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processes.specs.length === 0) {
    if (Date.now() >= deadline) throw new Error('external package was never spawned');
    await new Promise((done) => setTimeout(done, 5));
  }
  return processes.specs[0];
}
