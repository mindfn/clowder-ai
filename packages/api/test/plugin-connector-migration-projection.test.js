import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { projectConnectorMigrationStatuses } from '../dist/domains/plugin/connector-migration/index.js';

function fingerprint(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function packageDigest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

const builtin = { id: 'feishu', source: 'builtin', configured: true };
const external = { id: 'echo', source: 'external', configured: true, fields: [{ currentValue: '••••••••' }] };

function record(overrides = {}) {
  return {
    connectorId: 'echo',
    runtimeAuthority: 'legacy',
    phase: 'shadow-ready',
    revision: 3,
    sourceFingerprint: fingerprint('secret-bearing legacy state'),
    ownerIntent: 'enabled',
    hostPluginInstanceId: 'pi_echo',
    hostPackageDigest: packageDigest('echo-host-package'),
    evidenceFingerprint: fingerprint('secret-bearing evidence'),
    updatedAt: 1_000,
    ...overrides,
  };
}

function inventory(instanceOverrides = {}) {
  return {
    instances: [
      {
        pluginInstanceId: 'pi_echo',
        pluginId: 'connector.echo',
        packageDigest: packageDigest('echo-host-package'),
        lifecycleState: 'installed',
        activationState: 'disabled',
        runtimeState: 'stopped',
        ...instanceOverrides,
      },
    ],
  };
}

describe('K-2E unified connector Settings projection', () => {
  it('leaves built-ins unchanged and defaults an unmigrated external connector to legacy authority', () => {
    const projected = projectConnectorMigrationStatuses(
      [builtin, external],
      { schemaVersion: 1, records: [] },
      { instances: [{ ...inventory().instances[0], runtimeState: 'healthy' }] },
    );

    assert.deepEqual(projected[0], builtin);
    assert.equal(projected[1].runtimeAuthority, 'legacy');
    assert.equal(projected[1].migration, undefined);
  });

  it('joins one explicit migration record without exposing source or evidence fingerprints', () => {
    const projected = projectConnectorMigrationStatuses(
      [external],
      { schemaVersion: 1, records: [record()] },
      inventory(),
    );

    assert.deepEqual(projected[0].migration, {
      phase: 'shadow-ready',
      revision: 3,
      consistency: 'ready',
      hostPluginInstanceId: 'pi_echo',
    });
    assert.equal(projected[0].runtimeAuthority, 'legacy');
    assert.doesNotMatch(JSON.stringify(projected), /sourceFingerprint|evidenceFingerprint|secret-bearing/);
  });

  it('reports missing or mismatched Host shadow truth without guessing a different authority', () => {
    const active = record({ runtimeAuthority: 'host', phase: 'active', revision: 5 });

    const missing = projectConnectorMigrationStatuses(
      [external],
      { schemaVersion: 1, records: [active] },
      { instances: [] },
    );
    assert.equal(missing[0].runtimeAuthority, 'host');
    assert.equal(missing[0].migration.consistency, 'host-instance-missing');

    const mismatched = projectConnectorMigrationStatuses(
      [external],
      { schemaVersion: 1, records: [active] },
      inventory({ packageDigest: packageDigest('other-package') }),
    );
    assert.equal(mismatched[0].runtimeAuthority, 'host');
    assert.equal(mismatched[0].migration.consistency, 'host-package-mismatch');
  });
});
