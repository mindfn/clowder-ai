/**
 * F202 Train C1 — Core cutover gate, part 4a: checkpoint durability and settlement ordering.
 *
 * Gap E rationale, disqualified substitutes and the broker/authority design live in
 * ./f202-c1-checkpoint-fixture.js. This file owns the four cases where a checkpoint must behave
 * like durable Host-owned state: CAS fencing, restart survival, settlement-ordered commit, and
 * per-instance read scope. The safety negatives live in the companion safety file.
 *
 * Every success path here carries a settlement reference minted by a REAL Host-accepted delivery
 * (sixth-round review P1). The `messaging.send` row executes today through the same authenticated
 * connection, so the reference is the Host's own receipt rather than a string the test invented.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertCheckpointRowsReachable,
  assertNotPlumbingFailure,
  checkpointFixture,
  DECLARED_KEY,
  IsolatedCheckpointAuthority,
} from './f202-c1-checkpoint-fixture.js';
import {
  authenticatedConnection,
  BASE_GRANTS,
  CHECKPOINT_COMMIT,
  CHECKPOINT_READ,
  checkpointGrants,
  hostAcceptedDelivery,
  installConnectorInstance,
} from './f202-c1-production-composition-helpers.js';

describe('F202 C1 Core cutover gate — durable connector checkpoints', () => {
  test('12/RED — checkpoints are CAS-fenced and survive restart in a shared durable authority', async () => {
    // ONE authority instance shared by both compositions IS the durability subject.
    const checkpointStore = new IsolatedCheckpointAuthority();
    const before = await checkpointFixture('f202-c1-checkpoint-', { checkpointStore });

    // A REAL Host-accepted delivery first: this executes today and proves the settlement
    // reference the commit carries is minted by the Host rather than invented by the test.
    const receipt = await hostAcceptedDelivery(before.runtime, before.connection, before.pluginInstanceId, 'settle-1');
    assert.ok(receipt.messageId, 'the Host must mint a real receipt before any cursor may advance');
    assertCheckpointRowsReachable(before.runtime);

    const committed = await before.connection.call(CHECKPOINT_COMMIT, {
      key: DECLARED_KEY,
      value: { offset: 42 },
      expectedRevision: 0,
      operationId: 'op-1',
      settlementRef: { messageId: receipt.messageId },
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
          settlementRef: { messageId: receipt.messageId },
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

  test('16/RED — replaying one operationId commits once and returns the canonical result', async () => {
    const checkpointStore = new IsolatedCheckpointAuthority();
    const fixture = await checkpointFixture('f202-c1-checkpoint-replay-', { checkpointStore });
    const receipt = await hostAcceptedDelivery(fixture.runtime, fixture.connection, fixture.pluginInstanceId, 'replay');
    assertCheckpointRowsReachable(fixture.runtime);

    const input = {
      key: DECLARED_KEY,
      value: { offset: 5 },
      expectedRevision: 0,
      operationId: 'op-replay',
      settlementRef: { messageId: receipt.messageId },
    };
    const first = await fixture.connection.call(CHECKPOINT_COMMIT, input);
    const replay = await fixture.connection.call(CHECKPOINT_COMMIT, input);

    // At-least-once transport means the same commit WILL arrive twice. Comparing return values
    // alone still admits an implementation that re-applies the write and echoes the first
    // result, so the persistence layer itself must show exactly one commit and one revision.
    assert.deepEqual(replay, first, 'an operationId replay must return the canonical first result');
    assert.equal(checkpointStore.commits.length, 1, 'a replay must not re-apply the write at the authority');
    assert.equal(checkpointStore.read(fixture.pluginInstanceId, DECLARED_KEY)?.revision, 1, 'revision advances once');

    await fixture.runtime.shutdown('test');
  });

  test('18/RED — a commit that names no settlement at all is refused', async () => {
    const checkpointStore = new IsolatedCheckpointAuthority();
    const fixture = await checkpointFixture('f202-c1-checkpoint-unsettled-', { checkpointStore });
    const receipt = await hostAcceptedDelivery(
      fixture.runtime,
      fixture.connection,
      fixture.pluginInstanceId,
      'req-ref',
    );
    assertCheckpointRowsReachable(fixture.runtime);

    // Sixth-round review P1: rejecting only an INVALID ref leaves the widest hole open - an
    // implementation that simply omits the field advances the cursor with no settlement at all.
    // Positive first, so the refusal below cannot be satisfied by a broken commit path.
    const committed = await fixture.connection.call(CHECKPOINT_COMMIT, {
      key: DECLARED_KEY,
      value: { offset: 11 },
      expectedRevision: 0,
      operationId: 'op-settled',
      settlementRef: { messageId: receipt.messageId },
    });
    assert.equal(committed.revision, 1, 'a settled commit must succeed');

    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 12 },
          expectedRevision: 1,
          operationId: 'op-no-ref',
        }),
      assertNotPlumbingFailure,
      'a settlement-required key must refuse a commit that names no delivery',
    );
    assert.equal(checkpointStore.commits.length, 1, 'the refused commit must not reach the authority');

    await fixture.runtime.shutdown('test');
  });

  test('20/RED — one instance cannot read another instance checkpoint', async () => {
    const checkpointStore = new IsolatedCheckpointAuthority();
    const owner = await checkpointFixture('f202-c1-checkpoint-tenant-', { checkpointStore });
    const receipt = await hostAcceptedDelivery(owner.runtime, owner.connection, owner.pluginInstanceId, 'tenant');
    assertCheckpointRowsReachable(owner.runtime);

    await owner.connection.call(CHECKPOINT_COMMIT, {
      key: DECLARED_KEY,
      value: { offset: 77 },
      expectedRevision: 0,
      operationId: 'op-tenant',
      settlementRef: { messageId: receipt.messageId },
    });
    // Positive first: the owner reads its own value, so the refusal below cannot pass because
    // reads are broken generally.
    const own = await owner.connection.call(CHECKPOINT_READ, { key: DECLARED_KEY });
    assert.deepEqual(own.value, { offset: 77 }, 'the owning instance must read its own checkpoint');

    // A second fully-granted instance of the SAME package: write-side namespacing was already
    // proven through the injected authority, but a read handler that forgets the instance scope
    // still leaks a neighbour's cursor. This one holds the grant, so a CAPABILITY_DENIED here
    // would mean the implementation refused for the wrong reason.
    const neighbourId = await installConnectorInstance(owner.runtime, owner.projectRoot, {
      effectiveGrants: [...BASE_GRANTS, ...checkpointGrants()],
    });
    const neighbour = await authenticatedConnection(owner.runtime, neighbourId);

    // Seventh-round review P1: the read carries NO caller-supplied instance id. A wire that let a
    // package name someone else's instance would already BE the leak, so asserting that such a
    // call is refused would bless the wrong shape. The neighbour asks for its own slot under the
    // same key; instance scope must make that slot empty rather than the owner's value.
    let neighbourRead = null;
    try {
      neighbourRead = await neighbour.call(CHECKPOINT_READ, { key: DECLARED_KEY });
    } catch (error) {
      assert.notEqual(error?.code, 'CAPABILITY_DENIED', 'the neighbour holds the grant; scope must decide the read');
      assertNotPlumbingFailure(error);
    }
    assert.notDeepEqual(
      neighbourRead?.value ?? null,
      { offset: 77 },
      'a read handler that forgets instance scope leaks the neighbouring cursor',
    );
    assert.equal(
      neighbourRead?.value ?? null,
      null,
      'an unwritten slot under the same key must read scoped-empty/not-found for another instance',
    );

    await owner.runtime.shutdown('test');
  });
});
