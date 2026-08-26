import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isM0dAcceptancePassed, runM0dJointAcceptance } from './plugin-m0d-joint-runner.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const acceptanceCli = resolve(import.meta.dirname, '../scripts/m0d-joint-acceptance.mjs');
const frozenHostReviewedSha = '016a7767065a58cdebe08b39a416aba3174429cb';
const frozenHostMergeSha = '31105179e1da9b365709c00f0f925e4247e7f3d8';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function packageRoot(specifier, levels) {
  let root = fileURLToPath(import.meta.resolve(specifier));
  for (let index = 0; index < levels; index += 1) root = dirname(root);
  return root;
}

async function metadataOnlyPluginsRepository() {
  const root = await mkdtemp(join(tmpdir(), 'm0d-metadata-only-plugins-'));
  const contractRoot = packageRoot('@clowder-ai/plugin-contract/conformance', 3);
  const sdkRoot = packageRoot('@clowder-ai/plugin-sdk', 2);
  const fixtureDirectory = join(root, 'packages/plugin-contract/fixtures/behavior/messaging');
  await Promise.all([
    mkdir(fixtureDirectory, { recursive: true }),
    mkdir(join(root, 'packages/plugin-sdk/src'), { recursive: true }),
    mkdir(join(root, 'packages/plugin-contract/src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'packages/plugin-contract/package.json'), await readFile(join(contractRoot, 'package.json'))),
    writeFile(join(root, 'packages/plugin-sdk/package.json'), await readFile(join(sdkRoot, 'package.json'))),
    writeFile(
      join(fixtureDirectory, 'adversarial-invariants.json'),
      await readFile(
        fileURLToPath(
          import.meta.resolve('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants'),
        ),
      ),
    ),
    writeFile(
      join(root, 'packages/plugin-contract/src/index.ts'),
      "export const implementation = 'not-the-loaded-contract';\n",
    ),
    writeFile(join(root, 'packages/plugin-sdk/src/index.ts'), "export const implementation = 'not-the-loaded-sdk';\n"),
  ]);
  git(['init', '--quiet'], root);
  git(['config', 'user.name', 'M0D test'], root);
  git(['config', 'user.email', 'm0d-test@example.invalid'], root);
  git(['add', '.'], root);
  git(['commit', '--quiet', '-m', 'test fixture'], root);
  return { root, sha: git(['rev-parse', 'HEAD'], root) };
}

function runAcceptance(plugins, acceptanceReviewedSha) {
  return spawnSync(
    process.execPath,
    [
      acceptanceCli,
      '--plugins-repository',
      plugins.root,
      '--plugins-sha',
      plugins.sha,
      '--host-reviewed-sha',
      frozenHostReviewedSha,
      '--host-merge-sha',
      frozenHostMergeSha,
      '--host-acceptance-reviewed-sha',
      acceptanceReviewedSha,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1' },
      timeout: 120_000,
    },
  );
}

test('published M0 behavior catalog reports the real frozen Host execution boundary', async () => {
  const report = await runM0dJointAcceptance();
  assert.equal(report.catalog.catalogMatches, true);
  assert.equal(report.catalog.count, 18);
  assert.equal(report.counts['schema-incompatible-at-frozen-sha'], 3);
  assert.equal(report.counts['not-implemented-at-frozen-sha'], 6);
  assert.equal((report.counts.pass ?? 0) + (report.counts['canonical-mismatch'] ?? 0), 9);
  assert.equal(
    report.cases
      .filter((row) => row.transport !== 'host-admin')
      .every((row) => row.childPidObserved && row.sideEffectsPassed),
    true,
  );
  const snapshotRoundTrip = report.cases.find((row) => row.id === 'stale-cursor-snapshot-roundtrip');
  assert.equal(snapshotRoundTrip.observed.roundTrip.snapshot.snapshotAckToken, '<opaque>');
  assert.equal(snapshotRoundTrip.observed.result.ackToken, null);

  const canonicalFailures = report.cases
    .filter((row) => row.verdict === 'canonical-mismatch')
    .map((row) => ({ id: row.id, failures: row.failures, observed: row.observed }));
  assert.deepEqual(canonicalFailures, []);
});

test('joint acceptance CLI rejects provenance coordinates that are not durable commits', () => {
  const unrelatedSha = '0000000000000000000000000000000000000000';
  const result = spawnSync(
    process.execPath,
    [
      acceptanceCli,
      '--plugins-repository',
      repositoryRoot,
      '--plugins-sha',
      unrelatedSha,
      '--host-reviewed-sha',
      unrelatedSha,
      '--host-merge-sha',
      unrelatedSha,
      '--host-acceptance-reviewed-sha',
      unrelatedSha,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1' },
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /--plugins-sha .* does not resolve to a commit/);
});

test('joint acceptance CLI binds executed Host code to the acceptance-reviewed HEAD', async () => {
  const plugins = await metadataOnlyPluginsRepository();
  try {
    const result = runAcceptance(plugins, frozenHostMergeSha);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /acceptance-reviewed Host commit .* does not match executed HEAD/);
  } finally {
    await rm(plugins.root, { recursive: true, force: true });
  }
});

test('joint acceptance CLI rejects loaded plugin code unrelated to the supplied SHA', async () => {
  const plugins = await metadataOnlyPluginsRepository();
  try {
    const executedSha = git(['rev-parse', 'HEAD'], repositoryRoot);
    const result = runAcceptance(plugins, executedSha);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /cannot derive loaded plugin artifacts from commit/);
  } finally {
    await rm(plugins.root, { recursive: true, force: true });
  }
});

test('catalog integrity mismatch makes the acceptance verdict fail closed', () => {
  assert.equal(
    isM0dAcceptancePassed({
      catalog: { catalogMatches: false },
      counts: { pass: 9, 'schema-incompatible-at-frozen-sha': 3, 'not-implemented-at-frozen-sha': 6 },
    }),
    false,
  );
});
