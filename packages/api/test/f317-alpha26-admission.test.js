import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateHostPluginManifest } from '../dist/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import { resolveCompanionArchiveContract } from '../dist/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { managerEntryFixture } from './f317-manager-entry.fixture.js';
import { desktopWindowManifest } from './f317-window-manifest.fixture.js';

// Exact public f303f66268ae7af115cd2fa8535405abe3125e3a release rows; no mutable next tag.
const catalogData = JSON.parse(
  await readFile(new URL('./fixtures/f317-alpha26-catalog.json', import.meta.url), 'utf8'),
);
const fixtureOptions = { catalogData, latestVersion: '0.1.0-alpha.26', previousVersion: '0.1.0-alpha.25' };
const detailPath = '/api/plugin-manager/plugins/official.companion';

test('alpha.26 joins beta.28 only at its exact archive digest while alpha.24/.25 remain admitted', () => {
  for (const release of catalogData.plugins[0].versions) {
    const archive = {
      pluginId: 'official.companion',
      version: release.version,
      packageDigest: release.artifact.integrity,
    };
    assert.equal(
      resolveCompanionArchiveContract(archive),
      release.version === '0.1.0-alpha.24' ? '0.1.0-beta.27' : '0.1.0-beta.28',
      release.version,
    );
    for (const bad of [
      { ...archive, pluginId: 'foreign.companion' },
      { ...archive, version: '0.1.0-alpha.27' },
      { ...archive, packageDigest: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    ])
      assert.equal(resolveCompanionArchiveContract(bad), undefined);
  }
});

test('alpha.26 bridge1.5 passes the existing letter structure without admitting unknown releases or bridge pairs', () => {
  const base = desktopWindowManifest(undefined, '1.3.0');
  const manifest = {
    ...base,
    pluginId: 'official.companion',
    version: '0.1.0-alpha.26',
    contributions: base.contributions.map((row) => ({ ...row, bridgeVersion: '1.5.0' })),
  };
  assert.equal(validateHostPluginManifest(manifest).valid, true);
  for (const bad of [
    { ...manifest, pluginId: 'foreign.companion' },
    { ...manifest, version: '0.1.0-alpha.27' },
    { ...manifest, contributions: manifest.contributions.map((row) => ({ ...row, bridgeVersion: '1.4.0' })) },
    { ...manifest, contributions: [...manifest.contributions, { ...manifest.contributions[0], id: 'second' }] },
    { ...manifest, runtime: { transport: 'stdio', entrypoint: 'main.js' } },
  ])
    assert.equal(validateHostPluginManifest(bad).valid, false);
});

test('production Manager installs catalog alpha.26 and rejects a stale digest before download', async (t) => {
  const f = await managerEntryFixture(t, fixtureOptions);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const row = detail.json().plugin;
  assert.equal(row.availableVersion, '0.1.0-alpha.26');
  assert.equal(row.actions.install, true);
  const payload = {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  };
  const stale = await f.request('POST', '/api/plugin-manager/plugins/install', {
    ...payload,
    expectedDigest: catalogData.plugins[0].versions.find((row) => row.version === '0.1.0-alpha.25').artifact.integrity,
  });
  assert.equal(stale.statusCode, 409, stale.payload);
  assert.deepEqual(f.downloads, []);
  const installed = await f.request('POST', '/api/plugin-manager/plugins/install', payload);
  assert.equal(installed.statusCode, 201, installed.payload);
  await f.assertVersion('0.1.0-alpha.26');
});

test('production details upgrade an installed alpha.25 in place to alpha.26 without activation', async (t) => {
  const f = await managerEntryFixture(t, fixtureOptions);
  f.setOld(true);
  const old = f.releaseEntry();
  const installed = await f.request('POST', '/api/plugins/official/companion/install', {
    expectedCatalogVersion: old.version,
    expectedPackageDigest: old.packageDigest,
  });
  assert.equal(installed.statusCode, 200, installed.payload);
  const original = await f.assertVersion('0.1.0-alpha.25');
  f.setOld(false);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  assert.equal(detail.json().plugin.installedVersion, '0.1.0-alpha.25');
  assert.equal(detail.json().plugin.availableVersion, '0.1.0-alpha.26');
  const listed = await f.request('GET', '/api/plugins/official');
  const info = listed.json().plugins.find((row) => row.pluginId === 'official.companion');
  assert.equal(info.updateAvailable, true);
  const upgraded = await f.request('POST', `/api/plugins/official/${original.pluginInstanceId}/update`, {
    expectedRevision: info.instance.lifecycleRevision,
    expectedCatalogVersion: info.availableVersion,
    expectedPackageDigest: info.packageDigest,
  });
  assert.equal(upgraded.statusCode, 200, upgraded.payload);
  assert.equal((await f.assertVersion('0.1.0-alpha.26')).pluginInstanceId, original.pluginInstanceId);
});

test('production Manager rejects changed alpha.26 archive bytes with no installed instance', async (t) => {
  const f = await managerEntryFixture(t, { ...fixtureOptions, corrupt: true });
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const row = detail.json().plugin;
  const rejected = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  });
  assert.equal(rejected.statusCode, 422, rejected.payload);
  assert.equal((await f.runtime.inventoryStore.snapshot()).instances.length, 0);
});
