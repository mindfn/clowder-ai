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
 * Fail-CLOSED: a missing/unreadable/malformed registry is a violation, not a
 * pass. A guard whose own input vanished must not read as clean.
 *
 * Truth source: scripts/fork-only-patches.json (see docs/fork-only-patches.md).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REGISTRY = join(__dirname, 'fork-only-patches.json');

const violations = [];

function readRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY, 'utf8');
  } catch (err) {
    violations.push(`registry unreadable at scripts/fork-only-patches.json: ${err.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    violations.push(`registry is not valid JSON: ${err.message}`);
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patches)) {
    violations.push('registry is missing a top-level "patches" array');
    return null;
  }
  return parsed;
}

function checkPatch(patch) {
  const id = patch.id ?? '<unnamed patch>';

  for (const rel of patch.requiredFiles ?? []) {
    try {
      readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      violations.push(`[${id}] required file missing: ${rel}`);
    }
  }

  for (const anchor of patch.requiredAnchors ?? []) {
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, anchor.file), 'utf8');
    } catch {
      violations.push(`[${id}] anchor file missing: ${anchor.file}`);
      continue;
    }
    for (const needle of anchor.mustContain ?? []) {
      if (!content.includes(needle)) {
        const note = anchor.note ? ` (${anchor.note})` : '';
        violations.push(`[${id}] ${anchor.file} lost anchor ${JSON.stringify(needle)}${note}`);
      }
    }
  }
}

const registry = readRegistry();
if (registry) {
  for (const patch of registry.patches) checkPatch(patch);
}

if (violations.length > 0) {
  console.error('[check-fork-only-patches] FAIL - fork-only patch(es) missing from this tree.\n');
  for (const v of violations) console.error(`  - ${v}`);
  const ids = (registry?.patches ?? []).map((p) => p.id).join(', ');
  console.error('\nThis almost always means a develop_base rebuild onto upstream main dropped them.');
  console.error('Re-apply the listed patches, then re-run this check.');
  console.error(`Registered fork-only patches: ${ids || '(registry unavailable)'}`);
  console.error('Context: docs/fork-only-patches.md');
  process.exit(1);
}

const count = registry.patches.length;
console.log(`[check-fork-only-patches] OK - ${count} fork-only patch(es) present`);
