import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ConnectorMigrationControlPlane,
  FileConnectorMigrationStore,
} from '../dist/domains/plugin/connector-migration/index.js';

function fingerprint(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function packageDigest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function pathFor(name) {
  return join(await mkdtemp(join(tmpdir(), `connector-migration-${name}-`)), 'migration.json');
}

async function shadowReady(control, sourceFingerprint = fingerprint('echo-source')) {
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
    hostPackageDigest: packageDigest('echo-host-package'),
    evidenceFingerprint: fingerprint('echo-data-evidence'),
  });
  return { sourceFingerprint, ready };
}

describe('K-2E connector migration restart truth', () => {
  it('persists atomically and reloads a stable shadow without changing authority', async () => {
    const path = await pathFor('stable');
    const first = new ConnectorMigrationControlPlane(new FileConnectorMigrationStore(path), { now: () => 1_000 });
    const { ready } = await shadowReady(first);

    const restartedStore = new FileConnectorMigrationStore(path);
    const restarted = new ConnectorMigrationControlPlane(restartedStore, { now: () => 2_000 });

    assert.equal(await restarted.recoverAfterRestart(), 0);
    assert.deepEqual((await restartedStore.snapshot()).records, [ready]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 1);
  });

  it('normalizes interrupted copy to legacy authority and permits a clean retry', async () => {
    const path = await pathFor('copying');
    const sourceFingerprint = fingerprint('echo-source');
    const store = new FileConnectorMigrationStore(path);
    const first = new ConnectorMigrationControlPlane(store, { now: () => 1_000 });
    const observed = await first.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' });
    await first.beginShadow({
      connectorId: 'echo',
      expectedRevision: observed.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });

    const restarted = new ConnectorMigrationControlPlane(new FileConnectorMigrationStore(path), { now: () => 2_000 });
    assert.equal(await restarted.recoverAfterRestart(), 1);
    const interrupted = (await restarted.store.snapshot()).records[0];
    assert.equal(interrupted.runtimeAuthority, 'legacy');
    assert.equal(interrupted.phase, 'interrupted');
    assert.equal(interrupted.hostPluginInstanceId, undefined);

    const retry = await restarted.beginShadow({
      connectorId: 'echo',
      expectedRevision: interrupted.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    assert.equal(retry.phase, 'copying');
  });

  it('fences an interrupted Host activation back to legacy and clears old shadow binding on retry', async () => {
    const path = await pathFor('activating');
    const store = new FileConnectorMigrationStore(path);
    const first = new ConnectorMigrationControlPlane(store, { now: () => 1_000 });
    const { sourceFingerprint, ready } = await shadowReady(first);
    await first.beginCutover({
      connectorId: 'echo',
      expectedRevision: ready.revision,
      expectedSourceFingerprint: sourceFingerprint,
      legacyRuntimeState: 'stopped',
      hostRuntimeState: 'stopped',
    });

    const restarted = new ConnectorMigrationControlPlane(new FileConnectorMigrationStore(path), { now: () => 2_000 });
    assert.equal(await restarted.recoverAfterRestart(), 1);
    const interrupted = (await restarted.store.snapshot()).records[0];
    assert.equal(interrupted.runtimeAuthority, 'legacy');
    assert.equal(interrupted.phase, 'interrupted');
    assert.equal(interrupted.hostPluginInstanceId, 'pi_echo');

    const retry = await restarted.beginShadow({
      connectorId: 'echo',
      expectedRevision: interrupted.revision,
      expectedSourceFingerprint: sourceFingerprint,
    });
    assert.equal(retry.phase, 'copying');
    assert.equal(retry.hostPluginInstanceId, undefined);
    assert.equal(retry.hostPackageDigest, undefined);
    assert.equal(retry.evidenceFingerprint, undefined);
  });

  it('fails closed on corrupt, future, and open-schema snapshots', async () => {
    const corruptPath = await pathFor('corrupt');
    const futurePath = await pathFor('future');
    const openPath = await pathFor('open');
    await writeFile(corruptPath, '{not-json');
    await writeFile(futurePath, JSON.stringify({ schemaVersion: 99, records: [] }));
    await writeFile(openPath, JSON.stringify({ schemaVersion: 1, records: [], rawSecret: 'must-not-pass' }));

    await assert.rejects(
      () => new FileConnectorMigrationStore(corruptPath).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
    await assert.rejects(
      () => new FileConnectorMigrationStore(futurePath).snapshot(),
      (error) => error?.code === 'UNSUPPORTED_SCHEMA',
    );
    await assert.rejects(
      () => new FileConnectorMigrationStore(openPath).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
  });

  it('rejects a partially bound interrupted snapshot', async () => {
    const path = await pathFor('partial-interrupted-binding');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            connectorId: 'echo',
            runtimeAuthority: 'legacy',
            phase: 'interrupted',
            revision: 4,
            sourceFingerprint: fingerprint('echo-source'),
            ownerIntent: 'enabled',
            hostPluginInstanceId: 'pi_echo',
            updatedAt: 1_000,
          },
        ],
      }),
    );

    await assert.rejects(
      () => new FileConnectorMigrationStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
  });

  it('does not publish a candidate snapshot when atomic rename fails', async () => {
    const path = await pathFor('rename-failure');
    const sourceFingerprint = fingerprint('echo-source');
    const store = new FileConnectorMigrationStore(path, {
      fileOps: {
        rename: async () => {
          const error = new Error('injected rename failure');
          error.code = 'EIO';
          throw error;
        },
      },
    });
    const control = new ConnectorMigrationControlPlane(store);

    await assert.rejects(
      control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' }),
      /injected rename failure/,
    );
    await assert.rejects(
      () => readFile(path, 'utf8'),
      (error) => error?.code === 'ENOENT',
    );
    assert.deepEqual(await readdir(new URL('.', `file://${path}`)), []);
  });

  it('removes a partial temporary file when the write fails', async () => {
    const path = await pathFor('write-failure');
    const sourceFingerprint = fingerprint('echo-source');
    const store = new FileConnectorMigrationStore(path, {
      fileOps: {
        writeFile: async (temporaryPath, data, options) => {
          await writeFile(temporaryPath, data, options);
          const error = new Error('injected write failure');
          error.code = 'EIO';
          throw error;
        },
      },
    });
    const control = new ConnectorMigrationControlPlane(store);

    await assert.rejects(
      control.observe({ connectorId: 'echo', sourceFingerprint, ownerIntent: 'enabled' }),
      /injected write failure/,
    );
    assert.deepEqual(await readdir(new URL('.', `file://${path}`)), []);
  });
});
