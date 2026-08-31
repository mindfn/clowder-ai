import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ConnectorMigrationControlPlane,
  ConnectorMigrationError,
  MemoryConnectorMigrationStore,
} from '../dist/domains/plugin/connector-migration/index.js';

function fingerprint(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function packageDigest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function migrationError(code) {
  return (error) => error instanceof ConnectorMigrationError && error.code === code;
}

function harness() {
  let now = 1_000;
  const store = new MemoryConnectorMigrationStore();
  const control = new ConnectorMigrationControlPlane(store, { now: () => now++ });
  return { store, control };
}

describe('K-2E connector runtime authority fence', () => {
  it('observes a legacy connector without starting Host authority', async () => {
    const { store, control } = harness();
    const sourceFingerprint = fingerprint('echo package + config + operation state');

    const observed = await control.observe({
      connectorId: 'echo',
      sourceFingerprint,
      ownerIntent: 'enabled',
    });

    assert.deepEqual(observed, {
      connectorId: 'echo',
      runtimeAuthority: 'legacy',
      phase: 'observed',
      revision: 1,
      sourceFingerprint,
      ownerIntent: 'enabled',
      updatedAt: 1_000,
    });
    assert.deepEqual((await store.snapshot()).records, [observed]);
  });

  it('copy-and-verify reaches shadow-ready while legacy remains authoritative', async () => {
    const { control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const evidenceFingerprint = fingerprint('config + operations + bindings + permissions');
    const hostPackageDigest = packageDigest('host-owned echo adapter archive');
    const observed = await control.observe({
      connectorId: 'echo',
      sourceFingerprint,
      ownerIntent: 'disabled',
    });

    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    assert.equal(copying.runtimeAuthority, 'legacy');
    assert.equal(copying.phase, 'copying');
    assert.equal(copying.revision, 2);

    const ready = await control.markShadowReady({
      connectorId: 'echo',
      expectedRevision: copying.revision,
      expectedSourceFingerprint: sourceFingerprint,
      hostPluginInstanceId: 'pi_echo',
      hostPackageDigest,
      evidenceFingerprint,
    });
    assert.equal(ready.runtimeAuthority, 'legacy');
    assert.equal(ready.phase, 'shadow-ready');
    assert.equal(ready.revision, 3);
    assert.equal(ready.hostPluginInstanceId, 'pi_echo');
    assert.equal(ready.hostPackageDigest, hostPackageDigest);
    assert.equal(ready.evidenceFingerprint, evidenceFingerprint);
  });

  it('refuses cutover while either runtime is live and writes nothing', async () => {
    const { store, control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' });
    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    const ready = await control.markShadowReady({
      connectorId: 'echo',
      expectedRevision: copying.revision,
      expectedSourceFingerprint: sourceFingerprint,
      hostPluginInstanceId: 'pi_echo',
      hostPackageDigest: packageDigest('echo-adapter'),
      evidenceFingerprint: fingerprint('verified migration evidence'),
    });
    const before = await store.snapshot();

    await assert.rejects(
      control.beginCutover({
        connectorId: 'echo',
        expectedRevision: ready.revision,
        expectedSourceFingerprint: sourceFingerprint,
        legacyRuntimeState: 'running',
        hostRuntimeState: 'stopped',
      }),
      migrationError('LEGACY_RUNTIME_ACTIVE'),
    );
    assert.deepEqual(await store.snapshot(), before);

    await assert.rejects(
      control.beginCutover({
        connectorId: 'echo',
        expectedRevision: ready.revision,
        expectedSourceFingerprint: sourceFingerprint,
        legacyRuntimeState: 'stopped',
        hostRuntimeState: 'healthy',
      }),
      migrationError('HOST_RUNTIME_ACTIVE'),
    );
    assert.deepEqual(await store.snapshot(), before);
  });

  it('changes authority only at explicit revision-fenced cutover', async () => {
    const { control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' });
    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    const ready = await control.markShadowReady({
      connectorId: 'echo',
      expectedRevision: copying.revision,
      expectedSourceFingerprint: sourceFingerprint,
      hostPluginInstanceId: 'pi_echo',
      hostPackageDigest: packageDigest('echo-adapter'),
      evidenceFingerprint: fingerprint('verified migration evidence'),
    });

    const activating = await control.beginCutover({
      connectorId: 'echo',
      expectedRevision: ready.revision,
      expectedSourceFingerprint: sourceFingerprint,
      legacyRuntimeState: 'stopped',
      hostRuntimeState: 'stopped',
    });
    assert.equal(activating.runtimeAuthority, 'host');
    assert.equal(activating.phase, 'activating');
    assert.equal(activating.revision, 4);

    const active = await control.markHostActive({
      connectorId: 'echo',
      expectedRevision: activating.revision,
      hostPluginInstanceId: 'pi_echo',
    });
    assert.equal(active.runtimeAuthority, 'host');
    assert.equal(active.phase, 'active');
    assert.equal(active.revision, 5);
  });

  it('rejects stale revisions and changed source evidence without mutation', async () => {
    const { store, control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' });
    const before = await store.snapshot();

    await assert.rejects(
      control.beginShadow({
        connectorId: 'echo',
        expectedRevision: observed.revision + 1,
        expectedSourceFingerprint: sourceFingerprint,
      }),
      migrationError('STALE_REVISION'),
    );
    await assert.rejects(
      control.beginShadow({
        connectorId: 'echo',
        expectedRevision: observed.revision,
        expectedSourceFingerprint: fingerprint('changed-underfoot'),
      }),
      migrationError('SOURCE_CHANGED'),
    );
    assert.deepEqual(await store.snapshot(), before);
  });

  it('revision-fences an owner intent or source refresh before a new shadow begins', async () => {
    const { control } = harness();
    const initialFingerprint = fingerprint('echo-v1');
    const nextFingerprint = fingerprint('echo-v2');
    const observed = await control.observe({
      connectorId: 'echo',
      sourceFingerprint: initialFingerprint,
      ownerIntent: 'enabled',
    });

    const reconciled = await control.reconcileObservation({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      sourceFingerprint: nextFingerprint,
      ownerIntent: 'disabled',
    });
    assert.equal(reconciled.revision, 2);
    assert.equal(reconciled.sourceFingerprint, nextFingerprint);
    assert.equal(reconciled.ownerIntent, 'disabled');

    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: reconciled.revision,
      expectedSourceFingerprint: nextFingerprint,
    });
    await assert.rejects(
      control.reconcileObservation({
        connectorId: 'echo',
        expectedRevision: copying.revision,
        sourceFingerprint: initialFingerprint,
        ownerIntent: 'enabled',
      }),
      migrationError('INVALID_TRANSITION'),
    );
  });

  it('records an unchanged observation as a new reconciled revision', async () => {
    const { control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({
      connectorId: 'echo',
      sourceFingerprint,
      ownerIntent: 'enabled',
    });

    const reconciled = await control.reconcileObservation({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      sourceFingerprint,
      ownerIntent: 'enabled',
    });

    assert.equal(reconciled.runtimeAuthority, 'legacy');
    assert.equal(reconciled.phase, 'observed');
    assert.equal(reconciled.revision, observed.revision + 1);
    assert.equal(reconciled.updatedAt, 1_001);
  });

  it('fences a failed Host start back to legacy before verified restore clears the shadow binding', async () => {
    const { control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' });
    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    const ready = await control.markShadowReady({
      connectorId: 'echo',
      expectedRevision: copying.revision,
      expectedSourceFingerprint: sourceFingerprint,
      hostPluginInstanceId: 'pi_echo',
      hostPackageDigest: packageDigest('echo-adapter'),
      evidenceFingerprint: fingerprint('verified migration evidence'),
    });
    const activating = await control.beginCutover({
      connectorId: 'echo',
      expectedRevision: ready.revision,
      expectedSourceFingerprint: sourceFingerprint,
      legacyRuntimeState: 'stopped',
      hostRuntimeState: 'stopped',
    });

    const rollback = await control.markHostStartFailed({
      connectorId: 'echo',
      expectedRevision: activating.revision,
      hostPluginInstanceId: 'pi_echo',
    });
    assert.equal(rollback.runtimeAuthority, 'legacy');
    assert.equal(rollback.phase, 'rollback-required');

    const restored = await control.markLegacyRestored({
      connectorId: 'echo',
      expectedRevision: rollback.revision,
      hostPluginInstanceId: 'pi_echo',
      hostRuntimeState: 'stopped',
      legacyRuntimeState: 'running',
    });
    assert.equal(restored.runtimeAuthority, 'legacy');
    assert.equal(restored.phase, 'observed');
    assert.equal(restored.hostPluginInstanceId, undefined);
    assert.equal(restored.hostPackageDigest, undefined);
    assert.equal(restored.evidenceFingerprint, undefined);
  });

  it('requires the exact Host instance and owner-intent-compatible legacy state during rollback', async () => {
    const { store, control } = harness();
    const sourceFingerprint = fingerprint('echo-v1');
    const observed = await control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'disabled' });
    const copying = await control.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    const ready = await control.markShadowReady({
      connectorId: 'echo',
      expectedRevision: copying.revision,
      expectedSourceFingerprint: sourceFingerprint,
      hostPluginInstanceId: 'pi_echo',
      hostPackageDigest: packageDigest('echo-adapter'),
      evidenceFingerprint: fingerprint('verified migration evidence'),
    });
    const activating = await control.beginCutover({
      connectorId: 'echo',
      expectedRevision: ready.revision,
      expectedSourceFingerprint: sourceFingerprint,
      legacyRuntimeState: 'stopped',
      hostRuntimeState: 'stopped',
    });
    const active = await control.markHostActive({
      connectorId: 'echo',
      expectedRevision: activating.revision,
      hostPluginInstanceId: 'pi_echo',
    });
    const before = await store.snapshot();
    await assert.rejects(
      control.beginRollback({
        connectorId: 'echo',
        expectedRevision: active.revision,
        hostPluginInstanceId: 'pi_other',
      }),
      migrationError('HOST_INSTANCE_MISMATCH'),
    );
    assert.deepEqual(await store.snapshot(), before);

    const rollback = await control.beginRollback({
      connectorId: 'echo',
      expectedRevision: active.revision,
      hostPluginInstanceId: 'pi_echo',
    });
    await assert.rejects(
      control.markLegacyRestored({
        connectorId: 'echo',
        expectedRevision: rollback.revision,
        hostPluginInstanceId: 'pi_echo',
        hostRuntimeState: 'stopped',
        legacyRuntimeState: 'running',
      }),
      migrationError('LEGACY_RUNTIME_ACTIVE'),
    );
  });
});
