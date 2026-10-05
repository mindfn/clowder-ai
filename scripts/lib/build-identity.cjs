// Deployment identity for the direct launcher's complete build transaction.
// Stamps are disposable build metadata, never runtime/user storage.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const PRODUCTS = Object.freeze({
  shared: 'packages/shared/dist/index.js',
  'mcp-server': 'packages/mcp-server/dist/index.js',
  api: 'packages/api/dist/index.js',
  web: 'packages/web/.next/BUILD_ID',
});
const INPUTS = Object.freeze([
  'packages/api',
  'packages/shared',
  'packages/mcp-server',
  'packages/web',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
]);
const FULL_COMMIT = /^[0-9a-f]{40}$/;

function stampPath(root, pkg) {
  return path.join(path.dirname(path.resolve(root, PRODUCTS[pkg])), '.build-commit');
}

function invalidateBuildIdentity(root) {
  for (const pkg of Object.keys(PRODUCTS)) rmSync(stampPath(root, pkg), { force: true });
}

function captureBuildState(root) {
  try {
    const git = (args) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const dirty = () => git(['status', '--porcelain', '--untracked-files=all', '--', ...INPUTS]);
    if (!FULL_COMMIT.test(revision) || dirty()) return null;
    const hash = createHash('sha256');
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...INPUTS])
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      const stat = lstatSync(path.resolve(root, file), { bigint: true });
      hash.update(JSON.stringify([file, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]));
    }
    // The reflog's metadata observes normal HEAD moves-and-returns too. This
    // is detection, not an exclusive writer lock or a hermetic build promise.
    const reflog = path.resolve(root, git(['rev-parse', '--git-path', 'logs/HEAD']));
    if (existsSync(reflog)) {
      const stat = statSync(reflog, { bigint: true });
      hash.update(JSON.stringify([stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
    }
    if (dirty() || git(['rev-parse', '--verify', 'HEAD^{commit}']) !== revision) return null;
    return { revision, fingerprint: hash.digest('hex') };
  } catch {
    return null; // Non-git or unreadable inputs can build, but cannot claim identity.
  }
}

function captureBuildIdentity(root) {
  return captureBuildState(root)?.revision ?? null;
}

function productState(root, pkg) {
  try {
    const stat = statSync(path.resolve(root, PRODUCTS[pkg]), { bigint: true });
    if (!stat.isFile() || stat.size === 0n) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  } catch {
    return null;
  }
}

function readStamp(root, pkg) {
  try {
    return readFileSync(stampPath(root, pkg), 'utf8').trim();
  } catch {
    return null;
  }
}

function beginBuildIdentity(root) {
  const source = captureBuildState(root);
  const context = {
    root: path.resolve(root),
    revision: source?.revision ?? null,
    fingerprint: source?.fingerprint ?? null,
    products: Object.fromEntries(
      Object.keys(PRODUCTS).map((pkg) => [
        pkg,
        {
          state: productState(root, pkg),
          revision: readStamp(root, pkg),
        },
      ]),
    ),
  };
  invalidateBuildIdentity(root);
  return context;
}

function finishBuildIdentity(root, context, packages) {
  const capturedRevision = context.revision;
  const source = captureBuildState(root);
  const valid =
    FULL_COMMIT.test(capturedRevision ?? '') &&
    context.root === path.resolve(root) &&
    source?.revision === capturedRevision &&
    source?.fingerprint === context.fingerprint &&
    packages.length > 0 &&
    packages.every((pkg) => {
      if (!Object.hasOwn(PRODUCTS, pkg)) return false;
      const current = productState(root, pkg);
      const previous = context.products[pkg];
      // Incremental no-op is legitimate only for a previously proven artifact
      // at this exact revision. Existence alone cannot bless an old product.
      return (
        current &&
        (current !== previous.state || previous.revision === capturedRevision) &&
        (pkg !== 'web' || readStamp(root, pkg) === capturedRevision)
      );
    });
  if (!valid) {
    invalidateBuildIdentity(root);
    return false;
  }
  try {
    for (const pkg of packages) {
      const stamp = stampPath(root, pkg);
      const temp = `${stamp}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, `${capturedRevision}\n`, { flag: 'wx' });
        renameSync(temp, stamp);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    // Also guard a HEAD/input change while the small stamp set is published.
    const publishedSource = captureBuildState(root);
    if (publishedSource?.revision !== capturedRevision || publishedSource?.fingerprint !== context.fingerprint) {
      invalidateBuildIdentity(root);
      return false;
    }
    return true;
  } catch (error) {
    invalidateBuildIdentity(root);
    throw error;
  }
}

module.exports = {
  PRODUCTS,
  INPUTS,
  captureBuildIdentity,
  beginBuildIdentity,
  invalidateBuildIdentity,
  finishBuildIdentity,
  stampPath,
};

if (require.main === module) {
  const [action, root, revision, ...packages] = process.argv.slice(2);
  if (action === 'revision') {
    process.stdout.write(JSON.parse(root).revision ?? '');
  } else if (!root || !existsSync(path.resolve(root, 'package.json'))) {
    throw new Error('build identity requires a package root');
  } else if (action === 'begin') {
    process.stdout.write(JSON.stringify(beginBuildIdentity(root)));
  } else if (action === 'invalidate') {
    invalidateBuildIdentity(root);
  } else if (action === 'finish') {
    if (!finishBuildIdentity(root, JSON.parse(revision), packages)) {
      console.warn(
        '[build] deployment identity unavailable: missing products, dirty inputs or changed HEAD; stamps invalidated',
      );
    }
  } else {
    throw new Error(`unknown build identity action: ${action}`);
  }
}
