import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression for docs/bug-report/ghost-thread-cross-thread-session-routing/ (R-3).
 *
 * The defect was NOT a wrong rendered value — it was two independent implementations of the
 * same "strip the `thread_` namespace, then truncate" rule. The prompt path (ContextAssembler)
 * truncated the RAW id and collapsed every thread to the constant `thread_m`; the web bubble
 * happened to strip the prefix first and stayed correct. Cat and human read the same field and
 * saw different things for months.
 *
 * Asserting the rendered value cannot catch this class: both copies are correct *today*, so
 * such a test is green before and after the fix. The invariant that actually holds the fix is
 * that `shortThreadRef()` is the ONLY implementation. This test goes red the moment a third
 * copy appears — which is how the original defect was born.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** The single source of truth. Excluded from the scan because it IS the implementation. */
const CANONICAL_IMPLEMENTATION = 'packages/shared/src/types/cross-thread-coordination.ts';

const SCANNED_ROOTS = ['packages/web/src', 'packages/api/src', 'packages/mcp-server/src', 'packages/shared/src'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** `x.replace(/^thread_/, '')` followed closely by a truncation — the duplicated rule. */
const INLINE_SHORT_REF = /replace\(\s*\/\^thread_\/[^)]*\)[\s\S]{0,60}?\.slice\(/;

function collectSourceFiles(root: string): string[] {
  const absoluteRoot = join(REPO_ROOT, root);
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
    }
  };
  walk(absoluteRoot);
  return found;
}

describe('cross-post short thread ref has a single implementation', () => {
  it('no source file re-implements the strip-then-truncate rule outside shortThreadRef', () => {
    const offenders: string[] = [];

    for (const root of SCANNED_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const repoRelative = relative(REPO_ROOT, file).split('\\').join('/');
        if (repoRelative === CANONICAL_IMPLEMENTATION) continue;
        if (INLINE_SHORT_REF.test(readFileSync(file, 'utf8'))) offenders.push(repoRelative);
      }
    }

    expect(
      offenders,
      `These files hand-roll the short-thread-ref rule instead of importing shortThreadRef() ` +
        `from @cat-cafe/shared. Two copies of this rule is exactly how R-3 shipped:\n` +
        offenders.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('scan actually reaches real source files (guards against a silently empty sweep)', () => {
    const webFiles = collectSourceFiles('packages/web/src');
    expect(webFiles.length).toBeGreaterThan(50);
    expect(webFiles.some((f) => f.endsWith('ChatMessage.tsx'))).toBe(true);
  });
});
