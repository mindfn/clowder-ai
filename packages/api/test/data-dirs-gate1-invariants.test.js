/**
 * F770 Gate 1 invariants — data-dirs resolver freeze.
 *
 * Why: Gate 1 collapsed the five legacy per-path env knobs
 * (AUDIT_LOG_DIR, CLI_RAW_ARCHIVE_DIR, CONNECTOR_MEDIA_DIR,
 * TRANSCRIPT_DATA_DIR, UPLOAD_DIR) into fixed derivations under the
 * DATA_DIR/CACHE_DIR roots, and kept TTS_CACHE_DIR as a deprecated
 * compatibility override. These tests pin the resolver to the exact
 * pre-collapse behavior so the mechanical refactor cannot silently move
 * any of the 12 data items:
 *
 *  1. With no root env vars set, every resolved path must equal the
 *     pre-change (baseline) resolver output, the five dead knobs must be
 *     ignored even when set, and the migration plan must be a no-op.
 *  2. With DATA_DIR=X set, all 12 data items must land exactly where the
 *     pre-change resolver put them for the same input — not merely
 *     "somewhere under X".
 *
 * The baseline below is a frozen copy of packages/api/src/config/data-dirs.ts
 * as it was BEFORE the Gate 1 collapse (verified against the old dist build
 * during the refactor; the pre-change resolver never read the five knobs,
 * so the only intentional behavioral addition — the TTS_CACHE_DIR override —
 * is exercised in document-listen-paths.test.js and excluded here by always
 * running with TTS_CACHE_DIR unset).
 */

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { describeDataPaths } = await import('../dist/config/data-dirs.js');
const { buildMigrationPlan } = await import('../dist/config/data-dirs-migration.js');

// --- frozen pre-collapse baseline (copy of the old data-dirs.ts logic) -----

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OLD_MODULE_DEFAULT_UPLOAD_DIR = resolve(TEST_DIR, '../uploads');

function oldReadRoot(name) {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? resolve(raw) : undefined;
}
function oldJoin(root, sub) {
  return resolve(root, sub);
}

function oldEvidenceDb(repoRoot) {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'evidence.sqlite') : resolve(repoRoot, 'evidence.sqlite');
}
function oldWorldDb(repoRoot) {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'world.sqlite') : resolve(repoRoot, 'world.sqlite');
}
function oldTranscripts(monorepoRoot) {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'transcripts') : resolve(monorepoRoot, 'data/transcripts');
}
function oldAuditLogs() {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'audit-logs') : resolve(process.cwd(), 'data/audit-logs');
}
function oldCliRawArchive() {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'cli-raw-archive') : resolve(process.cwd(), 'data/cli-raw-archive');
}
function oldUploads() {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'uploads') : OLD_MODULE_DEFAULT_UPLOAD_DIR;
}
function oldCatCafeState(projectRoot) {
  const root = oldReadRoot('DATA_DIR');
  return root ? oldJoin(root, 'cat-cafe') : resolve(projectRoot, '.cat-cafe');
}
function oldRedisData() {
  const root = oldReadRoot('DATA_DIR');
  if (root) return oldJoin(root, 'redis');
  return process.env.REDIS_DATA_DIR || resolve(homedir(), '.cat-cafe/redis-dev');
}
function oldRedisBackups() {
  const root = oldReadRoot('DATA_DIR');
  if (root) return oldJoin(root, 'redis-backups');
  return process.env.REDIS_BACKUP_DIR || resolve(homedir(), '.cat-cafe/redis-backups/dev');
}
function oldTtsCache() {
  const root = oldReadRoot('CACHE_DIR');
  return root ? oldJoin(root, 'tts') : resolve(process.cwd(), 'data/tts-cache');
}
function oldConnectorMedia() {
  const root = oldReadRoot('CACHE_DIR');
  return root ? oldJoin(root, 'connector-media') : resolve(process.cwd(), 'data/connector-media');
}
function oldLogs() {
  const root = oldReadRoot('LOG_DIR');
  return root ?? resolve(process.cwd(), 'data/logs/api');
}

/** key → [rootEnv, subPath] for the 12 data items. */
const ITEMS = {
  evidenceDb: ['DATA_DIR', 'evidence.sqlite'],
  worldDb: ['DATA_DIR', 'world.sqlite'],
  transcripts: ['DATA_DIR', 'transcripts'],
  auditLogs: ['DATA_DIR', 'audit-logs'],
  cliRawArchive: ['DATA_DIR', 'cli-raw-archive'],
  uploads: ['DATA_DIR', 'uploads'],
  catCafeState: ['DATA_DIR', 'cat-cafe'],
  redisData: ['DATA_DIR', 'redis'],
  redisBackups: ['DATA_DIR', 'redis-backups'],
  ttsCache: ['CACHE_DIR', 'tts'],
  connectorMedia: ['CACHE_DIR', 'connector-media'],
  logs: ['LOG_DIR', ''],
};

function expectedCurrentPaths(repoRoot, monorepoRoot) {
  return {
    evidenceDb: oldEvidenceDb(repoRoot),
    worldDb: oldWorldDb(repoRoot),
    transcripts: oldTranscripts(monorepoRoot),
    auditLogs: oldAuditLogs(),
    cliRawArchive: oldCliRawArchive(),
    uploads: oldUploads(),
    catCafeState: oldCatCafeState(repoRoot),
    redisData: oldRedisData(),
    redisBackups: oldRedisBackups(),
    ttsCache: oldTtsCache(),
    connectorMedia: oldConnectorMedia(),
    logs: oldLogs(),
  };
}

const REPO_ROOT = resolve('/tmp', 'f770-invariant-fake-repo');
const MONOREPO_ROOT = resolve('/tmp', 'f770-invariant-fake-mono');
const DATA_ROOT = resolve('/tmp', 'f770-invariant-fake-data');
const CACHE_ROOT = resolve('/tmp', 'f770-invariant-fake-cache');

const ENV_KEYS = [
  'DATA_DIR',
  'CACHE_DIR',
  'LOG_DIR',
  'TTS_CACHE_DIR',
  'AUDIT_LOG_DIR',
  'CLI_RAW_ARCHIVE_DIR',
  'CONNECTOR_MEDIA_DIR',
  'TRANSCRIPT_DATA_DIR',
  'UPLOAD_DIR',
  'REDIS_DATA_DIR',
  'REDIS_BACKUP_DIR',
];

const savedEnv = {};

function clearEnv() {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function specsByKey() {
  const specs = describeDataPaths({ repoRoot: REPO_ROOT, monorepoRoot: MONOREPO_ROOT });
  return Object.fromEntries(specs.map((s) => [s.key, s]));
}

function assertMatchesBaseline(label) {
  const specs = specsByKey();
  const expected = expectedCurrentPaths(REPO_ROOT, MONOREPO_ROOT);
  for (const [key, currentPath] of Object.entries(expected)) {
    assert.equal(
      specs[key].currentPath,
      currentPath,
      `${label}: ${key}.currentPath drifted from pre-collapse baseline`,
    );
  }
  return { specs, expected };
}

describe('F770 Gate 1 data-dirs invariants', () => {
  before(clearEnv);
  after(restoreEnv);

  it('default config: output identical to pre-collapse baseline, dead knobs ignored, migration no-op', async () => {
    // The five collapsed knobs are dead: setting them must not move anything.
    for (const dead of [
      'AUDIT_LOG_DIR',
      'CLI_RAW_ARCHIVE_DIR',
      'CONNECTOR_MEDIA_DIR',
      'TRANSCRIPT_DATA_DIR',
      'UPLOAD_DIR',
    ]) {
      process.env[dead] = resolve('/tmp', `f770-dead-${dead.toLowerCase()}`);
    }

    const { specs, expected } = assertMatchesBaseline('clean env');

    // rootBasedPath must be null for every item when no root is set …
    for (const [key, spec] of Object.entries(specs)) {
      assert.equal(spec.rootBasedPath, null, `clean env: ${key}.rootBasedPath should be null`);
      assert.equal(spec.legacyPath, expected[key], `clean env: ${key}.legacyPath should equal the active path`);
    }
    // … and the uploads legacy default stays the module-relative one.
    assert.equal(specs.uploads.legacyPath, OLD_MODULE_DEFAULT_UPLOAD_DIR);

    // Migration must be an empty plan with default config.
    const plan = await buildMigrationPlan({ repoRoot: REPO_ROOT, monorepoRoot: MONOREPO_ROOT });
    assert.equal(plan.hasWork, false, 'migration must be a no-op with default config');
    for (const item of plan.items) {
      assert.equal(item.eligible, false, `migration item ${item.spec.key} must not be eligible`);
    }

    for (const dead of [
      'AUDIT_LOG_DIR',
      'CLI_RAW_ARCHIVE_DIR',
      'CONNECTOR_MEDIA_DIR',
      'TRANSCRIPT_DATA_DIR',
      'UPLOAD_DIR',
    ]) {
      delete process.env[dead];
    }
  });

  it('DATA_DIR=X: all 12 data items land exactly where the pre-collapse resolver put them', async () => {
    process.env.DATA_DIR = DATA_ROOT;

    const { specs } = assertMatchesBaseline('DATA_DIR set');

    for (const [key, spec] of Object.entries(specs)) {
      const [rootEnv, subPath] = ITEMS[key];
      if (rootEnv === 'DATA_DIR') {
        assert.equal(spec.rootBasedPath, resolve(DATA_ROOT, subPath), `${key}.rootBasedPath should be under DATA_DIR`);
      } else {
        assert.equal(spec.rootBasedPath, null, `${key} is governed by ${rootEnv}, not DATA_DIR`);
      }
    }

    delete process.env.DATA_DIR;
  });

  it('CACHE_DIR=Y: cache items match the pre-collapse resolver exactly', () => {
    process.env.DATA_DIR = DATA_ROOT;
    process.env.CACHE_DIR = CACHE_ROOT;

    const { expected } = assertMatchesBaseline('DATA_DIR + CACHE_DIR');
    assert.equal(expected.ttsCache, resolve(CACHE_ROOT, 'tts'));
    assert.equal(expected.connectorMedia, resolve(CACHE_ROOT, 'connector-media'));

    delete process.env.DATA_DIR;
    delete process.env.CACHE_DIR;
  });
});
