#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * F056 — Batch migrate hardcoded Tailwind colors → semantic tokens.
 * Run: node scripts/migrate-hardcoded-colors.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ── Deterministic replacement map (order matters: longer matches first) ──
const REPLACEMENTS = [
  // ── Dark-mode overrides → remove (tokens auto-switch via data-theme) ──
  // These need regex to strip the whole class
  // Handled separately below

  // ── Hover states ──
  ['hover:bg-amber-700', 'hover:opacity-90'],
  ['hover:bg-amber-600', 'hover:opacity-90'],
  ['hover:bg-blue-700', 'hover:opacity-90'],
  ['hover:bg-blue-800', 'hover:opacity-90'],
  ['hover:bg-red-700', 'hover:opacity-90'],
  ['hover:bg-red-600', 'hover:opacity-90'],
  ['hover:bg-green-700', 'hover:opacity-90'],
  ['hover:bg-gray-200', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-gray-100', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-gray-50', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-gray-700', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-gray-800', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:text-gray-900', 'hover:text-cafe'],
  ['hover:text-gray-800', 'hover:text-cafe'],
  ['hover:text-gray-700', 'hover:text-cafe-secondary'],
  ['hover:text-gray-600', 'hover:text-cafe-secondary'],

  // ── Text colors ──
  ['text-gray-900', 'text-cafe'],
  ['text-gray-800', 'text-cafe'],
  ['text-gray-700', 'text-cafe-secondary'],
  ['text-gray-600', 'text-cafe-secondary'],
  ['text-gray-500', 'text-cafe-muted'],
  ['text-gray-400', 'text-cafe-muted'],
  ['text-gray-300', 'text-cafe-muted'],
  ['text-gray-200', 'text-cafe-muted'],
  ['text-slate-500', 'text-cafe-muted'],
  ['text-slate-400', 'text-cafe-muted'],
  ['text-slate-300', 'text-cafe-muted'],
  ['text-blue-800', 'text-[var(--semantic-info)]'],
  ['text-blue-700', 'text-[var(--semantic-info)]'],
  ['text-blue-600', 'text-[var(--semantic-info)]'],
  ['text-blue-500', 'text-[var(--semantic-info)]'],
  ['text-blue-400', 'text-[var(--semantic-info)]'],
  ['text-red-800', 'text-conn-red-text'],
  ['text-red-700', 'text-conn-red-text'],
  ['text-red-600', 'text-conn-red-text'],
  ['text-red-500', 'text-conn-red-text'],
  ['text-red-400', 'text-conn-red-text'],
  ['text-green-800', 'text-conn-emerald-text'],
  ['text-green-700', 'text-conn-emerald-text'],
  ['text-green-600', 'text-conn-emerald-text'],
  ['text-green-500', 'text-conn-emerald-text'],
  ['text-green-400', 'text-conn-emerald-text'],
  ['text-emerald-700', 'text-conn-emerald-text'],
  ['text-emerald-600', 'text-conn-emerald-text'],
  ['text-emerald-500', 'text-conn-emerald-text'],
  ['text-amber-800', 'text-conn-amber-text'],
  ['text-amber-700', 'text-conn-amber-text'],
  ['text-amber-600', 'text-conn-amber-text'],
  ['text-amber-500', 'text-conn-amber-text'],
  ['text-amber-400', 'text-conn-amber-text'],
  ['text-orange-800', 'text-conn-amber-text'],
  ['text-orange-700', 'text-conn-amber-text'],
  ['text-orange-600', 'text-conn-amber-text'],
  ['text-yellow-800', 'text-conn-amber-text'],
  ['text-yellow-700', 'text-conn-amber-text'],
  ['text-yellow-600', 'text-conn-amber-text'],
  ['text-purple-700', 'text-[var(--color-cafe-accent)]'],
  ['text-purple-600', 'text-[var(--color-cafe-accent)]'],
  // text-white: context-dependent — on colored bg → text-[var(--cafe-surface)]
  ['text-white', 'text-[var(--cafe-surface)]'],

  // ── Background colors ──
  ['bg-gray-950', 'bg-cafe-surface-sunken'],
  ['bg-gray-900', 'bg-cafe-surface-sunken'],
  ['bg-gray-800', 'bg-cafe-surface-sunken'],
  ['bg-gray-300', 'bg-cafe-surface-sunken'],
  ['bg-gray-200', 'bg-cafe-surface'],
  ['bg-gray-100', 'bg-cafe-surface-elevated'],
  ['bg-gray-50', 'bg-cafe-surface-elevated'],
  ['bg-white', 'bg-cafe-surface-canvas'],
  ['bg-slate-100', 'bg-cafe-surface-elevated'],
  ['bg-slate-50', 'bg-cafe-surface-elevated'],
  ['bg-blue-600', 'bg-[var(--semantic-info)]'],
  ['bg-blue-500', 'bg-[var(--semantic-info)]'],
  ['bg-blue-100', 'bg-[var(--semantic-info-surface)]'],
  ['bg-blue-50', 'bg-[var(--semantic-info-surface)]'],
  ['bg-amber-600', 'bg-[var(--semantic-warning)]'],
  ['bg-amber-500', 'bg-[var(--semantic-warning)]'],
  ['bg-amber-400', 'bg-[var(--semantic-warning)]'],
  ['bg-amber-100', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-50', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-red-600', 'bg-[var(--semantic-critical)]'],
  ['bg-red-500', 'bg-[var(--semantic-critical)]'],
  ['bg-red-400', 'bg-[var(--semantic-critical)]'],
  ['bg-red-100', 'bg-[var(--semantic-critical-surface)]'],
  ['bg-red-50', 'bg-[var(--semantic-critical-surface)]'],
  ['bg-green-600', 'bg-[var(--semantic-success)]'],
  ['bg-green-500', 'bg-[var(--semantic-success)]'],
  ['bg-green-400', 'bg-[var(--semantic-success)]'],
  ['bg-green-100', 'bg-[var(--semantic-success-surface)]'],
  ['bg-green-50', 'bg-[var(--semantic-success-surface)]'],
  ['bg-emerald-600', 'bg-[var(--semantic-success)]'],
  ['bg-emerald-500', 'bg-[var(--semantic-success)]'],
  ['bg-emerald-100', 'bg-[var(--semantic-success-surface)]'],
  ['bg-emerald-50', 'bg-[var(--semantic-success-surface)]'],
  ['bg-orange-100', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-orange-50', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-yellow-100', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-yellow-50', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-purple-100', 'bg-[var(--accent-100)]'],
  ['bg-purple-50', 'bg-[var(--accent-50)]'],

  // ── Border colors ──
  ['border-gray-800', 'border-[var(--console-border-soft)]'],
  ['border-gray-700', 'border-[var(--console-border-soft)]'],
  ['border-gray-300', 'border-[var(--console-border-soft)]'],
  ['border-gray-200', 'border-[var(--console-border-soft)]'],
  ['border-gray-100', 'border-[var(--console-border-soft)]'],
  ['border-slate-200', 'border-[var(--console-border-soft)]'],
  ['border-orange-300', 'border-[var(--semantic-warning)]'],
  ['border-orange-200', 'border-[var(--semantic-warning)]'],
  ['border-red-300', 'border-[var(--semantic-critical)]'],
  ['border-red-200', 'border-[var(--semantic-critical)]'],
  ['border-blue-300', 'border-[var(--semantic-info)]'],
  ['border-blue-200', 'border-[var(--semantic-info)]'],
  ['border-green-300', 'border-[var(--semantic-success)]'],
  ['border-green-200', 'border-[var(--semantic-success)]'],
  ['border-amber-300', 'border-[var(--semantic-warning)]'],

  // ── Ring / accent ──
  ['accent-emerald-500', 'accent-[var(--color-cafe-accent)]'],
  ['accent-emerald-600', 'accent-[var(--color-cafe-accent)]'],
  ['ring-blue-500', 'ring-[var(--semantic-info)]'],
  ['ring-gray-300', 'ring-[var(--console-border-soft)]'],
  ['ring-gray-200', 'ring-[var(--console-border-soft)]'],
  ['ring-black/20', 'ring-[var(--console-border-soft)]'],
  ['ring-black/10', 'ring-[var(--console-border-soft)]'],

  // ── Divide ──
  ['divide-gray-200', 'divide-[var(--console-border-soft)]'],
  ['divide-gray-100', 'divide-[var(--console-border-soft)]'],

  // ── Round 2: opacity variants & edge shades ──
  // Hover edge cases
  ['hover:bg-gray-600', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-gray-300', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-emerald-600', 'hover:opacity-90'],
  ['hover:bg-emerald-700', 'hover:opacity-90'],
  ['hover:bg-black/5', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-black/10', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-amber-500/10', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:text-red-700', 'hover:text-conn-red-text'],
  ['hover:text-red-800', 'hover:text-conn-red-text'],
  ['hover:text-amber-200', 'hover:text-conn-amber-text'],
  ['hover:text-amber-300', 'hover:text-conn-amber-text'],

  // Bg with opacity
  ['bg-gray-900/50', 'bg-cafe-surface-sunken/50'],
  ['bg-gray-900/80', 'bg-cafe-surface-sunken/80'],
  ['bg-gray-900/90', 'bg-cafe-surface-sunken/90'],
  ['bg-gray-800/50', 'bg-cafe-surface-sunken/50'],
  ['bg-gray-700', 'bg-cafe-surface-sunken'],
  ['bg-amber-900/20', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-900/30', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-200', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-100', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-400', 'bg-[var(--semantic-warning)]'],
  ['bg-black/40', 'bg-[var(--console-overlay-medium)]'],
  ['bg-black/50', 'bg-[var(--console-overlay-medium)]'],
  ['bg-black/60', 'bg-[var(--console-overlay-medium)]'],
  ['bg-black/80', 'bg-[var(--console-overlay-heavy)]'],

  // Text edge shades
  ['text-gray-100', 'text-cafe'],
  ['text-amber-300', 'text-conn-amber-text'],
  ['text-amber-400/60', 'text-conn-amber-text/60'],
  ['text-indigo-500', 'text-[var(--semantic-info)]'],
  ['text-indigo-600', 'text-[var(--semantic-info)]'],

  // Border edge shades
  ['border-slate-700', 'border-[var(--console-border-soft)]'],
  ['border-slate-600', 'border-[var(--console-border-soft)]'],
  ['border-orange-100', 'border-[var(--semantic-warning-surface)]'],
  ['border-amber-900/30', 'border-[var(--semantic-warning)]'],
  ['border-amber-400', 'border-[var(--semantic-warning)]'],
  ['border-amber-300', 'border-[var(--semantic-warning)]'],
  ['border-amber-100', 'border-[var(--semantic-warning-surface)]'],
  ['border-red-100', 'border-[var(--semantic-critical-surface)]'],

  // ── Round 3: long-tail shades, gradients, misc ──
  // Background edge
  ['bg-slate-900/80', 'bg-cafe-surface-sunken/80'],
  ['bg-slate-800/90', 'bg-cafe-surface-sunken/90'],
  ['bg-slate-700', 'bg-cafe-surface-sunken'],
  ['bg-slate-600', 'bg-cafe-surface-sunken'],
  ['bg-red-950/20', 'bg-[var(--semantic-critical-surface)]'],
  ['bg-red-900/20', 'bg-[var(--semantic-critical-surface)]'],
  ['bg-red-800', 'bg-[var(--semantic-critical)]'],
  ['bg-blue-900/20', 'bg-[var(--semantic-info-surface)]'],
  ['bg-blue-400', 'bg-[var(--semantic-info)]'],
  ['bg-emerald-700', 'bg-[var(--semantic-success)]'],
  ['bg-green-600/50', 'bg-[var(--semantic-success)]/50'],
  ['bg-green-400', 'bg-[var(--semantic-success)]'],
  ['bg-orange-500', 'bg-[var(--semantic-warning)]'],
  ['bg-yellow-400', 'bg-[var(--semantic-warning)]'],
  ['bg-amber-950/30', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-500/20', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-amber-500/10', 'bg-[var(--semantic-warning-surface)]'],
  ['bg-black/30', 'bg-[var(--console-overlay-light)]'],

  // Text edge
  ['text-white/80', 'text-[var(--cafe-surface)]/80'],
  ['text-white/70', 'text-[var(--cafe-surface)]/70'],
  ['text-slate-600', 'text-cafe-secondary'],
  ['text-slate-200', 'text-cafe-muted'],
  ['text-slate-100', 'text-cafe'],
  ['text-rose-600', 'text-conn-red-text'],
  ['text-emerald-800', 'text-conn-emerald-text'],
  ['text-emerald-500/80', 'text-conn-emerald-text/80'],
  ['text-amber-200/80', 'text-conn-amber-text/80'],

  // Hover edge
  ['hover:bg-orange-600', 'hover:opacity-90'],
  ['hover:bg-emerald-50', 'hover:bg-[var(--console-hover-bg)]'],
  ['hover:bg-black/90', 'hover:bg-[var(--console-overlay-heavy)]'],
  ['hover:text-slate-600', 'hover:text-cafe-secondary'],
  ['hover:text-purple-800', 'hover:text-[var(--color-cafe-accent)]'],
  ['hover:text-purple-500', 'hover:text-[var(--color-cafe-accent)]'],
  ['hover:text-indigo-500', 'hover:text-[var(--semantic-info)]'],
  ['hover:text-gray-300', 'hover:text-cafe-muted'],
  ['hover:text-blue-300', 'hover:text-[var(--semantic-info)]'],
  ['hover:from-amber-600', 'hover:from-[var(--semantic-warning)]'],
  ['hover:to-orange-600', 'hover:to-[var(--semantic-warning)]'],
  ['hover:border-slate-500', 'hover:border-[var(--console-border-strong)]'],
  ['hover:border-purple-300', 'hover:border-[var(--color-cafe-accent)]'],
  ['hover:border-purple-200', 'hover:border-[var(--color-cafe-accent)]'],
  ['hover:border-indigo-400', 'hover:border-[var(--semantic-info)]'],
  ['hover:border-gray-400', 'hover:border-[var(--console-border-strong)]'],
  ['hover:border-amber-400', 'hover:border-[var(--semantic-warning)]'],

  // Border edge
  ['border-slate-100/60', 'border-[var(--console-border-soft)]'],
  ['border-red-900/30', 'border-[var(--semantic-critical)]'],
  ['border-red-800/40', 'border-[var(--semantic-critical)]'],
  ['border-purple-400', 'border-[var(--color-cafe-accent)]'],
  ['border-purple-300', 'border-[var(--color-cafe-accent)]'],
  ['border-green-400', 'border-[var(--semantic-success)]'],
  ['border-green-100', 'border-[var(--semantic-success-surface)]'],
  ['border-emerald-300', 'border-[var(--semantic-success)]'],
  ['border-emerald-200', 'border-[var(--semantic-success)]'],
  ['border-emerald-100/50', 'border-[var(--semantic-success-surface)]'],
  ['border-blue-900/30', 'border-[var(--semantic-info)]'],
  ['border-blue-600', 'border-[var(--semantic-info)]'],
  ['border-amber-800/40', 'border-[var(--semantic-warning)]'],
  ['border-amber-500/30', 'border-[var(--semantic-warning)]'],
  ['border-amber-100/50', 'border-[var(--semantic-warning-surface)]'],

  // Gradient from/to
  ['from-purple-100', 'from-[var(--accent-100)]'],
  ['from-orange-50', 'from-[var(--semantic-warning-surface)]'],
  ['from-indigo-50', 'from-[var(--semantic-info-surface)]'],
  ['from-emerald-50', 'from-[var(--semantic-success-surface)]'],
  ['from-blue-100', 'from-[var(--semantic-info-surface)]'],
  ['from-amber-500', 'from-[var(--semantic-warning)]'],
  ['from-amber-50', 'from-[var(--semantic-warning-surface)]'],
  ['to-yellow-100/50', 'to-[var(--semantic-warning-surface)]/50'],
  ['to-white', 'to-[var(--cafe-surface-canvas)]'],
  ['to-orange-500', 'to-[var(--semantic-warning)]'],
  ['to-indigo-100/50', 'to-[var(--semantic-info-surface)]/50'],
  ['to-indigo-100', 'to-[var(--semantic-info-surface)]'],
  ['to-green-100/50', 'to-[var(--semantic-success-surface)]/50'],
  ['to-cyan-100', 'to-[var(--semantic-info-surface)]'],

  // Misc
  ['shadow-slate-900/30', 'shadow-[var(--console-border-soft)]'],
  ['ring-black/5', 'ring-[var(--console-border-soft)]'],
  ['placeholder:text-gray-400', 'placeholder:text-cafe-muted'],
  ['focus:outline-blue-400', 'focus:outline-[var(--semantic-info)]'],
  ['decoration-gray-400/50', 'decoration-cafe-muted/50'],

  // Dark mode leftover
  ['dark:hover:bg-amber-950/20', ''],
  ['dark:bg-amber-950/30', ''],
  ['dark:bg-amber-950/20', ''],
  ['dark:hover:bg-amber-950/30', ''],

  // ── Round 4 (Option B sweep): high-frequency remaining ──
  // text-white family (button label on accent / overlay)
  ['text-white/90', 'text-[var(--cafe-surface)]/90'],
  ['text-white/60', 'text-[var(--cafe-surface)]/60'],
  ['text-white/50', 'text-[var(--cafe-surface)]/50'],
  ['text-white', 'text-[var(--cafe-surface)]'],
  ['from-white', 'from-[var(--cafe-surface)]'],
  ['to-white', 'to-[var(--cafe-surface)]'],
  ['via-white', 'via-[var(--cafe-surface)]'],
  // amber variants
  ['bg-amber-600', 'bg-[var(--semantic-warning)]'],
  ['bg-amber-500', 'bg-[var(--semantic-warning)]'],
  ['hover:bg-amber-700', 'hover:opacity-90'],
  ['hover:bg-amber-500/10', 'hover:bg-[var(--semantic-warning-surface)]'],
  ['hover:bg-amber-500/20', 'hover:bg-[var(--semantic-warning-surface)]'],
  ['text-amber-400/60', 'text-conn-amber-text/60'],
  ['text-amber-400', 'text-conn-amber-text'],
  ['text-amber-300', 'text-conn-amber-text'],
  ['hover:text-amber-300', 'hover:text-conn-amber-text'],
  ['hover:text-amber-200', 'hover:text-conn-amber-text'],
  ['border-amber-900/30', 'border-[var(--semantic-warning)]'],
  ['bg-amber-900/20', 'bg-[var(--semantic-warning-surface)]'],
  // gray edge
  ['bg-gray-900/50', 'bg-[var(--console-overlay-medium)]'],
  ['bg-gray-900/40', 'bg-[var(--console-overlay-medium)]'],
  ['bg-gray-900/30', 'bg-[var(--console-overlay-light)]'],
  ['bg-gray-200', 'bg-cafe-surface-sunken'],
  ['ring-black/20', 'ring-[var(--console-border-soft)]'],
  ['ring-black/10', 'ring-[var(--console-border-soft)]'],
  // red/green edge
  ['border-red-100', 'border-[var(--semantic-critical-surface)]'],
  ['text-red-700', 'text-conn-red-text'],
  ['text-green-500', 'text-conn-emerald-text'],
  ['text-green-400', 'text-conn-emerald-text'],
  ['bg-green-600', 'bg-[var(--semantic-success)]'],
  // blue/indigo
  ['bg-indigo-50', 'bg-[var(--semantic-info-surface)]'],
  ['focus:ring-blue-300', 'focus:ring-[var(--semantic-info)]'],

  // ── Round 5 (Option B final sweep): cocreator + leftover Tailwind ──
  // Cocreator purple/violet — #9B7EBD family
  ['bg-[#9B7EBD]/15', 'bg-[var(--color-cocreator-primary)]/15'],
  ['bg-[#9B7EBD]/5', 'bg-[var(--color-cocreator-primary)]/5'],
  ['bg-[#9B7EBD]', 'bg-[var(--color-cocreator-primary)]'],
  ['text-[#9B7EBD]', 'text-[var(--color-cocreator-primary)]'],
  ['border-[#9B7EBD]', 'border-[var(--color-cocreator-primary)]'],
  ['bg-[#F3EEFA]', 'bg-[var(--color-cocreator-surface)]'],
  ['hover:bg-[#8B6FAE]', 'hover:opacity-90'],
  ['hover:bg-[#8A6DAC]', 'hover:opacity-90'],
  ['hover:bg-[#6A5ACD]', 'hover:opacity-90'],
  ['hover:bg-[#295ad6]', 'hover:opacity-90'],
  // Feishu brand brown — used in QR/share panels
  ['bg-[#F5EDE0]', 'bg-cafe-surface-sunken'],
  ['hover:bg-[#F5EDE0]', 'hover:bg-cafe-surface-sunken'],
  ['text-[#8D6E63]', 'text-cafe'],
  ['text-[#7A5C1F]', 'text-[var(--semantic-warning)]'],
  // Remaining Tailwind named colors
  ['text-purple-500', 'text-[var(--color-cocreator-primary)]'],
  ['text-indigo-400', 'text-[var(--semantic-info)]'],
  ['text-blue-300', 'text-[var(--semantic-info)]'],
  ['placeholder:text-gray-300', 'placeholder:text-cafe-muted'],
  ['hover:bg-yellow-200', 'hover:bg-[var(--semantic-warning-surface)]'],
  ['hover:bg-purple-100', 'hover:bg-[var(--color-cocreator-surface)]'],
  ['hover:bg-indigo-50', 'hover:bg-[var(--semantic-info-surface)]'],
  ['hover:bg-blue-100/50', 'hover:bg-[var(--semantic-info-surface)]/50'],
];

// dark: prefix classes to strip entirely
const DARK_PATTERN = /\bdark:[a-z]+-[a-z]+-[a-z0-9/]+\b\s*/g;

// ── Get file list from lint output ──
const lintOut = execSync('pnpm --filter @cat-cafe/web lint 2>&1 | grep "cafe/no-hardcoded" -B1 | grep "^\\./"', {
  cwd: '/Users/lang/workspace/github-lab/clowder-ai-f056-oklch/packages/web',
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});

const files = [
  ...new Set(
    lintOut
      .trim()
      .split('\n')
      .map((l) => l.trim()),
  ),
];
const basePath = '/Users/lang/workspace/github-lab/clowder-ai-f056-oklch/packages/web';

let totalReplacements = 0;
let filesModified = 0;

for (const relPath of files) {
  const absPath = `${basePath}/${relPath.replace(/^\.\//, '')}`;
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    console.log(`SKIP (not found): ${relPath}`);
    continue;
  }

  let modified = content;
  let fileReplacements = 0;

  // Strip dark: overrides
  const darkMatches = modified.match(DARK_PATTERN);
  if (darkMatches) {
    modified = modified.replace(DARK_PATTERN, '');
    fileReplacements += darkMatches.length;
  }

  // Apply deterministic replacements (word-boundary aware)
  for (const [from, to] of REPLACEMENTS) {
    // Match as whole class name (preceded by space/quote/' and followed by space/quote/')
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<=[\\s"'\`])${escaped}(?=[\\s"'\`])`, 'g');
    const before = modified;
    modified = modified.replace(regex, to);
    if (modified !== before) {
      const count = (before.match(regex) || []).length;
      fileReplacements += count;
    }
  }

  // Clean up double spaces that arose ONLY inside string literals from dark: removal.
  // Old code did a global `replace(/  +/g, ' ')` which destroyed all 2-space indentation.
  // Now: only collapse runs of spaces inside string content (between two quote marks),
  // and trim trailing space before closing quote.
  modified = modified.replace(
    /(["'`])([^"'`\n]*? {2,}[^"'`\n]*?)\1/g,
    (_match, q, inner) => `${q}${inner.replace(/ {2,}/g, ' ').trimEnd()}${q}`,
  );

  if (modified !== content) {
    writeFileSync(absPath, modified);
    filesModified++;
    totalReplacements += fileReplacements;
    console.log(`✓ ${relPath} (${fileReplacements} replacements)`);
  } else {
    console.log(`· ${relPath} (no changes)`);
  }
}

console.log(`\nDone: ${filesModified} files modified, ${totalReplacements} replacements`);
