import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_PACKAGE_ARCHIVES } from '../dist/domains/plugin/bundled-package-index.js';

// The compiled Host registration is the complete allowlist, independent of the build caller's cwd.
for (const record of Object.values(BUNDLED_PACKAGE_ARCHIVES)) {
  const source = new URL(`../src/domains/plugin/bundled-packages/${record.archivePath}`, import.meta.url);
  const target = new URL(`../dist/domains/plugin/bundled-packages/${record.archivePath}`, import.meta.url);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('bundled release must be a regular archive');
  const bytes = await readFile(source);
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (digest !== record.packageDigest) throw new Error(`bundled release integrity mismatch: ${record.catalogId}`);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await copyFile(source, target);
  const copiedDigest = `sha512-${createHash('sha512')
    .update(await readFile(target))
    .digest('base64')}`;
  if (copiedDigest !== record.packageDigest) throw new Error('copied bundled release integrity mismatch');
}
