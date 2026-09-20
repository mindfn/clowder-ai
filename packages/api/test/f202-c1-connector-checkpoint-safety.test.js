/**
 * F202 Train C1 — Core cutover gate, part 4b: checkpoint safety negatives (gap E).
 *
 * Gap E rationale and the broker/authority design live in ./f202-c1-checkpoint-fixture.js.
 * These negatives exist so a bare JSON key-value implementation cannot turn the gate green:
 * declared key, bounded value, settlement ordering, grant isolation and a content ban.
 *
 * PROVISIONAL GATE (sixth-round review P1). Case 13 is the negative half of a declared-key PAIR
 * whose positive half is case 12 (durability file). No manifest channel can express a
 * per-contribution key declaration today: ConnectorContribution is closed at
 * {type,id,identityRef,inboundMethod,outboundMethod} with additionalProperties:false, and the
 * only other candidate — manifest-level `data[]` — is catalog metadata over a fixed
 * dataClass/strategy vocabulary that Core reads nowhere outside official-catalog.ts. An
 * implementation honouring declared keys therefore cannot turn both halves green until the
 * §7.2 item 5 schema delta is signed, so this pair is NOT a settled Stage 2a completion gate.
 * Case 21 is the self-retiring marker: it passes only while that gap exists and turns RED the
 * moment a declaration channel lands, forcing the pair to be converted into a real gate.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertCheckpointRowsReachable, checkpointFixture, DECLARED_KEY } from './f202-c1-checkpoint-fixture.js';
import { BASE_GRANTS, CHECKPOINT_COMMIT, CONNECTOR_SECRET_VALUE } from './f202-c1-production-composition-helpers.js';

describe('F202 C1 Core cutover gate — connector checkpoint safety contract', () => {
  test('13/RED (provisional pair with 12) — a key the contribution never declared is refused', async () => {
    const fixture = await checkpointFixture('f202-c1-checkpoint-key-');
    assertCheckpointRowsReachable(fixture.runtime);

    // Without declared keys a package can squat unbounded namespaces, which is how a checkpoint
    // surface degrades into general plugin storage. See the PROVISIONAL GATE note above.
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

    await fixture.runtime.shutdown('test');
  });

  test('21/GREEN guard — no manifest channel can declare a checkpoint key yet (provisional marker)', async () => {
    const { default: schema } = await import('@clowder-ai/plugin-contract/schemas/manifest', {
      with: { type: 'json' },
    });
    const connector = schema.$defs.ConnectorContribution;

    // This guard exists to RETIRE itself. While it passes, the 12/13 declared-key pair is a
    // provisional gate and must not be reported as a settled Stage 2a completion gate. The day a
    // declaration channel is signed, this turns RED and the pair must be converted into a real
    // positive/negative on the declared key.
    assert.equal(connector.additionalProperties, false, 'ConnectorContribution must stay closed for this to hold');
    assert.deepEqual(
      Object.keys(connector.properties).sort(),
      ['id', 'identityRef', 'inboundMethod', 'outboundMethod', 'type'],
      'a new ConnectorContribution property may be the checkpoint key declaration - convert the pair',
    );
    assert.deepEqual(
      Object.keys(schema.$defs.DataDeclaration.properties).sort(),
      ['dataClass', 'name', 'schemaVersion', 'strategy'],
      'manifest data[] is catalog metadata, not a per-key state namespace - if it gains one, convert the pair',
    );
  });
});
