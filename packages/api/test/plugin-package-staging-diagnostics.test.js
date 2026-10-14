import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const childScript = String.raw`
import { createHash } from 'node:crypto';
import { harness, catalogEntry } from './test/plugin-official-package-installer.fixture.js';
import { OfficialPluginPackageInstaller } from './dist/domains/plugin/official-package-installer.js';
import { logger } from './dist/infrastructure/logger.js';
const bytes = Buffer.from('invalid gzip fixture; archive contents must not be logged');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const fixture = await harness({ bytes, integrity });
const { packagesRoot, inventory } = fixture;
let installer = fixture.installer;
const earlyFailure = process.argv[1] === 'admission';
if (earlyFailure) {
  const blocked = packagesRoot + '/not-a-directory';
  await (await import('node:fs/promises')).writeFile(blocked, 'fixture');
  installer = new OfficialPluginPackageInstaller({
    inventory, packagesRoot: blocked, catalog: [catalogEntry(integrity)], fetchArchive: async () => bytes,
  });
}
try {
  await installer.install('feishu-meeting-intake', { version: '0.1.0-alpha.1', packageDigest: integrity });
  throw new Error('invalid archive was admitted');
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: 'outcome', code: error.code, message: error.message,
    tarCode: error.cause?.cause?.code, stderr: error.cause?.cause?.stderr,
    admissionCode: error.cause?.code }) + '\n');
} finally {
  await (await import('node:fs/promises')).rm(packagesRoot, { recursive: true, force: true });
}
logger.flush();
`;

for (const phase of ['list', 'admission']) {
  test(`archive rejection retains ${phase} diagnostics and the existing public classification`, async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'package-staging-diagnostics-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', childScript, phase],
        {
          cwd: apiRoot,
          env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', LOG_DIR: logDir, NPM_TOKEN: 'must-not-leak' },
          timeout: 15_000,
        },
      );
      const rows = stdout
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const outcome = rows.find((row) => row.kind === 'outcome');
      assert.equal(outcome.code, 'INVALID_PACKAGE_ARCHIVE');
      assert.equal(outcome.message, 'official package archive is invalid');
      if (phase === 'list') assert.ok(outcome.tarCode !== undefined, 'fixture must fail in the real tar subprocess');
      else
        assert.ok(['EEXIST', 'ENOTDIR'].includes(outcome.admissionCode), 'fixture must fail before entering staging');
      const diagnostics = rows.filter((row) => row.module === 'plugin/package-staging');
      assert.equal(diagnostics.length, 1, 'tar cause must be observable instead of disappearing behind HTTP 422');
      assert.equal(diagnostics[0].phase, phase);
      assert.equal(diagnostics[0].platform, process.platform);
      const leaf = phase === 'list' ? diagnostics[0].error.cause : diagnostics[0].error;
      assert.equal(leaf.code, phase === 'list' ? outcome.tarCode : outcome.admissionCode);
      if (phase === 'list') assert.equal(leaf.stderr, outcome.stderr.slice(0, 2048));
      assert.equal('stack' in diagnostics[0].error, false);
      assert.equal('stdout' in diagnostics[0].error, false);
      assert.equal(stdout.includes('must-not-leak'), false);
      assert.equal(stdout.includes('archive contents must not be logged'), false);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
}
