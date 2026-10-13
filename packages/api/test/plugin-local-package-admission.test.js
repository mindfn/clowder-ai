import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  FilePluginPackageQuarantineStore,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import { manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeLocalPackage(root, packageManifest = manifest(), entrypoint = '// local fixture\n') {
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'schemas'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`, 'utf8');
  await writeFile(join(root, 'dist/entrypoint.js'), entrypoint, 'utf8');
  await writeFile(
    join(root, 'schemas/official.test.v1.schema.json'),
    `${JSON.stringify({
      type: 'object',
      properties: { payload: { type: 'object' }, source: { type: 'object' } },
      required: ['payload', 'source'],
    })}\n`,
    'utf8',
  );
}

async function harness({ quarantine = false, grantPolicy } = {}) {
  const packagesRoot = await tempRoot('cat-cafe-f202-local-packages-');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_local',
    now: () => 12_000,
  });
  const quarantineStore = quarantine
    ? new FilePluginPackageQuarantineStore(join(packagesRoot, 'quarantines.json'), { now: () => 12_000 })
    : undefined;
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot,
    grantPolicy:
      grantPolicy ??
      (async (packageManifest) => packageManifest.features.flatMap((feature) => [...feature.capabilities])),
    ...(quarantineStore ? { quarantine: quarantineStore } : {}),
  });
  return { admission, inventory, packagesRoot, store, quarantines: quarantineStore };
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarEntry({ name, body = Buffer.alloc(0), type = '0', linkName = '' }) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(body.byteLength, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

function maliciousArchive(entries) {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024, 0)]));
}

test('admits a local npm-style archive into immutable Host inventory without executing its entrypoint', async () => {
  const sideEffect = join(await tempRoot('cat-cafe-f202-local-side-effect-'), 'executed');
  const archive = await packageArchive({
    packageManifest: manifest(),
  });
  const archivePath = join(await tempRoot('cat-cafe-f202-local-archive-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, packagesRoot, store } = await harness();

  const result = await admission.install({ kind: 'local-archive', path: archivePath });

  assert.equal(result.pluginId, 'official.test-source');
  assert.equal(result.pluginInstanceId, 'pi_local');
  assert.equal(result.packageDigest, archive.integrity);
  await access(join(packagesRoot, packageDirectoryName(archive.integrity), 'package.tgz'));
  await assert.rejects(access(sideEffect), { code: 'ENOENT' });
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.grants[0].effectiveGrants, ['events.publish']);
  assert.equal(snapshot.packages[0].packageState, 'installed');
  assert.deepEqual(snapshot.packages[0].provenance, {
    kind: 'local-archive',
    packageName: '@clowder-ai/official-test-source',
  });
});

test('copies a local directory into an immutable canonical archive before inventory admission', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-');
  const sideEffect = join(sourceRoot, 'entrypoint-executed');
  await writeLocalPackage(
    sourceRoot,
    manifest(),
    `await import('node:fs/promises').then(({ writeFile }) => writeFile(${JSON.stringify(sideEffect)}, 'bad'));\n`,
  );
  const { admission, packagesRoot, store } = await harness();

  const result = await admission.install({ kind: 'local-directory', path: sourceRoot });

  assert.equal(result.pluginId, 'official.test-source');
  assert.equal(result.pluginInstanceId, 'pi_local');
  assert.match(result.packageDigest, /^sha512-[A-Za-z0-9+/]{86}==$/);
  await access(join(packagesRoot, packageDirectoryName(result.packageDigest), 'package.tgz'));
  await assert.rejects(access(sideEffect), { code: 'ENOENT' });
  assert.equal((await store.snapshot()).instances.length, 1);
});

test('quarantines a local package rejected by Host grant admission', async () => {
  const archive = await packageArchive();
  const archivePath = join(await tempRoot('cat-cafe-f202-local-invalid-grant-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, store, quarantines } = await harness({
    quarantine: true,
    grantPolicy: async () => ['secret.read'],
  });

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVENTORY_REJECTED',
  );

  assert.equal((await store.snapshot()).instances.length, 0);
  const [rejected] = await quarantines.list();
  assert.equal(rejected.packageDigest, archive.integrity);
  assert.equal(rejected.failure.code, 'INVALID_GRANT');
});

test('rejects a traversal archive before publishing bytes or mutating inventory', async () => {
  const archivePath = join(await tempRoot('cat-cafe-f202-local-traversal-'), 'traversal.tgz');
  const bytes = maliciousArchive([
    { name: 'package/', type: '5' },
    { name: 'package/../../escape', body: Buffer.from('escaped') },
  ]);
  await writeFile(archivePath, bytes);
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const { admission, packagesRoot, store, quarantines } = await harness({ quarantine: true });

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVALID_PACKAGE_ARCHIVE',
  );
  await assert.rejects(access(join(packagesRoot, packageDirectoryName(digest), 'package.tgz')));
  assert.equal((await store.snapshot()).instances.length, 0);
  const [rejected] = await quarantines.list();
  assert.equal(rejected.packageDigest, digest);
  assert.equal(rejected.failure.code, 'INVALID_PACKAGE_ARCHIVE');
  assert.deepEqual(rejected.source, { kind: 'local-archive' });
});

test('rejects archive symlinks before extraction can escape the private stage', async () => {
  const externalRoot = await tempRoot('cat-cafe-f202-local-symlink-target-');
  const escapedPath = join(externalRoot, 'escaped');
  const archivePath = join(await tempRoot('cat-cafe-f202-local-symlink-'), 'symlink.tgz');
  const bytes = maliciousArchive([
    { name: 'package/', type: '5' },
    { name: 'package/link', type: '2', linkName: externalRoot },
    { name: 'package/link/escaped', body: Buffer.from('escaped') },
  ]);
  await writeFile(archivePath, bytes);
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-archive', path: archivePath }),
    (error) => error?.code === 'INVALID_PACKAGE_ARCHIVE',
  );
  await assert.rejects(access(escapedPath), { code: 'ENOENT' });
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('rejects local directory symlinks without reading or packaging their target', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-symlink-');
  const externalRoot = await tempRoot('cat-cafe-f202-local-directory-external-');
  await writeLocalPackage(sourceRoot);
  await writeFile(join(externalRoot, 'secret'), 'private', 'utf8');
  await symlink(externalRoot, join(sourceRoot, 'linked'));
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('refuses an unproven pnpm physical dependency tree before admission', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-directory-pnpm-');
  await writeLocalPackage(sourceRoot);
  const packageStore = join(sourceRoot, 'node_modules', '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture');
  await mkdir(packageStore, { recursive: true });
  await writeFile(join(packageStore, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(
    join(sourceRoot, 'package.json'),
    '{"name":"@clowder-ai/official-test-source","version":"1.0.0","dependencies":{"fixture":"1.0.0"}}\n',
  );
  await symlink('.pnpm/fixture@1.0.0/node_modules/fixture', join(sourceRoot, 'node_modules', 'fixture'));
  const { admission, store } = await harness();
  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_LOCAL_SOURCE' && error.cause?.code === 'DEPENDENCY_LOCK_MISSING',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('records shipped or materialized closure for immutable owner archives', async () => {
  const packageJson = JSON.stringify({
    name: '@clowder-ai/official-test-source',
    version: '1.0.0',
    dependencies: { fixture: '1.0.0' },
  });
  for (const closure of ['shipped', 'materialized']) {
    const archive = await packageArchive({
      extraFiles: {
        'package.json': packageJson,
        ...(closure === 'shipped'
          ? { 'node_modules/fixture/package.json': '{"name":"fixture","version":"1.0.0"}' }
          : {}),
      },
    });
    const archivePath = join(await tempRoot('cat-cafe-f202-local-closure-'), 'package.tgz');
    await writeFile(archivePath, archive.bytes);
    const { admission, store } = await harness();
    await admission.install({ kind: 'local-archive', path: archivePath });
    assert.equal((await store.snapshot()).packages[0].provenance.dependencyClosure, closure);
  }
});

test('rejects manifest/schema mismatch with zero inventory mutation', async () => {
  const sourceRoot = await tempRoot('cat-cafe-f202-local-schema-mismatch-');
  await writeLocalPackage(sourceRoot);
  await rm(join(sourceRoot, 'schemas/official.test.v1.schema.json'));
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error?.code === 'INVALID_PACKAGE_SCHEMA',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('rejects a source that changes its archive digest before admission', async () => {
  const archive = await packageArchive();
  const archivePath = join(await tempRoot('cat-cafe-f202-local-digest-race-'), 'plugin.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, store } = await harness();

  await assert.rejects(
    admission.install(
      { kind: 'local-archive', path: archivePath },
      { expectedDigest: `sha512-${createHash('sha512').update('different').digest('base64')}` },
    ),
    (error) => error?.code === 'PACKAGE_DIGEST_MISMATCH',
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('owner directory reselection upgrades a failed stopped instance without discarding history or data', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-');
  await writeLocalPackage(sourceRoot);
  const { admission, packagesRoot, store } = await harness();
  const first = await admission.install({ kind: 'local-directory', path: sourceRoot });
  const error = { code: 'UNEXPECTED_RUNTIME_FAILURE', exitCode: 1, signal: null, occurredAt: 12000 };
  await store.transaction((tx) => {
    const instance = tx.instances.get(first.pluginInstanceId);
    tx.instances.put({ ...instance, activationState: 'error', lastRuntimeError: error });
  });
  const before = await store.snapshot();
  const dataFile = join(packagesRoot, 'owner-data-kept');
  await writeFile(dataFile, 'retained');
  await writeFile(join(sourceRoot, 'dist/entrypoint.js'), '// repaired local module\n');
  const updated = await admission.install({ kind: 'local-directory', path: sourceRoot });
  const after = await store.snapshot();
  assert.equal(updated.pluginInstanceId, first.pluginInstanceId);
  assert.notEqual(updated.packageDigest, first.packageDigest);
  assert.equal(after.instances.length, 1);
  assert.equal(after.instances[0].installedAt, before.instances[0].installedAt);
  assert.equal(after.instances[0].lifecycleRevision, before.instances[0].lifecycleRevision + 1);
  assert.deepEqual(after.instances[0].lastRuntimeError, error);
  assert.equal(after.grants[0].grantRevision, before.grants[0].grantRevision + 1);
  assert.ok(after.packages.some((p) => p.packageDigest === first.packageDigest));
  await access(join(packagesRoot, packageDirectoryName(first.packageDigest), 'package.tgz'));
  assert.equal(await readFile(dataFile, 'utf8'), 'retained');
});

test('directory reselection cannot replace a running instance', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-running-');
  await writeLocalPackage(sourceRoot);
  const { admission, store } = await harness();
  const installed = await admission.install({ kind: 'local-directory', path: sourceRoot });
  await store.transaction((tx) => {
    tx.instances.put({
      ...tx.instances.get(installed.pluginInstanceId),
      runtimeState: 'healthy',
      activationState: 'enabled',
    });
  });
  const before = await store.snapshot();
  await writeFile(join(sourceRoot, 'dist/entrypoint.js'), '// update\n');
  await assert.rejects(
    admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVENTORY_REJECTED' && error.cause?.code === 'RUNTIME_NOT_STOPPED',
  );
  assert.deepEqual(await store.snapshot(), before);
});

test('directory update retains the request-start grant fence while source verification is in flight', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-grant-');
  await writeLocalPackage(sourceRoot);
  let revoke = false;
  const h = await harness({
    grantPolicy: async () => {
      if (revoke)
        await h.inventory.revokeGrant({
          pluginInstanceId: 'pi_local',
          capability: 'events.publish',
          expectedGrantRevision: 1,
        });
      return ['events.publish'];
    },
  });
  const first = await h.admission.install({ kind: 'local-directory', path: sourceRoot });
  revoke = true;
  await writeFile(join(sourceRoot, 'dist/entrypoint.js'), '// update\n');
  await assert.rejects(
    h.admission.install({ kind: 'local-directory', path: sourceRoot }),
    (error) => error.code === 'INVENTORY_REJECTED' && error.cause?.code === 'STALE_GRANT_REVISION',
  );
  const after = await h.store.snapshot();
  assert.equal(after.instances[0].packageDigest, first.packageDigest);
  assert.equal(after.grants[0].grantRevision, 2);
  assert.deepEqual(after.grants[0].effectiveGrants, []);
});

test('directory reselection does not silently take over an archive-origin instance', async () => {
  const sourceRoot = await tempRoot('cat-cafe-local-update-origin-');
  await writeLocalPackage(sourceRoot);
  const archive = await packageArchive();
  const archivePath = join(await tempRoot('cat-cafe-local-update-archive-'), 'package.tgz');
  await writeFile(archivePath, archive.bytes);
  const { admission, store } = await harness();
  await admission.install({ kind: 'local-archive', path: archivePath });
  const before = await store.snapshot();
  await assert.rejects(admission.install({ kind: 'local-directory', path: sourceRoot }), {
    code: 'INVENTORY_REJECTED',
  });
  assert.deepEqual(await store.snapshot(), before);
});
