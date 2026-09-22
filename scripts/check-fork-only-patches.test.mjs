/**
 * Tests for the fork-only patch guard.
 *
 * The guard's whole claim is that it turns a silent rebuild loss into a red
 * check. An untested guard cannot support that claim - it would be the same
 * "trust me, I verified it once" the guard exists to replace. These tests pin
 * the two detection modes that matter and the fail-closed behaviour:
 *
 *   - required file deleted           (patch added a new file, rebuild dropped it)
 *   - anchor lost from a shared file  (file survives the rebuild, patch reverted)
 *   - registry missing/malformed/empty (the guard's own input vanished)
 *
 * The last block asserts against the REAL repo: the guard's automatic
 * enforcement point (its develop_base workflow) must stay registered, or the
 * guard silently degrades to "someone remembers to run pnpm check".
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync as mkdirp,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkForkOnlyPatches, checkRebuildSurvival } from './check-fork-only-patches.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REGISTRY = {
  patches: [
    {
      id: 'demo-patch',
      requiredFiles: ['src/added-by-fork.ts'],
      requiredAnchors: [
        {
          file: 'src/shared.ts',
          mustContain: ['forkOnlySymbol'],
          note: 'wiring a rebuild reverts silently',
        },
      ],
    },
  ],
};

function fixture(t, { registry = REGISTRY, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fork-only-patches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });

  if (registry !== null) {
    writeFileSync(
      join(root, 'scripts/fork-only-patches.json'),
      typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2),
    );
  }

  const tree = {
    'src/added-by-fork.ts': 'export const addedByFork = true;\n',
    'src/shared.ts': 'export const forkOnlySymbol = 1;\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(tree)) {
    if (content === null) continue;
    writeFileSync(join(root, rel), content);
  }
  return root;
}

test('intact tree reports no violations', (t) => {
  const { violations, patchIds } = checkForkOnlyPatches(fixture(t));
  assert.deepEqual(violations, []);
  assert.deepEqual(patchIds, ['demo-patch']);
});

test('detects a required file dropped by a rebuild', (t) => {
  const root = fixture(t, { files: { 'src/added-by-fork.ts': null } });
  const { violations } = checkForkOnlyPatches(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /required file missing: src\/added-by-fork\.ts/);
});

test('detects a lost anchor when the shared file itself survives', (t) => {
  // The silent case: existence checks read clean because the file is still
  // there; only the fork's edit inside it was reverted.
  const root = fixture(t, {
    files: { 'src/shared.ts': 'export const somethingElse = 1;\n' },
  });
  const { violations } = checkForkOnlyPatches(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /lost anchor "forkOnlySymbol"/);
  assert.match(violations[0], /wiring a rebuild reverts silently/);
});

test('fails closed when the registry is missing', (t) => {
  const { violations } = checkForkOnlyPatches(fixture(t, { registry: null }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /registry unreadable/);
});

test('fails closed when the registry is malformed', (t) => {
  const { violations } = checkForkOnlyPatches(fixture(t, { registry: '{ not json' }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /not valid JSON/);
});

test('fails closed when the registry declares zero patches', (t) => {
  // An emptied registry must not read as "nothing to protect" - that is
  // indistinguishable from the registry itself being reverted.
  const { violations } = checkForkOnlyPatches(fixture(t, { registry: { patches: [] } }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /zero patches/);
});

test('the guard is green against the real repo tree', () => {
  const { violations } = checkForkOnlyPatches(REPO_ROOT);
  assert.deepEqual(violations, [], `real tree has fork-only patch violations:\n${violations.join('\n')}`);
});

test('the guard keeps its own automatic enforcement point on develop_base', () => {
  // Regression guard for the gap this test file shipped with: every other
  // workflow triggers on `main` only, so a guard without this workflow never
  // runs automatically on the branch that actually loses the patches.
  const workflowRel = '.github/workflows/fork-only-patches.yml';
  const workflow = readFileSync(join(REPO_ROOT, workflowRel), 'utf8');
  // Strip comments: the file explains *why* paths-ignore is absent, and that
  // prose must not satisfy - or trip - a check about the directive itself.
  const directives = workflow
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  assert.match(directives, /push:\s*\n\s*branches: \[develop_base\]/);
  assert.match(directives, /pull_request:\s*\n\s*branches: \[develop_base\]/);
  assert.doesNotMatch(
    directives,
    /paths-ignore/,
    'a rebuild can drop a patch regardless of which paths its diff touches',
  );

  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/fork-only-patches.json'), 'utf8'));
  const registeredFiles = registry.patches.flatMap((p) => p.requiredFiles ?? []);
  assert.ok(
    registeredFiles.includes(workflowRel),
    `${workflowRel} must be a registered fork-only patch, or a rebuild drops the guard's CI trigger unnoticed`,
  );
});

// ---------------------------------------------------------------------------
// Rebuild fixture (PR #185 review, 砚砚 P1): a tree check reads the registry
// FROM the tree, so a rebuild that wipes the tree erases the guard together
// with the patches and nothing reports. These tests reproduce that exact
// rebuild and prove the loss is detected from the surviving remote-tracking ref.
// ---------------------------------------------------------------------------

const BASELINE = 'refs/remotes/origin/develop_base';

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitCapture(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const BASELINE_REGISTRY = {
  baselineRef: BASELINE,
  patches: [
    {
      id: 'demo-patch',
      requiredFiles: ['src/added-by-fork.ts'],
      requiredAnchors: [{ file: 'src/shared.ts', mustContain: ['forkOnlySymbol'] }],
    },
  ],
};

/** Builds a repo whose pre-rebuild tip is recorded as origin/develop_base. */
function rebuiltRepo(t, { rebuild }) {
  const root = mkdtempSync(join(tmpdir(), 'fork-only-rebuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });

  git(root, 'init', '--initial-branch=develop_base');
  git(root, 'config', 'user.email', 'guard@test.local');
  git(root, 'config', 'user.name', 'guard');

  // Pre-rebuild develop_base: patch present, registry present, guard green.
  writeFileSync(join(root, 'scripts/fork-only-patches.json'), JSON.stringify(BASELINE_REGISTRY, null, 2));
  writeFileSync(join(root, 'src/added-by-fork.ts'), 'export const addedByFork = true;\n');
  writeFileSync(join(root, 'src/shared.ts'), 'export const forkOnlySymbol = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'pre-rebuild develop_base');

  // The ref that survives `git reset --hard upstream/main`.
  git(root, 'update-ref', BASELINE, gitCapture(root, 'rev-parse', 'HEAD').trim());

  rebuild(root);
  // A real rebuild produces a commit, so HEAD must advance past the baseline.
  // Leaving it uncommitted would make the baseline and the tree under test the
  // same commit, which the guard now (correctly) refuses to compare.
  git(root, 'add', '-A');
  git(root, 'commit', '--allow-empty', '-m', 'rebuild onto upstream main');
  return root;
}

test('a rebuild that erases the registry AND the patch is still detected', (t) => {
  const root = rebuiltRepo(t, {
    rebuild: (r) => {
      // Upstream main has none of it - registry, guard and patch all gone.
      rmSync(join(r, 'scripts/fork-only-patches.json'));
      rmSync(join(r, 'src/added-by-fork.ts'));
      writeFileSync(join(r, 'src/shared.ts'), 'export const upstreamOnly = 1;\n');
    },
  });

  // The tree check alone can only say "my own input vanished".
  const tree = checkForkOnlyPatches(root);
  assert.ok(tree.violations.every((v) => v.includes('registry unreadable')));

  const { violations } = checkRebuildSurvival(root, { baselineRef: BASELINE });
  assert.ok(
    violations.some((v) => v.includes('REBUILD LOSS') && v.includes('src/added-by-fork.ts')),
    `expected the dropped file to be named, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((v) => v.includes('src/shared.ts')),
    'a reverted anchor in a surviving shared file must be reported too',
  );
  assert.ok(
    violations.some((v) => v.includes('registry itself is gone')),
    'the guard must report its own erasure, which is what hid the first three losses',
  );
});

test('a rebuild that preserved everything reports no loss', (t) => {
  const root = rebuiltRepo(t, { rebuild: () => {} });
  const { violations, comparedPatches } = checkRebuildSurvival(root, { baselineRef: BASELINE });
  assert.deepEqual(violations, []);
  assert.equal(comparedPatches, 1);
});

test('an unreachable baseline fails closed with an actionable recovery', (t) => {
  const root = rebuiltRepo(t, { rebuild: () => {} });
  const { violations } = checkRebuildSurvival(root, { baselineRef: 'refs/remotes/origin/nope' });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /cannot be detected/);
  assert.match(violations[0], /git fetch origin develop_base/);
});

test('a baseline that never carried a registry makes no claim to lose', (t) => {
  // First adoption: the prior tip predates the guard. Absence of a prior claim
  // is not an unverifiable claim, so it must not be dressed up as a violation.
  const root = rebuiltRepo(t, { rebuild: () => {} });
  const registry = readFileSync(join(root, 'scripts/fork-only-patches.json'), 'utf8');

  rmSync(join(root, 'scripts/fork-only-patches.json'));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'pre-adoption tip: no registry');
  git(root, 'update-ref', 'refs/remotes/origin/empty', gitCapture(root, 'rev-parse', 'HEAD').trim());

  // HEAD then advances past that baseline and adopts the registry.
  writeFileSync(join(root, 'scripts/fork-only-patches.json'), registry);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'adopt the guard');

  const { violations, comparedPatches } = checkRebuildSurvival(root, {
    baselineRef: 'refs/remotes/origin/empty',
  });
  assert.deepEqual(violations, []);
  assert.equal(comparedPatches, 0);
});

// --- hollow entries (PR #185 review, 砚砚 P2) -------------------------------

test('a patch entry that asserts nothing fails closed', (t) => {
  const root = fixture(t, { registry: { baselineRef: BASELINE, patches: [{ id: 'hollow' }] } });
  const { violations } = checkForkOnlyPatches(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /asserts nothing/);
});

test('a patch entry without an id fails closed', (t) => {
  const root = fixture(t, {
    registry: { baselineRef: BASELINE, patches: [{ requiredFiles: ['src/added-by-fork.ts'] }] },
  });
  const { violations } = checkForkOnlyPatches(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /without a string "id"/);
});

// --- ordering anchors (PR #185 review, 砚砚 P2) -----------------------------

test('ordering anchor catches a gate moved after the step it must precede', (t) => {
  const root = fixture(t, {
    registry: {
      baselineRef: BASELINE,
      patches: [
        {
          id: 'ordered',
          requiredAnchors: [{ file: 'src/shared.ts', order: ['gateRuns()', 'thenPublishes()'] }],
        },
      ],
    },
    files: { 'src/shared.ts': 'thenPublishes();\ngateRuns();\n' },
  });
  const { violations } = checkForkOnlyPatches(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /AFTER/);
  assert.match(violations[0], /cannot prevent the invocation/);
});

test('ordering anchor passes when the gate runs first', (t) => {
  const root = fixture(t, {
    registry: {
      baselineRef: BASELINE,
      patches: [
        {
          id: 'ordered',
          requiredAnchors: [{ file: 'src/shared.ts', order: ['gateRuns()', 'thenPublishes()'] }],
        },
      ],
    },
    files: { 'src/shared.ts': 'gateRuns();\nthenPublishes();\n' },
  });
  assert.deepEqual(checkForkOnlyPatches(root).violations, []);
});

// ---------------------------------------------------------------------------
// The guard must never silently no-op.
//
// Found while testing the documented recovery from docs/fork-only-patches.md:
// `node /tmp/guard.mjs` printed nothing and exited 0. `import.meta.url` gives
// the REAL path (/private/tmp/...) while `process.argv[1]` gives the path as
// typed (/tmp/...), so the entrypoint comparison was false and main() never
// ran. A guard that exits 0 having checked nothing is the precise failure this
// file exists to remove, so it is pinned here.
// ---------------------------------------------------------------------------

const GUARD = join(REPO_ROOT, 'scripts/check-fork-only-patches.mjs');

function runGuard(args, cwd) {
  try {
    const stdout = execFileSync('node', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('runs when invoked through a symlinked path instead of exiting 0 in silence', (t) => {
  const box = mkdtempSync(join(tmpdir(), 'guard-symlink-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  mkdirp(join(box, 'real'));
  copyFileSync(GUARD, join(box, 'real/guard.mjs'));
  symlinkSync(join(box, 'real'), join(box, 'link'));

  const { out } = runGuard([join(box, 'link/guard.mjs')], REPO_ROOT);
  assert.match(out, /\[check-fork-only-patches\]/, 'guard produced no verdict at all');
});

test('rescued out of the repo, it still checks the repo it is run from', (t) => {
  // The documented rebuild recovery: the tree lost the guard, so it is read
  // back out of the surviving ref into /tmp and run from the repo.
  const box = mkdtempSync(join(tmpdir(), 'guard-rescue-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const rescued = join(box, 'guard.mjs');
  copyFileSync(GUARD, rescued);

  const { code, out } = runGuard([rescued], REPO_ROOT);
  assert.equal(code, 0, out);
  assert.match(out, /fork-only patch\(es\) present/);
  // A script-relative root would have resolved to "/" and found no registry.
  assert.doesNotMatch(out, /registry unreadable/);
});

test('--repo-root targets an explicit tree', (t) => {
  const root = rebuiltRepo(t, { rebuild: () => {} });
  const { code, out } = runGuard([GUARD, '--repo-root', root], tmpdir());
  assert.equal(code, 0, out);
  assert.match(out, /1 fork-only patch\(es\) present/);
});

test('an explicit tree with no resolvable baseline still fails closed', (t) => {
  // --repo-root must not become a way to opt out of the survival half.
  const root = fixture(t, { registry: { baselineRef: BASELINE, patches: REGISTRY.patches } });
  const { code, out } = runGuard([GUARD, '--repo-root', root], tmpdir());
  assert.equal(code, 1);
  assert.match(out, /rebuild loss cannot be detected/);
});

// ---------------------------------------------------------------------------
// Post-push lifecycle (PR #185 review round 2, 砚砚 P1).
//
// CI fetched `origin/develop_base` AFTER the push, so the "baseline" was the
// very tree being validated. Worse, the registry is itself a shared file: a
// rebuild can REVERT it rather than delete it, and then both trees look
// internally consistent and the guard confirms its own amnesia as healthy.
// ---------------------------------------------------------------------------

function pushedRepo(t, { baselinePatches, afterPatches, files }) {
  const root = mkdtempSync(join(tmpdir(), 'guard-postpush-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirp(join(root, 'scripts'));
  mkdirp(join(root, 'src'));
  git(root, 'init', '--initial-branch=develop_base');
  git(root, 'config', 'user.email', 'guard@test.local');
  git(root, 'config', 'user.name', 'guard');

  const writeRegistry = (patches) =>
    writeFileSync(
      join(root, 'scripts/fork-only-patches.json'),
      JSON.stringify({ baselineRef: BASELINE, patches }, null, 2),
    );

  writeRegistry(baselinePatches);
  writeFileSync(join(root, 'src/kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(root, 'src/dropped.ts'), 'export const dropped = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'pre-rebuild');
  const preResetSha = gitCapture(root, 'rev-parse', 'HEAD').trim();
  git(root, 'update-ref', BASELINE, preResetSha);

  writeRegistry(afterPatches);
  for (const [rel, content] of Object.entries(files ?? {})) {
    if (content === null) rmSync(join(root, rel));
    else writeFileSync(join(root, rel), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--allow-empty', '-m', 'rebuild onto upstream main');
  // The push: the remote-tracking ref advances to the tree under validation.
  git(root, 'update-ref', BASELINE, gitCapture(root, 'rev-parse', 'HEAD').trim());
  return { root, preResetSha };
}

const KEPT = { id: 'kept-patch', requiredFiles: ['src/kept.ts'] };
const DROPPED = { id: 'f192-gate', requiredFiles: ['src/dropped.ts'] };

test('a baseline that advanced to the validated tree fails closed, never green', (t) => {
  const { root } = pushedRepo(t, {
    baselinePatches: [KEPT, DROPPED],
    afterPatches: [KEPT],
    files: { 'src/dropped.ts': null },
  });
  // This is exactly what CI did: fetch origin/develop_base after the push.
  const { violations } = checkRebuildSurvival(root, { baselineRef: BASELINE });
  assert.ok(violations.length > 0, 'a witness that is the accused must not return green');
  assert.match(violations[0], /resolves to HEAD/);
  assert.match(violations[0], /--baseline-ref/);
});

test('a reverted registry is a loss, not a smaller honest claim', (t) => {
  const { root, preResetSha } = pushedRepo(t, {
    baselinePatches: [KEPT, DROPPED],
    afterPatches: [KEPT],
    files: { 'src/dropped.ts': null },
  });
  const { violations } = checkRebuildSurvival(root, { baselineRef: preResetSha });
  assert.ok(
    violations.some((v) => v.includes('f192-gate') && v.includes('registry was reverted')),
    `the dropped CLAIM must be named, not just the file: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((v) => v.includes('src/dropped.ts')),
    'the dropped file must still be named too',
  );
});

test('the CLI honours --baseline-ref instead of the registry default', (t) => {
  const { root, preResetSha } = pushedRepo(t, {
    baselinePatches: [KEPT, DROPPED],
    afterPatches: [KEPT],
    files: { 'src/dropped.ts': null },
  });
  copyFileSync(GUARD, join(root, 'scripts/check-fork-only-patches.mjs'));

  const withBaseline = runGuard(
    [join(root, 'scripts/check-fork-only-patches.mjs'), '--baseline-ref', preResetSha],
    root,
  );
  assert.equal(withBaseline.code, 1, withBaseline.out);
  assert.match(withBaseline.out, /registry was reverted/);

  const withoutBaseline = runGuard([join(root, 'scripts/check-fork-only-patches.mjs')], root);
  assert.equal(withoutBaseline.code, 1, 'the advanced default must fail closed too');
  assert.match(withoutBaseline.out, /resolves to HEAD/);
});

test('--no-baseline states the skip instead of hiding it', (t) => {
  const { root } = pushedRepo(t, { baselinePatches: [KEPT], afterPatches: [KEPT] });
  copyFileSync(GUARD, join(root, 'scripts/check-fork-only-patches.mjs'));
  const { code, out } = runGuard([join(root, 'scripts/check-fork-only-patches.mjs'), '--no-baseline'], root);
  assert.equal(code, 0, out);
  assert.match(out, /rebuild-survival SKIPPED/);
});
