/**
 * F202 Train C1 — Core cutover gate, part 3: connector binding authority and durability.
 *
 * Split from the production-composition file per fourth-round review P2. This file pins the
 * two Host-owned truths a migrated multi-chat connector cannot run without:
 *   - binding bootstrap/recovery (gap D — public-wire boundary blocker, no connector.* row)
 *   - durable connector checkpoints (gap E — boundary blocker; plugin.state.get/set are
 *     RESERVED L0 capability NAMES ONLY, absent from the 13-row wire registry, with no Core
 *     handler, store, or composition path)
 *
 * Authority rule these cases enforce: the external package supplies provider coordinates and
 * nothing else. Owner (userId) is Host-derived, pluginInstanceId comes from broker identity,
 * and connectorId is checked against that instance's declared connector contribution.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import {
  CONNECTOR_ID,
  EXTERNAL_CHAT_ID,
  EXTERNAL_INSTANCE,
  ingressDraft,
  productionComposition,
  SIBLING_CONNECTOR_ID,
} from './f202-c1-production-composition-helpers.js';

const BOOTSTRAP_ABSENT =
  'C1 gap D: issueConnectorBindingHandle (handles.ts:60) has no production caller and the plugin ' +
  'contract exposes no connector.* wire row, so a migrated connector holding (connectorId, ' +
  'externalChatId) cannot obtain the opaque handle messaging.send demands.';

describe('F202 C1 Core cutover gate — connector binding authority and durability', () => {
  test('8/RED — a Host route resolves-or-creates a binding from broker identity alone', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-bootstrap-'));
    const { runtime } = await productionComposition(projectRoot);

    const resolveBinding = runtime.messaging.resolveConnectorBinding;
    assert.equal(typeof resolveBinding, 'function', BOOTSTRAP_ABSENT);

    // Caller identity is the FIRST argument, mirroring messaging.send(caller, draft): it is
    // supplied by the broker, never chosen by the package. The package passes only provider
    // coordinates — no userId, because an external package must not select the Host-side owner.
    const caller = { pluginInstanceId: EXTERNAL_INSTANCE };
    const coordinates = { connectorId: CONNECTOR_ID, externalChatId: EXTERNAL_CHAT_ID };

    const first = await resolveBinding.call(runtime.messaging, caller, coordinates);
    assert.ok(first?.handleId, 'the Host must return an opaque connector_binding handle');
    assert.ok(first?.threadId, 'the Host — not the package — owns external-chat to thread mapping');
    assert.ok(
      first?.userId,
      'the Host must derive the owner itself (legacy ConnectorRouter uses defaultUserId); a route ' +
        'that accepts a package-supplied userId lets untrusted code choose whose thread it writes to',
    );

    const again = await resolveBinding.call(runtime.messaging, caller, coordinates);
    assert.equal(again.threadId, first.threadId, 'resolve-or-create must be idempotent per external chat');

    const receipt = await runtime.messaging.send(
      caller,
      ingressDraft(first.handleId, '@opus 用 Host 签发的 handle', 'prod-8'),
    );
    assert.ok(receipt?.messageId, 'a Host-issued handle must be directly usable for ingress send');

    await runtime.shutdown('test');
  });

  test('11/RED — a package cannot bootstrap a binding for a connector it did not declare', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-forgery-'));
    const { runtime } = await productionComposition(projectRoot);

    const resolveBinding = runtime.messaging.resolveConnectorBinding;
    assert.equal(typeof resolveBinding, 'function', BOOTSTRAP_ABSENT);

    // The instance above declares CONNECTOR_ID. Asking for a sibling connector must fail closed,
    // otherwise case 8 can go green via cross-plugin binding forgery: any admitted package could
    // mint bindings for every other connector in the catalog and read/write their threads.
    await assert.rejects(
      () =>
        resolveBinding.call(
          runtime.messaging,
          { pluginInstanceId: EXTERNAL_INSTANCE },
          { connectorId: SIBLING_CONNECTOR_ID, externalChatId: EXTERNAL_CHAT_ID },
        ),
      'connectorId must be checked against the instance declared connector contribution',
    );

    await runtime.shutdown('test');
  });

  test('9/RED — bindings survive a Host restart through a shared durable authority', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-restart-'));
    // One explicitly isolated store instance shared by both compositions IS the durability
    // subject. projectRoot must NOT be the persistence mechanism: the shipped authority is
    // RedisConnectorThreadBindingStore (index.ts:7389), and a projectRoot-shaped test would
    // fail a correct Redis-backed implementation and pressure it toward a duplicate file store.
    const bindingStore = new MemoryConnectorThreadBindingStore();

    const before = await productionComposition(projectRoot, { bindingStore });
    const resolveBinding = before.runtime.messaging.resolveConnectorBinding;
    assert.equal(typeof resolveBinding, 'function', BOOTSTRAP_ABSENT);
    const caller = { pluginInstanceId: EXTERNAL_INSTANCE };
    const coordinates = { connectorId: CONNECTOR_ID, externalChatId: EXTERNAL_CHAT_ID };
    const initial = await resolveBinding.call(before.runtime.messaging, caller, coordinates);
    await before.runtime.shutdown('restart');

    const after = await productionComposition(projectRoot, { bindingStore });
    const recovered = await after.runtime.messaging.resolveConnectorBinding(caller, coordinates);

    assert.equal(
      recovered.threadId,
      initial.threadId,
      'after restart the same (connectorId, externalChatId) must resolve to the same thread, or a ' +
        'migrated multi-chat connector loses outbound addressing for every existing conversation',
    );
    assert.equal(
      bindingStore.getByExternal(CONNECTOR_ID, EXTERNAL_CHAT_ID)?.threadId,
      initial.threadId,
      'the binding must live in the injected Host authority, not in composition-local memory',
    );
    await after.runtime.shutdown('test');
  });

  test('12/RED — Host offers each connector instance a durable checkpoint surface', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-checkpoint-'));
    const { runtime } = await productionComposition(projectRoot);

    const checkpoints = runtime.messaging.connectorCheckpoints;
    assert.equal(
      typeof checkpoints?.commit,
      'function',
      'C1 gap E: Telegram long polling and WeCom Bot/XiaoYi WebSocket resume need a restart-safe ' +
        'provider cursor. plugin.state.get/set are reserved L0 capability NAMES only — absent from ' +
        'the 13-row wire registry, with no Core handler, store, or composition path. Subscription ' +
        'cursor (plugin reads of the Host output stream), inventory snapshot (lifecycle projection) ' +
        'and the 7-day messaging settlement ledger (same-idempotency-key replay) are not substitutes.',
    );

    const caller = { pluginInstanceId: EXTERNAL_INSTANCE };
    // CAS/operation-id idempotency: a stale expected revision must be refused, not silently won,
    // or a restarted process racing its predecessor rewinds the provider cursor and redelivers.
    const committed = await checkpoints.commit(caller, {
      key: 'provider-cursor',
      value: { offset: 42 },
      expectedRevision: 0,
      operationId: 'op-1',
    });
    assert.equal(committed.revision, 1, 'commit must return a monotonic revision for CAS');
    await assert.rejects(
      () =>
        checkpoints.commit(caller, {
          key: 'provider-cursor',
          value: { offset: 7 },
          expectedRevision: 0,
          operationId: 'op-2',
        }),
      'a stale expectedRevision must fail closed rather than rewind the cursor',
    );

    // TTL=0: the checkpoint is user-visible recoverable state, so it must outlive restart.
    const after = await productionComposition(projectRoot);
    const recovered = await after.runtime.messaging.connectorCheckpoints.read(caller, { key: 'provider-cursor' });
    assert.deepEqual(recovered.value, { offset: 42 }, 'checkpoints must be TTL=0 and survive restart');

    // Instance isolation: one plugin must never read another plugin checkpoint namespace.
    await assert.rejects(
      () =>
        after.runtime.messaging.connectorCheckpoints.read({ pluginInstanceId: 'pi_other' }, { key: 'provider-cursor' }),
      'checkpoints must be namespaced per plugin instance + declared key',
    );

    await runtime.shutdown('test');
    await after.runtime.shutdown('test');
  });
});
