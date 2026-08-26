import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { M0D_BEHAVIOR_FIXTURE_PATH, runM0dJointAcceptance } from '../test/plugin-m0d-joint-runner.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing required ${name} <sha>`);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full lowercase Git SHA`);
  return value;
}

async function packageRoot(specifier) {
  let directory = dirname(await realpath(fileURLToPath(import.meta.resolve(specifier))));
  for (;;) {
    const candidate = join(directory, 'package.json');
    try {
      if ((await stat(candidate)).isFile()) return directory;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate package root for ${specifier}`);
    directory = parent;
  }
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function directoryDigest(root) {
  const hash = createHash('sha256');
  for (const path of await listFiles(root)) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

async function packageEvidence(specifier, resolveSpecifier = specifier) {
  const root = await packageRoot(resolveSpecifier);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return {
    name: manifest.name,
    version: manifest.version,
    contentDigest: await directoryDigest(root),
  };
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repositoryRoot });
  return stdout.trim();
}

const pluginsSha = requiredArgument('--plugins-sha');
const hostReviewedSha = requiredArgument('--host-reviewed-sha');
const hostMergeSha = requiredArgument('--host-merge-sha');
const [hostSha, worktreeStatus] = await Promise.all([
  gitOutput(['rev-parse', 'HEAD']),
  gitOutput(['status', '--porcelain']),
]);
if (worktreeStatus !== '') {
  throw new Error('joint acceptance evidence requires a clean worktree so executedSha identifies the executed code');
}
const [execution, contract, sdk, fixtureBytes] = await Promise.all([
  runM0dJointAcceptance(),
  packageEvidence('@clowder-ai/plugin-contract', '@clowder-ai/plugin-contract/conformance'),
  packageEvidence('@clowder-ai/plugin-sdk'),
  readFile(M0D_BEHAVIOR_FIXTURE_PATH),
]);
const canonicalMismatchCount = execution.counts['canonical-mismatch'] ?? 0;
const admissionSafetyFailureCount = execution.counts['admission-safety-failure'] ?? 0;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  integrity: {
    host: { executedSha: hostSha, reviewedSha: hostReviewedSha, mergeSha: hostMergeSha },
    plugins: { frozenSha: pluginsSha },
    packages: { contract, sdk },
    behaviorFixture: {
      source: execution.catalog.source,
      digest: `sha256-${createHash('sha256').update(fixtureBytes).digest('hex')}`,
      count: execution.catalog.count,
      catalogMatches: execution.catalog.catalogMatches,
    },
  },
  isolation: {
    runtimeActivation: 'dormant',
    persistentDataStore: 'none',
    reservedPortsUsed: [],
    packageInstallRoot: 'per-case-temporary-directory',
  },
  acceptance: {
    passed: canonicalMismatchCount === 0 && admissionSafetyFailureCount === 0,
    counts: execution.counts,
  },
  nonClaims: [
    'No live Clowder AI runtime was activated.',
    'No real Feishu credential or external message delivery was exercised.',
    'Host-admin cases were classified but not executed through invented stdio methods.',
    'Admission mismatches prove fail-closed behavior, not canonical domain-code conformance.',
  ],
  cases: execution.cases,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.acceptance.passed) process.exitCode = 1;
