import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const { buildMigrationPlan, measurePath, runDataDirsMigration } = await import(
  '../dist/config/data-dirs-migration.js'
);

function snapshotEnv() {
  return {
    DATA_DIR: process.env.DATA_DIR,
    CACHE_DIR: process.env.CACHE_DIR,
    LOG_DIR: process.env.LOG_DIR,
  };
}

function restoreEnv(snap) {
  for (const key of Object.keys(snap)) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

function clearRoots() {
  delete process.env.DATA_DIR;
  delete process.env.CACHE_DIR;
  delete process.env.LOG_DIR;
}

function plentyOfSpaceIO() {
  return {
    diskFree: async () => ({ availableBytes: 1_000_000_000_000, totalBytes: 2_000_000_000_000 }),
  };
}

function squeezedSpaceIO(availableBytes) {
  return {
    diskFree: async () => ({ availableBytes, totalBytes: availableBytes * 2 }),
  };
}

describe('data-dirs-migration', () => {
  let savedEnv;
  let workRoot;

  beforeEach(async () => {
    savedEnv = snapshotEnv();
    clearRoots();
    workRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-671-mig-'));
  });

  afterEach(async () => {
    restoreEnv(savedEnv);
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  describe('buildMigrationPlan', () => {
    test('reports no work when no root env var is set', async () => {
      const plan = await buildMigrationPlan({ repoRoot: workRoot, monorepoRoot: workRoot });
      assert.equal(plan.hasWork, false);
      assert.equal(plan.totalBytes, 0);
      const reasons = new Set(plan.items.map((i) => i.skipReason));
      assert.ok(reasons.has('root-env-not-set'));
    });

    test('skips items with no source data', async () => {
      // chdir to a clean dir so cwd-relative legacy paths (audit-logs, cli-raw-archive)
      // don't see leftover data from prior test runs in the project root.
      const cleanCwd = await mkdtemp(join(tmpdir(), 'cat-cafe-671-cwd-'));
      const originalCwd = process.cwd();
      process.chdir(cleanCwd);
      try {
        process.env.DATA_DIR = join(workRoot, 'data');
        const plan = await buildMigrationPlan({ repoRoot: workRoot, monorepoRoot: workRoot });
        assert.equal(plan.hasWork, false);
        for (const item of plan.items) {
          if (item.spec.root === 'DATA_DIR') {
            assert.ok(['no-source-data', 'legacy-equals-target'].includes(item.skipReason));
          }
        }
      } finally {
        process.chdir(originalCwd);
        await rm(cleanCwd, { recursive: true, force: true });
      }
    });

    test('detects eligible items with source data + empty target', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'fake sqlite content', 'utf-8');
      process.env.DATA_DIR = join(workRoot, 'data');

      const plan = await buildMigrationPlan({ repoRoot: workRoot, monorepoRoot: workRoot });
      assert.equal(plan.hasWork, true);
      const evidence = plan.items.find((i) => i.spec.key === 'evidenceDb');
      assert.ok(evidence);
      assert.equal(evidence.eligible, true);
      assert.ok(evidence.sourceBytes > 0);
    });

    test('skips items where target is already populated', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'fake', 'utf-8');
      const targetDb = join(workRoot, 'data', 'evidence.sqlite');
      await mkdir(join(workRoot, 'data'), { recursive: true });
      await writeFile(targetDb, 'existing target content', 'utf-8');

      process.env.DATA_DIR = join(workRoot, 'data');
      const plan = await buildMigrationPlan({ repoRoot: workRoot, monorepoRoot: workRoot });
      const evidence = plan.items.find((i) => i.spec.key === 'evidenceDb');
      assert.equal(evidence.eligible, false);
      assert.equal(evidence.skipReason, 'target-not-empty');
    });
  });

  describe('measurePath', () => {
    test('returns 0 for missing paths', async () => {
      assert.equal(await measurePath('/tmp/this-does-not-exist-671'), 0);
    });

    test('returns file size for plain files', async () => {
      const file = join(workRoot, 'sample.txt');
      await writeFile(file, 'abcdef', 'utf-8');
      assert.equal(await measurePath(file), 6);
    });

    test('includes SQLite sidecars (-wal, -shm) for *.sqlite files', async () => {
      const db = join(workRoot, 'evidence.sqlite');
      await writeFile(db, '1234567890', 'utf-8'); // 10 bytes
      await writeFile(`${db}-wal`, '12345', 'utf-8'); // 5 bytes
      await writeFile(`${db}-shm`, 'XX', 'utf-8'); // 2 bytes
      assert.equal(await measurePath(db), 17);
    });

    test('recursively sums directory contents', async () => {
      const dir = join(workRoot, 'tree');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8'); // 5
      await writeFile(join(dir, 'sub', 'b.txt'), 'world!', 'utf-8'); // 6
      assert.equal(await measurePath(dir), 11);
    });
  });

  describe('runDataDirsMigration', () => {
    test('returns attempted=false when no work pending', async () => {
      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(result.attempted, false);
      assert.equal(result.allSucceeded, true);
      assert.equal(result.restartRecommended, false);
    });

    test('migrates eligible file paths and SQLite sidecars', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'evidence-data', 'utf-8');
      await writeFile(`${legacyDb}-wal`, 'wal-data', 'utf-8');
      await writeFile(`${legacyDb}-shm`, 'shm-data', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });

      assert.equal(result.attempted, true);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      assert.ok(evidence);
      assert.equal(evidence.status, 'moved');

      // New paths exist with content
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite')), true);
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite-wal')), true);
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite-shm')), true);
      assert.equal(await readFile(join(dataRoot, 'evidence.sqlite'), 'utf-8'), 'evidence-data');

      // Legacy paths cleaned up
      assert.equal(existsSync(legacyDb), false);
      assert.equal(existsSync(`${legacyDb}-wal`), false);
      assert.equal(existsSync(`${legacyDb}-shm`), false);
    });

    test('migrates eligible directory paths recursively', async () => {
      // Set up legacy audit-logs dir relative to workRoot (acts as cwd surrogate)
      const legacyAudit = join(workRoot, 'data', 'audit-logs');
      await mkdir(legacyAudit, { recursive: true });
      await writeFile(join(legacyAudit, 'audit-2026-01-01.ndjson'), '{"a":1}\n', 'utf-8');
      await writeFile(join(legacyAudit, 'audit-2026-01-02.ndjson'), '{"b":2}\n', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      // Temporarily run from workRoot so cwd-relative legacy resolves correctly
      const originalCwd = process.cwd();
      process.chdir(workRoot);
      try {
        const result = await runDataDirsMigration({
          repoRoot: workRoot,
          monorepoRoot: workRoot,
          trigger: 'startup',
          io: plentyOfSpaceIO(),
        });
        assert.equal(result.attempted, true);
        const audit = result.items.find((i) => i.key === 'auditLogs');
        assert.equal(audit.status, 'moved');
        assert.equal(existsSync(join(dataRoot, 'audit-logs', 'audit-2026-01-01.ndjson')), true);
        assert.equal(existsSync(join(dataRoot, 'audit-logs', 'audit-2026-01-02.ndjson')), true);
        assert.equal(existsSync(legacyAudit), false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    test('aborts when disk space is insufficient — no partial moves', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'x'.repeat(1000), 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'startup',
        io: squeezedSpaceIO(500), // need ~1500, only have 500
      });

      assert.equal(result.attempted, false);
      assert.ok(result.abortedReason?.includes('insufficient-disk-space'));
      assert.equal(existsSync(legacyDb), true, 'legacy file must remain untouched on abort');
      assert.equal(existsSync(join(dataRoot, 'evidence.sqlite')), false);
    });

    test('recommends restart only for runtime trigger', async () => {
      const legacyDb = join(workRoot, 'evidence.sqlite');
      await writeFile(legacyDb, 'data', 'utf-8');
      process.env.DATA_DIR = join(workRoot, 'newdata');

      const startup = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(startup.restartRecommended, false);

      // Reset by moving file back
      await writeFile(legacyDb, 'data', 'utf-8');
      await rm(join(workRoot, 'newdata'), { recursive: true, force: true });

      const runtime = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'runtime',
        io: plentyOfSpaceIO(),
      });
      assert.equal(runtime.restartRecommended, true);
    });

    test('continues other items when one fails (per-item isolation)', async () => {
      const legacyA = join(workRoot, 'evidence.sqlite');
      const legacyB = join(workRoot, 'world.sqlite');
      await writeFile(legacyA, 'a-data', 'utf-8');
      await writeFile(legacyB, 'b-data', 'utf-8');

      const dataRoot = join(workRoot, 'newdata');
      // Pre-create the evidence target as a populated file → forces target-not-empty
      // for evidence, world should still migrate.
      await mkdir(dataRoot, { recursive: true });
      await writeFile(join(dataRoot, 'evidence.sqlite'), 'existing', 'utf-8');
      process.env.DATA_DIR = dataRoot;

      const result = await runDataDirsMigration({
        repoRoot: workRoot,
        monorepoRoot: workRoot,
        trigger: 'startup',
        io: plentyOfSpaceIO(),
      });
      assert.equal(result.attempted, true);
      const evidence = result.items.find((i) => i.key === 'evidenceDb');
      const world = result.items.find((i) => i.key === 'worldDb');
      assert.equal(evidence.status, 'skipped');
      assert.equal(evidence.reason, 'target-not-empty');
      assert.equal(world.status, 'moved');
      assert.equal(existsSync(join(dataRoot, 'world.sqlite')), true);
      assert.equal(existsSync(legacyB), false);
      // The pre-existing target evidence stays intact
      assert.equal(await readFile(join(dataRoot, 'evidence.sqlite'), 'utf-8'), 'existing');
    });
  });
});
