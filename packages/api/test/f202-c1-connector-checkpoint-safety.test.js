/**
 * F202 Train C1 — Core cutover gate, part 4b: checkpoint safety negatives (gap E).
 *
 * Gap E rationale and the broker/authority design live in ./f202-c1-checkpoint-fixture.js.
 * These negatives exist so a bare JSON key-value implementation cannot turn the gate green:
 * declared key, bounded value, settlement ordering, grant isolation and a content ban.
 *
 * PROVISIONAL GATE (sixth-round review P1). Case 13 is the negative half of a declared-key PAIR
 * whose positive half is case 12 (durability file). Neither of the TWO surfaces that could carry
 * a per-contribution key declaration expresses one today: ConnectorContribution is closed at
 * {type,id,identityRef,inboundMethod,outboundMethod} with additionalProperties:false, and
 * manifest-level `data[]` is catalog metadata over a fixed dataClass/strategy vocabulary that
 * Core reads nowhere outside official-catalog.ts. An implementation honouring declared keys
 * therefore cannot turn both halves green until the §7.2 item 5 schema delta is signed, so this
 * pair is NOT a settled Stage 2a completion gate. Case 21 is the tripwire over exactly those two
 * surfaces (seventh-round review P2 — it does not, and cannot, prove the absence of every
 * conceivable channel): it trips the moment either surface changes, forcing the pair to be
 * re-examined and converted into a real gate.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertCheckpointRowsReachable,
  assertNoDurableCommit,
  checkpointFixture,
  DECLARED_KEY,
  settledCheckpointFixture,
} from './f202-c1-checkpoint-fixture.js';
import { BASE_GRANTS, CHECKPOINT_COMMIT, CONNECTOR_SECRET_VALUE } from './f202-c1-production-composition-helpers.js';

describe('F202 C1 Core cutover gate — connector checkpoint safety contract', () => {
  test('13/RED (provisional pair with 12) — a key the contribution never declared is refused', async () => {
    const fixture = await settledCheckpointFixture('f202-c1-checkpoint-key-');
    assertCheckpointRowsReachable(fixture.runtime);

    // Without declared keys a package can squat unbounded namespaces, which is how a checkpoint
    // surface degrades into general plugin storage. See the PROVISIONAL GATE note above.
    // Settlement is pre-satisfied so the DECLARED-KEY rule is the only reason left to refuse.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: 'undeclared-scratch-space',
          value: { offset: 1 },
          expectedRevision: 0,
          operationId: 'op-undeclared',
          settlementRef: fixture.settlementRef,
        }),
      'checkpoint keys must be declared per contribution, not chosen freely at runtime',
    );
    assertNoDurableCommit(fixture.checkpointStore, 'declared-key');

    await fixture.runtime.shutdown('test');
  });

  test('14/RED — oversize and unbounded values are refused', async () => {
    const fixture = await settledCheckpointFixture('f202-c1-checkpoint-size-');
    assertCheckpointRowsReachable(fixture.runtime);

    // Unbounded values turn a cursor slot into a message spool and make Host memory/storage a
    // function of untrusted package behaviour.
    // Settlement is pre-satisfied so the SIZE rule is the only reason left to refuse.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { blob: 'x'.repeat(1_048_576) },
          expectedRevision: 0,
          operationId: 'op-oversize',
          settlementRef: fixture.settlementRef,
        }),
      'the checkpoint value must be bounded by a declared schema and size limit',
    );
    assertNoDurableCommit(fixture.checkpointStore, 'value-bound');

    await fixture.runtime.shutdown('test');
  });

  test('15/RED — a checkpoint naming an unsettled delivery is refused', async () => {
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
          settlementRef: { messageId: 'never-delivered' },
        }),
      'a checkpoint naming an unsettled delivery must be refused, not committed optimistically',
    );
    assertNoDurableCommit(fixture.checkpointStore, 'settlement-ordering');

    await fixture.runtime.shutdown('test');
  });

  test('17/RED — message bodies and secrets are refused', async () => {
    const fixture = await settledCheckpointFixture('f202-c1-checkpoint-content-');
    assertCheckpointRowsReachable(fixture.runtime);

    // A checkpoint is resume metadata. Admitting bodies or secrets would route user content and
    // credentials into a store with different retention, redaction and export rules than the
    // message plane, bypassing the Host's own content authority.
    // Settlement is pre-satisfied so the CONTENT ban is the only reason left to refuse.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 6, secret: CONNECTOR_SECRET_VALUE },
          expectedRevision: 0,
          operationId: 'op-secret',
          settlementRef: fixture.settlementRef,
        }),
      'checkpoint values must carry neither message bodies nor secrets',
    );
    assertNoDurableCommit(fixture.checkpointStore, 'content-ban');

    await fixture.runtime.shutdown('test');
  });

  test('19/RED — an instance without the checkpoint grant is refused fail-closed', async () => {
    // Same installed package and the same authenticated handshake; only the grant set differs.
    // The manifest still REQUESTS the checkpoint capabilities (the Host enforces effective
    // grants ⊆ manifest requests), so withholding them is a legitimate authorization negative
    // rather than an install failure.
    const fixture = await checkpointFixture('f202-c1-checkpoint-grant-', { effectiveGrants: [...BASE_GRANTS] });
    assertCheckpointRowsReachable(fixture.runtime);

    // CAPABILITY_DENIED is an EXISTING Host code (control-plane.ts:608), not a name this gate
    // invents: currentCallContext() throws it when the instance lacks the row's grant.
    await assert.rejects(
      () =>
        fixture.connection.call(CHECKPOINT_COMMIT, {
          key: DECLARED_KEY,
          value: { offset: 3 },
          expectedRevision: 0,
          operationId: 'op-ungranted',
        }),
      (error) => {
        assert.equal(error?.code, 'CAPABILITY_DENIED', 'a missing checkpoint grant must fail closed at the broker');
        return true;
      },
      'holding messaging grants alone must not reach the checkpoint rows',
    );
    assertNoDurableCommit(fixture.checkpointStore, 'grant');

    await fixture.runtime.shutdown('test');
  });

  test('21/GREEN tripwire — the two candidate declaration surfaces are unchanged (provisional marker)', async () => {
    const { default: schema } = await import('@clowder-ai/plugin-contract/schemas/manifest', {
      with: { type: 'json' },
    });
    const connector = schema.$defs.ConnectorContribution;

    // Scope (seventh-round review P2): this is a TRIPWIRE over the two surfaces below, not proof
    // that no declaration channel exists anywhere. While both are unchanged, the 12/13 pair stays
    // provisional and must not be reported as a settled Stage 2a completion gate. The day either
    // surface moves, this trips RED and the pair must be re-examined and converted into a real
    // positive/negative on the declared key.
    assert.equal(connector.additionalProperties, false, 'ConnectorContribution must stay closed for this to hold');
    assert.deepEqual(
      Object.keys(connector.properties).sort(),
      ['id', 'identityRef', 'inboundMethod', 'outboundMethod', 'type'],
      'surface 1 moved: a new ConnectorContribution property may be the key declaration - re-examine the pair',
    );
    assert.deepEqual(
      Object.keys(schema.$defs.DataDeclaration.properties).sort(),
      ['dataClass', 'name', 'schemaVersion', 'strategy'],
      'surface 2 moved: manifest data[] gained a property - re-examine whether it now carries a key namespace',
    );
  });
});
