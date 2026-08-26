import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  isM0dAcceptancePassed,
  M0D_BEHAVIOR_FIXTURE_PATH,
  runM0dJointAcceptance,
} from '../test/plugin-m0d-joint-runner.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing required ${name}`);
  return value;
}

function requiredSha(name) {
  const value = argumentValue(name);
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

async function gitOutput(args, cwd = repositoryRoot) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function gitEvidence(args, cwd, errorMessage, trim = true) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return trim ? stdout.trim() : stdout;
  } catch {
    throw new Error(errorMessage);
  }
}

async function gitRepository(argumentName) {
  const requestedPath = await realpath(resolve(argumentValue(argumentName)));
  const root = await realpath(await gitOutput(['rev-parse', '--show-toplevel'], requestedPath));
  if (requestedPath !== root) {
    throw new Error(`${argumentName} must name a Git repository root`);
  }
  return root;
}

async function verifiedCommit(repository, argumentName, sha) {
  const errorMessage = `${argumentName} ${sha} does not resolve to a commit in the declared repository`;
  const resolved = await gitEvidence(['rev-parse', '--verify', `${sha}^{commit}`], repository, errorMessage);
  if (resolved !== sha) throw new Error(errorMessage);
}

async function commitFile(repository, sha, path) {
  return gitEvidence(
    ['show', `${sha}:${path}`],
    repository,
    `commit ${sha} does not contain required provenance file ${path}`,
    false,
  );
}

async function verifyHostProvenance({ executedSha, reviewedSha, mergeSha }) {
  await Promise.all([
    verifiedCommit(repositoryRoot, '--host-reviewed-sha', reviewedSha),
    verifiedCommit(repositoryRoot, '--host-merge-sha', mergeSha),
  ]);
  if (reviewedSha === mergeSha) {
    throw new Error('reviewed Host commit and merged Host commit must be distinct coordinates');
  }
  if (mergeSha === executedSha) {
    throw new Error('merged Host predecessor must be a strict ancestor of the executed acceptance HEAD');
  }
  await gitEvidence(
    ['merge-base', '--is-ancestor', mergeSha, executedSha],
    repositoryRoot,
    `merged Host commit ${mergeSha} is not an ancestor of executed HEAD ${executedSha}`,
  );
  const [reviewedTree, mergeTree] = await Promise.all([
    gitOutput(['rev-parse', `${reviewedSha}^{tree}`]),
    gitOutput(['rev-parse', `${mergeSha}^{tree}`]),
  ]);
  if (reviewedTree !== mergeTree) {
    throw new Error(`reviewed Host commit ${reviewedSha} and merge commit ${mergeSha} do not have the same tree`);
  }
  return {
    mergeIsStrictAncestorOfExecution: true,
    reviewedTreeMatchesMerge: true,
    treeSha: reviewedTree,
  };
}

async function verifyPluginsProvenance({ repository, sha, contract, sdk, fixtureBytes }) {
  const contractManifestPath = 'packages/plugin-contract/package.json';
  const sdkManifestPath = 'packages/plugin-sdk/package.json';
  const fixturePath = 'packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json';
  const [contractManifestBytes, sdkManifestBytes, sourceFixtureBytes] = await Promise.all([
    commitFile(repository, sha, contractManifestPath),
    commitFile(repository, sha, sdkManifestPath),
    commitFile(repository, sha, fixturePath),
  ]);
  const sourceContract = JSON.parse(contractManifestBytes);
  const sourceSdk = JSON.parse(sdkManifestBytes);
  if (sourceContract.name !== contract.name || sourceContract.version !== contract.version) {
    throw new Error(
      `plugin source ${sha} declares ${sourceContract.name}@${sourceContract.version}, not loaded ${contract.name}@${contract.version}`,
    );
  }
  if (sourceSdk.name !== sdk.name || sourceSdk.version !== sdk.version) {
    throw new Error(
      `plugin source ${sha} declares ${sourceSdk.name}@${sourceSdk.version}, not loaded ${sdk.name}@${sdk.version}`,
    );
  }
  if (!Buffer.from(sourceFixtureBytes).equals(fixtureBytes)) {
    throw new Error(`plugin source ${sha} behavior fixture does not match the loaded package bytes`);
  }
  return {
    commitVerified: true,
    packageVersionsMatch: true,
    behaviorFixtureBytesMatch: true,
  };
}

const pluginsRepository = await gitRepository('--plugins-repository');
const pluginsSha = requiredSha('--plugins-sha');
const hostReviewedSha = requiredSha('--host-reviewed-sha');
const hostMergeSha = requiredSha('--host-merge-sha');
const [hostSha, worktreeStatus] = await Promise.all([
  gitOutput(['rev-parse', 'HEAD']),
  gitOutput(['status', '--porcelain']),
]);
if (worktreeStatus !== '') {
  throw new Error('joint acceptance evidence requires a clean worktree so executedSha identifies the executed code');
}
await verifiedCommit(pluginsRepository, '--plugins-sha', pluginsSha);
const hostProvenance = await verifyHostProvenance({
  executedSha: hostSha,
  reviewedSha: hostReviewedSha,
  mergeSha: hostMergeSha,
});
const [contract, sdk, fixtureBytes] = await Promise.all([
  packageEvidence('@clowder-ai/plugin-contract', '@clowder-ai/plugin-contract/conformance'),
  packageEvidence('@clowder-ai/plugin-sdk'),
  readFile(M0D_BEHAVIOR_FIXTURE_PATH),
]);
const pluginsProvenance = await verifyPluginsProvenance({
  repository: pluginsRepository,
  sha: pluginsSha,
  contract,
  sdk,
  fixtureBytes,
});
const execution = await runM0dJointAcceptance();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  integrity: {
    host: {
      executedSha: hostSha,
      reviewedSha: hostReviewedSha,
      mergeSha: hostMergeSha,
      provenance: hostProvenance,
    },
    plugins: { frozenSha: pluginsSha, provenance: pluginsProvenance },
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
    passed: isM0dAcceptancePassed(execution),
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
