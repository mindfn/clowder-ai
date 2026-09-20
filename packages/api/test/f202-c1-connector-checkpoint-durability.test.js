/**
 * F202 Train C1 — Core cutover gate, part 4: durable connector checkpoints (gap E).
 *
 * Gap E is a PUBLIC-WIRE boundary blocker, not narrow wiring. Verified against the installed
 * @clowder-ai/plugin-contract@0.1.0-beta.15: WIRE_METHOD_COUNT === 13 and
 * isWireMethod('plugin.state.get'|'plugin.state.set') === false. Those two names exist only in
 * the L0 capability enum and design prose; Core has no handler, store or composition path.
 *
 * Telegram long polling and WeCom Bot / XiaoYi WebSocket resume need a restart-safe provider
 * cursor. The three candidate substitutes are all disqualified at the interface level:
 *   - messaging settlement ledger: LEDGER_RETENTION_MS = 7d with a documented at-least-once
 *     boundary (ledger.ts:13,20) vs the TTL=0 this requires; keyed by the request's own
 *     idempotencyKey, with no read() and no revision CAS.
 *   - subscription cursor: tracks the HOST's output event log, advance-only (a stale advance is
 *     silently absorbed - precisely the rewind this must refuse), and dies with the handle.
 *   - inventory snapshot: a Host-authored lifecycle projection with no plugin-writable region.
 *
 * WHY THROUGH THE BROKER + AN INJECTED AUTHORITY (fifth-round review P1): asserting on
 * `runtime.messaging.connectorCheckpoints` lets an internal method satisfy the gate while the
 * package still cannot reach it, and sharing only `projectRoot` between the before/after
 * compositions pressures the implementation toward a package-local file store. These cases call
 * through an authenticated Broker connection and pin durability to an explicitly isolated
 * authority shared by both compositions.
 *
 * The safety negatives exist so a bare JSON key-value implementation cannot turn this green.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { isWireMethod } from '@clowder-ai/plugin-contract';
import {
  authenticatedConnection,
  CONNECTOR_SECRET_VALUE,
  installConnectorInstance,
  productionComposition,
} from './f202-c1-production-composition-helpers.js';

/**
 * PROPOSED spelling; the exact public names are a maintainer decision (plan section 7.2 item 5).
 * What is gated is the requirement: a bounded, per-instance, declared-key durable surface
 * reachable only through the authenticated public wire.
 */
const CHECKPOINT_COMMIT = 'connector.checkpoint.commit';
const CHECKPOINT_READ = 'connector.checkpoint.read';

const DECLARED_KEY = 'provider-cursor';

const GAP_E_WIRE_ABSENT =
  'C1 gap E (boundary blocker): the 13-row wire registry has no checkpoint row. plugin.state.get/set ' +
  'are RESERVED L0 capability NAMES ONLY - isWireMethod() returns false for both against the ' +
  'installed 0.1.0-beta.15 - with no Core handler, store or composition path. An internal ' +
  'MessagingService method does NOT satisfy this: a migrated stdio package cannot call it.';

/**
 * An explicitly isolated durable checkpoint authority, shared across compositions so that the
 * restart case measures Host-owned durability rather than a temp directory. Core exposes no such
 * seam today; offering one is how these cases refuse to pressure the implementation toward
 * projectRoot-as-persistence. Declaring the port here also pins its minimum shape.
 */
class IsolatedCheckpointAuthority {
  constructor() {
    this.records = new Map();
  }

  slot(pluginInstanceId, key) {
    return `${pluginInstanceId}::${key}`;
  }

  read(pluginInstanceId, key) {
    return this.records.get(this.slot(pluginInstanceId, key)) ?? null;
  }

  commit(pluginInstanceId, key, value, revision) {
    this.records.set(this.slot(pluginInstanceId, key), { value, revision });
    return { revision };
  }
}

async function checkpointFixture(prefix, overrides = {}) {
  const projectRoot = overrides.projectRoot ?? (await mkdtemp(resolve(tmpdir(), prefix)));
  await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
  await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');
  const { runtime } = await productionComposition(projectRoot, { checkpointStore: overrides.checkpointStore });
  const pluginInstanceId = overrides.pluginInstanceId ?? (await installConnectorInstance(runtime, projectRoot));
  const connection = await authenticatedConnection(runtime, pluginInstanceId);
  return { projectRoot, runtime, pluginInstanceId, connection };
}

/** The public-surface precondition every gap-E case shares. Fails first, and for one reason. */
function assertCheckpointRowsReachable(runtime) {
  assert.ok(isWireMethod(CHECKPOINT_COMMIT), GAP_E_WIRE_ABSENT);
  assert.ok(isWireMethod(CHECKPOINT_READ), GAP_E_WIRE_ABSENT);
  const registered = runtime.broker.options.methods.map((handler) => handler.method);
  assert.ok(
    registered.includes(CHECKPOINT_COMMIT) && registered.includes(CHECKPOINT_READ),
    'the SHIPPED composition must register Host handlers for both rows; a contract row with no ' +
      'Core handler is still unreachable for a migrated package',
  );
}

describe('F202 C1 Core cutover gate — durable connector checkpoints', () => {
  test('12/RED — checkpoints are CAS-fenced and survive restart in a shared durable authority', async () => {
    // ONE authority instance shared by both compositions IS the durability subject.
    const checkpointStore = new IsolatedCheckpointAuthority();
    const before = await checkpointFixture('f202-c1-checkpoint-', { checkpointStore });
    assertCheckpointRowsReachable(before.runtime);

    const committed = await before.connection.call(CHECKPOINT_COMMIT, {
      key: DECLARED_KEY,
      value: { offset: 42 },
      expectedRevision: 0,
      operationId: 'op-1',
    });
    assert.equal(committed.revision, 1, 'commit must return a monotonic revision for CAS');
    assert.deepEqual(
      checkpointStore.read(before.pluginInstanceId, DECLARED_KEY)?.value,
      { offset: 42 },
      'the checkpoint must land in the injected Host authority, not in composition-local memory ' +
        'or a projectRoot file - the latter cannot survive a Redis-backed production deployment',
    );

    // A stale expectedRevision must fail closed: a restarted process racing its predecessor
    // would otherwise rewind the provider cursor and redeliver every message after it.
    await assert.rejects(
      () =>
        before.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 7 },
          expectedRevision: 0,
          operationId: 'op-2',
        }),
      'a stale expectedRevision must fail closed rather than rewind the cursor',
    );
    await before.runtime.shutdown('restart');

    // TTL=0: the checkpoint is user-visible recoverable state, so it must outlive restart.
    const after = await checkpointFixture('f202-c1-checkpoint-', {
      projectRoot: before.projectRoot,
      pluginInstanceId: before.pluginInstanceId,
      checkpointStore,
    });
    const recovered = await after.connection.call(CHECKPOINT_READ, { key: DECLARED_KEY });
    assert.deepEqual(recovered.value, { offset: 42 }, 'checkpoints must be TTL=0 and survive restart');

    await after.runtime.shutdown('test');
  });

  test('13/RED — a key the contribution never declared is refused', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-key-');
    assertCheckpointRowsReachable(fixture.runtime);

    // ConnectorContribution is a CLOSED type today ({type,id,identityRef,inboundMethod,
    // outboundMethod}, additionalProperties:false), so the per-contribution key declaration is
    // itself part of the gap-E schema delta. Without declared keys a package can squat unbounded
    // namespaces, which is how a checkpoint surface degrades into general plugin storage.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: 'undeclared-scratch-space',
          value: { offset: 1 },
          expectedRevision: 0,
          operationId: 'op-undeclared',
        }),
      'checkpoint keys must be declared per contribution, not chosen freely at runtime',
    );

    await fixture.runtime.shutdown('test');
  });

  test('14/RED — oversize and unbounded values are refused', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-size-');
    assertCheckpointRowsReachable(fixture.runtime);

    // Unbounded values turn a cursor slot into a message spool and make Host memory/storage a
    // function of untrusted package behaviour.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { blob: 'x'.repeat(1_048_576) },
          expectedRevision: 0,
          operationId: 'op-oversize',
        }),
      'the checkpoint value must be bounded by a declared schema and size limit',
    );

    await fixture.runtime.shutdown('test');
  });

  test('15/RED — the cursor cannot advance before the Host accepts the delivery', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-settlement-');
    assertCheckpointRowsReachable(fixture.runtime);

    // Settlement-ordered commit: if a package may advance its cursor before Host-accepted
    // delivery, a crash between the two drops messages permanently - the silent-loss half of the
    // no-double-run contract, and unrecoverable because the provider offset has already moved.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 99 },
          expectedRevision: 0,
          operationId: 'op-unsettled',
          settlementRef: { deliveryId: 'never-delivered' },
        }),
      'a checkpoint naming an unsettled delivery must be refused, not committed optimistically',
    );

    await fixture.runtime.shutdown('test');
  });

  test('16/RED — replaying one operationId returns the canonical result rather than re-applying', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-replay-');
    assertCheckpointRowsReachable(fixture.runtime);

    const input = { key: DECLARED_KEY, value: { offset: 5 }, expectedRevision: 0, operationId: 'op-replay' };
    const first = await fixture.connection.call(CHECKPOINT_COMMIT, input);
    const replay = await fixture.connection.call(CHECKPOINT_COMMIT, input);

    // At-least-once transport means the same commit WILL arrive twice. Re-applying it would
    // consume a second revision and make every concurrent CAS fence spuriously stale.
    assert.deepEqual(replay, first, 'an operationId replay must return the canonical first result');

    await fixture.runtime.shutdown('test');
  });

  test('17/RED — message bodies and secrets are refused', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-content-');
    assertCheckpointRowsReachable(fixture.runtime);

    // A checkpoint is resume metadata. Admitting bodies or secrets would route user content and
    // credentials into a store with different retention, redaction and export rules than the
    // message plane, bypassing the Host's own content authority.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 6, secret: CONNECTOR_SECRET_VALUE },
          expectedRevision: 0,
          operationId: 'op-secret',
        }),
      'checkpoint values must carry neither message bodies nor secrets',
    );

    await fixture.runtime.shutdown('test');
  });
});
