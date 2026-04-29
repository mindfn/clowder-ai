// @vitest-environment node
/**
 * F056 Design Token Audit — catches hardcoded colors in ALL contexts.
 *
 * The ESLint rule cafe/no-hardcoded-colors only checks JSX className/style
 * literals. This test catches colors stored in variables, maps, and objects
 * that are later interpolated into className — the gap codex identified.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, '..', '..', '..');

const ALLOWLISTED_PATHS = [
  '__tests__/',
  '.test.',
  'console-shell.css',
  'theme-tokens.css',
  'color-utils.ts',
  'pixel-brawl/',
  'types.ts',
  'story-export/story-data.ts',
];

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectFiles(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function isAllowlisted(filePath: string): boolean {
  return ALLOWLISTED_PATHS.some((p) => filePath.includes(p));
}

type Hit = { file: string; line: number; text: string };

function scanFiles(pattern: RegExp): Hit[] {
  const files = collectFiles(resolve(srcDir, 'src'), ['.ts', '.tsx']);
  const hits: Hit[] = [];
  for (const file of files) {
    if (isAllowlisted(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.includes('eslint-disable')) continue;
      if (pattern.test(text)) {
        hits.push({ file: file.replace(srcDir + '/', ''), line: i + 1, text: text.trim() });
      }
    }
  }
  return hits;
}

function formatHits(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
}

describe('F056 hardcoded color audit (variable-stored)', () => {
  it('no arbitrary hex colors in Tailwind classes (bg-[#...], text-[#...], etc.)', () => {
    const pattern = /(?:bg|text|border|ring|from|to|via|outline|shadow|fill|stroke)-\[#/;
    const hits = scanFiles(pattern).filter((h) => !h.text.includes('var(--'));
    expect(hits, `Found hardcoded hex in Tailwind classes:\n${formatHits(hits)}`).toEqual([]);
  });

  it('no non-semantic Tailwind color utilities (bg-red-*, text-blue-*, etc.)', () => {
    const rawColors =
      'green|red|amber|blue|yellow|gray|slate|indigo|purple|teal|violet|pink|rose|orange|cyan|lime|fuchsia';
    const pattern = new RegExp(`(?:bg|text|border)-(?:${rawColors})-\\d`);
    const hits = scanFiles(pattern);
    expect(hits, `Found non-semantic Tailwind colors:\n${formatHits(hits)}`).toEqual([]);
  });
});
