#!/usr/bin/env node

/**
 * Lint guard for a real production bug pattern we hit twice in PR #674:
 *
 *   echo "  ... $myvar（chinese paren ...）"
 *
 * Under `set -u`, bash variable-name lexing extends the identifier into
 * the UTF-8 lead bytes of full-width Chinese punctuation immediately
 * following $var, treats it as an unknown var, and aborts:
 *
 *   prereq-check.sh: line 372: sys_proxy_candidate�: unbound variable
 *
 * The fix is always the same: wrap the var in ${...}. Catching this
 * at lint time means we don't ship another "regression that takes
 * down install on Mac" hotfix cycle.
 *
 * Heuristic: `$IDENT` (no braces, no `:-` default) followed within
 * 1 char by a high-byte (UTF-8 lead, 0x80..0xFF) — that means a
 * non-ASCII character is touching the variable, which is the only
 * scenario where this bash-parser quirk fires.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(new URL(import.meta.url).pathname, '..', '..');
const SCAN_ROOT = join(ROOT, 'scripts/services');

// Match `$identifier` followed by a non-ASCII byte. Skip `${...}` (safe).
// Skip `$$` (special), `$1..$9` (positional, never relevant here).
const HAZARD_RE = /(?<![${\\])\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/u;

function walkShellScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkShellScripts(full));
    } else if (entry.endsWith('.sh')) {
      out.push(full);
    }
  }
  return out;
}

function scan(file) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HAZARD_RE);
    if (match) hits.push({ line: i + 1, text: lines[i].trim(), match: match[0] });
  }
  return hits;
}

function main() {
  const files = walkShellScripts(SCAN_ROOT);
  const allHits = [];
  for (const file of files) {
    const hits = scan(file);
    for (const hit of hits) {
      allHits.push({ file: relative(ROOT, file), ...hit });
    }
  }
  if (allHits.length === 0) {
    console.log('✅ No $var-before-multibyte hazards in scripts/services/*.sh');
    process.exit(0);
  }
  console.error('❌ $var-before-multibyte hazard(s) found — wrap in ${...}:');
  for (const hit of allHits) {
    console.error(`  ${hit.file}:${hit.line}  matched "${hit.match}"`);
    console.error(`    ${hit.text}`);
  }
  console.error('');
  console.error('Why this matters: under `set -u`, bash extends the var name');
  console.error('into UTF-8 lead bytes, fails with "unbound variable", aborts');
  console.error('the install. Saw this twice in PR #674 already.');
  process.exit(1);
}

main();
