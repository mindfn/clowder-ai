/**
 * F202 Train C1 — Core cutover gate, part 3: connector binding authority and durability.
 *
 * Gap D is a PUBLIC-WIRE boundary blocker: the 13-row registry has no `connector.*` row, and
 * `issueConnectorBindingHandle` (handles.ts:60) has no production caller. A migrated multi-chat
 * connector therefore holds (connectorId, externalChatId) but can never obtain the opaque handle
 * `messaging.send` demands, nor recover thread-to-chat mapping after restart.
 *
 * WHY THESE CASES GO THROUGH THE BROKER (fifth-round review P1): asserting on an internal
 * `runtime.messaging.*` method is satisfiable by adding a method to MessagingService while the
 * external package still cannot reach it. Every case here calls through an AUTHENTICATED
 * external Broker connection, so HostBrokerControlPlane.call() enforces wire-registry
 * membership, handler registration, live lease and grant possession before any Host code runs.
 *
 * Authority rule: the package supplies provider coordinates and nothing else. Owner (userId) is
 * Host-derived, pluginInstanceId comes from broker identity, and connectorId is checked against
 * that instance's DECLARED connector contribution.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { isWireMethod } from '@clowder-ai/plugin-contract';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import {
  authenticatedConnection,
  CONNECTOR_ID,
  EXTERNAL_CHAT_ID,
  ingressDraft,
  installConnectorInstance,
  productionComposition,
  SIBLING_CONNECTOR_ID,
} from './f202-c1-production-composition-helpers.js';

/**
 * PROPOSED spelling. The exact public name is a maintainer decision (plan section 7.2 item 4);
 * what these cases gate is the REQUIREMENT, not the spelling. Whatever row is signed must be a
 * contract-ready plugin-to-Host row, present in Core's shipped handler set, callable by an
 * authenticated connector instance, and Host-authoritative over owner and connector scope.
 */
const BINDING_RESOLVE = 'connector.binding.resolve';

const GAP_D_WIRE_ABSENT =
  'C1 gap D (boundary blocker): the 13-row wire registry contains no `connector.*` row, so no ' +
  'public method exists for a migrated connector to resolve or recover its binding. Adding a ' +
  'method to MessagingService does NOT satisfy this - an external stdio package cannot call it.';

const PLUMBING_FAILURES = new Set(['METHOD_NOT_READY', 'METHOD_NOT_REGISTERED', 'INSTANCE_NOT_READY']);

async function connectorProjectRoot(prefix) {
  const projectRoot = await mkdtemp(resolve(tmpdir(), prefix));
  await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
  await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');
  return projectRoot;
}

/** The public-surface precondition every gap-D case shares. Fails first, and for one reason. */
function assertBindingRowReachable(runtime) {
  assert.ok(isWireMethod(BINDING_RESOLVE), GAP_D_WIRE_ABSENT);
  assert.ok(
    runtime.broker.options.methods.some((handler) => handler.method === BINDING_RESOLVE),
    'the SHIPPED composition (runtime-composition.ts:217-232) must register a Host handler for ' +
      'the row; a contract row with no Core handler is still unreachable for a migrated package',
  );
}

describe('F202 C1 Core cutover gate — connector binding authority and durability', () => {
  test('8/RED — an authenticated package resolves-or-creates a binding from broker identity alone', async () => {
    const projectRoot = await connectorProjectRoot('f202-c1-bootstrap-');
    const { runtime } = await productionComposition(projectRoot);
    const pluginInstanceId = await installConnectorInstance(runtime, projectRoot);
    const connection = await authenticatedConnection(runtime, pluginInstanceId);

    assertBindingRowReachable(runtime);

    // The package passes ONLY provider coordinates - no userId, because untrusted code must not
    // select whose thread it writes to (legacy ConnectorRouter derives it from defaultUserId),
    // and no pluginInstanceId, because broker identity already supplies it.
    const coordinates = { connectorId: CONNECTOR_ID, externalChatId: EXTERNAL_CHAT_ID };
    const first = await connection.call(BINDING_RESOLVE, coordinates);

    assert.ok(first?.handleId, 'the Host must return an opaque connector_binding handle');
    assert.ok(first?.threadId, 'the Host - not the package - owns external-chat to thread mapping');
    assert.ok(first?.userId, 'the Host must derive the owner itself rather than accept one');

    const again = await connection.call(BINDING_RESOLVE, coordinates);
    assert.equal(again.threadId, first.threadId, 'resolve-or-create must be idempotent per external chat');

    const receipt = await runtime.messaging.send(
      { pluginInstanceId },
      ingressDraft(first.handleId, '@opus 用 Host 签发的 handle', 'prod-8'),
    );
    assert.ok(receipt?.messageId, 'a Host-issued handle must be directly usable for ingress send');

    await runtime.shutdown('test');
  });

  test('11/RED — a package cannot bootstrap a binding for a connector it did not declare', async () => {
    const projectRoot = await connectorProjectRoot('f202-c1-forgery-');
    // Eighth-round review P1: an observable store is what separates "refused" from "created the
    // foreign binding, then threw". assert.rejects alone cannot see the durable write.
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const { runtime } = await productionComposition(projectRoot, { bindingStore });
    const pluginInstanceId = await installConnectorInstance(runtime, projectRoot);
    const connection = await authenticatedConnection(runtime, pluginInstanceId);

    assertBindingRowReachable(runtime);

    // POSITIVE FIRST, deliberately (fifth-round review P1): without it, an implementation that
    // rejects EVERY connector - because the instance does not exist, or because the row is
    // unimplemented - would satisfy a bare assert.rejects, and this case would pass for the
    // wrong reason while proving nothing about connector scope.
    const declared = await connection.call(BINDING_RESOLVE, {
      connectorId: CONNECTOR_ID,
      externalChatId: EXTERNAL_CHAT_ID,
    });
    assert.ok(declared?.handleId, 'the DECLARED connector must resolve, or the negative below proves nothing');

    let rejection;
    await assert.rejects(
      () =>
        connection.call(BINDING_RESOLVE, {
          connectorId: SIBLING_CONNECTOR_ID,
          externalChatId: EXTERNAL_CHAT_ID,
        }),
      (error) => {
        rejection = error;
        return true;
      },
      'connectorId must be checked against the declared connector contribution, otherwise any ' +
        'admitted package can mint bindings for every connector in the catalog',
    );
    assert.ok(
      !PLUMBING_FAILURES.has(rejection?.code),
      `the refusal must be a connector-scope decision, not plumbing (${rejection?.code}): this ` +
        `instance is installed, enabled, and declares only ${CONNECTOR_ID}`,
    );
    // The atomicity half: refusing the call is not enough if the foreign binding was already
    // minted. Nothing for the undeclared connector may exist at the store afterwards.
    assert.equal(
      await bindingStore.getByExternal(SIBLING_CONNECTOR_ID, EXTERNAL_CHAT_ID),
      null,
      'a refused bootstrap must leave NO binding for the undeclared connector',
    );

    await runtime.shutdown('test');
  });

  test('9/RED — bindings survive a Host restart through a shared durable authority', async () => {
    const projectRoot = await connectorProjectRoot('f202-c1-restart-');
    // One explicitly isolated store instance shared by both compositions IS the durability
    // subject. projectRoot must NOT be the persistence mechanism: the shipped authority is
    // RedisConnectorThreadBindingStore (index.ts:7389), and a projectRoot-shaped test would fail
    // a correct Redis-backed implementation and pressure it toward a duplicate file store.
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const coordinates = { connectorId: CONNECTOR_ID, externalChatId: EXTERNAL_CHAT_ID };

    const before = await productionComposition(projectRoot, { bindingStore });
    const pluginInstanceId = await installConnectorInstance(before.runtime, projectRoot);
    const beforeConnection = await authenticatedConnection(before.runtime, pluginInstanceId);
    assertBindingRowReachable(before.runtime);
    const initial = await beforeConnection.call(BINDING_RESOLVE, coordinates);
    await before.runtime.shutdown('restart');

    // Same projectRoot: the inventory snapshot - and therefore the installed instance - is
    // recovered from disk, so this is a Host restart rather than a fresh install.
    const after = await productionComposition(projectRoot, { bindingStore });
    const afterConnection = await authenticatedConnection(after.runtime, pluginInstanceId);
    const recovered = await afterConnection.call(BINDING_RESOLVE, coordinates);

    assert.equal(
      recovered.threadId,
      initial.threadId,
      'after restart the same (connectorId, externalChatId) must resolve to the same thread, or a ' +
        'migrated multi-chat connector loses outbound addressing for every existing conversation',
    );
    assert.equal(
      (await bindingStore.getByExternal(CONNECTOR_ID, EXTERNAL_CHAT_ID))?.threadId,
      initial.threadId,
      'the binding must live in the injected Host authority, not in composition-local memory',
    );
    await after.runtime.shutdown('test');
  });
});
