import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { generateBundledPluginArtifacts } from '../scripts/bundled-plugin-artifacts.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bundled-artifact-encoding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginRoot = pathToFileURL(`${directory}/`);
  const packagePath = join(directory, 'bundled-packages/fixture/1.0.0');
  await mkdir(join(packagePath, 'assets'), { recursive: true });
  await writeFile(
    join(packagePath, 'assets/icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  );
  const definitions = [
    {
      catalogId: 'fixture',
      manifest: { pluginId: 'fixture.plugin', version: '1.0.0', icon: { src: 'assets/icon.svg' } },
    },
  ];
  await generateBundledPluginArtifacts(pluginRoot, definitions);
  return {
    archivePath: join(packagePath, 'package.tgz'),
    indexPath: join(directory, 'bundled-package-index.ts'),
    manifestPath: join(packagePath, 'manifest.json'),
    check: () => generateBundledPluginArtifacts(pluginRoot, definitions, { check: true }),
  };
}

const digest = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

async function replaceArchive(f, bytes, updateDigest = true) {
  const previous = await readFile(f.archivePath);
  await writeFile(f.archivePath, bytes);
  if (updateDigest) {
    const index = await readFile(f.indexPath, 'utf8');
    assert.ok(index.includes(digest(previous)));
    await writeFile(f.indexPath, index.replace(digest(previous), digest(bytes)));
  }
}

test('canonical inputs and the actual archive SRI accept another valid gzip encoding without rewriting it', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.archivePath);
  // Real macOS/Linux Node zlib versions encode the identical USTAR differently.
  const encoded = gzipSync(gunzipSync(original), { level: 0 });
  encoded[9] = original[9] === 3 ? 19 : 3;
  assert.notDeepEqual(encoded, original);
  assert.deepEqual(gunzipSync(encoded), gunzipSync(original));
  await replaceArchive(f, encoded);
  const before = await Promise.all([f.archivePath, f.indexPath, f.manifestPath].map((path) => readFile(path)));
  await f.check();
  const after = await Promise.all([f.archivePath, f.indexPath, f.manifestPath].map((path) => readFile(path)));
  assert.deepEqual(after, before, 'checking must not rewrite installed archive identity or generated inputs');
});

test('an unchanged payload cannot excuse a stale archive SRI', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.archivePath);
  const encoded = gzipSync(gunzipSync(original), { level: 0 });
  await replaceArchive(f, encoded, false);
  await assert.rejects(f.check(), /stale bundled artifact: .*bundled-package-index\.ts/);
});

test('a changed canonical asset is rejected even when the archive SRI is refreshed', async (t) => {
  const f = await fixture(t);
  const tar = gunzipSync(await readFile(f.archivePath));
  tar[512] ^= 1;
  await replaceArchive(f, gzipSync(tar));
  await assert.rejects(f.check(), /stale bundled artifact: .*package\.tgz/);
});

test('extra decoded bytes are rejected even when the archive SRI is refreshed', async (t) => {
  const f = await fixture(t);
  const tar = gunzipSync(await readFile(f.archivePath));
  await replaceArchive(f, gzipSync(Buffer.concat([tar, Buffer.from('unowned tail')])));
  await assert.rejects(f.check(), { code: 'ERR_BUFFER_TOO_LARGE' });
});

test('invalid gzip does not become a valid artifact by updating its SRI', async (t) => {
  const f = await fixture(t);
  await replaceArchive(f, Buffer.from('not a gzip archive'));
  await assert.rejects(f.check());
});
