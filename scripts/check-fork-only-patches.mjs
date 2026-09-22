#!/usr/bin/env node
/**
 * Fork-only patch guard.
 *
 * Problem this solves: this fork carries patches that upstream main does NOT
 * have. Every `develop_base` rebuild onto upstream main silently drops them.
 * The F192 evidence-prerequisite gate was lost three times this way (PR #91,
 * PR #137, commit 70d79a2f2) and each loss went unnoticed for days-to-weeks
 * while the scheduler burned a full LLM session per daily eval fire.
 *
 * Maintainer direction (zts212653/clowder-ai#1352, closed 2026-08-25):
 * "this is fork-specific harness logic that doesn't belong in upstream. The
 * rebuild-loss issue should be solved by improving our fork's develop_base
 * rebuild SOP (rebase fork-only patches), not by pushing internal code into
 * the community repo."
 *
 * "Remembering to re-apply" is not a mechanism. This guard is: it asserts each
 * registered patch is still present, so a rebuild that drops one turns
 * `pnpm check` RED immediately instead of failing silently in production.
 *
 * Enforcement points (both required, neither sufficient alone):
 *   - `pnpm check` locally, wired first so it fails fast.
 *   - .github/workflows/fork-only-patches.yml on every push/PR to develop_base.
 *     The repo's other workflows trigger on `main` only, so without this the
 *     guard would never run automatically on the exact branch that loses the
 *     patches. That workflow is itself a registered fork-only patch.
 *
 * Fail-CLOSED: a missing/unreadable/malformed registry is a violation, not a
 * pass. A guard whose own input vanished must not read as clean.
 *
 * Truth source: scripts/fork-only-patches.json (see docs/fork-only-patches.md).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_REL = 'scripts/fork-only-patches.json';

function readRegistry(repoRoot, violations) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, REGISTRY_REL), 'utf8');
  } catch (err) {
    violations.push(`registry unreadable at ${REGISTRY_REL}: ${err.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    violations.push('registry is not valid JSON: ' + err.message);
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patches)) {
    violations.push('registry is missing a top-level "patches" array');
    return null;
  }
  if (parsed.patches.length === 0) {
    violations.push(
      'registry declares zero patches - an empty registry cannot distinguish "nothing to protect" from "the registry was reverted"',
    );
    return null;
  }
  return parsed;
}

function checkPatch(repoRoot, patch, violations) {
  const id = patch.id ?? '<unnamed patch>';

  // Fail closed on a hollow entry. A patch that asserts nothing passes
  // vacuously, which is indistinguishable from a rebuild having emptied it -
  // the same silent-green failure this guard exists to remove.
  if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || patch.id.length === 0) {
    violations.push('registry contains a patch entry without a string "id"');
    return;
  }
  const fileCount = (patch.requiredFiles ?? []).length;
  const anchorCount = (patch.requiredAnchors ?? []).length;
  if (fileCount === 0 && anchorCount === 0) {
    violations.push(`[${id}] asserts nothing: needs requiredFiles and/or requiredAnchors`);
    return;
  }

  for (const rel of patch.requiredFiles ?? []) {
    try {
      readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      violations.push(`[${id}] required file missing: ${rel}`);
    }
  }

  for (const anchor of patch.requiredAnchors ?? []) {
    let content;
    try {
      content = readFileSync(join(repoRoot, anchor.file), 'utf8');
    } catch {
      violations.push(`[${id}] anchor file missing: ${anchor.file}`);
      continue;
    }
    if ((anchor.mustContain ?? []).length === 0 && (anchor.order ?? []).length === 0) {
      violations.push(`[${id}] anchor for ${anchor.file} asserts nothing`);
      continue;
    }
    for (const needle of anchor.mustContain ?? []) {
      if (!content.includes(needle)) {
        const note = anchor.note ? ` (${anchor.note})` : '';
        violations.push(`[${id}] ${anchor.file} lost anchor ${JSON.stringify(needle)}${note}`);
      }
    }
    // Ordering anchors: substring presence cannot tell an executed gate from a
    // stray import or a comment. Where sequence carries the meaning, pin it.
    const order = anchor.order ?? [];
    for (let i = 0; i + 1 < order.length; i++) {
      const first = content.indexOf(order[i]);
      const second = content.indexOf(order[i + 1]);
      if (first === -1 || second === -1) {
        violations.push(
          `[${id}] ${anchor.file} is missing an ordered anchor: ${JSON.stringify(order[i])} -> ${JSON.stringify(order[i + 1])}`,
        );
      } else if (first > second) {
        violations.push(
          `[${id}] ${anchor.file} has ${JSON.stringify(order[i])} AFTER ${JSON.stringify(order[i + 1])}; the gate must run first or it cannot prevent the invocation`,
        );
      }
    }
  }
}

/**
 * @param {string} repoRoot absolute path to the repository root
 * @returns {{ violations: string[], patchIds: string[] }}
 */
export function checkForkOnlyPatches(repoRoot) {
  const violations = [];
  const registry = readRegistry(repoRoot, violations);
  if (registry) {
    for (const patch of registry.patches) checkPatch(repoRoot, patch, violations);
  }
  return { violations, patchIds: (registry?.patches ?? []).map((p) => p.id) };
}

/**
 * Did the rebuild that just happened drop anything?
 *
 * The tree check above answers "is the patch here right now" - but it reads the
 * registry FROM THE TREE. A rebuild that resets the whole tree removes the
 * registry and this very script along with the patches, so the guard cannot
 * report on its own erasure. That is the gap PR #185 review (砚砚 P1) named:
 * the registry is only useful if it survives independently.
 *
 * What survives `git reset --hard upstream/main` is the REMOTE-TRACKING REF.
 * `origin/develop_base` still points at the pre-rebuild tip, so the previous
 * tree's registry is readable straight out of git even after the working tree
 * has been replaced:
 *
 *     git show origin/develop_base:scripts/fork-only-patches.json
 *
 * This check reads what the PREVIOUS tree claimed to protect and verifies it
 * against the CURRENT one. Run it as the last step of a rebuild, before the
 * result is pushed or deployed. It stays runnable even when the rebuild deleted
 * the guard, because the guard can be read from the same ref:
 *
 *     git show origin/develop_base:scripts/check-fork-only-patches.mjs > /tmp/guard.mjs
 *
 * Why not assert membership of a "carrier" branch instead: `fork/optimizations`
 * is an orphan snapshot (7 commits, no merge-base with upstream/main, a July
 * full-tree copy). Membership of it is not a survival predicate, and demanding
 * that current code be committed onto a stale unrelated history would be
 * incoherent. Comparing against the previous tip is the claim that actually holds.
 */
function gitOut(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveRef(repoRoot, ref) {
  try {
    gitOut(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {{ baselineRef?: string }} [options]
 * @returns {{ violations: string[], baselineRef: string | null, comparedPatches: number }}
 */
export function checkRebuildSurvival(repoRoot, options = {}) {
  const violations = [];
  // Read the tree registry into a throwaway sink: its problems are the tree
  // check's to report. Here it is only the source of the baseline ref, plus the
  // signal that the guard's own input was erased.
  const treeRegistry = readRegistry(repoRoot, []);
  const baselineRef = options.baselineRef ?? treeRegistry?.baselineRef ?? 'origin/develop_base';

  if (!resolveRef(repoRoot, baselineRef)) {
    violations.push(
      `baseline ref "${baselineRef}" is not present in this checkout, so rebuild loss cannot be detected. ` +
        `Fetch it first: git fetch origin develop_base`,
    );
    return { violations, baselineRef: null, comparedPatches: 0 };
  }

  // PR #185 review (砚砚 P1): CI fetched `origin/develop_base` AFTER the push, so
  // the "baseline" was the very tree being validated. A witness that is the
  // accused cannot testify - and it fails silently, which is the whole disease.
  // The baseline must be an immutable PRE-reset commit, so refuse to compare a
  // commit with itself.
  try {
    const head = gitOut(repoRoot, ['rev-parse', 'HEAD^{commit}']).trim();
    const base = gitOut(repoRoot, ['rev-parse', `${baselineRef}^{commit}`]).trim();
    if (head === base) {
      violations.push(
        `baseline "${baselineRef}" resolves to HEAD (${head.slice(0, 9)}), the same tree being checked, ` +
          `so it cannot witness a loss. Pass the pre-reset commit explicitly: --baseline-ref <sha>`,
      );
      return { violations, baselineRef, comparedPatches: 0 };
    }
  } catch {
    violations.push(`cannot resolve HEAD or "${baselineRef}" to a commit; rebuild loss cannot be detected`);
    return { violations, baselineRef, comparedPatches: 0 };
  }

  let baselineRaw;
  try {
    baselineRaw = gitOut(repoRoot, ['show', `${baselineRef}:${REGISTRY_REL}`]);
  } catch {
    // The previous tree made no claim, so there is nothing it could have lost.
    // This is a real absence of a prior claim, not an unverifiable one - the
    // fail-closed rule applies to the latter.
    return { violations, baselineRef, comparedPatches: 0 };
  }

  let baseline;
  try {
    baseline = JSON.parse(baselineRaw);
  } catch (err) {
    violations.push(`baseline registry at ${baselineRef} is not valid JSON: ${err.message}`);
    return { violations, baselineRef, comparedPatches: 0 };
  }
  if (!baseline || !Array.isArray(baseline.patches)) {
    violations.push(`baseline registry at ${baselineRef} has no "patches" array`);
    return { violations, baselineRef, comparedPatches: 0 };
  }

  // The registry is itself a shared file, so a rebuild can REVERT it instead of
  // deleting it. Both trees then look internally consistent and the guard
  // confirms its own amnesia as healthy. Compare the claim SETS, not just files.
  const treeIds = new Set((treeRegistry?.patches ?? []).map((p) => p?.id).filter(Boolean));
  for (const patch of baseline.patches) {
    const id = patch?.id;
    if (typeof id === 'string' && id.length > 0 && treeRegistry && !treeIds.has(id)) {
      violations.push(
        `REBUILD LOSS vs ${baselineRef} - patch "${id}" was registered in the baseline but is no longer in ` +
          `${REGISTRY_REL}; the registry was reverted, not just the patch`,
      );
    }
  }

  const dropped = [];
  for (const patch of baseline.patches) {
    const id = patch?.id ?? '<unnamed patch>';
    const before = violations.length;
    checkPatch(repoRoot, patch, violations);
    // Re-label: these are losses relative to the previous tree, which is a
    // sharper statement than "missing" - it names a regression with a culprit.
    for (let i = before; i < violations.length; i++) {
      violations[i] = `REBUILD LOSS vs ${baselineRef} - ${violations[i]}`;
    }
    if (violations.length > before) dropped.push(id);
  }

  // The guard's own erasure is the case that hid the first three losses.
  if (!treeRegistry) {
    violations.push(
      `REBUILD LOSS vs ${baselineRef} - the fork-only patch registry itself is gone from this tree; ` +
        `restore ${REGISTRY_REL} and scripts/check-fork-only-patches.mjs`,
    );
  }

  return { violations, baselineRef, comparedPatches: baseline.patches.length };
}

/**
 * Where is the repo?
 *
 * Not "next to this script". The documented recovery for a rebuild that deleted
 * the guard is to read it back out of the surviving ref and run it:
 *
 *     git show origin/develop_base:scripts/check-fork-only-patches.mjs > /tmp/guard.mjs
 *     node /tmp/guard.mjs
 *
 * A script-relative root resolves to `/` there and checks nothing. Ask git from
 * the working directory first, so the guard works from wherever it was rescued to.
 */
function resolveRepoRoot(argv) {
  const flag = argv.indexOf('--repo-root');
  if (flag !== -1 && argv[flag + 1]) return resolve(argv[flag + 1]);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  }
}

function readFlag(argv, name) {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const repoRoot = resolveRepoRoot(argv);
  const tree = checkForkOnlyPatches(repoRoot);
  // --baseline-ref names the immutable PRE-reset commit. CI must pass it
  // (github.event.before / pull_request.base.sha); the registry default is only
  // good enough for a manual pre-push run, where the local ref still names the
  // prior tip.
  // --no-baseline is for the one honest case with no prior tree at all (branch
  // creation). It is explicit on purpose: skipping the survival half must be a
  // stated intent, never a silent fallback when a baseline lookup failed.
  const skipBaseline = argv.includes('--no-baseline');
  const survival = skipBaseline
    ? { violations: [], baselineRef: null, comparedPatches: 0 }
    : checkRebuildSurvival(repoRoot, { baselineRef: readFlag(argv, '--baseline-ref') });
  const seen = new Set();
  const violations = [...tree.violations, ...survival.violations].filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  const patchIds = tree.patchIds;

  if (violations.length > 0) {
    console.error('[check-fork-only-patches] FAIL - fork-only patch(es) missing from this tree.\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nThis almost always means a develop_base rebuild onto upstream main dropped them.');
    console.error('Re-apply the listed patches, then re-run this check.');
    console.error(`Registered fork-only patches: ${patchIds.join(', ') || '(registry unavailable)'}`);
    console.error('Context: docs/fork-only-patches.md');
    process.exit(1);
  }

  const baseline = skipBaseline
    ? '; rebuild-survival SKIPPED (--no-baseline: no prior tree)'
    : survival.baselineRef
      ? `; ${survival.comparedPatches} claimed by ${survival.baselineRef} still present`
      : '';
  console.log(`[check-fork-only-patches] OK - ${patchIds.length} fork-only patch(es) present${baseline}`);
}

/**
 * Symlink-safe entrypoint detection.
 *
 * `fileURLToPath(import.meta.url)` is the REAL path; `process.argv[1]` is the
 * path as typed. On macOS `/tmp` is a symlink to `/private/tmp`, so comparing
 * them with resolve() alone returns false and main() never runs - the guard
 * exits 0 having checked nothing. A guard that can silently no-op is the exact
 * failure mode this file exists to remove, so compare real paths.
 */
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  main();
}
